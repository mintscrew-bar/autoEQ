import { describe, expect, it } from "vitest";
import { headroomDb, responseDb, type FilterSpec } from "./response";

const bell = (freq: number, gain: number, q = 1): FilterSpec => ({ type: "bell", freq, gain, q });
const at = (spec: FilterSpec, f: number) => responseDb([spec], [f])[0]!;

describe("responseDb", () => {
  it("필터가 없거나 gain이 0인 벨은 어디서나 0dB다", () => {
    for (const v of responseDb([bell(1000, 0)], [30, 1000, 12000])) expect(v).toBeCloseTo(0, 9);
    for (const v of responseDb([], [30, 1000])) expect(v).toBe(0);
  });

  it("벨은 중심 주파수에서 gain만큼, 멀리서는 거의 0이다", () => {
    expect(at(bell(1000, 6), 1000)).toBeCloseTo(6, 1);
    expect(at(bell(1000, -6), 1000)).toBeCloseTo(-6, 1);
    expect(Math.abs(at(bell(1000, 6, 4), 30))).toBeLessThan(0.3);
  });

  it("Q가 클수록 벨이 좁다", () => {
    expect(at(bell(1000, 6, 8), 1500)).toBeLessThan(at(bell(1000, 6, 1), 1500));
  });

  it("로우 쉘프는 저역을 gain만큼, 고역은 거의 건드리지 않는다", () => {
    const s: FilterSpec = { type: "lowshelf", freq: 200, gain: 6, q: 1 };
    expect(at(s, 20)).toBeCloseTo(6, 0);
    expect(Math.abs(at(s, 15000))).toBeLessThan(0.3);
  });

  it("하이 쉘프는 고역을 gain만큼, 저역은 거의 건드리지 않는다", () => {
    const s: FilterSpec = { type: "highshelf", freq: 5000, gain: -6, q: 1 };
    expect(at(s, 20000)).toBeCloseTo(-6, 0);
    expect(Math.abs(at(s, 50))).toBeLessThan(0.3);
  });

  it("하이패스는 저역을 깎고, 로우패스는 고역을 깎는다", () => {
    const hp: FilterSpec = { type: "highpass", freq: 200, gain: 0, q: Math.SQRT1_2 };
    expect(at(hp, 20)).toBeLessThan(-30);
    expect(at(hp, 200)).toBeCloseTo(-3, 0);
    expect(Math.abs(at(hp, 5000))).toBeLessThan(0.1);
    const lp: FilterSpec = { type: "lowpass", freq: 5000, gain: 0, q: Math.SQRT1_2 };
    expect(at(lp, 18000)).toBeLessThan(-15);
    expect(Math.abs(at(lp, 100))).toBeLessThan(0.1);
  });

  it("노치는 중심에서 크게 깎고 멀리서는 거의 0이다", () => {
    const s: FilterSpec = { type: "notch", freq: 1000, gain: 0, q: 8 };
    expect(at(s, 1000)).toBeLessThan(-40);
    expect(Math.abs(at(s, 100))).toBeLessThan(0.1);
  });

  it("직렬로 걸면 dB가 더해진다", () => {
    expect(responseDb([bell(1000, 3), bell(1000, 3)], [1000])[0]).toBeCloseTo(6, 1);
  });
});

describe("headroomDb", () => {
  it("컷만 있으면 0이고, 필터가 없어도 0이다", () => {
    expect(headroomDb([bell(1000, -6)])).toBe(0);
    expect(headroomDb([])).toBe(0);
  });

  it("한 밴드만 +6dB면 약 6dB다(모든 밴드 합이 아니다)", () => {
    const h = headroomDb([bell(1000, 6), bell(100, 0), bell(8000, 0)]);
    expect(h).toBeGreaterThan(5);
    expect(h).toBeLessThan(7);
  });
});
