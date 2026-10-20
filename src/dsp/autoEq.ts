// 자동 EQ 핵심 로직: 입력 스펙트럼에서 주변보다 유난히 튀거나 꺼진 음역을 찾아 밴드별 보정량(dB)을 계산한다.
// 기본 목표는 곡 자신의 넓은 추세(이동 중앙값)라서, 곡의 전체적인 기울기·음색은 그대로 두고 국소적인 굴곡만 다듬는다.
// 레퍼런스에서 학습한 목표를 쓰면 그 곡의 음색에 맞춘다.
// 웹 오디오에 의존하지 않는 순수 로직이라, 나중에 JUCE(C++)로 옮길 때 그대로 기준 구현으로 쓴다.

export interface AutoEqOptions {
  /**
   * 추세를 구할 때 한 밴드 좌우로 보는 폭(옥타브). 이 폭보다 좁은 굴곡이 보정 대상이 된다.
   * 직선 목표는 중역이 불룩한 실제 음악을 V자로 깎아서(NOTES.md) 곡 자신의 추세를 목표로 쓴다.
   */
  smoothOctaves: number;
  /** 한 밴드에 줄 수 있는 최대 보정량(dB, 부스트·컷 공통) */
  maxCorrectionDb: number;
  /** 자동 보정이 건드리는 가장 낮은 주파수(Hz). 그 아래 밴드는 보정 0 */
  minHz: number;
  /** 자동 보정이 건드리는 가장 높은 주파수(Hz). MP3 등은 고역이 깎여 있어 올려도 잡음만 커진다 */
  maxHz: number;
  /** 보정 강도 0~1 */
  amount: number;
  /** 스펙트럼 평균의 시정수(초). 클수록 천천히, 안정적으로 따라간다 */
  averageSeconds: number;
  /** 가장 큰 밴드가 이 값(dB)보다 작으면 무음으로 보고 학습하지 않는다 */
  gateDb: number;
  /**
   * 보정이 완전한 강도에 이르는 데 필요한 분석 시간(초). 그 전에는 쌓인 시간에 비례해 약하게 적용한다.
   * 짧은 구간의 평균은 지금 울리는 화음·음정 때문에 치우쳐서, 곡의 내용을 결함으로 읽기 쉽다. 0이면 끈다.
   */
  confidenceSeconds: number;
  /** 추세에서 이만큼(dB) 이내로 벗어난 것은 결함으로 보지 않는다. 넘은 만큼만 보정한다. 완만한 곡률·측정 잡음의 오탐을 막는다 */
  deadbandDb: number;
  /**
   * 악기 프로파일(setInstrument)을 쓸 때, 악기 고유 음색에서 벗어난 넓은 불균형을 얼마나 바로잡을지 0~1.
   * 0이면 프로파일은 "정상적인 굴곡"을 알려 주는 용도로만 쓰이고(좁은 결함만 보정), 1이면 프로파일 모양으로 완전히 당긴다.
   */
  instrumentMatch: number;
}

export const DEFAULT_OPTIONS: AutoEqOptions = {
  smoothOctaves: 1.5,
  maxCorrectionDb: 3,
  minHz: 50,
  maxHz: 8000,
  amount: 1,
  averageSeconds: 4,
  gateDb: -75,
  confidenceSeconds: 8,
  deadbandDb: 0.5,
  instrumentMatch: 0.5,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * 로버스트 직선(Theil–Sen)을 (xs, ys)에 맞춰 x0에서의 값을 돌려준다. 이웃 점 몇 개가 튀어도 직선이 끌려가지 않는다.
 * 중앙값은 기울어진 구간에서 튀는 점의 이웃 값을 돌려주어 기울기 한 칸만큼 보정이 사라지므로, 기울기를 함께 맞춘다.
 */
function robustLineAt(xs: readonly number[], ys: readonly number[], x0: number): number {
  if (xs.length < 4) return median([...ys]);
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const dx = (xs[j] ?? 0) - (xs[i] ?? 0);
      if (dx > 1e-9) slopes.push(((ys[j] ?? 0) - (ys[i] ?? 0)) / dx);
    }
  }
  const slope = slopes.length ? median(slopes) : 0;
  const intercept = median(ys.map((y, k) => y - slope * (xs[k] ?? 0)));
  return intercept + slope * x0;
}

