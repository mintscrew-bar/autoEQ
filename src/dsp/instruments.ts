// 악기별 기준 음색(프로파일)과 스펙트럼 모양으로 악기를 추정하는 함수.
// 웹 오디오와 무관한 순수 로직이라 JUCE로 옮길 때 그대로 기준 구현으로 쓴다.
//
// 주의: 아래 곡선은 녹음 자료로 측정한 값이 아니라 믹싱 일반론으로 손으로 그린 근사다(검증 전).
// 악기·마이킹·장르에 따라 크게 달라지므로 "정답"이 아니라 약한 사전 지식으로만 쓴다(AutoEq의 instrumentMatch).

export type InstrumentId =
  | "vocal"
  | "guitar"
  | "eguitar"
  | "aguitar"
  | "bass"
  | "drums"
  | "kick"
  | "snare"
  | "cymbals"
  | "piano"
  | "strings";

/** 악기 묶음. Auto 판별은 묶음 단위로 확신 여부를 정한다(비슷한 악기끼리의 헷갈림은 묶음 안에서만 일어나게) */
export type InstrumentCategory = "vocal" | "guitar" | "bass" | "drums" | "keys" | "strings";

export const CATEGORY_NAMES: Record<InstrumentCategory, string> = {
  vocal: "Vocal",
  guitar: "Guitar",
  bass: "Bass",
  drums: "Drums",
  keys: "Keys",
  strings: "Strings / Pad",
};

export interface InstrumentProfile {
  id: InstrumentId;
  name: string;
  category: InstrumentCategory;
  /** 묶음 전체를 아우르는 프로파일(기타 통합, 드럼 킷 버스) */
  generic?: boolean;
  /** 옥타브 밴드 에너지 기준의 [Hz, dB] 기준점. 평탄한 선은 핑크 노이즈(밴드당 같은 에너지)다. 모양만 의미가 있다 */
  anchors: readonly (readonly [number, number])[];
}

export const INSTRUMENTS: readonly InstrumentProfile[] = [
  { id: "vocal", name: "Vocal", category: "vocal", anchors: [[60, -22], [100, -12], [200, -2], [400, 0], [800, 0], [1600, 0], [3000, 1], [5000, -3], [8000, -9], [12000, -16]] },
  { id: "guitar", name: "Guitar (any)", category: "guitar", generic: true, anchors: [[60, -21], [120, -8], [250, -0.5], [500, -0.5], [1000, -1.5], [2500, -2], [4000, -3.5], [6000, -9.5], [10000, -18.5]] },
  { id: "eguitar", name: "Electric Guitar", category: "guitar", anchors: [[60, -22], [120, -10], [250, -1], [500, 0], [1000, 0], [2500, 0], [4000, -3], [6000, -10], [10000, -20]] },
  { id: "aguitar", name: "Acoustic Guitar", category: "guitar", anchors: [[60, -20], [120, -6], [250, 0], [500, -1], [1000, -3], [3000, -4], [6000, -9], [12000, -17]] },
  { id: "bass", name: "Bass", category: "bass", anchors: [[30, -8], [60, 0], [100, 0], [200, -2], [400, -9], [800, -17], [1600, -24], [4000, -34]] },
  { id: "drums", name: "Drums (full kit)", category: "drums", generic: true, anchors: [[40, -6], [60, 0], [100, -1], [200, -3], [400, -8], [1000, -9], [3000, -6], [6000, -4], [10000, -6], [16000, -14]] },
  { id: "kick", name: "Kick", category: "drums", anchors: [[30, -10], [60, 0], [100, -1], [200, -8], [400, -13], [1000, -15], [3000, -13], [8000, -20], [16000, -32]] },
  { id: "snare", name: "Snare", category: "drums", anchors: [[60, -18], [120, -6], [200, 0], [400, -2], [1000, -4], [2500, -1], [5000, -4], [10000, -10], [16000, -20]] },
  { id: "cymbals", name: "Cymbals / Hi-hat", category: "drums", anchors: [[200, -34], [500, -26], [1000, -18], [3000, -8], [6000, 0], [10000, 0], [16000, -7]] },
  { id: "piano", name: "Piano", category: "keys", anchors: [[40, -16], [100, -5], [250, 0], [500, -1], [1000, -3], [2000, -7], [5000, -13], [10000, -21]] },
  { id: "strings", name: "Strings / Pad", category: "strings", anchors: [[60, -16], [150, -2], [300, 0], [600, -2], [1500, -6], [4000, -13], [8000, -21]] },
];

