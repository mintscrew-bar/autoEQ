import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeBands } from "../dsp/bands";
import type { FilterSpec } from "../dsp/response";
import { Engine, SLOT_COUNT } from "./engine";

// 웹 오디오 노드의 최소 대역: 몇 개를 만들었고 몇 번 이었는지만 센다.
class FakeParam {
  value = 0;
  targets: number[] = [];
  setTargetAtTime(v: number): void {
    this.targets.push(v);
  }
}
class FakeNode {
  static created = 0;
  static connects = 0;
  static disconnects = 0;
  readonly id = FakeNode.created++;
  type = "";
  fftSize = 0;
  smoothingTimeConstant = 0;
  frequencyBinCount = 4096;
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
  connect(n: FakeNode): FakeNode {
    FakeNode.connects++;
    return n;
  }
  disconnect(): void {
    FakeNode.disconnects++;
  }
  getFloatTimeDomainData(buf: Float32Array): void {
    buf.fill(0.1);
  }
  getFloatFrequencyData(buf: Float32Array): void {
    buf.fill(-60);
  }
}
class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  createMediaElementSource = () => new FakeNode();
  createAnalyser = () => new FakeNode();
  createGain = () => new FakeNode();
  createBiquadFilter = () => new FakeNode();
}

const bell = (id: number, freq: number, gain: number, extra: Partial<FilterSpec> = {}): FilterSpec => ({
  id,
  type: "bell",
  freq,
  gain,
  q: 1,
  ...extra,
});

describe("Engine 고정 필터 슬롯", () => {
  beforeEach(() => {
    FakeNode.created = FakeNode.connects = FakeNode.disconnects = 0;
    vi.stubGlobal("AudioContext", FakeContext);
  });
  afterEach(() => vi.unstubAllGlobals());

  const make = () => new Engine({} as HTMLAudioElement, makeBands());

  it("밴드를 늘리고 줄여도 노드를 새로 만들거나 연결을 바꾸지 않는다", () => {
    const e = make();
    const nodes = FakeNode.created;
    const connects = FakeNode.connects;
    const disconnects = FakeNode.disconnects;
    e.apply([bell(1, 100, 3)], 3);
    e.apply([bell(1, 100, 3), bell(2, 1000, -2), bell(3, 5000, 1)], 3);
    e.apply([bell(2, 1000, -2)], 0);
    e.apply([], 0);
    expect(FakeNode.created).toBe(nodes);
    expect(FakeNode.connects).toBe(connects);
    expect(FakeNode.disconnects).toBe(disconnects);
  });

  it("사라진 밴드의 슬롯은 게인 0으로 내려가고, 남은 밴드의 필터는 그대로다", () => {
    const e = make();
    const filters = (e as unknown as { slots: { filter: FakeNode }[] }).slots.map((s) => s.filter);
    e.apply([bell(1, 100, 3), bell(2, 1000, -2)], 3);
    e.apply([bell(2, 1000, -2)], 0);
    expect(filters[0]!.gain.targets.at(-1)).toBe(0); // 밴드 1이 쓰던 슬롯 0이 투명해진다
    expect(filters[1]!.gain.targets.at(-1)).toBe(-2); // 밴드 2는 같은 슬롯에서 계속
    expect(filters[1]!.gain.targets).toHaveLength(2);
  });

  it("새 밴드는 비워진 슬롯을 재사용하고 종류·주파수는 바로 설정된다", () => {
    const e = make();
    const filters = (e as unknown as { slots: { filter: FakeNode }[] }).slots.map((s) => s.filter);
    e.apply([bell(1, 100, 3), bell(2, 1000, -2)], 3);
    e.apply([bell(2, 1000, -2)], 0);
    e.apply([bell(2, 1000, -2), { id: 9, type: "highshelf", freq: 8000, gain: 2, q: 1 }], 0);
    expect(filters[0]!.type).toBe("highshelf");
    expect(filters[0]!.frequency.value).toBe(8000);
  });

  it("다이나믹 밴드만 검출기를 만들고 레벨은 밴드 id로 돌려준다", () => {
    const e = make();
    const before = FakeNode.created;
    e.apply([bell(1, 100, 3), bell(2, 1000, -2, { dynamic: true })], 3);
    expect(FakeNode.created).toBe(before + 2); // 필터 + 분석기
    const levels = e.readDetectorLevels(true);
    expect([...levels.keys()]).toEqual([2]);
    expect(levels.get(2)).toBeCloseTo(-20, 1); // 진폭 0.1 → -20dB
    expect(e.readDetectorLevels(false).get(2)).toBe(-100);
    e.apply([bell(1, 100, 3), bell(2, 1000, -2)], 3); // 다이나믹을 끄면 검출기가 사라진다
    expect(e.readDetectorLevels(true).size).toBe(0);
  });

  it("슬롯 수를 넘는 밴드는 무시하고 죽지 않는다", () => {
    const e = make();
    const many = Array.from({ length: SLOT_COUNT + 3 }, (_, i) => bell(i + 1, 100 + i * 10, 1));
    expect(() => e.apply(many, 1)).not.toThrow();
  });
});
