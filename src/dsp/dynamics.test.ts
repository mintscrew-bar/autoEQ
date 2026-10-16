import { describe, expect, it } from "vitest";
import { DEFAULT_DYN, dynamicTarget, effectiveGain, KNEE_DB, rmsDb, smoothAmount } from "./dynamics";

describe("dynamicTarget", () => {
  it("above: 문턱값보다 한참 낮으면 0, 한참 높으면 1, 문턱값에서 0.5다", () => {
    const s = { threshold: -30, mode: "above" as const };
    expect(dynamicTarget(-60, s)).toBe(0);
    expect(dynamicTarget(0, s)).toBe(1);
    expect(dynamicTarget(-30, s)).toBeCloseTo(0.5, 9);
  });

  it("below: 반대로 문턱값에 못 미칠수록 커진다", () => {
    const s = { threshold: -30, mode: "below" as const };
    expect(dynamicTarget(-60, s)).toBe(1);
    expect(dynamicTarget(0, s)).toBe(0);
    expect(dynamicTarget(-30, s)).toBeCloseTo(0.5, 9);
  });

  it("소프트니 폭 안에서 선형으로 변한다", () => {
    const s = { threshold: -30, mode: "above" as const };
    expect(dynamicTarget(-30 - KNEE_DB / 4, s)).toBeCloseTo(0.25, 9);
    expect(dynamicTarget(-30 + KNEE_DB / 4, s)).toBeCloseTo(0.75, 9);
  });
});

describe("smoothAmount", () => {
  it("커질 때는 attack, 작아질 때는 release 속도를 쓴다", () => {
    const up = smoothAmount(0, 1, 0.01, 10, 1000);
    const down = smoothAmount(1, 0, 0.01, 10, 1000);
    expect(up).toBeGreaterThan(0.6); // attack 10ms, 10ms 경과 → 약 63%
    expect(1 - down).toBeLessThan(0.02); // release 1초, 10ms 경과 → 약 1%
  });

  it("충분히 지나면 목표에 수렴한다", () => {
    let a = 0;
    for (let i = 0; i < 200; i++) a = smoothAmount(a, 1, 0.01, 20, 100);
    expect(a).toBeCloseTo(1, 4);
  });

  it("프레임 간격이 달라도 같은 시간이 지나면 같은 값이다", () => {
    let coarse = 0;
    for (let i = 0; i < 5; i++) coarse = smoothAmount(coarse, 1, 0.02, 50, 100);
    let fine = 0;
    for (let i = 0; i < 10; i++) fine = smoothAmount(fine, 1, 0.01, 50, 100);
    expect(coarse).toBeCloseTo(fine, 9);
  });
});

describe("effectiveGain", () => {
  it("작동 정도에 비례해 range만큼 움직인다", () => {
    expect(effectiveGain(3, { range: -6 }, 0)).toBe(3);
    expect(effectiveGain(3, { range: -6 }, 1)).toBe(-3);
    expect(effectiveGain(3, { range: -6 }, 0.5)).toBe(0);
    expect(effectiveGain(0, { range: 4 }, 1)).toBe(4);
  });
});

describe("rmsDb", () => {
  it("무음은 바닥값이고, 진폭 1의 사인파는 약 -3dB다", () => {
    expect(rmsDb(new Float32Array(512))).toBe(-100);
    const sine = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((2 * Math.PI * 100 * i) / 4096));
    expect(rmsDb(sine)).toBeCloseTo(-3.01, 1);
  });
});

describe("DEFAULT_DYN", () => {
  it("기본은 꺼져 있고 깎는 방향이다", () => {
    expect(DEFAULT_DYN.enabled).toBe(false);
    expect(DEFAULT_DYN.range).toBeLessThan(0);
  });
});
