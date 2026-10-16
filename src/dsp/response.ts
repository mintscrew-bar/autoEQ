// 필터 체인의 주파수 응답. 화면에 EQ 곡선을 그리고, 실제로 얼마나 커지는지(헤드룸) 계산할 때 쓴다.
// 웹 오디오의 BiquadFilterNode와 같은 RBJ 공식(웹 오디오 사양)을 쓴다.

import type { DynSettings } from "./dynamics";

export type FilterType = "bell" | "lowshelf" | "highshelf" | "highpass" | "lowpass" | "notch";

export interface FilterSpec {
  /** 밴드 id. 엔진이 밴드를 같은 필터 슬롯에 계속 배정하는 데 쓴다 */
  id?: number;
  type: FilterType;
  /** 중심(또는 차단) 주파수(Hz) */
  freq: number;
  /** dB. bell·shelf에서만 의미가 있다 */
  gain: number;
  /** bell·highpass·lowpass·notch에서만 의미가 있다. shelf는 웹 오디오가 Q를 무시한다 */
  q: number;
  /** 다이나믹 EQ: 엔진이 이 밴드의 대역 레벨을 재야 한다 */
  dynamic?: boolean;
}

/** 사용자가 만든 EQ 밴드 */
export interface UserBand extends FilterSpec {
  id: number;
  enabled: boolean;
  /** 자동 보정이 만들고 움직이는 밴드. 사용자가 만지면 고정(false)된다 */
  auto?: boolean;
  /** 학습(LEARN)이 끝나며 고정된 밴드. 사용자가 만지면 내 밴드가 된다 */
  learned?: boolean;
  /** 다이나믹 EQ 설정. 켜면 대역 레벨에 따라 게인이 gain에서 gain+range 쪽으로 움직인다 */
  dyn?: DynSettings;
  /** 학습한 밴드의 100% 강도 게인. 강도 슬라이더가 이 값에 곱해 적용한다 */
  base?: number;
}

export const FILTER_LABELS: Record<FilterType, string> = {
  bell: "Bell",
  lowshelf: "Low Shelf",
  highshelf: "High Shelf",
  highpass: "High Pass",
  lowpass: "Low Pass",
  notch: "Notch",
};

export const hasGain = (type: FilterType): boolean => type === "bell" || type === "lowshelf" || type === "highshelf";
export const hasQ = (type: FilterType): boolean => type !== "lowshelf" && type !== "highshelf";

export function defaultQ(type: FilterType): number {
  if (type === "highpass" || type === "lowpass") return Math.SQRT1_2;
  if (type === "notch") return 8;
  return 1;
}

/** BiquadFilterNode.type 이름 */
export function webAudioType(type: FilterType): BiquadFilterType {
  return type === "bell" ? "peaking" : type;
}

/** BiquadFilterNode.Q에 넣을 값. 하이·로우패스의 Q는 웹 오디오에서 dB 단위다. */
export function webAudioQ(type: FilterType, q: number): number {
  return type === "highpass" || type === "lowpass" ? 20 * Math.log10(q) : q;
}

type Coeffs = readonly [number, number, number, number, number, number];

function coeffs(spec: FilterSpec, sampleRate: number): Coeffs {
  const w0 = (2 * Math.PI * spec.freq) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * spec.q);
  switch (spec.type) {
    case "bell": {
      const a = 10 ** (spec.gain / 40);
      return [1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a];
    }
    case "lowpass":
      return [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    case "highpass":
      return [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    case "notch":
      return [1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha];
    case "lowshelf":
    case "highshelf": {
      const a = 10 ** (spec.gain / 40);
      const beta = 2 * Math.sqrt(a) * (sin / 2) * Math.SQRT2; // 쉘프 기울기 S=1
      if (spec.type === "lowshelf") {
        return [
          a * (a + 1 - (a - 1) * cos + beta),
          2 * a * (a - 1 - (a + 1) * cos),
          a * (a + 1 - (a - 1) * cos - beta),
          a + 1 + (a - 1) * cos + beta,
          -2 * (a - 1 + (a + 1) * cos),
          a + 1 + (a - 1) * cos - beta,
        ];
      }
      return [
        a * (a + 1 + (a - 1) * cos + beta),
        -2 * a * (a - 1 + (a + 1) * cos),
        a * (a + 1 + (a - 1) * cos - beta),
        a + 1 - (a - 1) * cos + beta,
        2 * (a - 1 - (a + 1) * cos),
        a + 1 - (a - 1) * cos - beta,
      ];
    }
  }
}

/** 시간 영역에서 직접 필터를 걸 때 쓰는 정규화 계수 [b0, b1, b2, a1, a2] (a0 = 1) */
export function biquadCoeffs(spec: FilterSpec, sampleRate = 48000): [number, number, number, number, number] {
  const [b0, b1, b2, a0, a1, a2] = coeffs(spec, sampleRate);
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function magnitudeDb(c: Coeffs, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const mag2 = (k0: number, k1: number, k2: number) => {
    const re = k0 + k1 * c1 + k2 * c2;
    const im = -(k1 * s1 + k2 * s2);
    return re * re + im * im;
  };
  return 10 * Math.log10(mag2(c[0], c[1], c[2]) / mag2(c[3], c[4], c[5]));
}

/** 필터들을 직렬로 걸었을 때 freqs(Hz) 각 지점의 응답(dB) */
export function responseDb(specs: readonly FilterSpec[], freqs: readonly number[], sampleRate = 48000): number[] {
  const all = specs.map((s) => coeffs(s, sampleRate));
  return freqs.map((f) => all.reduce((sum, c) => sum + magnitudeDb(c, f, sampleRate), 0));
}

/** 20Hz~20kHz를 로그 간격으로 나눈 점들 */
export function logFreqs(count: number, minHz = 20, maxHz = 20000): number[] {
  return Array.from({ length: count }, (_, i) => minHz * (maxHz / minHz) ** (i / (count - 1)));
}

/** 응답이 0dB를 넘어 커지는 만큼(dB). 출력이 클리핑되지 않게 이만큼 줄이면 된다. */
export function headroomDb(specs: readonly FilterSpec[]): number {
  if (specs.length === 0) return 0;
  return Math.max(0, ...responseDb(specs, logFreqs(96)));
}
