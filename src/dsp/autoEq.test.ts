import { describe, expect, it } from "vitest";
import { AutoEq } from "./autoEq";
import { aggregateBins, makeBands } from "./bands";

const layout = makeBands();

/** 목표 곡선과 같은 모양에 임의의 음량 오프셋을 더한 입력 */
function targetShaped(eq: AutoEq, offsetDb: number): number[] {
  return eq.target().map((db) => db + offsetDb);
}

describe("makeBands", () => {
  it("40Hz에서 시작해 16kHz를 넘지 않는 로그 간격 밴드를 만든다", () => {
    expect(layout.centers[0]).toBeCloseTo(40);
    expect(layout.centers.at(-1)!).toBeLessThanOrEqual(16000);
    // 옥타브당 2밴드이면 인접 밴드 비가 2^(1/2)
    expect(layout.centers[1]! / layout.centers[0]!).toBeCloseTo(2 ** 0.5);
  });

  it("옥타브당 2밴드의 Q는 약 2.87이다", () => {
    expect(layout.q).toBeCloseTo(2.87, 1);
  });
});

describe("aggregateBins", () => {
  const sampleRate = 48000;
  const fftSize = 8192;
  const binCount = fftSize / 2;

  it("모든 빈이 같은 레벨이면 모든 밴드가 그 레벨이다", () => {
    const bins = new Float32Array(binCount).fill(-40);
    for (const db of aggregateBins(bins, sampleRate, fftSize, layout)) {
      expect(db).toBeCloseTo(-40, 3);
    }
  });

  it("1kHz 부근 빈만 높으면 1kHz 밴드가 가장 높다", () => {
    const bins = new Float32Array(binCount).fill(-80);
    const k = Math.round(1000 / (sampleRate / fftSize));
    bins[k] = -20;
    const out = aggregateBins(bins, sampleRate, fftSize, layout);
    const peak = out.indexOf(Math.max(...out));
    expect(layout.centers[peak]).toBeGreaterThan(900);
    expect(layout.centers[peak]).toBeLessThan(1150);
  });

  it("-Infinity가 섞여 있어도 NaN이 나오지 않는다", () => {
    const bins = new Float32Array(binCount).fill(-Infinity);
    bins[Math.round(1000 / (sampleRate / fftSize))] = -30;
    const out = aggregateBins(bins, sampleRate, fftSize, layout);
    expect(out.some(Number.isNaN)).toBe(false);
  });
});

describe("AutoEq", () => {
  it("입력이 목표 곡선과 같은 모양이면 음량과 상관없이 보정이 0이다", () => {
    const eq = new AutoEq(layout.centers);
    expect(eq.update(targetShaped(eq, -30), 0.05)).toBe(true);
    for (const c of eq.correction()) expect(Math.abs(c)).toBeLessThan(1e-9);

    const louder = new AutoEq(layout.centers);
    louder.update(targetShaped(louder, -10), 0.05);
    for (const c of louder.correction()) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it("한 밴드만 6dB 튀면 그 밴드만 깎고 나머지는 건드리지 않는다", () => {
    const eq = new AutoEq(layout.centers);
    const input = targetShaped(eq, -30);
    const hot = 8;
    input[hot] = input[hot]! + 6;
    eq.update(input, 0.05);
    eq.correction().forEach((c, i) => {
      if (i === hot) expect(c).toBeCloseTo(-6, 6);
      else expect(Math.abs(c)).toBeLessThan(1e-6);
    });
  });

  it("보정량은 maxCorrectionDb를 넘지 않는다", () => {
    const eq = new AutoEq(layout.centers, { maxCorrectionDb: 6 });
    const input = targetShaped(eq, -30);
    input[8] = input[8]! + 12;
    input[3] = input[3]! - 12;
    eq.update(input, 0.05);
    expect(eq.correction()[8]).toBeCloseTo(-6, 6);
    expect(eq.correction()[3]).toBeCloseTo(6, 6);
  });

  it("amount가 보정량에 비례해 곱해진다", () => {
    const eq = new AutoEq(layout.centers, { amount: 0.5 });
    const input = targetShaped(eq, -30);
    input[8] = input[8]! + 6;
    eq.update(input, 0.05);
    expect(eq.correction()[8]).toBeCloseTo(-3, 6);
  });

  it("옵션을 바꾸면 이미 학습한 평균으로 보정량을 다시 계산한다", () => {
    const eq = new AutoEq(layout.centers);
    const input = targetShaped(eq, -30);
    input[8] = input[8]! + 6;
    eq.update(input, 0.05);
    eq.setOptions({ amount: 0 });
    expect(eq.correction()[8]).toBeCloseTo(0, 9);
  });

  it("무음 프레임은 학습하지 않고 보정을 바꾸지 않는다", () => {
    const eq = new AutoEq(layout.centers);
    const silent = layout.centers.map(() => -120);
    expect(eq.update(silent, 0.05)).toBe(false);
    expect(eq.correction().every((c) => c === 0)).toBe(true);
  });

  it("-Infinity 밴드가 섞여도 NaN을 만들지 않는다", () => {
    const eq = new AutoEq(layout.centers);
    const input = targetShaped(eq, -30);
    input[0] = -Infinity;
    eq.update(input, 0.05);
    expect(eq.correction().some(Number.isNaN)).toBe(false);
  });

  it("평균은 시정수에 따라 새 입력으로 서서히 옮겨 간다", () => {
    const eq = new AutoEq(layout.centers, { averageSeconds: 1 });
    eq.update(targetShaped(eq, -30), 0.05);
    const bumped = targetShaped(eq, -30);
    bumped[8] = bumped[8]! + 6;

    // 0.05초 뒤에는 거의 반영되지 않고, 충분히 지나면 거의 완전히 반영된다.
    eq.update(bumped, 0.05);
    const early = eq.correction()[8]!;
    for (let i = 0; i < 200; i++) eq.update(bumped, 0.05);
    const late = eq.correction()[8]!;

    expect(Math.abs(early)).toBeLessThan(1);
    expect(late).toBeCloseTo(-6, 1);
  });

  it("reset하면 보정이 0으로 돌아간다", () => {
    const eq = new AutoEq(layout.centers);
    const input = targetShaped(eq, -30);
    input[8] = input[8]! + 6;
    eq.update(input, 0.05);
    eq.reset();
    expect(eq.correction().every((c) => c === 0)).toBe(true);
  });

  it("밴드 수가 다른 입력은 거부한다", () => {
    const eq = new AutoEq(layout.centers);
    expect(() => eq.update([-30, -30], 0.05)).toThrow();
  });
});
