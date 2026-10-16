// 밴드 id를 고정된 필터 슬롯에 배정한다. 밴드가 늘거나 줄어도 남은 밴드는 같은 슬롯(같은 필터 노드)을 유지하므로,
// 필터를 새로 만들며 생기는 상태 리셋(클릭)이 없다. 웹 오디오와 무관한 순수 로직이다.

export interface SlotAssignment {
  /** ids와 같은 순서의 슬롯 번호. 슬롯이 모자라면 -1 */
  slotOf: number[];
  /** ids와 같은 순서: 이번에 처음 배정됐는지 */
  fresh: boolean[];
  /** 이번에 주인이 없어진 슬롯 번호들 */
  freed: number[];
}

export class SlotAllocator {
  private readonly owner: (number | null)[];

  constructor(readonly capacity: number) {
    this.owner = Array.from({ length: capacity }, () => null);
  }

  assign(ids: readonly number[]): SlotAssignment {
    const present = new Set(ids);
    const freed: number[] = [];
    this.owner.forEach((id, slot) => {
      if (id !== null && !present.has(id)) {
        this.owner[slot] = null;
        freed.push(slot);
      }
    });

    const slotOf: number[] = [];
    const fresh: boolean[] = [];
    for (const id of ids) {
      let slot = this.owner.indexOf(id);
      let isFresh = false;
      if (slot < 0) {
        slot = this.owner.indexOf(null);
        if (slot >= 0) {
          this.owner[slot] = id;
          isFresh = true;
        }
      }
      slotOf.push(slot);
      fresh.push(isFresh);
    }
    return { slotOf, fresh, freed };
  }
}
