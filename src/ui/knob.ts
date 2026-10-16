// 회전 노브: 눈금 둘레, 굵은 값 호, 호 끝의 점, 안쪽 원 가운데에 값을 크게 적는 평평한 SVG 노브.
// 위아래로 끌어서 바꾸고(Shift는 미세 조정), 휠과 방향키도 된다. 한 번 누르면 값을 직접 쓸 수 있고, 빠르게 두 번 누르면 기본값으로 돌아간다.
// 크기(lg/md/sm)로 위계를 나눈다: 메인 값은 크게, 보조 값은 작게.

export type KnobSize = "lg" | "md" | "sm";

export interface KnobOptions {
  label: string;
  size?: KnobSize;
  min: number;
  max: number;
  /** 로그 눈금(주파수, Q, 시간처럼 곱으로 느끼는 값) */
  log?: boolean;
  /** 0이 가운데인 값(게인, 범위). 호가 가운데에서부터 칠해진다 */
  bipolar?: boolean;
  get(): number;
  set(value: number): void;
  format(value: number): string;
  parse(text: string): number | null;
  /** 더블클릭하면 돌아갈 값 */
  reset?: number;
  title?: string;
}

export interface Knob {
  el: HTMLElement;
  sync(): void;
  setVisible(visible: boolean): void;
}

const START_DEG = 135;
const SWEEP_DEG = 270;
const C = 36; // viewBox 72의 중심
/** 큰 노브는 눈금 둘레를 두르고 호를 안쪽에 둔다. 작은 노브는 눈금을 빼고 호를 바깥으로 밀어 안쪽 원(값이 들어가는 곳)을 키운다. */
const R_ARC_LARGE = 29;
const R_ARC_SMALL = 32.5;
const R_BODY_LARGE = 22;
const R_BODY_SMALL = 26;
const R_TICK_IN = 33;
const R_TICK_OUT = 35.2;
/** 끌어서 처음부터 끝까지 가는 데 필요한 거리(px) */
const DRAG_PX = 180;
/** 이 거리(px) 안에서 뗀 것은 끌기가 아니라 클릭으로 본다 */
const CLICK_PX = 3;
/** 이 시간(ms) 안에 다시 누르면 더블클릭(리셋)으로 본다 */
const DOUBLE_MS = 350;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function polar(deg: number, r: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: C + r * Math.cos(rad), y: C + r * Math.sin(rad) };
}

