import { describe, expect, it } from "vitest";
import { AutoEq } from "./autoEq";
import { aggregateBins, makeBands } from "./bands";

const layout = makeBands();
/** 신뢰도 램프를 끈 설정: 기존 테스트는 짧은 입력에서도 완전한 보정량을 기대한다 */
const INSTANT = { confidenceSeconds: 0 };

/** 로그 주파수에 대해 직선인 입력(옥타브당 slope dB)에 음량 오프셋을 더한 것 */
function line(slope: number, offsetDb: number): number[] {
  return layout.centers.map((f) => slope * Math.log2(f / 1000) + offsetDb);
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
  it("기울기가 어떻든 매끈한 직선이면 음량과 상관없이 보정이 0이다", () => {
    for (const slope of [-6, -3, 0, 2]) {
      const eq = new AutoEq(layout.centers, INSTANT);
      expect(eq.update(line(slope, -30), 0.05)).toBe(true);
      for (const c of eq.correction()) expect(Math.abs(c)).toBeLessThan(1e-9);
    }
  });

  it("한 밴드만 6dB 튀면 그 밴드를 깎고, 멀리 떨어진 밴드는 건드리지 않는다", () => {
    const eq = new AutoEq(layout.centers, { ...INSTANT, maxCorrectionDb: 6 });
    const input = line(-4, -30);
    const hot = 8;
    input[hot] = input[hot]! + 6;
    eq.update(input, 0.05);
    const c = eq.correction();
    expect(c[hot]).toBeLessThan(-3);
    expect(c[hot]).toBeGreaterThanOrEqual(-6);
    // 창(±1.5옥타브 = 3밴드)에 튀는 밴드가 들어오지 않는 밴드
    for (const i of [1, 2, 3, 4, 12, 13, 14]) expect(Math.abs(c[i]!)).toBeLessThan(1e-9);
  });

  it("곡의 넓은 기울기는 그대로 두고 좁은 굴곡만 다룬다", () => {
    const eq = new AutoEq(layout.centers, { ...INSTANT, maxCorrectionDb: 12 });
    const input = line(-6, -30);
    input[8] = input[8]! + 6;
    eq.update(input, 0.05);
    // 가파른 -6dB/oct 곡이어도 튀는 곳 외에는 거의 움직이지 않는다
    eq.correction().forEach((c, i) => {
      if (Math.abs(i - 8) > 3) expect(Math.abs(c)).toBeLessThan(1e-9);
      else expect(Math.abs(c)).toBeLessThan(7);
    });
  });

  it("보정량은 maxCorrectionDb를 넘지 않는다", () => {
    const eq = new AutoEq(layout.centers, { ...INSTANT, maxCorrectionDb: 6 });
    const input = line(-3, -30);
    input[8] = input[8]! + 20;
    input[3] = input[3]! - 20;
    eq.update(input, 0.05);
    expect(eq.correction()[8]).toBeCloseTo(-6, 6);
    expect(eq.correction()[3]).toBeCloseTo(6, 6);
  });

  it("기본 최대 보정량은 3dB다", () => {
    const eq = new AutoEq(layout.centers, INSTANT);
    const input = line(-3, -30);
    input[8] = input[8]! + 20;
    eq.update(input, 0.05);
    expect(eq.correction()[8]).toBeCloseTo(-3, 6);
  });

  it("amount가 보정량에 비례해 곱해진다", () => {
    const input = line(-3, -30);
    input[8] = input[8]! + 6;
    const full = new AutoEq(layout.centers, { ...INSTANT, maxCorrectionDb: 6 });
    full.update(input, 0.05);
    const half = new AutoEq(layout.centers, { ...INSTANT, maxCorrectionDb: 6, amount: 0.5 });
    half.update(input, 0.05);
    expect(half.correction()[8]).toBeCloseTo(full.correction()[8]! * 0.5, 9);
  });

  it("smoothOctaves가 좁으면 더 좁은 굴곡까지만 본다", () => {
    // 넓게 불룩한 곡(3밴드 폭의 둔덕)은 창이 좁으면 추세로 보고 건드리지 않는다
    const bump = line(-3, -30);
    for (const i of [7, 8, 9]) bump[i] = bump[i]! + 6;
    const narrow = new AutoEq(layout.centers, { ...INSTANT, smoothOctaves: 0.5, maxCorrectionDb: 6 });
    narrow.update(bump, 0.05);
    const wide = new AutoEq(layout.centers, { ...INSTANT, smoothOctaves: 1.5, maxCorrectionDb: 6 });
    wide.update(bump, 0.05);
    expect(Math.abs(narrow.correction()[8]!)).toBeLessThan(Math.abs(wide.correction()[8]!));
  });

  it("옵션을 바꾸면 이미 학습한 평균으로 보정량을 다시 계산한다", () => {
    const eq = new AutoEq(layout.centers, { ...INSTANT, maxCorrectionDb: 6 });
    const input = line(-3, -30);
    input[8] = input[8]! + 6;
    eq.update(input, 0.05);
    expect(eq.correction()[8]).toBeLessThan(-1);
    eq.setOptions({ amount: 0 });
    expect(eq.correction()[8]).toBeCloseTo(0, 9);
  });

  it("무음 프레임은 학습하지 않고 보정을 바꾸지 않는다", () => {
    const eq = new AutoEq(layout.centers, INSTANT);
    const silent = layout.centers.map(() => -120);
    expect(eq.update(silent, 0.05)).toBe(false);
    expect(eq.correction().every((c) => c === 0)).toBe(true);
  });

  it("-Infinity 밴드가 섞여도 NaN을 만들지 않는다", () => {
    const eq = new AutoEq(layout.centers, INSTANT);
    const input = line(-3, -30);
    input[0] = -Infinity;
    eq.update(input, 0.05);
    expect(eq.correction().some(Number.isNaN)).toBe(false);
    expect(eq.target().some(Number.isNaN)).toBe(false);
  });

  it("평균은 시정수에 따라 새 입력으로 서서히 옮겨 간다", () => {
    const eq = new AutoEq(layout.centers, { ...INSTANT, averageSeconds: 1, maxCorrectionDb: 6 });
    eq.update(line(-3, -30), 0.05);
    const bumped = line(-3, -30);
    bumped[8] = bumped[8]! + 6;

    // 0.05초 뒤에는 거의 반영되지 않고, 충분히 지나면 거의 완전히 반영된다.
    eq.update(bumped, 0.05);
    const early = eq.correction()[8]!;
    for (let i = 0; i < 200; i++) eq.update(bumped, 0.05);
    const late = eq.correction()[8]!;

    expect(Math.abs(early)).toBeLessThan(1);
    expect(late).toBeLessThan(-3);
  });

  it("학습 중에는 시작한 뒤 들어온 프레임 전체의 평균을 쓴다", () => {
    const eq = new AutoEq(layout.centers, { ...INSTANT, averageSeconds: 0.5, maxCorrectionDb: 12 });
    eq.beginLearning();
    const base = line(-3, -30);
    const bumped = line(-3, -30);
    bumped[8] = bumped[8]! + 8;
    // 같은 시간만큼 평평한 입력과 튀는 입력을 번갈아 먹이면 평균은 정확히 절반만 튄다.
    for (let i = 0; i < 100; i++) eq.update(base, 0.05);
    for (let i = 0; i < 100; i++) eq.update(bumped, 0.05);
    expect(eq.aligned()[8]! - eq.aligned()[7]! - (base[8]! - base[7]!)).toBeCloseTo(4, 1);
  });

  it("학습을 끝내면 평균이 그대로 남고, 다시 시작하면 비워진다", () => {
    const eq = new AutoEq(layout.centers, INSTANT);
    eq.beginLearning();
    const input = line(-3, -30);
    input[8] = input[8]! + 6;
    eq.update(input, 0.05);
    eq.endLearning();
    expect(eq.hasData()).toBe(true);
    eq.beginLearning();
    expect(eq.hasData()).toBe(false);
  });

  it("reset하면 보정이 0으로 돌아간다", () => {
    const eq = new AutoEq(layout.centers, INSTANT);
    const input = line(-3, -30);
    input[8] = input[8]! + 6;
    eq.update(input, 0.05);
    eq.reset();
    expect(eq.correction().every((c) => c === 0)).toBe(true);
  });

  it("학습한 목표와 같은 모양이면 직선이 아니어도 보정이 0이다", () => {
    const eq = new AutoEq(layout.centers, INSTANT);
    // 중역이 불룩한 곡선
    const bulge = layout.centers.map((f) => -4 * Math.abs(Math.log2(f / 1000)) + 10);
    eq.update(bulge, 0.05);
    expect(eq.learnTarget()).toBe(true);
    expect(eq.correction().every((c) => Math.abs(c) < 1e-9)).toBe(true);
    eq.reset();
    eq.update(bulge.map((db) => db - 20), 0.05);
    expect(eq.correction().every((c) => Math.abs(c) < 1e-9)).toBe(true);
  });

  it("clearTarget하면 곡 자신의 추세 목표로 돌아간다", () => {
    const eq = new AutoEq(layout.centers, INSTANT);
    eq.update(layout.centers.map((f) => -4 * Math.abs(Math.log2(f / 1000))), 0.05);
    eq.learnTarget();
    const learned = eq.target();
    eq.clearTarget();
    expect(eq.hasLearnedTarget()).toBe(false);
    expect(eq.target()).not.toEqual(learned);
  });

  it("학습한 평균이 없으면 learnTarget은 false다", () => {
    expect(new AutoEq(layout.centers, INSTANT).learnTarget()).toBe(false);
  });

  it("minHz~maxHz 밖 밴드는 보정하지 않고 추세 계산에도 쓰지 않는다", () => {
    const eq = new AutoEq(layout.centers, { ...INSTANT, minHz: 100, maxHz: 5000, maxCorrectionDb: 6 });
    const input = line(-3, -30);
    // 고역이 통째로 비어 있는 곡(MP3 고역 컷)을 흉내 낸다
    layout.centers.forEach((f, i) => {
      if (f > 8000) input[i] = input[i]! - 40;
    });
    eq.update(input, 0.05);
    layout.centers.forEach((f, i) => {
      const c = eq.correction()[i]!;
      if (f < 100 || f > 5000) expect(c).toBe(0);
      else expect(Math.abs(c)).toBeLessThan(1e-9);
    });
  });

  it("밴드 수가 다른 입력은 거부한다", () => {
    const eq = new AutoEq(layout.centers, INSTANT);
    expect(() => eq.update([0, 0, 0], 0.05)).toThrow();
  });
});

