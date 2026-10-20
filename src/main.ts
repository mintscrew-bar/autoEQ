import { Engine } from "./audio/engine";
import { fitBands, type AutoBandFit } from "./dsp/autoBands";
import { DEFAULT_DYN, MAX_RANGE, dynamicTarget, smoothAmount, type DynSettings } from "./dsp/dynamics";
import { AutoEq } from "./dsp/autoEq";
import { makeBands } from "./dsp/bands";
import {
  CATEGORY_NAMES,
  INSTRUMENTS,
  STYLES,
  identifyInstrument,
  instrumentById,
  profileTarget,
  type InstrumentCategory,
  type InstrumentId,
  type StyleId,
} from "./dsp/instruments";
import {
  FILTER_LABELS,
  defaultQ,
  hasGain,
  hasQ,
  headroomDb,
  logFreqs,
  responseDb,
  type FilterSpec,
  type FilterType,
  type UserBand,
} from "./dsp/response";
import {
  MAX_FREQ,
  MAX_GAIN,
  MAX_Q,
  MIN_FREQ,
  MIN_Q,
  clamp,
  createBandView,
  formatFreq,
  parseFreq,
  parseGain,
  type BandView,
} from "./ui/bandControls";
import { createKnob } from "./ui/knob";
import { drawEqCurve, dynLayout, eqMapper, EQ_RANGE_DB, NODE_HIT_PX } from "./ui/curves";

const layout = makeBands();
const eq = new AutoEq(layout.centers);
const curveFreqs = logFreqs(200);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const player = $<HTMLAudioElement>("player");
const fileInput = $<HTMLInputElement>("file");
const bypassBox = $<HTMLInputElement>("bypass");
const learnToggle = $<HTMLButtonElement>("learn-toggle");
const learnInfo = $("learn-info");
const autoMore = $<HTMLButtonElement>("auto-more");
const autoDrawer = $("auto-drawer");
const playButton = $<HTMLButtonElement>("play");
const seek = $<HTMLInputElement>("seek");
const timeText = $("time");
const resetButton = $<HTMLButtonElement>("reset");
const saveRefButton = $<HTMLButtonElement>("save-ref");
const targetMode = $<HTMLSelectElement>("target-mode");
const refState = $("ref-state");
const statusText = $("status");
const eqCanvas = $<HTMLCanvasElement>("eq");

let engine: Engine | null = null;
let lastFrame = performance.now();
let objectUrl: string | null = null;

const formatHz = formatFreq;

const mmss = (sec: number) => {
  const t = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};


// ---------------------------------------------------------------------------
// 자동 보정 설정

interface MountOptions {
  label: string;
  min: number;
  max: number;
  log?: boolean;
  value: number;
  reset?: number;
  size?: "lg" | "md" | "sm";
  title?: string;
  format: (v: number) => string;
  parse: (text: string) => number | null;
  /** 값을 계단식으로 맞출 때(정수, 0.5 단위 등) */
  snap?: (v: number) => number;
  apply: (v: number) => void;
}

/** 노브 하나를 만들어 컨테이너에 붙이고, 값이 바뀔 때마다 apply를 부른다. 처음 값도 바로 적용한다. */
function mountKnob(containerId: string, o: MountOptions): void {
  let current = o.value;
  const knob = createKnob({
    label: o.label,
    min: o.min,
    max: o.max,
    ...(o.log ? { log: true } : {}),
    ...(o.reset !== undefined ? { reset: o.reset } : {}),
    ...(o.size ? { size: o.size } : {}),
    ...(o.title ? { title: o.title } : {}),
    get: () => current,
    set: (v) => {
      current = clamp(o.snap ? o.snap(v) : v, o.min, o.max);
      o.apply(current);
    },
    format: o.format,
    parse: o.parse,
  });
  $(containerId).append(knob.el);
  knob.sync();
  o.apply(current);
}

mountKnob("k-smooth", {
  size: "sm",
  label: "Smoothing",
  min: 0.5,
  max: 3,
  value: 1.5,
  reset: 1.5,
  title: "Smoothing, in octaves: only features narrower than this are corrected. Small: only sharp spikes. Large: broad bumps too.",
  format: (v) => v.toFixed(1),
  parse: parseGain,
  snap: (v) => Math.round(v * 2) / 2,
  apply: (v) => eq.setOptions({ smoothOctaves: v }),
});
mountKnob("k-minhz", {
  size: "sm",
  label: "Low limit",
  min: 20,
  max: 200,
  value: 50,
  reset: 50,
  title: "LEARN never touches anything below this frequency.",
  format: (v) => `${Math.round(v)}Hz`,
  parse: parseFreq,
  snap: (v) => Math.round(v / 10) * 10,
  apply: (v) => eq.setOptions({ minHz: v }),
});
mountKnob("k-maxhz", {
  size: "sm",
  label: "High limit",
  min: 4000,
  max: 16000,
  value: 8000,
  reset: 8000,
  title: "LEARN never touches anything above this frequency. MP3s are rolled off up there, so boosting only raises noise.",
  format: (v) => `${formatHz(v)}Hz`,
  parse: parseFreq,
  snap: (v) => Math.round(v / 500) * 500,
  apply: (v) => eq.setOptions({ maxHz: v }),
});
const instrumentSel = $<HTMLSelectElement>("instrument");
// Auto가 고른 프로파일은 판별이 틀릴 수 있어(NOTES.md) Match를 절반만 적용한다.
let userMatch = 0.3;
function syncMatch(): void {
  eq.setOptions({ instrumentMatch: userMatch * (instrumentSel.value === "auto" ? 0.5 : 1) });
}
mountKnob("k-match", {
  size: "sm",
  label: "Match",
  min: 0,
  max: 1,
  value: 0.3,
  reset: 0.3,
  title: "Instrument match: how far to pull the overall balance toward the chosen instrument's normal tone. 0 only fixes narrow spots.",
  format: (v) => `${Math.round(v * 100)}%`,
  parse: parseGain,
  snap: (v) => Math.round(v * 20) / 20,
  apply: (v) => {
    userMatch = v;
    syncMatch();
  },
});