/** 두 각도 사이의 호 경로. from→to가 시계 방향이면 sweep=1 */
function arc(from: number, to: number, r: number): string {
  if (Math.abs(to - from) < 0.01) return "";
  const a = polar(from, r);
  const b = polar(to, r);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function createKnob(o: KnobOptions): Knob {
  const toT = (v: number) =>
    clamp01(o.log ? Math.log(Math.max(v, o.min) / o.min) / Math.log(o.max / o.min) : (v - o.min) / (o.max - o.min));
  const fromT = (t: number) => (o.log ? o.min * (o.max / o.min) ** clamp01(t) : o.min + (o.max - o.min) * clamp01(t));

  const large = o.size === "lg";
  const R_ARC = large ? R_ARC_LARGE : R_ARC_SMALL;
  const el = document.createElement("div");
  el.className = `knob k-${o.size ?? "md"}`;
  if (o.title) el.title = o.title;

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 72 72");
  svg.setAttribute("role", "slider");
  svg.setAttribute("tabindex", "0");
  svg.setAttribute("aria-label", o.label);
  const el_ = <K extends keyof SVGElementTagNameMap>(tag: K, cls: string) => {
    const n = document.createElementNS(NS, tag);
    n.setAttribute("class", cls);
    return n;
  };

  // 둘레 눈금 11개: 양 끝과 가운데(0이 가운데인 값)는 조금 더 길고 진하다.
  const ticks = el_("g", "k-ticks");
  for (let i = 0; i <= 10; i++) {
    const deg = START_DEG + (SWEEP_DEG * i) / 10;
    const a = polar(deg, R_TICK_IN);
    const b = polar(deg, R_TICK_OUT);
    const t = el_("line", i === 0 || i === 10 || (o.bipolar && i === 5) ? "k-tick major" : "k-tick");
    t.setAttribute("x1", a.x.toFixed(2));
    t.setAttribute("y1", a.y.toFixed(2));
    t.setAttribute("x2", b.x.toFixed(2));
    t.setAttribute("y2", b.y.toFixed(2));
    ticks.append(t);
  }
  const track = el_("path", "k-track");
  track.setAttribute("d", arc(START_DEG, START_DEG + SWEEP_DEG, R_ARC));
  const value = el_("path", "k-value");
  const body = el_("circle", "k-body");
  body.setAttribute("cx", String(C));
  body.setAttribute("cy", String(C));
  body.setAttribute("r", String(large ? R_BODY_LARGE : R_BODY_SMALL));
  const dot = el_("circle", "k-dot");
  dot.setAttribute("r", "3.2");
  if (large) svg.append(ticks);
  svg.append(track, value, body, dot);

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.autocomplete = "off";
  input.setAttribute("aria-label", `${o.label} value`);

  const face = document.createElement("div");
  face.className = "k-face";
  face.append(svg, input);

  const label = document.createElement("span");
  label.className = "k-label";
  label.textContent = o.label;
  el.append(face, label);

  const sync = () => {
    const v = o.get();
    const t = toT(v);
    const deg = START_DEG + SWEEP_DEG * t;
    const origin = o.bipolar ? START_DEG + SWEEP_DEG / 2 : START_DEG;
    value.setAttribute("d", arc(origin, deg, R_ARC));
    const end = polar(deg, R_ARC);
    dot.setAttribute("cx", end.x.toFixed(2));
    dot.setAttribute("cy", end.y.toFixed(2));
    svg.setAttribute("aria-valuenow", String(v));
    if (document.activeElement !== input) input.value = o.format(v);
  };

  const commit = () => {
    const parsed = o.parse(input.value);
    if (parsed !== null && Number.isFinite(parsed)) o.set(parsed);
    input.value = o.format(o.get());
  };
  input.addEventListener("change", commit);
  input.addEventListener("focus", () => input.select());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") svg.focus();
    else if (e.key === "Escape") {
      input.value = o.format(o.get());
      svg.focus();
    }
  });
  input.addEventListener("blur", () => {
    input.value = o.format(o.get());
  });

  // 위아래로 끌기. 거의 움직이지 않고 떼면 클릭이다: 한 번이면 값 입력, 빠른 두 번이면 리셋.
  let drag: { x: number; y: number; t: number; moved: boolean } | null = null;
  let lastClick = 0;
  svg.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    svg.focus();
    drag = { x: e.clientX, y: e.clientY, t: toT(o.get()), moved: false };
    svg.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < CLICK_PX) return;
    drag.moved = true;
    const px = e.shiftKey ? DRAG_PX * 5 : DRAG_PX;
    o.set(fromT(drag.t + (drag.y - e.clientY) / px));
    sync();
  });
  svg.addEventListener("pointerup", () => {
    const wasDrag = drag?.moved ?? false;
    drag = null;
    el.classList.remove("dragging");
    if (wasDrag) return;
    const now = performance.now();
    if (now - lastClick < DOUBLE_MS) {
      lastClick = 0;
      if (o.reset !== undefined) {
        o.set(o.reset);
        sync();
      }
    } else {
      lastClick = now;
      input.focus();
    }
  });
  svg.addEventListener("pointercancel", () => {
    drag = null;
    el.classList.remove("dragging");
  });
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const step = (e.shiftKey ? 0.004 : 0.02) * (e.deltaY < 0 ? 1 : -1);
      o.set(fromT(toT(o.get()) + step));
      sync();
    },
    { passive: false },
  );
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : -1;
    o.set(fromT(toT(o.get()) + dir * (e.shiftKey ? 0.004 : 0.02)));
    sync();
  });

  return { el, sync, setVisible: (visible) => el.classList.toggle("na", !visible) };
}