export class AutoEq {
  private readonly options: AutoEqOptions;
  private average: number[] | null = null;
  /** 학습 중이면 지수 이동평균 대신 학습을 시작한 뒤의 전체 평균을 쓴다 */
  private cumulative = false;
  private elapsed = 0;
  /** 레퍼런스에서 학습한 목표 곡선. 없으면 직선 목표를 쓴다 */
  private learned: number[] | null = null;
  /** 악기 프로파일(밴드 중심별 dB, 분석기와 같은 영역). 없으면 곡 자신의 추세만 쓴다 */
  private instrument: number[] | null = null;
  private alignedCurve: number[];
  private trendCurve: number[];
  private correctionCurve: number[];

  constructor(
    private readonly centers: number[],
    options: Partial<AutoEqOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.alignedCurve = centers.map(() => 0);
    this.trendCurve = centers.map(() => 0);
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

  /**
   * 학습을 시작한다. 지금까지 쌓은 평균을 비우고, 이 시점부터 들어오는 프레임의 전체 평균을 만든다.
   * (디노이저의 Learn처럼 곡의 대표적인 구간을 충분히 들려주면 그 평균에 수렴한다.)
   */
  beginLearning(): void {
    this.reset();
    this.cumulative = true;
  }

  /** 학습을 끝낸다. 평균은 그대로 남는다. */
  endLearning(): void {
    this.cumulative = false;
  }

  /** 학습한 평균을 비운다. 다른 소스로 바꿀 때 쓴다. */
  reset(): void {
    this.elapsed = 0;
    this.average = null;
    this.alignedCurve = this.centers.map(() => 0);
    this.trendCurve = this.centers.map(() => 0);
    this.correctionCurve = this.centers.map(() => 0);
  }

  /**
   * 지금까지 학습한 평균 스펙트럼을 목표 곡선으로 저장한다.
   * 직선 목표는 실제 음악의 불룩한 중역을 결함으로 읽어 V자로 깎기 때문에(NOTES.md), 좋아하는 곡의 모양을 기준으로 삼는다.
   * @returns 학습한 평균이 없으면 false
   */
  learnTarget(): boolean {
    if (!this.average) return false;
    const offset = median(this.average);
    this.learned = this.average.map((db) => db - offset);
    this.recompute();
    return true;
  }

  /**
   * 악기 프로파일을 정한다(null이면 해제). 길이는 centers와 같아야 한다.
   * 평균 스펙트럼에서 프로파일을 뺀 잔차로 좁은 결함을 찾으므로, 악기 고유의 굴곡이 결함으로 읽히지 않는다.
   */
  setInstrument(target: readonly number[] | null): void {
    if (target && target.length !== this.centers.length) {
      throw new Error(`밴드 수가 다릅니다: ${target.length} != ${this.centers.length}`);
    }
    this.instrument = target ? [...target] : null;
    if (this.average) this.recompute();
  }

  hasInstrument(): boolean {
    return this.instrument !== null;
  }

  /** 지금까지 쌓은 평균 스펙트럼(밴드 중심별 dB). 악기 추정에 쓴다 */
  averageLevels(): readonly number[] | null {
    return this.average;
  }

  /** 학습한 목표를 버리고 직선 목표로 돌아간다. */
  clearTarget(): void {
    this.learned = null;
    if (this.average) this.recompute();
  }

  /** 분석한 프레임이 하나라도 있는지 */
  hasData(): boolean {
    return this.average !== null;
  }

  hasLearnedTarget(): boolean {
    return this.learned !== null;
  }

  /** 밴드 중심 주파수별 목표 곡선(dB). 학습한 목표가 있으면 그것, 없으면 지금 곡의 추세 */
  target(): number[] {
    if (this.learned) return [...this.learned];
    return [...this.trendCurve];
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
      this.elapsed = dtSeconds;
      this.average = frame;
    } else {
      // 학습 중에는 전체 평균(가중치 dt/경과 시간), 아니면 지수 이동평균.
      // dt에 따라 가중치를 정해 프레임 간격이 달라도 같은 속도로 수렴한다.
      this.elapsed += dtSeconds;
      const alpha = this.cumulative
        ? Math.min(1, dtSeconds / Math.max(dtSeconds, this.elapsed))
        : 1 - Math.exp(-dtSeconds / Math.max(0.01, this.options.averageSeconds));
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

  /** 지금까지 쌓인 분석 시간에 대한 신뢰도 0~1. 보정량에 곱해진다 */
  confidence(): number {
    const { confidenceSeconds } = this.options;
    return confidenceSeconds > 0 ? Math.min(1, this.elapsed / confidenceSeconds) : 1;
  }

  /** 밴드별 보정량(dB). 양수는 부스트, 음수는 컷 */
  correction(): readonly number[] {
    return this.correctionCurve;
  }

  private recompute(): void {
    const avg = this.average;
    if (!avg) return;
    const { maxCorrectionDb, amount, minHz, maxHz, smoothOctaves, deadbandDb } = this.options;

    // 보정 대상 밴드. 범위 밖 밴드는 추세·오프셋 계산에도 넣지 않는다(고역이 비어 있는 곡에서 값이 끌려가는 것을 막는다).
    const active = this.centers.map((f) => f >= minHz && f <= maxHz);
    const activeIdx = avg.flatMap((_, i) => (active[i] ? [i] : []));

    let target: number[];
    let offset: number;
    /** 추세 대비 어긋남에 더해지는, 악기 고유 음색 쪽으로 당기는 양(dB) */
    let pull: number[] | null = null;
    if (this.learned) {
      target = this.learned;
      // 음량 차이를 없애려고 (목표 - 평균)의 중앙값을 오프셋으로 쓴다. 평균이 아니라 중앙값이라 한두 밴드가 튀어도 끌려가지 않는다.
      const diffs = activeIdx.map((i) => (target[i] ?? 0) - (avg[i] ?? 0));
      offset = diffs.length ? median(diffs) : 0;
    } else {
      // 곡 자신의 추세: 좌우 smoothOctaves 안 밴드들에 맞춘 로버스트 직선의 값.
      // 악기 프로파일이 있으면 그것을 뺀 잔차에서 추세를 구한다. 프로파일이 설명하는 굴곡은 결함이 아니다.
      // 가장자리에서는 창이 한쪽으로만 있지만, 직선은 기울기를 따로 맞추므로 한쪽으로 치우치지 않는다.
      const inst = this.instrument;
      const base = inst ? avg.map((db, i) => db - (inst[i] ?? 0)) : avg;
      target = base.slice();
      for (const i of activeIdx) {
        const here = Math.log2(this.centers[i] ?? 1);
        const near = activeIdx.filter((j) => Math.abs(Math.log2(this.centers[j] ?? 1) - here) <= smoothOctaves + 1e-9);
        target[i] = robustLineAt(
          near.map((j) => Math.log2(this.centers[j] ?? 1)),
          near.map((j) => base[j] ?? 0),
          here,
        );
      }
      if (inst) {
        // 잔차의 넓은 추세가 평탄해지도록(= 프로파일 모양이 되도록) 당긴다. 전체 음량은 건드리지 않게 중앙값을 뺀다.
        const medTrend = median(activeIdx.map((i) => target[i] ?? 0));
        pull = target.map((t) => -this.options.instrumentMatch * (t - medTrend));
        target = target.map((t, i) => t + (inst[i] ?? 0));
      }
      // 화면에서 보기 좋게 곡 전체 높이를 0dB 근처로 옮길 뿐, 보정량에는 영향이 없다.
      const levels = activeIdx.map((i) => avg[i] ?? 0);
      offset = levels.length ? -median(levels) : 0;
      target = target.map((db) => db + offset);
    }
    this.trendCurve = target.slice();
    this.alignedCurve = avg.map((db) => db + offset);
    const confidence = this.confidence();
    this.correctionCurve = this.alignedCurve.map((db, i) => {
      if (!active[i]) return 0;
      const dev = (target[i] ?? 0) - db + (pull?.[i] ?? 0);
      const raw = Math.sign(dev) * Math.max(0, Math.abs(dev) - deadbandDb);
      const clamped = Math.max(-maxCorrectionDb, Math.min(maxCorrectionDb, raw));
      return clamped * amount * confidence;
    });
  }
}