// 악기: 고르거나 Auto(스펙트럼 모양으로 추정, 확신이 있을 때만 적용, 깜박임 방지로 같은 후보가 3초 이어져야 바꾼다)
const instInfo = $("inst-info");
for (const category of Object.keys(CATEGORY_NAMES) as InstrumentCategory[]) {
  const group = document.createElement("optgroup");
  group.label = CATEGORY_NAMES[category];
  for (const p of INSTRUMENTS.filter((x) => x.category === category)) group.append(new Option(p.name, p.id));
  instrumentSel.append(group);
}
const styleSel = $<HTMLSelectElement>("style");
for (const st of STYLES) if (st.id !== "none") styleSel.add(new Option(st.name, st.id));
let appliedInstrument: InstrumentId | null = null;
let instCandidate: InstrumentId | null = null;
let instCandidateSince = 0;
let instLastConfident = 0;

function applyInstrument(id: InstrumentId | null): void {
  appliedInstrument = id;
  eq.setInstrument(id ? profileTarget(instrumentById(id), layout.centers, styleSel.value as StyleId) : null);
  instInfo.textContent =
    instrumentSel.value === "auto" ? (id ? `Detected: ${instrumentById(id).name}` : "Detecting…") : "";
}

function updateInstrument(now: number): void {
  const sel = instrumentSel.value;
  if (sel !== "auto") return;
  const avg = eq.averageLevels();
  if (!avg || eq.confidence() < 0.5) return;
  const r = identifyInstrument(avg, layout.centers);
  if (!r.confident) {
    instCandidate = null;
    if (appliedInstrument && now - instLastConfident > 8000) applyInstrument(null);
    return;
  }
  const best = r.applied!;
  instLastConfident = now;
  if (best === appliedInstrument) {
    instCandidate = null;
  } else if (best !== instCandidate) {
    instCandidate = best;
    instCandidateSince = now;
  } else if (now - instCandidateSince >= 3000) {
    applyInstrument(best);
    instCandidate = null;
  }
}

styleSel.addEventListener("change", () => applyInstrument(appliedInstrument));
instrumentSel.addEventListener("change", () => {
  instCandidate = null;
  syncMatch();
  const v = instrumentSel.value;
  applyInstrument(v === "auto" || v === "off" ? null : (v as InstrumentId));
  if (v === "off") instInfo.textContent = "";
});
applyInstrument(null);

let maxAutoBands = 5;
mountKnob("k-bands", {
  size: "sm",
  label: "Bands",
  min: 1,
  max: 8,
  value: 5,
  reset: 5,
  title: "Maximum number of bands LEARN may place (set before learning)",
  format: (v) => String(Math.round(v)),
  parse: parseGain,
  snap: (v) => Math.round(v),
  apply: (v) => {
    maxAutoBands = v;
  },
});

autoMore.addEventListener("click", () => {
  autoDrawer.hidden = !autoDrawer.hidden;
  autoMore.setAttribute("aria-expanded", String(!autoDrawer.hidden));
  autoMore.textContent = autoDrawer.hidden ? "Options ▾" : "Options ▴";
});

/** 목표 선택 상자와 안내 문구를 현재 목표 방식에 맞춘다. */
function syncTargetUi(): void {
  const learned = eq.hasLearnedTarget();
  const refOption = targetMode.querySelector<HTMLOptionElement>('option[value="ref"]');
  if (refOption) refOption.disabled = !learned;
  targetMode.value = learned ? "ref" : "own";
  refState.textContent = learned ? "Reference saved" : "No reference saved";
}

saveRefButton.addEventListener("click", () => {
  if (!eq.learnTarget()) {
    statusText.textContent = "Use LEARN on the reference song first.";
    return;
  }
  syncTargetUi();
  statusText.textContent = "Saved this song's tone as the target. Open another song to compare.";
});

targetMode.addEventListener("change", () => {
  // 기준 곡은 저장할 때만 켜지고, Own trend를 고르면 저장한 기준을 버린다.
  if (targetMode.value === "own") eq.clearTarget();
  syncTargetUi();
});

resetButton.addEventListener("click", () => {
  if (learning) stopLearning();
  clearLearned();
  eq.reset();
  statusText.textContent = "Cleared learned bands and analysis.";
});

// ---------------------------------------------------------------------------
// 사용자 EQ 밴드 (Pro-Q처럼 직접 만들고 지운다)

const MAX_BANDS = 24;
const STORAGE_KEY = "auto-eq:bands:v1";
const TYPES = Object.keys(FILTER_LABELS) as FilterType[];

function loadBands(): UserBand[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item): UserBand[] => {
      const b = item as Partial<UserBand> | null;
      const type = TYPES.find((t) => t === b?.type);
      if (!b || !type) return [];
      const { id, freq, gain, q } = b;
      if (typeof id !== "number" || typeof freq !== "number" || typeof gain !== "number" || typeof q !== "number") return [];
      if (![id, freq, gain, q].every(Number.isFinite)) return [];
      return [{
        id,
        type,
        freq: clamp(freq, MIN_FREQ, MAX_FREQ),
        gain: clamp(gain, -MAX_GAIN, MAX_GAIN),
        q: clamp(q, MIN_Q, MAX_Q),
        enabled: b.enabled !== false,
        ...(b.learned === true && typeof b.base === "number" && Number.isFinite(b.base) ? { learned: true, base: b.base } : {}),
        ...(parseDyn(b.dyn) ? { dyn: parseDyn(b.dyn)! } : {}),
      }];
    });
  } catch {
    return [];
  }
}

/** 저장된 다이나믹 설정을 검증한다. 값이 이상하면 기본값으로 채우고, 형식이 틀리면 버린다. */
function parseDyn(raw: unknown): DynSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<DynSettings>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    enabled: d.enabled === true,
    threshold: clamp(num(d.threshold, DEFAULT_DYN.threshold), -90, 0),
    range: clamp(num(d.range, DEFAULT_DYN.range), -18, 18),
    attack: clamp(num(d.attack, DEFAULT_DYN.attack), 0.5, 200),
    release: clamp(num(d.release, DEFAULT_DYN.release), 5, 3000),
    mode: d.mode === "below" ? "below" : "above",
  };
}

