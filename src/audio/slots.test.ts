import { describe, expect, it } from "vitest";
import { SlotAllocator } from "./slots";

describe("SlotAllocator", () => {
  it("새 밴드는 빈 슬롯 중 가장 낮은 번호를 받고 fresh로 표시된다", () => {
    const a = new SlotAllocator(4);
    const r = a.assign([10, 11]);
    expect(r.slotOf).toEqual([0, 1]);
    expect(r.fresh).toEqual([true, true]);
    expect(r.freed).toEqual([]);
  });

  it("남은 밴드는 다른 밴드가 사라져도 같은 슬롯을 유지한다", () => {
    const a = new SlotAllocator(4);
    a.assign([10, 11, 12]);
    const r = a.assign([10, 12]);
    expect(r.slotOf).toEqual([0, 2]);
    expect(r.fresh).toEqual([false, false]);
    expect(r.freed).toEqual([1]);
  });

  it("비워진 슬롯은 다음 새 밴드가 다시 쓴다", () => {
    const a = new SlotAllocator(4);
    a.assign([10, 11, 12]);
    a.assign([10, 12]);
    const r = a.assign([10, 12, 13]);
    expect(r.slotOf).toEqual([0, 2, 1]);
    expect(r.fresh).toEqual([false, false, true]);
  });

  it("목록 순서가 바뀌어도 슬롯은 id를 따라간다", () => {
    const a = new SlotAllocator(4);
    a.assign([1, 2, 3]);
    expect(a.assign([3, 1, 2]).slotOf).toEqual([2, 0, 1]);
  });

  it("슬롯이 모자라면 -1을 돌려준다", () => {
    const a = new SlotAllocator(2);
    expect(a.assign([1, 2, 3]).slotOf).toEqual([0, 1, -1]);
  });
});
