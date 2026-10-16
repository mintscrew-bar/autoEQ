// 다이나믹 EQ: 밴드의 주파수 대역 레벨이 문턱값을 넘으면(또는 못 미치면) 그 밴드의 게인이 range만큼 움직인다.
// 웹 오디오와 무관한 순수 로직이라 JUCE로 옮길 때 그대로 기준 구현으로 쓴다.

export type DynMode = "above" | "below";

export interface DynSettings {
  enabled: boolean;
  /** 대역 레벨(dB)이 이 값을 기준으로 켜지고 꺼진다 */
  threshold: number;
  /** 완전히 작동했을 때 게인이 움직이는 양(dB). 음수는 깎고 양수는 올린다 */
  range: number;
  /** 작동하기 시작하는 시간(ms) */
  attack: number;
  /** 작동이 풀리는 시간(ms) */
  release: number;
  /** above: 문턱값을 넘으면 작동(컴프레서처럼), below: 못 미치면 작동(익스팬더처럼) */
  mode: DynMode;
}

export const DEFAULT_DYN: DynSettings = {
  enabled: false,
  threshold: -40,
  range: -6,
  attack: 10,
  release: 150,
  mode: "above",
};

/** 문턱값 주변에서 작동이 서서히 시작되는 폭(dB). 너무 딱 끊기면 게인이 덜컥거린다. */
export const KNEE_DB = 6;

/** 미터와 그래프의 레벨 게이지가 보여 주는 범위(dB) */
export const METER_MIN_DB = -80;
export const METER_MAX_DB = 0;

export const MIN_THRESHOLD = -90;
export const MAX_THRESHOLD = 0;
export const MAX_RANGE = 18;

/** 대역 레벨에서 작동 정도 0~1(소프트니). 문턱값에서 0.5, 절반 폭 위·아래에서 각각 1과 0 */
export function dynamicTarget(levelDb: number, s: Pick<DynSettings, "threshold" | "mode">): number {
  const x = s.mode === "above" ? levelDb - (s.threshold - KNEE_DB / 2) : s.threshold + KNEE_DB / 2 - levelDb;
  return Math.max(0, Math.min(1, x / KNEE_DB));
}

/** 작동 정도를 목표 쪽으로 옮긴다. 커질 때는 attack, 작아질 때는 release 시간 규모로 따라간다. */
export function smoothAmount(prev: number, target: number, dtSeconds: number, attackMs: number, releaseMs: number): number {
  const ms = target > prev ? attackMs : releaseMs;
  const alpha = 1 - Math.exp(-dtSeconds / Math.max(0.001, ms / 1000));
  return prev + (target - prev) * alpha;
}

/** 밴드의 실제 게인 = 정해 둔 게인 + range × 작동 정도 */
export function effectiveGain(base: number, s: Pick<DynSettings, "range">, amount: number): number {
  return base + s.range * amount;
}

/** 시간 영역 샘플의 RMS를 dB로. 무음은 바닥값 */
export function rmsDb(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] ?? 0) ** 2;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return Math.max(-100, 20 * Math.log10(rms + 1e-9));
}
