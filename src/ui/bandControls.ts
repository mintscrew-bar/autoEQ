// EQ 밴드 한 개를 편집하는 컨트롤 묶음: 종류 드롭다운, 주파수·게인·Q 노브, 다이나믹(DYN) 노브, 켜기/삭제.
// 그래프 아래의 편집 막대("bar")와 그래프 위에 뜨는 작은 편집창("pop")이 같은 구성요소를 쓴다.

import {
  DEFAULT_DYN,
  MAX_RANGE,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  type DynMode,
  type DynSettings,
} from "../dsp/dynamics";
import { FILTER_LABELS, hasGain, hasQ, type FilterType, type UserBand } from "../dsp/response";
import { createKnob, type Knob } from "./knob";

export const MIN_FREQ = 20;
export const MAX_FREQ = 20000;
export const MIN_Q = 0.1;
export const MAX_Q = 18;
export const MAX_GAIN = 18;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function formatFreq(hz: number): string {
  if (hz >= 1000) return `${+(hz / 1000).toFixed(2)}k`;
  return `${+hz.toFixed(hz < 100 ? 1 : 0)}`;
}
export const formatGain = (db: number) => `${db > 0 ? "+" : ""}${db.toFixed(1)}`;
export const formatQ = (q: number) => q.toFixed(2);

/** "1.2k", "800hz", "1200" 같은 입력을 Hz로 읽는다. 읽을 수 없으면 null */
export function parseFreq(text: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(k?)\s*(hz)?\s*$/i.exec(text);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}
/** "+3", "-6.5db" 같은 입력을 dB로 읽는다. */
export function parseGain(text: string): number | null {
  const m = /^\s*([+-]?[0-9]*\.?[0-9]+)\s*(db)?\s*$/i.exec(text);
  return m ? Number(m[1]) : null;
}
export function parseQ(text: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(ms)?\s*$/i.exec(text);
  return m ? Number(m[1]) : null;
}

export interface BandHandlers {
  find(id: number): UserBand | undefined;
  patch(id: number, patch: Partial<UserBand>): void;
  select(id: number): void;
  remove(id: number): void;
}

export interface BandView {
  el: HTMLElement;
  sync(band: UserBand, index: number, selected: boolean): void;
  /** 다이나믹 밴드의 지금 대역 레벨(dB)과 그 결과 게인이 움직인 양(dB). 글자 표시를 갱신한다 */
  setLevel(levelDb: number, gainChangeDb: number): void;
}

const fmtMs = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));