function saveBands(): void {
  try {
    // 자동 밴드는 곡마다 새로 찾으므로 저장하지 않는다.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bands.filter((b) => !b.auto)));
  } catch {
    // 저장이 막혀 있어도 EQ는 동작해야 한다.
  }
}

let bands: UserBand[] = loadBands();
let selectedId: number | null = null;
let nextId = bands.reduce((m, b) => Math.max(m, b.id), 0) + 1;

const stripEl = $("band-strip");
const barEl = $("band-bar");
const popEl = $("band-pop");

const selected = (): UserBand | undefined => bands.find((b) => b.id === selectedId);

/** 노드를 세로로 놓을 dB. gain이 없는 종류는 0선 위에 둔다. */
const nodeDb = (b: UserBand) => (hasGain(b.type) ? b.gain : 0);

const handlers = {
  find: (id: number) => bands.find((b) => b.id === id),
  patch: (id: number, patch: Partial<UserBand>) => patchBand(id, patch),
  select: (id: number) => select(id),
  remove: (id: number) => removeBand(id),
};

/** 그래프 아래 편집 막대와 그래프 위 팝업은 선택한 밴드의 것만 만들어 두고 값을 갱신한다. */
const views: Record<"bar" | "pop", { id: number; view: BandView } | null> = { bar: null, pop: null };

function syncSelectedView(kind: "bar" | "pop", host: HTMLElement, sel: UserBand | undefined): void {
  if (!sel) {
    views[kind] = null;
    if (kind === "pop") {
      host.hidden = true;
    } else {
      const hint = document.createElement("span");
      hint.className = "empty";
      hint.textContent = bands.length ? "Select a band to edit its type and values here." : "Double-click the graph or press + to create your first band.";
      host.replaceChildren(hint);
    }
    return;
  }
  let v = views[kind];
  if (!v || v.id !== sel.id) {
    host.replaceChildren();
    v = { id: sel.id, view: createBandView(sel.id, handlers, kind) };
    views[kind] = v;
    host.append(v.view.el);
  }
  v.view.sync(sel, bands.indexOf(sel), true);
  host.hidden = false;
}

/**
 * 밴드 탭 줄: 번호, 주파수, 게인을 한눈에 보고 눌러서 고른다. 끝의 +로 새 밴드를 만든다.
 * 자동 밴드가 계속 움직이므로 줄을 통째로 다시 만들지 않고, 밴드마다 탭을 하나씩 두고 글자만 갱신한다.
 * (다시 만들면 누르는 도중에 탭이 바뀌어 클릭이 사라진다.)
 */
interface TabRef {
  tab: HTMLButtonElement;
  badge: HTMLElement;
  text: HTMLElement;
  gain: HTMLElement;
}
const tabs = new Map<number, TabRef>();
const TAB_LABELS: Record<FilterType, string> = { bell: "", lowshelf: "LS", highshelf: "HS", highpass: "HP", lowpass: "LP", notch: "NT" };
/** 같은 글자면 건드리지 않는다. 움직이는 밴드의 숫자가 매 프레임 DOM을 갱신하며 깜박이지 않게 한다. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

const addTab = $<HTMLButtonElement>("add-band");
addTab.addEventListener("click", () => addBand(1000, 0));
const clearTab = $<HTMLButtonElement>("clear-bands");
clearTab.addEventListener("click", () => {
  bands = [];
  autoTargets.clear();
  select(null);
});
// 휠로 탭 줄을 가로로 민다.
stripEl.addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    stripEl.scrollLeft += e.deltaY;
    e.preventDefault();
  },
  { passive: false },
);

function renderStrip(): void {
  for (const [id, ref] of tabs) {
    if (!bands.some((b) => b.id === id)) {
      ref.tab.remove();
      tabs.delete(id);
    }
  }
  bands.forEach((b, i) => {
    let ref = tabs.get(b.id);
    if (!ref) {
      const tab = document.createElement("button");
      tab.type = "button";
      const badge = document.createElement("span");
      badge.className = "badge";
      const text = document.createElement("span");
      const gain = document.createElement("small");
      tab.append(badge, text, gain);
      tab.addEventListener("click", () => select(b.id));
      ref = { tab, badge, text, gain };
      tabs.set(b.id, ref);
    }
    const cls = "tab" + (b.id === selectedId ? " on" : "") + (b.enabled ? "" : " off") + (b.auto || b.learned ? " auto" : "");
    if (ref.tab.className !== cls) ref.tab.className = cls;
    setText(ref.badge, String(i + 1));
    setText(ref.text, formatFreq(b.freq));
    setText(ref.gain, hasGain(b.type) ? `${b.gain > 0 ? "+" : ""}${b.gain.toFixed(1)}` : TAB_LABELS[b.type]);
    if (stripEl.children[i] !== ref.tab) stripEl.insertBefore(ref.tab, stripEl.children[i] ?? null);
  });
  addTab.disabled = bands.length >= MAX_BANDS;
  clearTab.hidden = bands.length === 0;
  // 고른 밴드가 가려져 있으면 보이는 곳까지 탭 줄을 민다(화면 전체는 움직이지 않는다).
  const sel = selectedId === null ? undefined : tabs.get(selectedId)?.tab;
  if (sel && selectedId !== lastRevealed) {
    const left = sel.offsetLeft - stripEl.offsetLeft;
    if (left < stripEl.scrollLeft + 10) stripEl.scrollLeft = Math.max(0, left - 10);
    else if (left + sel.offsetWidth > stripEl.scrollLeft + stripEl.clientWidth - 18)
      stripEl.scrollLeft = left + sel.offsetWidth - stripEl.clientWidth + 18;
  }
  lastRevealed = selectedId;
}
let lastRevealed: number | null = null;

function syncViews(): void {
  renderStrip();
  const sel = selected();
  syncSelectedView("bar", barEl, sel);
  syncSelectedView("pop", popEl, sel);
}

let placedFor: number | null = null;
let popBusy = false;
popEl.addEventListener("pointerdown", () => {
  popBusy = true;
});
document.addEventListener("pointerup", () => {
  popBusy = false;
});
document.addEventListener("pointercancel", () => {
  popBusy = false;
});

/**
 * 선택한 밴드의 팝업을 그 점 옆에 놓는다. 그래프 밖으로 나가면 안쪽으로 밀어 넣는다.
 * 팝업 안의 값을 만지는 동안에는 점이 움직여도 팝업을 옮기지 않는다(끌고 있는 칸이 손 밑에서 달아나지 않게).
 */
