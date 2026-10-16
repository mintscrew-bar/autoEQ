// 닫힌 루프 검증: 알려진 결함을 넣은 핑크 노이즈를 앱과 같은 경로(FFT → 밴드 → AutoEq → fitBands)로 분석해
// 만든 필터를 시간 영역에서 실제로 걸고, 다시 측정해 "깨끗한 원본"과의 모양 차이가 줄었는지 본다.
import { describe, expect, it } from "vitest";
import { AutoEq, type AutoEqOptions } from "./autoEq";
import { fitBands } from "./autoBands";
import { makeBands } from "./bands";
import type { FilterSpec } from "./response";
import { applyFilters, bandFrames, meanBands, pinkNoise, shapeError, SAMPLE_RATE, FFT_SIZE } from "./testkit";

const layout = makeBands();
const SECONDS = 16;
const HOP_SECONDS = FFT_SIZE / 2 / SAMPLE_RATE;
const MIN_HZ = 50;
const MAX_HZ = 8000;

const bell = (freq: number, gain: number, q: number): FilterSpec => ({ type: "bell", freq, gain, q });
const lowshelf = (freq: number, gain: number): FilterSpec => ({ type: "lowshelf", freq, gain, q: 0.7 });
const highshelf = (freq: number, gain: number): FilterSpec => ({ type: "highshelf", freq, gain, q: 0.7 });

interface Result {
  before: number;
  after: number;
  fits: FilterSpec[];
}

function run(clean: FilterSpec[], flaws: FilterSpec[], seed = 1, seconds = SECONDS, options: Partial<AutoEqOptions> = {}): Result {
  const reference = applyFilters(pinkNoise(seconds * SAMPLE_RATE, seed), clean);
  const flawed = applyFilters(reference, flaws);
  const refLevels = meanBands(bandFrames(reference, layout));

  const frames = bandFrames(flawed, layout);
  const eq = new AutoEq(layout.centers, options);
  for (const f of frames) expect(eq.update(f, HOP_SECONDS)).toBe(true);
  const fits = fitBands(layout.centers, eq.correction(), { maxBands: 8, minGainDb: 0.5 }).map(
    (f): FilterSpec => ({ type: "bell", ...f }),
  );

  const corrected = applyFilters(flawed, fits);
  const err = (signal: Float64Array) => shapeError(meanBands(bandFrames(signal, layout)), refLevels, layout.centers, MIN_HZ, MAX_HZ);
  return { before: err(flawed), after: err(corrected), fits };
}

const summary: string[] = [];
function report(name: string, r: Result): void {
  const fits = r.fits.map((f) => `${Math.round(f.freq)}Hz ${f.gain.toFixed(1)}dB`).join(", ") || "-";
  summary.push(`${name.padEnd(28)} 오차 ${r.before.toFixed(2)} → ${r.after.toFixed(2)} dB   [${fits}]`);
}

describe("닫힌 루프: 결함을 넣은 신호를 보정하면 원본 모양에 가까워진다", () => {
  // improves=true: 기울기만 있는 매끈한 스펙트럼이거나 결함이 뚜렷해서 보정이 오차를 눈에 띄게 줄이는 경우.
  // improves=false: 보컬 프레즌스 불룩·쉘프처럼 넓게 휘어진 스펙트럼. 로컬 추세 방식은 휘어진 곡선과 결함을 구분하지 못해
  // 개선도 거의 없고 오탐도 섞인다(NOTES.md의 알려진 한계). 여기서는 "크게 나빠지지 않음"만 보장한다.
  const cases: { name: string; clean: FilterSpec[]; flaws: FilterSpec[]; improves: boolean }[] = [
    { name: "플랫 + 공명 2곳", clean: [], flaws: [bell(250, 3, 4), bell(3000, -3, 4)], improves: true },
    { name: "보컬(프레즌스 불룩) + 공명", clean: [bell(3000, 5, 0.5), bell(200, 3, 0.7)], flaws: [bell(400, 3, 5), bell(5000, 3, 6)], improves: false },
    { name: "저역 강조 + 공명", clean: [lowshelf(150, 8)], flaws: [bell(90, 3, 5), bell(1200, -2.5, 4)], improves: false },
    { name: "어두운 곡 + 중역 공명", clean: [highshelf(4000, -10)], flaws: [bell(700, 3, 5)], improves: false },
    { name: "밝은 곡 + 저중역 공명", clean: [highshelf(3000, 6), lowshelf(200, -4)], flaws: [bell(160, 3, 4)], improves: true },
  ];

  for (const c of cases) {
    it(`${c.name}`, () => {
      const r = run(c.clean, c.flaws);
      report(c.name, r);
      if (c.improves) expect(r.after).toBeLessThan(r.before * 0.8);
      else expect(r.after).toBeLessThanOrEqual(r.before * 1.25);
    });
  }

  it("보정 한도(±3dB)를 넘는 결함은 한도만큼만 줄이고 과보정하지 않는다", () => {
    const r = run([], [bell(1000, 8, 5)]);
    report("큰 결함 +8dB", r);
    expect(r.after).toBeLessThan(r.before);
    expect(r.fits.every((f) => Math.abs(f.gain) <= 3 * 1.25 + 1e-9)).toBe(true);
  });

  it("결함이 없는 곡을 0.5dB 넘게 바꾸지 않는다(오탐 한도)", () => {
    const shapes: [string, FilterSpec[]][] = [
      ["플랫", []],
      ["보컬형", [bell(3000, 5, 0.5), bell(200, 3, 0.7)]],
      ["저역 강조", [lowshelf(150, 8)]],
      ["어두운 곡", [highshelf(4000, -10)]],
    ];
    for (const [name, clean] of shapes) {
      const r = run(clean, [], 7);
      report(`결함 없음: ${name}`, r);
      expect(r.after).toBeLessThanOrEqual(0.5);
    }
  });

  it("다른 노이즈로 다시 해도 결과가 비슷하다(표본에 의존하지 않는다)", () => {
    const rs = [11, 12, 13].map((seed) => run([], [bell(250, 3, 4), bell(3000, -3, 4)], seed));
    const ratios = rs.map((r) => r.after / r.before);
    report("재현성(seed 11)", rs[0]!);
    expect(Math.max(...ratios)).toBeLessThan(0.8);
  });

  it("요약 출력", () => {
    (globalThis as unknown as { process: { stderr: { write(s: string): void } } }).process.stderr.write(`\n${summary.join("\n")}\n`);
  });
});
