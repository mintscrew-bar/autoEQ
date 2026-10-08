// 자동 EQ 핵심 로직: 입력 스펙트럼의 "모양"을 목표 곡선과 비교해 밴드별 보정량(dB)을 계산한다.
// 웹 오디오에 의존하지 않는 순수 로직이라, 나중에 JUCE(C++)로 옮길 때 그대로 기준 구현으로 쓴다.

export interface AutoEqOptions {
  /** 목표 곡선의 옥타브당 기울기(dB). 핑크 노이즈는 -3, 실제 믹스는 대체로 -4.5 근처 */
  slopeDbPerOct: number;
  /** 기울기의 기준 주파수(Hz). 목표 곡선은 이 지점에서 0dB */
  pivotHz: number;
  /** 한 밴드에 줄 수 있는 최대 보정량(dB, 부스트·컷 공통) */
  maxCorrectionDb: number;
  /** 보정 강도 0~1 */
  amount: number;
  /** 스펙트럼 평균의 시정수(초). 클수록 천천히, 안정적으로 따라간다 */
  averageSeconds: number;
  /** 가장 큰 밴드가 이 값(dB)보다 작으면 무음으로 보고 학습하지 않는다 */
  gateDb: number;
}

export const DEFAULT_OPTIONS: AutoEqOptions = {
  slopeDbPerOct: -3,
  pivotHz: 1000,
  maxCorrectionDb: 6,
  amount: 1,
  averageSeconds: 4,
  gateDb: -75,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export class AutoEq {
  private readonly options: AutoEqOptions;
  private average: number[] | null = null;
  private alignedCurve: number[];
  private correctionCurve: number[];

  constructor(
    private readonly centers: number[],
    options: Partial<AutoEqOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.alignedCurve = centers.map(() => 0);
    this.correctionCurve = centers.map(() => 0);
  }

  setOptions(partial: Partial<AutoEqOptions>): void {
    Object.assign(this.options, partial);
    // 옵션이 바뀌면 새 옵션 기준으로 보정량을 다시 계산한다.
    if (this.average) this.recompute();
  }

  getOptions(): Readonly<AutoEqOptions> {
    return this.options;
  }

  /** 학습한 평균을 비운다. 다른 소스로 바꿀 때 쓴다. */
  reset(): void {
    this.average = null;
    this.alignedCurve = this.centers.map(() => 0);
    this.correctionCurve = this.centers.map(() => 0);
  }

  /** 밴드 중심 주파수별 목표 곡선(dB). pivot에서 0dB */
  target(): number[] {
    const { slopeDbPerOct, pivotHz } = this.options;
    return this.centers.map((f) => slopeDbPerOct * Math.log2(f / pivotHz));
  }

  /**
   * 한 프레임의 밴드 레벨(dB)을 먹여 평균을 갱신하고 보정량을 다시 계산한다.
   * @returns 프레임을 학습에 반영했는지(무음이면 false)
   */
  update(bandDb: number[], dtSeconds: number): boolean {
    if (bandDb.length !== this.centers.length) {
      throw new Error(`밴드 수가 다릅니다: ${bandDb.length} != ${this.centers.length}`);
    }
    const loudest = Math.max(...bandDb);
    if (!Number.isFinite(loudest) || loudest < this.options.gateDb) return false;

    // -Infinity가 섞여 있으면 평균이 오염되므로 바닥값으로 막는다.
    const frame = bandDb.map((db) => (Number.isFinite(db) ? db : this.options.gateDb));

    if (!this.average) {
      this.average = frame;
    } else {
      // 지수 이동평균. dt에 따라 가중치를 정해 프레임 간격이 달라도 같은 속도로 수렴한다.
      const alpha = 1 - Math.exp(-dtSeconds / Math.max(0.01, this.options.averageSeconds));
      this.average = this.average.map((prev, i) => prev + alpha * ((frame[i] ?? prev) - prev));
    }
    this.recompute();
    return true;
  }

  /**
   * 평균 스펙트럼을 목표 곡선 높이에 맞춰 정렬한 값(dB).
   * 절대 음량은 의미가 없으므로 중앙값 기준으로만 맞춘다.
   */
  aligned(): readonly number[] {
    return this.alignedCurve;
  }

  /** 밴드별 보정량(dB). 양수는 부스트, 음수는 컷 */
  correction(): readonly number[] {
    return this.correctionCurve;
  }

  private recompute(): void {
    const avg = this.average;
    if (!avg) return;
    const target = this.target();
    const { maxCorrectionDb, amount } = this.options;

    // 음량 차이를 없애려고 (목표 - 평균)의 중앙값을 오프셋으로 쓴다.
    // 평균이 아니라 중앙값을 쓰는 이유: 한두 밴드가 크게 튀어도 나머지 밴드가 끌려가지 않게 하려는 것이다.
    const offset = median(avg.map((db, i) => (target[i] ?? 0) - db));
    this.alignedCurve = avg.map((db) => db + offset);
    this.correctionCurve = this.alignedCurve.map((db, i) => {
      const raw = (target[i] ?? 0) - db;
      const clamped = Math.max(-maxCorrectionDb, Math.min(maxCorrectionDb, raw));
      return clamped * amount;
    });
  }
}
