// 자동 보정량 곡선(밴드 중심별 dB)을 EQ 밴드 몇 개로 바꾼다.
// 가장 크게 어긋난 곳부터 벨 하나를 놓고, 그 응답을 빼고 남은 어긋남으로 다음 밴드를 놓는 방식(매칭 추적)이다.
// 웹 오디오와 무관한 순수 로직이라 JUCE로 옮길 때 그대로 기준 구현으로 쓴다.

import { responseDb } from "./response";

export interface AutoBandFit {
  freq: number;
  gain: number;
  q: number;
}

export interface FitOptions {
  /** 놓을 수 있는 최대 밴드 수 */
  maxBands: number;
  /** 남은 어긋남이 이보다 작으면 멈춘다(dB) */
  minGainDb: number;
}

const MIN_BW_OCT = 0.5;
const MAX_BW_OCT = 4;

/** 폭 N옥타브 벨의 Q. sqrt(2^N) / (2^N - 1) */
export function qFromOctaves(octaves: number): number {
  const n = 2 ** octaves;
  return Math.sqrt(n) / (n - 1);
}

/** 피크에서 한쪽으로 가며 크기가 절반으로 떨어지는 지점까지의 로그 주파수(옥타브) 위치 */
function halfCrossing(
  logs: readonly number[],
  r: readonly number[],
  peak: number,
  dir: 1 | -1,
  stepOct: number,
): number {
  const sign = Math.sign(r[peak] ?? 0);
  const half = Math.abs(r[peak] ?? 0) / 2;
  let j = peak;
  while (true) {
    const next = j + dir;
    if (next < 0 || next >= r.length) return (logs[j] ?? 0) + dir * stepOct * 0.5;
    const v = Math.sign(r[next] ?? 0) === sign ? Math.abs(r[next] ?? 0) : 0;
    if (v < half) {
      const cur = Math.abs(r[j] ?? 0);
      const t = cur === v ? 0.5 : (cur - half) / (cur - v);
      return (logs[j] ?? 0) + t * ((logs[next] ?? 0) - (logs[j] ?? 0));
    }
    j = next;
  }
}

export function fitBands(
  centers: readonly number[],
  correction: readonly number[],
  options: FitOptions,
): AutoBandFit[] {
  const n = centers.length;
  if (n < 3) return [];
  const logs = centers.map((c) => Math.log2(c));
  const stepOct = ((logs[n - 1] ?? 0) - (logs[0] ?? 0)) / (n - 1);
  const residual = correction.slice();
  const fits: AutoBandFit[] = [];
  // 첫 밴드가 설명하고 남은 작은 찌꺼기에 밴드를 낭비하지 않도록, 가장 큰 어긋남의 40%도 하한으로 쓴다.
  const strongest = correction.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const stopDb = Math.max(options.minGainDb, strongest * 0.4);

  while (fits.length < options.maxBands) {
    let peak = 0;
    for (let i = 1; i < n; i++) if (Math.abs(residual[i] ?? 0) > Math.abs(residual[peak] ?? 0)) peak = i;
    const value = residual[peak] ?? 0;
    if (Math.abs(value) < stopDb) break;
    const sign = Math.sign(value);

    // 이웃과 포물선을 맞춰 센터 사이의 진짜 꼭짓점을 찾는다.
    let delta = 0;
    let vertex = Math.abs(value);
    if (peak > 0 && peak < n - 1) {
      const a = sign * (residual[peak - 1] ?? 0);
      const b = Math.abs(value);
      const c = sign * (residual[peak + 1] ?? 0);
      const denom = a - 2 * b + c;
      if (denom < 0) {
        delta = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
        vertex = b - 0.25 * (a - c) * delta;
      }
    }
    const logFreq = (logs[peak] ?? 0) + delta * stepOct;
    const bw = Math.max(
      MIN_BW_OCT,
      Math.min(MAX_BW_OCT, halfCrossing(logs, residual, peak, 1, stepOct) - halfCrossing(logs, residual, peak, -1, stepOct)),
    );
    const fit: AutoBandFit = {
      freq: 2 ** logFreq,
      gain: sign * Math.min(vertex, Math.abs(value) * 1.25),
      q: qFromOctaves(bw),
    };
    fits.push(fit);

    // 이 밴드가 이미 설명하는 만큼을 빼고 남은 어긋남으로 다음 밴드를 찾는다.
    const used = responseDb([{ type: "bell", freq: fit.freq, gain: fit.gain, q: fit.q }], centers);
    for (let i = 0; i < n; i++) residual[i] = (residual[i] ?? 0) - (used[i] ?? 0);
  }
  return fits.filter((f) => Math.abs(f.gain) >= options.minGainDb).sort((x, y) => x.freq - y.freq);
}
