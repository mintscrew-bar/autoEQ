// 악기별 기준 음색(프로파일)과 스펙트럼 모양으로 악기를 추정하는 함수.
// 웹 오디오와 무관한 순수 로직이라 JUCE로 옮길 때 그대로 기준 구현으로 쓴다.
//
// 주의: 아래 곡선은 녹음 자료로 측정한 값이 아니라 믹싱 일반론으로 손으로 그린 근사다(검증 전).
// 악기·마이킹·장르에 따라 크게 달라지므로 "정답"이 아니라 약한 사전 지식으로만 쓴다(AutoEq의 instrumentMatch).

export type InstrumentId = "vocal" | "kick" | "snare" | "bass" | "eguitar" | "aguitar" | "piano" | "cymbals" | "strings";

export interface InstrumentProfile {
  id: InstrumentId;
  name: string;
  /** 옥타브 밴드 에너지 기준의 [Hz, dB] 기준점. 평탄한 선은 핑크 노이즈(밴드당 같은 에너지)다. 모양만 의미가 있다 */
  anchors: readonly (readonly [number, number])[];
}

export const INSTRUMENTS: readonly InstrumentProfile[] = [
  { id: "vocal", name: "Vocal", anchors: [[60, -22], [100, -12], [200, -2], [400, 0], [800, 0], [1600, 0], [3000, 1], [5000, -3], [8000, -9], [12000, -16]] },
  { id: "kick", name: "Kick", anchors: [[30, -10], [60, 0], [100, -1], [200, -8], [400, -13], [1000, -15], [3000, -13], [8000, -20], [16000, -32]] },
  { id: "snare", name: "Snare", anchors: [[60, -18], [120, -6], [200, 0], [400, -2], [1000, -4], [2500, -1], [5000, -4], [10000, -10], [16000, -20]] },
  { id: "bass", name: "Bass", anchors: [[30, -8], [60, 0], [100, 0], [200, -2], [400, -9], [800, -17], [1600, -24], [4000, -34]] },
  { id: "eguitar", name: "Electric Guitar", anchors: [[60, -22], [120, -10], [250, -1], [500, 0], [1000, 0], [2500, 0], [4000, -3], [6000, -10], [10000, -20]] },
  { id: "aguitar", name: "Acoustic Guitar", anchors: [[60, -20], [120, -6], [250, 0], [500, -1], [1000, -3], [3000, -4], [6000, -9], [12000, -17]] },
  { id: "piano", name: "Piano", anchors: [[40, -16], [100, -5], [250, 0], [500, -1], [1000, -3], [2000, -7], [5000, -13], [10000, -21]] },
  { id: "cymbals", name: "Cymbals / Hi-hat", anchors: [[200, -34], [500, -26], [1000, -18], [3000, -8], [6000, 0], [10000, 0], [16000, -7]] },
  { id: "strings", name: "Strings / Pad", anchors: [[60, -16], [150, -2], [300, 0], [600, -2], [1500, -6], [4000, -13], [8000, -21]] },
];

export const instrumentById = (id: InstrumentId): InstrumentProfile => INSTRUMENTS.find((p) => p.id === id)!;

/** 기준점 사이를 로그 주파수에 대해 직선으로 잇는다. 양 끝 밖은 끝 값을 유지한다. */
export function octaveDb(anchors: InstrumentProfile["anchors"], hz: number): number {
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  if (hz <= first[0]) return first[1];
  if (hz >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [f1, d1] = anchors[i]!;
    if (hz <= f1) {
      const [f0, d0] = anchors[i - 1]!;
      return d0 + ((d1 - d0) * Math.log2(hz / f0)) / Math.log2(f1 / f0);
    }
  }
  return last[1];
}

/**
 * 밴드 중심 주파수별 목표(dB). 분석기와 같은 "빈 평균 전력" 영역이라서, 옥타브 밴드 에너지에서
 * 밴드 폭(주파수에 비례)만큼 -10log10(f)를 뺀다(핑크 노이즈가 밴드당 -3dB/oct로 보이는 이유).
 */
export function profileTarget(profile: InstrumentProfile, centers: readonly number[]): number[] {
  return centers.map((f) => octaveDb(profile.anchors, f) - 10 * Math.log10(f / 1000));
}

export interface InstrumentGuess {
  id: InstrumentId;
  /** 모양 차이(RMS dB, 전체 음량 차이는 뺌). 작을수록 닮았다 */
  distance: number;
}

export interface IdentifyResult {
  ranking: InstrumentGuess[];
  /** 1등과 2등의 차이(dB)와 1등의 절대 거리가 모두 충분할 때만 true */
  confident: boolean;
}

const IDENT_MIN_HZ = 60;
const IDENT_MAX_HZ = 12000;
/** 1등이 이보다 멀면 어느 악기와도 닮지 않은 것으로 본다(dB) */
const IDENT_MAX_DISTANCE = 5;
/** 1등과 2등의 차이가 이보다 작으면 확신하지 않는다(dB) */
const IDENT_MIN_MARGIN = 0.8;

/**
 * 평균 스펙트럼(밴드 중심별 dB)의 모양으로 악기를 추정한다. 모양만 보므로 비슷한 음색(어쿠스틱·일렉 기타, 피아노·스트링)은
 * 자주 헷갈린다. 확신이 없으면 confident=false이므로, 호출하는 쪽은 사용자가 고르게 하거나 악기 보정을 끄는 것이 안전하다.
 */
export function identifyInstrument(avg: readonly number[], centers: readonly number[]): IdentifyResult {
  const idx = centers.flatMap((f, i) => (f >= IDENT_MIN_HZ && f <= IDENT_MAX_HZ ? [i] : []));
  const ranking = INSTRUMENTS.map((p): InstrumentGuess => {
    const target = profileTarget(p, centers);
    const diffs = idx.map((i) => (avg[i] ?? 0) - (target[i] ?? 0));
    const sorted = [...diffs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const offset = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    const distance = Math.sqrt(diffs.reduce((s, d) => s + (d - offset) ** 2, 0) / Math.max(1, diffs.length));
    return { id: p.id, distance };
  }).sort((a, b) => a.distance - b.distance);
  const best = ranking[0]!;
  const second = ranking[1]!;
  return { ranking, confident: best.distance <= IDENT_MAX_DISTANCE && second.distance - best.distance >= IDENT_MIN_MARGIN };
}
