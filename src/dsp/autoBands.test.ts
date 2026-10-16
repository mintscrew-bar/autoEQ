import { describe, expect, it } from "vitest";
import { fitBands, qFromOctaves } from "./autoBands";
import { makeBands } from "./bands";
import { responseDb } from "./response";

const { centers } = makeBands();
const opts = { maxBands: 6, minGainDb: 0.5 };
const flat = () => centers.map(() => 0);
const octaves = (a: number, b: number) => Math.abs(Math.log2(a / b));

describe("qFromOctaves", () => {
  it("1옥타브 폭의 Q는 약 1.41이다", () => {
    expect(qFromOctaves(1)).toBeCloseTo(Math.SQRT2, 6);
  });
});

describe("fitBands", () => {
  it("보정할 게 없으면 밴드를 만들지 않는다", () => {
    expect(fitBands(centers, flat(), opts)).toEqual([]);
  });

  it("한 곳만 움푹하면 그 자리에 컷 밴드 하나를 놓는다", () => {
    const c = flat();
    c[8] = -3;
    const fits = fitBands(centers, c, opts);
    expect(fits).toHaveLength(1);
    expect(octaves(fits[0]!.freq, centers[8]!)).toBeLessThan(0.25);
    expect(fits[0]!.gain).toBeLessThan(-2);
    expect(fits[0]!.gain).toBeGreaterThan(-4);
  });

  it("떨어진 두 곳은 밴드 두 개로, 부호도 맞는다", () => {
    const c = flat();
    c[3] = 2;
    c[12] = -2.5;
    const fits = fitBands(centers, c, opts);
    expect(fits).toHaveLength(2);
    expect(octaves(fits[0]!.freq, centers[3]!)).toBeLessThan(0.3);
    expect(fits[0]!.gain).toBeGreaterThan(1);
    expect(octaves(fits[1]!.freq, centers[12]!)).toBeLessThan(0.3);
    expect(fits[1]!.gain).toBeLessThan(-1.5);
  });

  it("넓게 불룩하면 좁게 튀는 경우보다 Q가 낮다", () => {
    const narrow = flat();
    narrow[8] = 3;
    const broad = flat();
    [0.5, 1.5, 3, 1.5, 0.5].forEach((v, i) => (broad[6 + i] = v));
    const q = (c: number[]) => fitBands(centers, c, opts)[0]!.q;
    expect(q(broad)).toBeLessThan(q(narrow));
  });

  it("두 센터 사이의 꼭짓점이면 주파수가 센터에서 벗어난다", () => {
    const c = flat();
    c[8] = 2;
    c[9] = 2;
    const fits = fitBands(centers, c, opts);
    const mid = Math.sqrt(centers[8]! * centers[9]!);
    expect(octaves(fits[0]!.freq, mid)).toBeLessThan(0.2);
  });

  it("maxBands를 넘지 않는다", () => {
    const c = centers.map((_, i) => (i % 2 ? 2 : -2));
    expect(fitBands(centers, c, { maxBands: 3, minGainDb: 0.5 }).length).toBeLessThanOrEqual(3);
  });

  it("만든 밴드를 합친 응답이 원래 보정량에 가깝다", () => {
    const c = flat();
    [0, 1, 2, 3, 4].forEach((_, i) => (c[4 + i] = [-1, -2.5, -3, -2, -0.5][i]!));
    [0, 1, 2].forEach((_, i) => (c[11 + i] = [1, 2.5, 1][i]!));
    const fits = fitBands(centers, c, opts);
    const got = responseDb(fits.map((f) => ({ type: "bell" as const, ...f })), centers);
    const rms = Math.sqrt(c.reduce((s, v, i) => s + (v - got[i]!) ** 2, 0) / c.length);
    expect(rms).toBeLessThan(0.7);
  });
});