/** variant: "bar"는 그래프 아래의 편집 막대(노브 크게, 다이나믹 전부), "pop"은 그래프 위에 뜨는 작은 편집창 */
export function createBandView(id: number, h: BandHandlers, variant: "bar" | "pop"): BandView {
  const band = () => h.find(id);
  const el = document.createElement("div");
  el.className = `bandview ${variant === "pop" ? "popview" : "barview"}`;

  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "badge";
  badge.addEventListener("click", () => h.select(id));

  const type = document.createElement("select");
  type.className = "type";
  type.setAttribute("aria-label", "Type");
  for (const t of Object.keys(FILTER_LABELS) as FilterType[]) type.add(new Option(FILTER_LABELS[t], t));
  type.addEventListener("change", () => h.patch(id, { type: type.value as FilterType }));

  const autoTag = document.createElement("span");
  autoTag.className = "autotag";
  autoTag.title = "A band created by LEARN. Touch any value and it becomes your own band.";

  // 위계: 메인 값(주파수·게인·Q)은 큰 노브, 다이나믹 값은 한 단계 작은 노브. 작은 편집창은 둘 다 한 단계씩 줄인다.
  const big = variant === "bar" ? "lg" : "md";
  const small = variant === "bar" ? "md" : "sm";

  // ---- 주파수·게인·Q
  const freq = createKnob({
    size: big,
    label: "Freq",
    min: MIN_FREQ,
    max: MAX_FREQ,
    log: true,
    get: () => band()?.freq ?? 1000,
    set: (v) => h.patch(id, { freq: clamp(v, MIN_FREQ, MAX_FREQ) }),
    format: (v) => formatFreq(v),
    parse: parseFreq,
  });
  const gain = createKnob({
    size: big,
    label: "Gain",
    min: -MAX_GAIN,
    max: MAX_GAIN,
    bipolar: true,
    reset: 0,
    get: () => band()?.gain ?? 0,
    set: (v) => h.patch(id, { gain: clamp(Math.round(v * 10) / 10, -MAX_GAIN, MAX_GAIN) }),
    format: formatGain,
    parse: parseGain,
  });
  const q = createKnob({
    size: big,
    label: "Q",
    min: MIN_Q,
    max: MAX_Q,
    log: true,
    reset: 1,
    get: () => band()?.q ?? 1,
    set: (v) => h.patch(id, { q: clamp(v, MIN_Q, MAX_Q) }),
    format: formatQ,
    parse: parseQ,
  });

  // ---- 다이나믹 EQ: DYN을 켜면 Gain 옆에 Range가 붙고, 문턱값·시간 노브가 나타난다
  const dynOf = (): DynSettings => band()?.dyn ?? DEFAULT_DYN;
  const patchDyn = (partial: Partial<DynSettings>) => h.patch(id, { dyn: { ...dynOf(), ...partial } });

  const dynBtn = document.createElement("button");
  dynBtn.type = "button";
  dynBtn.className = "dynbtn";
  dynBtn.textContent = "DYN";
  dynBtn.title = "Dynamic EQ: the gain moves with the level in this band's frequency range";
  dynBtn.addEventListener("click", () => patchDyn({ enabled: !dynOf().enabled }));

  const range = createKnob({
    size: small,
    label: "Range",
    min: -MAX_RANGE,
    max: MAX_RANGE,
    bipolar: true,
    reset: DEFAULT_DYN.range,
    title: "How far the gain moves when fully active (negative cuts, positive boosts)",
    get: () => dynOf().range,
    set: (v) => patchDyn({ range: Math.round(clamp(v, -MAX_RANGE, MAX_RANGE) * 10) / 10 }),
    format: formatGain,
    parse: parseGain,
  });
  const threshold = createKnob({
    size: small,
    label: "Thresh",
    min: MIN_THRESHOLD,
    max: MAX_THRESHOLD,
    reset: DEFAULT_DYN.threshold,
    title: "Band level (dB) where the dynamics start to act",
    get: () => dynOf().threshold,
    set: (v) => patchDyn({ threshold: Math.round(clamp(v, MIN_THRESHOLD, MAX_THRESHOLD)) }),
    format: (v) => String(Math.round(v)),
    parse: parseGain,
  });
  const attack = createKnob({
    size: small,
    label: "Attack",
    min: 0.5,
    max: 200,
    log: true,
    reset: DEFAULT_DYN.attack,
    get: () => dynOf().attack,
    set: (v) => patchDyn({ attack: clamp(v, 0.5, 200) }),
    format: (v) => `${fmtMs(v)}ms`,
    parse: parseQ,
  });
  const release = createKnob({
    size: small,
    label: "Release",
    min: 5,
    max: 3000,
    log: true,
    reset: DEFAULT_DYN.release,
    get: () => dynOf().release,
    set: (v) => patchDyn({ release: clamp(v, 5, 3000) }),
    format: (v) => `${fmtMs(v)}ms`,
    parse: parseQ,
  });

  const modeBox = document.createElement("div");
  modeBox.className = "segmented";
  modeBox.setAttribute("role", "radiogroup");
  modeBox.setAttribute("aria-label", "Dynamic mode");
  const modeButtons = new Map<DynMode, HTMLButtonElement>();
  for (const [value, text, tip] of [
    ["above", "Over", "Acts when the band level is above the threshold (like a compressor)"],
    ["below", "Under", "Acts when the band level is below the threshold (like an expander)"],
  ] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = tip;
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => patchDyn({ mode: value }));
    modeButtons.set(value, b);
    modeBox.append(b);
  }

  const levelText = document.createElement("span");
  levelText.className = "levelread";
  const modeCol = document.createElement("div");
  modeCol.className = "modecol";
  levelText.title = "Current level in this band's frequency range, and how much the gain moved";

  const power = document.createElement("button");
  power.type = "button";
  power.className = "power";
  power.title = "Band on/off";
  power.setAttribute("aria-label", "Band on/off");
  power.addEventListener("click", () => h.patch(id, { enabled: !band()?.enabled }));

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.title = "Delete band";
  del.setAttribute("aria-label", "Delete band");
  del.textContent = "✕";
  del.addEventListener("click", () => h.remove(id));

  const group = (cls: string, ...kids: HTMLElement[]) => {
    const d = document.createElement("div");
    d.className = cls;
    d.append(...kids);
    return d;
  };
  const dynTitle = document.createElement("span");
  dynTitle.className = "dyn-title";
  dynTitle.textContent = "DYNAMICS";
  modeCol.append(modeBox, levelText);
  const dynGroup = group("dyngroup");

  if (variant === "pop") {
    // 작은 편집창: 윗줄에 번호·종류·DYN·켜기·삭제, 다음 줄에 큰 노브 셋, 다이나믹이 켜지면 작은 노브 둘과 방향
    attack.el.classList.add("adv");
    release.el.classList.add("adv");
    dynGroup.append(group("dynknobs", range.el, threshold.el, attack.el, release.el), modeCol);
    el.append(
      group("head", badge, autoTag, type, dynBtn, power, del),
      group("knobs", freq.el, gain.el, q.el),
      dynGroup,
    );
  } else {
    // 밴드 막대: [번호·종류 / DYN·켜기·삭제] | 큰 노브 셋 | 다이나믹 묶음(켜졌을 때만)
    dynGroup.append(dynTitle, group("dynknobs", range.el, threshold.el, attack.el, release.el), modeCol);
    el.append(
      group("idcol", group("row", badge, autoTag, type), group("row", dynBtn, power, del)),
      group("knobs", freq.el, gain.el, q.el),
      dynGroup,
    );
  }

  return {
    el,
    sync(b, index, selected) {
      badge.textContent = String(index + 1);
      el.classList.toggle("selected", selected);
      el.classList.toggle("disabled", !b.enabled);
      el.classList.toggle("auto", !!b.auto);
      el.classList.toggle("learned", !!b.learned);
      autoTag.textContent = b.auto ? "LEARNING" : "LEARN";
      if (document.activeElement !== type) type.value = b.type;
      freq.sync();
      gain.sync();
      q.sync();
      gain.setVisible(hasGain(b.type));
      q.setVisible(hasQ(b.type));
      power.classList.toggle("on", b.enabled);
      power.setAttribute("aria-pressed", String(b.enabled));

      const canDyn = hasGain(b.type);
      const dyn = b.dyn ?? DEFAULT_DYN;
      const dynOn = canDyn && dyn.enabled;
      dynBtn.hidden = !canDyn;
      dynBtn.classList.toggle("on", dynOn);
      dynBtn.setAttribute("aria-pressed", String(dynOn));
      dynGroup.hidden = !dynOn;
      el.classList.toggle("dynon", dynOn);
      range.sync();
      threshold.sync();
      attack.sync();
      release.sync();
      for (const [m, btn] of modeButtons) {
        btn.classList.toggle("on", m === dyn.mode);
        btn.setAttribute("aria-checked", String(m === dyn.mode));
      }
    },
    setLevel(levelDb, gainChangeDb) {
      const text = `${levelDb.toFixed(1)} dB · ${gainChangeDb > 0 ? "+" : ""}${gainChangeDb.toFixed(1)}`;
      if (levelText.textContent !== text) levelText.textContent = text;
    },
  };
}