function positionPopup(): void {
  const sel = selected();
  if (!sel || popEl.hidden) {
    placedFor = null;
    return;
  }
  // 그래프에서 점을 끄는 동안에는 점을 가리지 않도록 숨긴다.
  popEl.style.visibility = dragging !== null ? "hidden" : "";
  const editing = popBusy || popEl.matches(":hover") || popEl.contains(document.activeElement);
  if (editing && placedFor === sel.id) return;
  placedFor = sel.id;

  const m = eqMapper(eqCanvas);
  const nx = m.xOf(sel.freq);
  const ny = m.yOf(clamp(nodeDb(sel), -EQ_RANGE_DB, EQ_RANGE_DB));
  const w = popEl.offsetWidth;
  const h = popEl.offsetHeight;
  const wrapW = eqCanvas.clientWidth;
  const wrapH = eqCanvas.clientHeight;
  const gapX = 18;
  const gapY = 14;
  let left = nx + gapX;
  if (left + w > wrapW - 4) left = nx - gapX - w;
  left = clamp(left, 4, Math.max(4, wrapW - w - 4));
  let top = ny - h - gapY;
  if (top < 4) top = ny + gapY + 4;
  top = clamp(top, 4, Math.max(4, wrapH - h - 4));
  popEl.style.left = `${left}px`;
  popEl.style.top = `${top}px`;
}

function refresh(): void {
  syncViews();
  saveBands();
}

function select(id: number | null): void {
  selectedId = id;
  refresh();
}

function addBand(freq: number, gain: number, type: FilterType = "bell"): void {
  // VST 파라미터는 개수가 정해져 있어야 하므로 밴드 수에 상한을 둔다.
  if (bands.length >= MAX_BANDS) {
    statusText.textContent = `You can have at most ${MAX_BANDS} bands.`;
    return;
  }
  const band: UserBand = {
    id: nextId++,
    type,
    freq: clamp(freq, MIN_FREQ, MAX_FREQ),
    gain: hasGain(type) ? clamp(gain, -MAX_GAIN, MAX_GAIN) : 0,
    q: defaultQ(type),
    enabled: true,
  };
  bands.push(band);
  select(band.id);
}

/** 사용자가 만진 자동 밴드는 내 밴드로 굳는다. */
function adopt(b: UserBand): void {
  if (!b.auto && !b.learned) return;
  delete b.auto;
  delete b.learned;
  delete b.base;
  autoTargets.delete(b.id);
}

function removeBand(id: number): void {
  const gone = bands.find((b) => b.id === id);
  // 학습 중에 지운 자동 밴드가 바로 다시 생기지 않도록 그 자리를 비워 둔다.
  if (gone?.auto) blocked.push(Math.log2(gone.freq));
  autoTargets.delete(id);
  bands = bands.filter((b) => b.id !== id);
  select(selectedId === id ? null : selectedId);
}

function patchBand(id: number, patch: Partial<UserBand>): void {
  const b = bands.find((v) => v.id === id);
  if (!b) return;
  if (patch.type && patch.type !== b.type) {
    // 종류가 바뀌면 그 종류에 맞는 기본 Q로 시작하고, 게인이 없는 종류는 0으로 맞춘다.
    patch = { ...patch, q: defaultQ(patch.type), gain: hasGain(patch.type) ? b.gain : 0 };
  }
  adopt(b);
  Object.assign(b, patch);
  selectedId = id;
  refresh();
}

// ---------------------------------------------------------------------------
// 자동 밴드: 분석으로 찾은 보정량을 EQ 밴드로 바꿔 놓고, 같은 밴드들이 부드럽게 움직이며 최적값을 따라간다.

const FIT_INTERVAL_MS = 150;
/** 밴드가 목표값으로 다가가는 데 걸리는 시간 규모(초). 짧으면 파르르 떨고 길면 굼뜬다. */
const SMOOTH_SECONDS = 0.45;
/** 새 밴드가 이미 있는 자동 밴드와 같은 밴드로 이어지는 최대 거리(옥타브) */
const MATCH_OCT = 0.75;
/** 지운·고정한 자리 주변(옥타브)에는 자동 밴드를 다시 놓지 않는다. */
const BLOCK_OCT = 0.5;

/** 새 밴드는 같은 자리에서 이만큼(ms) 계속 제안돼야 놓는다. 순간적으로 튀는 값에 밴드가 깜박이지 않게 한다. */
const SPAWN_DELAY_MS = 600;
/** 기존 밴드는 짝이 사라져도 이만큼(ms)은 그 자리를 지킨다. 목표가 잠깐 흔들려도 밴드가 사라졌다 생기지 않게 한다. */
const GRACE_MS = 2000;

const autoTargets = new Map<number, AutoBandFit>();
const lastMatched = new Map<number, number>();
/** 아직 놓지 않은 제안이 처음 나온 시각. 키는 1/3옥타브 단위 주파수 */
const proposed = new Map<number, number>();
let blocked: number[] = [];
let lastFit = 0;
let lastUiSync = 0;