// 음악 스타일(장르)별로 프로파일 위에 얹는 작은 보정(dB). 장르별 실제 녹음으로 구한 값이 아니라 일반론에서 추정한 값이라
// 근거가 약하다(검증 전). 크기를 ±3dB 안으로 제한하고 기본은 none이다.
export type StyleId = "none" | "rock" | "pop" | "hiphop" | "edm" | "jazz" | "acoustic";

export const STYLES: readonly { id: StyleId; name: string; anchors: readonly (readonly [number, number])[] }[] = [
  { id: "none", name: "None", anchors: [[20, 0], [20000, 0]] },
  { id: "rock", name: "Rock", anchors: [[60, 0], [120, 1], [250, 0], [1000, 1], [3000, 2], [8000, 0], [16000, -2]] },
  { id: "pop", name: "Pop", anchors: [[60, 0], [200, 0], [1000, 0], [5000, 1.5], [12000, 2]] },
  { id: "hiphop", name: "Hip-hop", anchors: [[40, 3], [80, 3], [200, 0], [1000, 0], [5000, 0], [12000, -1]] },
  { id: "edm", name: "EDM", anchors: [[40, 3], [80, 2], [250, -1], [1000, 0], [6000, 2], [14000, 3]] },
  { id: "jazz", name: "Jazz", anchors: [[60, 0], [200, 1], [1000, 0], [5000, -1.5], [12000, -3]] },
  { id: "acoustic", name: "Acoustic / Folk", anchors: [[60, -1], [200, 1], [1000, 0], [4000, 1], [10000, 0]] },
];

export const styleById = (id: StyleId) => STYLES.find((s) => s.id === id)!;

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
export function profileTarget(profile: InstrumentProfile, centers: readonly number[], style: StyleId = "none"): number[] {
  const delta = styleById(style).anchors;
  return centers.map((f) => octaveDb(profile.anchors, f) + octaveDb(delta, f) - 10 * Math.log10(f / 1000));
}

export interface InstrumentGuess {
  id: InstrumentId;
  /** 모양 차이(RMS dB, 전체 음량 차이는 뺌). 작을수록 닮았다 */
  distance: number;
}

export interface CategoryGuess {
  category: InstrumentCategory;
  /** 이 묶음에서 가장 닮은 프로파일 */
  best: InstrumentId;
  distance: number;
}

export interface IdentifyResult {
  /** 프로파일별 순위 */
  ranking: InstrumentGuess[];
  /** 묶음별 순위(묶음 안에서 가장 닮은 프로파일의 거리) */
  categories: CategoryGuess[];
  /** 1등 묶음의 거리와, 1등·2등 묶음의 차이가 모두 충분할 때만 true */
  confident: boolean;
  /** confident일 때 적용할 프로파일(1등 묶음 안에서 가장 닮은 것). 아니면 null */
  applied: InstrumentId | null;
}

const IDENT_MIN_HZ = 60;
const IDENT_MAX_HZ = 12000;
/** 1등이 이보다 멀면 어느 악기와도 닮지 않은 것으로 본다(dB) */
const IDENT_MAX_DISTANCE = 5;
/** 1등 묶음과 2등 묶음의 차이가 이보다 작으면 확신하지 않는다(dB) */
const IDENT_MIN_MARGIN = 0.8;

/**
 * 평균 스펙트럼(밴드 중심별 dB)의 모양으로 악기를 추정한다. 모양만 보므로 비슷한 음색은 자주 헷갈린다.
 * 같은 묶음(예: 일렉·어쿠스틱 기타, 킥·킷 버스) 안의 헷갈림은 확신 여부에 영향을 주지 않고, 묶음끼리 구분될 때만 확신한다.
 * 확신이 없으면 applied=null이므로, 호출하는 쪽은 사용자가 고르게 하거나 악기 보정을 끄는 것이 안전하다.
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

  const categories: CategoryGuess[] = [];
  for (const g of ranking) {
    const category = instrumentById(g.id).category;
    if (!categories.some((c) => c.category === category)) categories.push({ category, best: g.id, distance: g.distance });
  }
  const best = categories[0]!;
  const second = categories[1];
  const confident = best.distance <= IDENT_MAX_DISTANCE && (!second || second.distance - best.distance >= IDENT_MIN_MARGIN);
  return { ranking, categories, confident, applied: confident ? best.best : null };
}