describe("AutoEq 신뢰도", () => {
  const bumpy = () => {
    const input = line(-3, 0);
    input[8] = input[8]! + 20;
    return input;
  };

  it("분석 시간이 짧으면 보정이 약하고, confidenceSeconds가 지나면 완전하다", () => {
    const eq = new AutoEq(layout.centers, { confidenceSeconds: 8 });
    const at = (seconds: number) => {
      eq.reset();
      for (let t = 0; t < seconds; t += 0.1) eq.update(bumpy(), 0.1);
      return eq.correction()[8]!;
    };
    expect(at(2)).toBeCloseTo(-3 * 0.25, 1);
    expect(at(4)).toBeCloseTo(-3 * 0.5, 1);
    expect(at(8)).toBeCloseTo(-3, 1);
    expect(at(20)).toBeCloseTo(-3, 1);
  });

  it("confidenceSeconds가 0이면 첫 프레임부터 완전한 보정이다", () => {
    const eq = new AutoEq(layout.centers, { confidenceSeconds: 0 });
    eq.update(bumpy(), 0.05);
    expect(eq.confidence()).toBe(1);
    expect(eq.correction()[8]).toBeCloseTo(-3, 6);
  });

  it("reset하면 신뢰도도 다시 0부터 쌓인다", () => {
    const eq = new AutoEq(layout.centers, { confidenceSeconds: 8 });
    for (let t = 0; t < 10; t += 0.1) eq.update(bumpy(), 0.1);
    expect(eq.confidence()).toBe(1);
    eq.reset();
    eq.update(bumpy(), 0.1);
    expect(eq.confidence()).toBeLessThan(0.05);
  });
});