/** 분석 결과로 자동 밴드들의 목표값을 정한다. 이미 있는 밴드는 가장 가까운 것을 이어 쓴다. */
function retargetAutoBands(now: number): void {
  const manual = bands.filter((b) => !b.auto).length;
  const room = Math.max(0, Math.min(maxAutoBands, MAX_BANDS - manual));
  const wanted =
    learning && eq.hasData()
      ? fitBands(layout.centers, eq.correction(), { maxBands: room, minGainDb: 0.5 }).filter(
          (f) => !blocked.some((l) => Math.abs(Math.log2(f.freq) - l) < BLOCK_OCT),
        )
      : [];

  const autos = bands.filter((b) => b.auto);
  const pairs: { band: UserBand; fit: number; d: number }[] = [];
  autos.forEach((band) =>
    wanted.forEach((f, fi) => pairs.push({ band, fit: fi, d: Math.abs(Math.log2(f.freq / band.freq)) })),
  );
  pairs.sort((x, y) => x.d - y.d);
  const usedBands = new Set<number>();
  const usedFits = new Set<number>();
  for (const p of pairs) {
    if (p.d > MATCH_OCT || usedBands.has(p.band.id) || usedFits.has(p.fit)) continue;
    usedBands.add(p.band.id);
    usedFits.add(p.fit);
    autoTargets.set(p.band.id, wanted[p.fit]!);
    lastMatched.set(p.band.id, now);
  }

  let changed = false;
  // 짝이 없는 제안은 한동안 계속 나올 때만 새 밴드로: 그 자리에서 게인 0으로 시작해 서서히 커진다.
  const keys = new Set<number>();
  wanted.forEach((f, fi) => {
    if (usedFits.has(fi)) return;
    const key = Math.round(Math.log2(f.freq) * 3);
    keys.add(key);
    const since = proposed.get(key) ?? now;
    proposed.set(key, since);
    if (now - since < SPAWN_DELAY_MS || bands.length >= MAX_BANDS) return;
    const band: UserBand = { id: nextId++, type: "bell", freq: f.freq, gain: 0, q: f.q, enabled: true, auto: true };
    bands.push(band);
    autoTargets.set(band.id, f);
    lastMatched.set(band.id, now);
    proposed.delete(key);
    changed = true;
  });
  for (const key of [...proposed.keys()]) if (!keys.has(key)) proposed.delete(key);

  // 짝이 없어진 기존 밴드는 잠시 제자리를 지키다가, 계속 짝이 없으면 서서히 0으로 줄어든 뒤 사라진다.
  for (const b of autos) {
    if (usedBands.has(b.id)) continue;
    const idle = now - (lastMatched.get(b.id) ?? 0);
    if (!learning || idle > GRACE_MS) autoTargets.set(b.id, { freq: b.freq, gain: 0, q: b.q });
  }
  if (changed) refresh();
}

/**
 * 한 값을 목표로 부드럽게 옮긴다(임계 감쇠 스프링). 속도가 이어져서, 목표가 150ms마다 조금씩 바뀌어도
 * 밴드가 멈칫하거나 떨지 않고 미끄러지듯 따라간다.
 */
function smoothDamp(current: number, target: number, velocity: number, dt: number): { value: number; velocity: number } {
  const omega = 2 / SMOOTH_SECONDS;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  return { value: target + (change + temp) * decay, velocity: (velocity - omega * temp) * decay };
}

const velocities = new Map<number, { f: number; g: number; q: number }>();
let hoverId: number | null = null;

/** 사용자가 잡았거나 만지고 있는 밴드는 가만히 둔다. 움직이는 걸 쫓아가며 만질 수는 없다. */
function isHeld(id: number): boolean {
  if (id === dragging || id === hoverId) return true;
  if (id !== selectedId) return false;
  return (
    popBusy ||
    popEl.matches(":hover") ||
    barEl.matches(":hover") ||
    popEl.contains(document.activeElement) ||
    barEl.contains(document.activeElement)
  );
}

/** 자동 밴드를 목표값 쪽으로 한 걸음 옮긴다. 주파수와 Q는 로그 값으로, 게인은 dB로 다가간다. */
function glideAutoBands(dt: number): void {
  let removed = false;
  for (const b of bands) {
    if (!b.auto) continue;
    const t = autoTargets.get(b.id);
    if (!t) continue;
    const v = velocities.get(b.id) ?? { f: 0, g: 0, q: 0 };
    velocities.set(b.id, v);
    if (isHeld(b.id)) {
      v.f = v.g = v.q = 0;
      continue;
    }
    const f = smoothDamp(Math.log2(b.freq), Math.log2(t.freq), v.f, dt);
    const g = smoothDamp(b.gain, t.gain * amountScale, v.g, dt);
    const q = smoothDamp(Math.log2(b.q), Math.log2(t.q), v.q, dt);
    b.freq = 2 ** f.value;
    b.gain = g.value;
    b.q = 2 ** q.value;
    v.f = f.velocity;
    v.g = g.velocity;
    v.q = q.velocity;
  }
  const keep = bands.filter((b) => {
    const t = autoTargets.get(b.id);
    const dead = b.auto === true && t !== undefined && t.gain === 0 && Math.abs(b.gain) < 0.1 && !isHeld(b.id);
    if (dead) {
      autoTargets.delete(b.id);
      velocities.delete(b.id);
    }
    removed ||= dead;
    return !dead;
  });
  if (removed) {
    bands = keep;
    if (selectedId !== null && !bands.some((b) => b.id === selectedId)) selectedId = null;
    refresh();
  }
}

// ---------------------------------------------------------------------------
// LEARN: 누르고 곡의 대표적인 구간을 재생하면 분석이 쌓이고 밴드가 최적값을 찾아 움직인다. 다시 누르면 그 값으로 고정된다.

let learning = false;
let learnSeconds = 0;
let amountScale = 1;
let maxCorrection = 3;

/** 학습으로 만든 밴드(진행 중인 자동 밴드 포함)를 모두 지운다. */
function clearLearned(): void {
  bands = bands.filter((b) => !b.auto && !b.learned);
  autoTargets.clear();
  velocities.clear();
  lastMatched.clear();
  proposed.clear();
  blocked = [];
  if (selectedId !== null && !bands.some((b) => b.id === selectedId)) selectedId = null;
  refresh();
}

