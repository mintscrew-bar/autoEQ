// 테스트 전용: 시간 영역 신호로 분석 → 보정 → 재측정을 돌려 보는 도구. 앱 코드에서는 쓰지 않는다.

import { aggregateBins, type BandLayout } from "./bands";
import { biquadCoeffs, type FilterSpec } from "./response";

export const SAMPLE_RATE = 48000;
export const FFT_SIZE = 8192;

/** 재현 가능한 난수 (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 핑크 노이즈(Paul Kellet 근사). RMS를 rms로 맞춘다 */
export function pinkNoise(length: number, seed: number, rms = 0.1): Float64Array {
  const rand = rng(seed);
  const out = new Float64Array(length);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let energy = 0;
  for (let i = 0; i < length; i++) {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    out[i] = v;
    energy += v * v;
  }
  const gain = rms / Math.sqrt(energy / length);
  for (let i = 0; i < length; i++) out[i]! *= gain;
  return out;
}

/** 필터들을 직렬로 시간 영역 신호에 건다(전치 직접형 II) */
export function applyFilters(signal: Float64Array, specs: readonly FilterSpec[]): Float64Array {
  let x = signal;
  for (const spec of specs) {
    const [b0, b1, b2, a1, a2] = biquadCoeffs(spec, SAMPLE_RATE);
    const y = new Float64Array(x.length);
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i]!;
      const yi = b0 * xi + z1;
      z1 = b1 * xi - a1 * yi + z2;
      z2 = b2 * xi - a2 * yi;
      y[i] = yi;
    }
    x = y;
  }
  return x;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/**
 * 신호를 앱의 분석기처럼 프레임으로 잘라(한 프레임 FFT_SIZE, 절반씩 겹침) 밴드 레벨(dB)을 프레임마다 돌려준다.
 * Web Audio AnalyserNode와 같이 블랙만 창을 쓰고 dBFS로 낸다.
 */
export function bandFrames(signal: Float64Array, layout: BandLayout): number[][] {
  const hop = FFT_SIZE / 2;
  const win = Float64Array.from({ length: FFT_SIZE }, (_, i) => {
    const a = (2 * Math.PI * i) / FFT_SIZE;
    return 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
  });
  const norm = win.reduce((s, w) => s + w, 0);
  const frames: number[][] = [];
  for (let start = 0; start + FFT_SIZE <= signal.length; start += hop) {
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) re[i] = signal[start + i]! * win[i]!;
    fft(re, im);
    const bins = new Float32Array(FFT_SIZE / 2);
    for (let k = 0; k < bins.length; k++) {
      const mag = Math.hypot(re[k]!, im[k]!) / norm;
      bins[k] = 20 * Math.log10(Math.max(mag, 1e-12));
    }
    frames.push(aggregateBins(bins, SAMPLE_RATE, FFT_SIZE, layout));
  }
  return frames;
}

/** 프레임별 밴드 레벨의 dB 평균 (AutoEq의 누적 평균과 같은 방식) */
export function meanBands(frames: readonly number[][]): number[] {
  const n = frames[0]!.length;
  return Array.from({ length: n }, (_, b) => frames.reduce((s, f) => s + f[b]!, 0) / frames.length);
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * 기준(깨끗한 신호)과 비교한 모양 오차: 밴드별 차이에서 전체 음량 차이(중앙값)를 뺀 RMS(dB).
 * minHz~maxHz 안의 밴드만 본다.
 */
export function shapeError(
  levels: readonly number[],
  reference: readonly number[],
  centers: readonly number[],
  minHz: number,
  maxHz: number,
): number {
  const idx = centers.flatMap((f, i) => (f >= minHz && f <= maxHz ? [i] : []));
  const diffs = idx.map((i) => levels[i]! - reference[i]!);
  const off = median(diffs);
  return Math.sqrt(diffs.reduce((s, d) => s + (d - off) ** 2, 0) / diffs.length);
}