describe("AutoEq 기울어진 스펙트럼", () => {
  it("-6dB/oct로 기운 곡에서도 튀는 밴드의 보정이 기울기 한 칸만큼 사라지지 않는다", () => {
    const eq = new AutoEq(layout.centers, { confidenceSeconds: 0, deadbandDb: 0 });
    const input = line(-6, 0); // 밴드 간격이 반 옥타브라 한 칸에 3dB씩 내려간다
    input[8] = input[8]! + 2;
    eq.update(input, 0.05);
    // 중앙값 추세였다면 이웃 값(한 칸 = 3dB 차이)이 추세로 잡혀 보정이 거의 0이었다.
    expect(eq.correction()[8]).toBeCloseTo(-2, 1);
  });

  it("deadbandDb 이내의 어긋남은 건드리지 않고, 넘는 만큼만 보정한다", () => {
    const eq = new AutoEq(layout.centers, { confidenceSeconds: 0, deadbandDb: 0.5 });
    const input = line(-3, 0);
    input[8] = input[8]! + 0.4;
    eq.update(input, 0.05);
    expect(eq.correction()[8]).toBeCloseTo(0, 6);
    const big = line(-3, 0);
    big[8] = big[8]! + 2;
    const eq2 = new AutoEq(layout.centers, { confidenceSeconds: 0, deadbandDb: 0.5 });
    eq2.update(big, 0.05);
    expect(eq2.correction()[8]).toBeCloseTo(-1.5, 1);
  });
});