function startLearning(): void {
  clearLearned();
  eq.beginLearning();
  if (instrumentSel.value === "auto") applyInstrument(null);
  learning = true;
  learnSeconds = 0;
  syncLearnUi();
  statusText.textContent = player.paused
    ? "LEARN armed — start playback to begin analysis."
    : "Learning — play a representative section, then press STOP to lock the bands.";
}

function stopLearning(): void {
  learning = false;
  eq.endLearning();
  // 움직이던 밴드를 목표 위치에서 굳힌다. 사라지는 중이던 밴드는 버린다.
  const kept: UserBand[] = [];
  let count = 0;
  for (const b of bands) {
    if (!b.auto) {
      kept.push(b);
      continue;
    }
    const t = autoTargets.get(b.id);
    if (!t || t.gain === 0) continue;
    b.freq = t.freq;
    b.q = t.q;
    b.base = t.gain;
    b.gain = clamp(t.gain * amountScale, -maxCorrection, maxCorrection);
    delete b.auto;
    b.learned = true;
    kept.push(b);
    count++;
  }
  bands = kept;
  autoTargets.clear();
  lastMatched.clear();
  proposed.clear();
  refresh();
  syncLearnUi();
  statusText.textContent = count ? `Learning done — placed ${count} band${count === 1 ? "" : "s"}. Touch a value to make it your own.` : "Learning done — nothing stuck out enough to correct.";
}

function syncLearnUi(): void {
  learnToggle.classList.toggle("on", learning);
  learnToggle.querySelector("span")!.textContent = learning ? "STOP" : "LEARN";
  const n = bands.filter((b) => b.auto || b.learned).length;
  learnInfo.textContent = learning ? `${mmss(learnSeconds)} · ${n} band${n === 1 ? "" : "s"}` : n ? `Learned · ${n} band${n === 1 ? "" : "s"}` : "";
}

/** 강도·한도 슬라이더를 학습한 밴드의 게인에 반영한다. */
function applyLearnedGains(): void {
  for (const b of bands) {
    if (b.learned && b.base !== undefined) b.gain = clamp(b.base * amountScale, -maxCorrection, maxCorrection);
  }
  refresh();
}

learnToggle.addEventListener("click", () => {
  if (learning) stopLearning();
  else startLearning();
});

mountKnob("k-amount", {
  size: "md",
  label: "Amount",
  min: 0,
  max: 100,
  value: 100,
  reset: 100,
  title: "Scales the gain of learned bands. 0% changes nothing; 100% is the learned value.",
  format: (v) => `${Math.round(v)}%`,
  parse: parseGain,
  snap: (v) => Math.round(v),
  apply: (v) => {
    amountScale = v / 100;
    applyLearnedGains();
  },
});
mountKnob("k-max", {
  size: "sm",
  label: "Limit",
  min: 1,
  max: 6,
  value: 3,
  reset: 3,
  title: "The most one band can boost or cut. High values easily make the sound muddy.",
  format: (v) => `±${v.toFixed(1)}`,
  parse: parseGain,
  snap: (v) => Math.round(v * 2) / 2,
  apply: (v) => {
    maxCorrection = v;
    eq.setOptions({ maxCorrectionDb: v });
    applyLearnedGains();
  },
});

// 그래프 조작: 드래그로 이동, 더블클릭으로 추가/삭제, 휠로 Q
let dragging: number | null = null;

function pointer(e: MouseEvent): { x: number; y: number } {
  const rect = eqCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

type Grab = "node" | "range";
/** 끌고 있는 손잡이 종류. 노드는 주파수·게인, 마름모는 다이나믹 범위를 바꾼다. */
let dragKind: Grab = "node";

/** 마우스 아래에 있는 노드나 다이나믹 손잡이 중 가장 가까운 것 */
function hitAny(x: number, y: number): { band: UserBand; kind: Grab } | undefined {
  const m = eqMapper(eqCanvas);
  let best: { band: UserBand; kind: Grab } | undefined;
  let bestDist = Infinity;
  const consider = (band: UserBand, kind: Grab, dist: number, limit: number) => {
    if (dist <= limit && dist < bestDist) {
      best = { band, kind };
      bestDist = dist;
    }
  };
  for (const b of bands) {
    const ny = nodeDb(b);
    consider(b, "node", Math.hypot(m.xOf(b.freq) - x, m.yOf(clamp(ny, -EQ_RANGE_DB, EQ_RANGE_DB)) - y), NODE_HIT_PX);
    if (b.dyn?.enabled && hasGain(b.type) && b.enabled) {
      const d = dynLayout(m, b.freq, ny, b.dyn.range);
      // 손잡이는 작아서 노드와 겹칠 때 노드를 먼저 잡도록 판정 거리를 살짝 늘려 비교한다.
      consider(b, "range", Math.hypot(d.rangeX - x, d.rangeY - y) + 2, 11);
    }
  }
  return best;
}

const hitBand = (x: number, y: number): UserBand | undefined => hitAny(x, y)?.band;

eqCanvas.style.touchAction = "none";
eqCanvas.addEventListener("pointerdown", (e) => {
  const { x, y } = pointer(e);
  const hit = hitAny(x, y);
  select(hit?.band.id ?? null);
  if (hit) {
    dragging = hit.band.id;
    dragKind = hit.kind;
    eqCanvas.setPointerCapture(e.pointerId);
  }
});
eqCanvas.addEventListener("pointermove", (e) => {
  const { x, y } = pointer(e);
  if (dragging === null) {
    const over = hitAny(x, y);
    hoverId = over?.band.id ?? null;
    eqCanvas.style.cursor = !over ? "crosshair" : over.kind === "node" ? "grab" : "ns-resize";
    return;
  }
  const b = bands.find((v) => v.id === dragging);
  if (!b) return;
  const m = eqMapper(eqCanvas);
  adopt(b);
  if (dragKind === "range" && b.dyn) {
    // 마름모를 위아래로 끌면 범위가 바뀐다: 노드의 게인에서 끈 위치까지의 거리가 범위다.
    const range = clamp(Math.round((m.dbOf(y) - nodeDb(b)) * 10) / 10, -MAX_RANGE, MAX_RANGE);
    b.dyn = { ...b.dyn, range };
  } else {
    b.freq = clamp(m.hzOf(x), MIN_FREQ, MAX_FREQ);
    if (hasGain(b.type)) b.gain = clamp(Math.round(m.dbOf(y) * 10) / 10, -EQ_RANGE_DB, EQ_RANGE_DB);
  }
  refresh();
});
const endDrag = () => {
  dragging = null;
  dragKind = "node";
};
eqCanvas.addEventListener("pointerleave", () => {
  hoverId = null;
});
eqCanvas.addEventListener("pointerup", endDrag);
eqCanvas.addEventListener("pointercancel", endDrag);
eqCanvas.addEventListener("dblclick", (e) => {
  const { x, y } = pointer(e);
  const hit = hitAny(x, y);
  // 다이나믹 손잡이를 더블클릭해도 밴드를 지우거나 새로 만들지 않는다.
  if (hit) {
    if (hit.kind === "node") removeBand(hit.band.id);
    return;
  }
  const m = eqMapper(eqCanvas);
  addBand(m.hzOf(x), Math.round(m.dbOf(y) * 10) / 10);
});
eqCanvas.addEventListener(
  "wheel",
  (e) => {
    const { x, y } = pointer(e);
    const target = hitBand(x, y) ?? selected();
    if (!target || !hasQ(target.type)) return;
    e.preventDefault();
    adopt(target);
    // 휠 한 칸(보통 deltaY 100)이 너무 크게 건너뛰지 않도록 한 번에 움직이는 양을 제한한다.
    target.q = clamp(target.q * Math.exp(-clamp(e.deltaY, -120, 120) * 0.0012), MIN_Q, MAX_Q);
    selectedId = target.id;
    refresh();
  },
  { passive: false },
);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (selectedId !== null) removeBand(selectedId);
});

