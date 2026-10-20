import { describe, expect, it } from "vitest";
import { AutoEq } from "./autoEq";
import { makeBands } from "./bands";
import { identifyInstrument, INSTRUMENTS, instrumentById, profileTarget } from "./instruments";
import { rng } from "./testkit";

const layout = makeBands();
const centers = layout.centers;
const target = (id: Parameters<typeof instrumentById>[0]) => profileTarget(instrumentById(id), centers);

describe("profileTarget", () => {
  it("밴드마다 유한한 값을 내고, 핑크 노이즈 모양(옥타브 에너지 평탄)은 빈 영역에서 -3dB/oct다", () => {
    const flat = { id: "vocal", name: "flat", anchors: [[20, 0], [20000, 0]] } as const;
    const t = profileTarget(flat, centers);
    expect(t.every(Number.isFinite)).toBe(true);
    const i = 4;
    const j = i + 2; // 두 칸 = 1옥타브
    expect(t[j]! - t[i]!).toBeCloseTo(-3.01, 1);
  });

  it("모든 악기가 서로 다른 모양이다", () => {
    for (const a of INSTRUMENTS)
      for (const b of INSTRUMENTS) {
        if (a.id >= b.id) continue;
        const ta = profileTarget(a, centers), tb = profileTarget(b, centers);
        const d = ta.map((v, i) => v - tb[i]!);
        const mean = d.reduce((s, v) => s + v, 0) / d.length;
        const rms = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length);
        expect(rms, `${a.id} vs ${b.id}`).toBeGreaterThan(1);
      }
  });
});

describe("identifyInstrument", () => {
  const noisy = (id: Parameters<typeof instrumentById>[0], sigma: number, seed: number, level = -50) => {
    const r = rng(seed);
    return target(id).map((v) => v + level + sigma * (r() + r() + r() - 1.5) * 2);
  };

  it("프로파일 그대로의 스펙트럼은 그 악기로 추정하고 음량에 상관없다", () => {
    for (const p of INSTRUMENTS) {
      expect(identifyInstrument(target(p.id).map((v) => v - 63), centers).ranking[0]!.id).toBe(p.id);
    }
  });

  it("±1.5dB 안팎 잡음이 있어도 대부분 맞춘다", () => {
    let right = 0, total = 0;
    for (const p of INSTRUMENTS) for (let seed = 1; seed <= 20; seed++) {
      total++;
      if (identifyInstrument(noisy(p.id, 1.5, seed), centers).ranking[0]!.id === p.id) right++;
    }
    expect(right / total).toBeGreaterThan(0.8);
  });

  it("아무 악기와도 닮지 않은 평탄 스펙트럼은 확신하지 않는다", () => {
    const flat = centers.map(() => -50);
    expect(identifyInstrument(flat, centers).confident).toBe(false);
  });

  it("뚜렷하게 다른 악기(킥과 보컬)는 확신하고 구분한다", () => {
    const r = identifyInstrument(noisy("kick", 1, 3), centers);
    expect(r.ranking[0]!.id).toBe("kick");
    expect(r.confident).toBe(true);
  });
});

describe("AutoEq 악기 프로파일", () => {
  const opts = { confidenceSeconds: 0, deadbandDb: 0 };
  const feed = (eq: AutoEq, levels: number[]) => eq.update(levels, 0.05);

  it("프로파일이 설명하는 굴곡은 결함으로 보지 않고, 그 위의 좁은 공명만 보정한다", () => {
    const base = target("vocal");
    const input = base.map((v) => v - 50);
    const bump = centers.findIndex((f) => f > 700);
    input[bump] = input[bump]! + 2.5;

    const withInst = new AutoEq(centers, { ...opts, instrumentMatch: 0 });
    withInst.setInstrument(base);
    feed(withInst, input);
    const without = new AutoEq(centers, opts);
    feed(without, input);

    const leak = (eq: AutoEq) => Math.max(...eq.correction().map((c, i) => (i === bump ? 0 : Math.abs(c))));
    expect(withInst.correction()[bump]).toBeLessThan(-1.8);
    expect(leak(withInst)).toBeLessThan(0.3);
    expect(leak(without)).toBeGreaterThan(leak(withInst));
  });

  it("instrumentMatch가 커지면 악기 음색에서 벗어난 넓은 기울기를 바로잡는다", () => {
    const base = target("vocal");
    // 고역이 옥타브당 2dB씩 과하게 올라간 보컬
    const tilted = base.map((v, i) => v - 50 + 2 * Math.log2(centers[i]! / 1000));
    const hi = centers.findIndex((f) => f > 4000);
    const lo = centers.findIndex((f) => f > 150);
    const run = (match: number) => {
      const eq = new AutoEq(centers, { ...opts, instrumentMatch: match, maxCorrectionDb: 6 });
      eq.setInstrument(base);
      feed(eq, tilted);
      return eq.correction();
    };
    expect(Math.abs(run(0)[hi]!)).toBeLessThan(0.3);
    expect(run(1)[hi]!).toBeLessThan(-1.5); // 고역은 깎고
    expect(run(1)[lo]!).toBeGreaterThan(1.5); // 저역은 올린다
    expect(Math.abs(run(0.5)[hi]!)).toBeLessThan(Math.abs(run(1)[hi]!));
  });

  it("setInstrument(null)이면 기존 동작(곡 자신의 추세)으로 돌아간다", () => {
    const input = target("piano").map((v) => v - 50);
    const a = new AutoEq(centers, opts);
    feed(a, input);
    const b = new AutoEq(centers, opts);
    b.setInstrument(target("vocal"));
    b.setInstrument(null);
    feed(b, input);
    expect(b.correction()).toEqual(a.correction());
  });

  it("길이가 다른 프로파일은 거부한다", () => {
    expect(() => new AutoEq(centers).setInstrument([0, 1])).toThrow();
  });
});