// ---------------------------------------------------------------------------
// 재생과 화면 갱신

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  if (learning) stopLearning();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  player.src = objectUrl;
  // 소스가 바뀌면 이전 곡의 평균이 새 곡의 보정에 섞이지 않도록 비운다.
  eq.reset();
  playButton.disabled = true;
  statusText.textContent = `${file.name} — press play.`;
});

let seeking = false;
playButton.addEventListener("click", () => {
  if (player.paused) void player.play();
  else player.pause();
});
const syncPlayIcon = () => {
  playButton.textContent = player.paused ? "▶" : "❚❚";
};
player.addEventListener("play", syncPlayIcon);
player.addEventListener("pause", syncPlayIcon);
player.addEventListener("ended", () => {
  syncPlayIcon();
  if (learning) stopLearning();
});
player.addEventListener("loadedmetadata", () => {
  playButton.disabled = false;
});
seek.addEventListener("pointerdown", () => {
  seeking = true;
});
seek.addEventListener("input", () => {
  if (Number.isFinite(player.duration)) player.currentTime = (player.duration * Number(seek.value)) / 1000;
});
seek.addEventListener("change", () => {
  seeking = false;
});

player.addEventListener("play", async () => {
  // AudioContext와 MediaElementSource는 사용자 조작 이후에 한 번만 만든다.
  engine ??= new Engine(player, layout);
  liveDb = null;
  liveRef = null;
  await engine.context.resume();
});

/**
 * 화면용 실시간 스펙트럼. 로그 간격 격자에서 읽어 ±1/6옥타브로 퍼뜨리고, 올라갈 땐 빠르게 내려갈 땐 느리게 따라가게 한 뒤
 * 곡 전체 높이를 지운다. 음악은 고역이 작으므로 옥타브당 4.5dB를 더해 보기 좋게 펴 준다(Pro-Q의 스펙트럼 기울기 옵션과 같다).
 */
const SPEC_FREQS = logFreqs(120);
const SPEC_TILT_DB = 4.5;
const SPEC_REF_LO = 100;
const SPEC_REF_HI = 8000;
const tilt = (hz: number) => SPEC_TILT_DB * Math.log2(hz / 1000);

let liveDb: number[] | null = null;
let liveRef: number | null = null;
let live: number[] | null = null;

/** 기준 구간(100Hz~8kHz)의 평균. 곡 전체 높이를 지우는 데 쓴다. */
function refLevel(values: readonly (number | null)[]): number {
  let sum = 0;
  let n = 0;
  SPEC_FREQS.forEach((hz, i) => {
    const v = values[i];
    if (v !== null && v !== undefined && hz >= SPEC_REF_LO && hz <= SPEC_REF_HI) {
      sum += v;
      n++;
    }
  });
  return n ? sum / n : 0;
}

function updateLive(db: number[], dt: number): void {
  const tilted = db.map((v, i) => Math.max(Number.isFinite(v) ? v : -120, -120) + tilt(SPEC_FREQS[i]!));
  const attack = 1 - Math.exp(-dt / 0.05);
  const release = 1 - Math.exp(-dt / 0.45);
  liveDb = liveDb
    ? liveDb.map((p, i) => p + ((tilted[i] ?? p) - p) * ((tilted[i] ?? p) > p ? attack : release))
    : tilted;
  // 기준 높이는 천천히 따라가서, 음량이 순간적으로 바뀌어도 스펙트럼 전체가 위아래로 출렁이지 않는다.
  const mean = refLevel(liveDb);
  liveRef = liveRef === null ? mean : liveRef + (mean - liveRef) * (1 - Math.exp(-dt / 1.5));
  const ref = liveRef;
  live = liveDb.map((v) => v - ref);
}

/** 밴드 중심별 학습 평균을 같은 격자 위의 매끈한 곡선으로 늘인다(Catmull-Rom). 밴드가 없는 범위는 null */
function profileOnGrid(): (number | null)[] {
  const values = eq.aligned();
  const logs = layout.centers.map((c) => Math.log2(c));
  const n = logs.length;
  const step = ((logs[n - 1] ?? 0) - (logs[0] ?? 0)) / (n - 1);
  const raw = SPEC_FREQS.map((hz) => {
    const x = Math.log2(hz);
    if (x < (logs[0] ?? 0) || x > (logs[n - 1] ?? 0)) return null;
    const u = (x - (logs[0] ?? 0)) / step;
    const i = Math.min(n - 2, Math.floor(u));
    const t = u - i;
    const p0 = values[Math.max(i - 1, 0)] ?? 0;
    const p1 = values[i] ?? 0;
    const p2 = values[i + 1] ?? 0;
    const p3 = values[Math.min(i + 2, n - 1)] ?? 0;
    const v = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    return v + tilt(hz);
  });
  const ref = refLevel(raw);
  return raw.map((v) => (v === null ? null : v - ref));
}

/** 뒤 배경 그래프: 항상 실시간 스펙트럼을 그리고, 학습한 평균은 점선으로 겹친다. */
function analyzerView(): { freqs: readonly number[]; levels: readonly number[]; profile?: readonly (number | null)[] } | null {
  if (!live) return null;
  return { freqs: SPEC_FREQS, levels: live, ...(eq.hasData() ? { profile: profileOnGrid() } : {}) };
}

const toSpec = (b: UserBand): FilterSpec => ({ id: b.id, type: b.type, freq: b.freq, gain: hasGain(b.type) ? b.gain : 0, q: b.q });

/** 선택한 밴드 하나의 응답을 그릴 때 쓰는 값(다이나믹이면 지금 실제 게인) */
function selSpec(b: UserBand): FilterSpec {
  const st = b.dyn?.enabled ? dynState.get(b.id) : undefined;
  return st ? { ...toSpec(b), gain: st.gain } : toSpec(b);
}

function liveY(b: UserBand): { liveY?: number; dyn?: { range: number } } {
  const st = b.dyn?.enabled && hasGain(b.type) ? dynState.get(b.id) : undefined;
  return st && b.dyn ? { liveY: st.gain, dyn: { range: b.dyn.range } } : {};
}

/** 다이나믹 밴드마다 따로 이어 가는 상태: 작동 정도(0~1), 마지막 대역 레벨, 지금 실제 게인 */
const dynState = new Map<number, { amount: number; level: number; gain: number }>();

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;

  timeText.textContent = `${mmss(player.currentTime)} / ${mmss(player.duration)}`;
  if (!seeking && Number.isFinite(player.duration) && player.duration > 0) {
    seek.value = String((player.currentTime / player.duration) * 1000);
  }

  if (engine && !player.paused && !player.ended) {
    if (learning) {
      if (eq.update(engine.readBands(), dt)) learnSeconds += dt;
      statusText.textContent = `Learning ${mmss(learnSeconds)} — play a representative section, then press STOP.`;
    }
    updateLive(engine.readSpectrum(SPEC_FREQS), dt);
  }

  // 자동 밴드: 목표는 일정 간격으로 다시 정하고, 움직임은 매 프레임 이어 간다.
  if (learning && now - lastFit >= FIT_INTERVAL_MS) {
    lastFit = now;
    updateInstrument(now);
    retargetAutoBands(now);
  }
  glideAutoBands(dt);
  // 움직이는 밴드의 숫자·탭·편집창은 초당 8번만 갱신한다. 매 프레임 바꾸면 숫자가 깜박이고 눈이 피곤하다.
  if (now - lastUiSync >= 120 && bands.some((b) => b.auto)) {
    lastUiSync = now;
    syncViews();
    syncLearnUi();
  }

  // 원본 듣기면 모두 끈다.
  const bypass = bypassBox.checked;
  const active = bypass ? [] : bands.filter((b) => b.enabled);
  const playing = !player.paused && !player.ended;
  const levels = engine?.readDetectorLevels(playing) ?? new Map<number, number>();
  // 다이나믹 밴드: 대역 레벨 → 작동 정도(어택·릴리즈로 부드럽게) → 실제 게인
  const user: FilterSpec[] = active.map((b) => {
    const dyn = b.dyn?.enabled && hasGain(b.type) ? b.dyn : null;
    if (!dyn) {
      dynState.delete(b.id);
      return toSpec(b);
    }
    const st = dynState.get(b.id) ?? { amount: 0, level: -100, gain: b.gain };
    st.level = levels.get(b.id) ?? -100;
    st.amount = smoothAmount(st.amount, dynamicTarget(st.level, dyn), dt, dyn.attack, dyn.release);
    st.gain = b.gain + dyn.range * st.amount;
    dynState.set(b.id, st);
    return { ...toSpec(b), gain: st.gain, dynamic: true };
  });
  const headroom = headroomDb(user);
  engine?.apply(user, headroom);

  const selBand = selected();
  const selState = selBand ? dynState.get(selBand.id) : undefined;
  if (selBand && selState && selBand.dyn?.enabled) {
    const change = selState.gain - selBand.gain;
    views.bar?.view.setLevel(selState.level, change);
    views.pop?.view.setLevel(selState.level, change);
  }

  const sel = selected();
  // 다이나믹 밴드마다 "쉴 때 ~ 완전히 작동했을 때" 곡선 쌍을 만들어 그래프에 색 띠로 보여 준다.
  const ranges = active.flatMap((b) => {
    if (!b.dyn?.enabled || !hasGain(b.type)) return [];
    const spec = toSpec(b);
    return [{
      a: responseDb([spec], curveFreqs),
      b: responseDb([{ ...spec, gain: clamp(b.gain + b.dyn.range, -MAX_GAIN, MAX_GAIN) }], curveFreqs),
      selected: b.id === selectedId,
    }];
  });
  drawEqCurve(eqCanvas, {
    ranges,
    analyzer: analyzerView(),
    freqs: curveFreqs,
    responseDb: responseDb(user, curveFreqs),
    nodes: bands.map((b) => ({ id: b.id, freq: b.freq, y: nodeDb(b), enabled: b.enabled && !bypass, auto: !!(b.auto || b.learned), ...liveY(b) })),
    selectedId,
    selectedResponseDb: sel?.enabled ? responseDb([selSpec(sel)], curveFreqs) : null,
  });
  positionPopup();
  requestAnimationFrame(frame);
}
syncTargetUi();
syncLearnUi();
refresh();
requestAnimationFrame(frame);
