// EQ 그래프: 곡의 스펙트럼(분석기) 위에 EQ 응답 곡선과 밴드 노드를 그린다.
// 그라데이션·글로우·점선 없이 단색과 가는 실선만 쓴다. 색은 index.html의 CSS 변수를 그대로 읽는다.

const MIN_HZ = 20;
const MAX_HZ = 20000;
const PAD = { left: 38, right: 10, top: 10, bottom: 22 };

interface Palette {
  grid: string;
  text: string;
  target: string;
  input: string;
  result: string;
  boost: string;
  cut: string;
  analyzer: string;
  auto: string;
  dyn: string;
  bg: string;
}

/** "#rrggbb" 색에 알파를 붙여 canvas에서 쓸 수 있는 rgba 문자열로 만든다. 읽을 수 없으면 그대로 돌려준다. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function palette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    grid: v("--line"),
    text: v("--muted"),
    target: v("--c-target"),
    input: v("--c-input"),
    result: v("--c-result"),
    boost: v("--c-boost"),
    cut: v("--c-cut"),
    analyzer: v("--c-analyzer"),
    auto: v("--c-auto"),
    dyn: v("--c-dyn"),
    bg: v("--bg"),
  };
}

/** 캔버스 CSS 크기와 세로 범위(±dB)로 좌표 변환 함수를 만든다. */
function geometry(width: number, height: number, range: number) {
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const logSpan = Math.log(MAX_HZ / MIN_HZ);
  return {
    plotW,
    plotH,
    xOf: (hz: number) => PAD.left + (Math.log(hz / MIN_HZ) / logSpan) * plotW,
    yOf: (db: number) => PAD.top + plotH / 2 - (db / range) * (plotH / 2),
    hzOf: (x: number) => MIN_HZ * Math.exp(((x - PAD.left) / plotW) * logSpan),
    dbOf: (y: number) => ((PAD.top + plotH / 2 - y) / (plotH / 2)) * range,
  };
}

interface Frame {
  ctx: CanvasRenderingContext2D;
  p: Palette;
  plotW: number;
  plotH: number;
  xOf: (hz: number) => number;
  yOf: (db: number) => number;
}

/**
 * 캔버스 크기를 화면 배율에 정확히 맞추고, 축과 격자까지 그린 뒤 좌표 변환 함수를 돌려준다.
 * 캔버스 버퍼를 (CSS 크기 × 배율)의 정수로 잡고 그 비율 그대로 그려서, 가로 폭이 소수여도 선이 번지거나 깨지지 않는다.
 * 격자선은 기기 픽셀 한가운데에 놓아 1px로 또렷하게 그린다.
 */
function frame(canvas: HTMLCanvasElement, range: number, step: number): Frame {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const bw = Math.max(1, Math.round(width * dpr));
  const bh = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const sx = bw / width;
  const sy = bh / height;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const p = palette();
  const { plotW, plotH, xOf, yOf } = geometry(width, height, range);
  const snapX = (x: number) => (Math.round(x * sx - 0.5) + 0.5) / sx;
  const snapY = (y: number) => (Math.round(y * sy - 0.5) + 0.5) / sy;
  const bottom = PAD.top + plotH;
  const right = width - PAD.right;

  ctx.lineWidth = 1 / Math.min(sx, sy);
  // 주파수 격자: 100, 1k, 10k는 조금 진하게
  const decade = new Set([100, 1000, 10000]);
  const lines: number[] = [];
  for (const base of [10, 100, 1000, 10000]) for (let k = 1; k <= 9; k++) lines.push(base * k);
  for (const hz of lines) {
    if (hz < 20 || hz > 20000) continue;
    const x = snapX(xOf(hz));
    ctx.strokeStyle = decade.has(hz) ? withAlpha(p.text, 0.28) : withAlpha(p.text, 0.1);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  // dB 격자: 0dB선은 또렷하게
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let db = -range; db <= range; db += step) {
    const y = snapY(yOf(db));
    ctx.strokeStyle = db === 0 ? withAlpha(p.text, 0.45) : withAlpha(p.text, 0.1);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillStyle = db === 0 ? p.text : withAlpha(p.text, 0.7);
    ctx.fillText(db > 0 ? `+${db}` : `${db}`, Math.round(PAD.left - 7), Math.round(yOf(db)));
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const hz of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    ctx.fillStyle = withAlpha(p.text, decade.has(hz) ? 0.95 : 0.7);
    const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
    // 맨 끝 눈금은 잘리지 않게 안쪽으로 민다
    const tx = Math.max(PAD.left + 6, Math.min(right - 6, xOf(hz)));
    ctx.fillText(label, Math.round(tx), Math.round(bottom + 6));
  }
  return { ctx, p, plotW, plotH, xOf, yOf };
}

function polyline(
  f: Frame,
  freqs: readonly number[],
  values: readonly number[],
  color: string,
  widthPx: number,
): void {
  f.ctx.strokeStyle = color;
  f.ctx.lineWidth = widthPx;
  f.ctx.lineJoin = "round";
  f.ctx.beginPath();
  freqs.forEach((hz, i) => {
    const x = f.xOf(hz);
    const y = f.yOf(values[i] ?? 0);
    if (i === 0) f.ctx.moveTo(x, y);
    else f.ctx.lineTo(x, y);
  });
  f.ctx.stroke();
}

export const EQ_RANGE_DB = 18;

function clampDb(db: number): number {
  return Math.max(-EQ_RANGE_DB, Math.min(EQ_RANGE_DB, db));
}

/** EQ 그래프의 화면 좌표 ↔ (Hz, dB) 변환. 마우스 조작에서 쓴다. 좌표는 캔버스 왼쪽 위가 기준이다. */
export function eqMapper(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return geometry(Math.max(1, rect.width), Math.max(1, rect.height), EQ_RANGE_DB);
}

export interface EqNode {
  id: number;
  freq: number;
  /** 노드를 세로로 놓을 dB. gain이 없는 종류(하이패스 등)는 0 */
  y: number;
  enabled: boolean;
  /** 자동 보정이 만든 밴드 */
  auto: boolean;
  /** 다이나믹 밴드가 지금 실제로 거는 게인의 세로 위치(dB). 다이나믹이 아니면 없다 */
  liveY?: number;
  /** 다이나믹 설정. 그래프에서는 범위 손잡이(마름모)로 그려지고 끌어서 바꾼다 */
  dyn?: { range: number };
}

/**
 * 다이나믹 범위 손잡이의 화면 위치. 그리기와 마우스 판정이 같은 값을 쓰도록 한 곳에서 계산한다.
 * 완전히 작동했을 때 게인 위치(마름모)를 위아래로 끌면 범위가 바뀐다.
 */
export function dynLayout(m: ReturnType<typeof eqMapper>, freq: number, nodeDb: number, range: number) {
  const x = m.xOf(freq);
  return { x, y: m.yOf(clampDb(nodeDb)), rangeX: x, rangeY: m.yOf(clampDb(nodeDb + range)) };
}

/** 분석기: 로그 간격 주파수 격자(freqs)별 레벨(dB, 곡 전체 높이와 무관한 상대값) */
export interface AnalyzerView {
  freqs: readonly number[];
  /** 지금 들리는 소리의 스펙트럼(계속 움직인다) */
  levels: readonly number[];
  /** 학습 중이거나 학습한 평균. 있으면 가는 선으로 겹쳐 그린다. 학습 범위 밖은 null */
  profile?: readonly (number | null)[];
}

/** 다이나믹 밴드 하나의 움직임 범위: 쉴 때(a)와 완전히 작동했을 때(b)의 응답 곡선 */
export interface DynRange {
  a: readonly number[];
  b: readonly number[];
  selected: boolean;
}

export interface EqView {
  /** 곡의 스펙트럼. 없으면(재생 전) 그리지 않는다 */
  analyzer: AnalyzerView | null;
  freqs: readonly number[];
  /** 모든 밴드를 합친 응답 */
  responseDb: readonly number[];
  nodes: readonly EqNode[];
  selectedId: number | null;
  /** 다이나믹 밴드들이 움직이는 범위. 곡선 뒤에 옅은 띠로 깔린다 */
  ranges?: readonly DynRange[];
  /** 선택한 밴드 하나만의 응답. 없으면 null */
  selectedResponseDb: readonly number[] | null;
}

/** 분석기는 EQ 눈금(dB)과 별개의 상대 눈금이다. 평균 높이가 그래프 아래쪽 1/3 부근에 오도록 맞춘다. */
const ANALYZER_FLOOR_DB = -48;
const ANALYZER_SPAN_DB = 72;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * 점들을 지나는 부드러운 곡선(이웃 점의 중점을 잇는 2차 곡선)을 현재 경로에 이어 붙인다.
 * join이 true면 새 경로를 시작하지 않고 지금 점에서 첫 점으로 이어서 그린다(면을 닫을 때 필요하다).
 */
function smoothPath(ctx: CanvasRenderingContext2D, pts: readonly { x: number; y: number }[], join = false): void {
  if (pts.length === 0) return;
  if (join) ctx.lineTo(pts[0]!.x, pts[0]!.y);
  else ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
    const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
    ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
  }
  const last = pts[pts.length - 1]!;
  ctx.lineTo(last.x, last.y);
}

function drawAnalyzer(f: Frame, analyzer: AnalyzerView | null): void {
  if (!analyzer || analyzer.freqs.length < 3) return;
  const bottom = PAD.top + f.plotH;
  const yOf = (db: number) => bottom - clamp01((db - ANALYZER_FLOOR_DB) / ANALYZER_SPAN_DB) * f.plotH;
  const ctx = f.ctx;
  const pts = analyzer.freqs.map((hz, i) => ({ x: f.xOf(hz), y: yOf(analyzer.levels[i] ?? ANALYZER_FLOOR_DB) }));
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;

  // 면: 단색 하나
  ctx.beginPath();
  ctx.moveTo(first.x, bottom);
  smoothPath(ctx, pts, true);
  ctx.lineTo(last.x, bottom);
  ctx.closePath();
  ctx.fillStyle = withAlpha(f.p.analyzer, 0.2);
  ctx.fill();
  // 윗선
  ctx.strokeStyle = withAlpha(f.p.analyzer, 0.75);
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  ctx.beginPath();
  smoothPath(ctx, pts);
  ctx.stroke();

  // 학습 평균: 가는 실선. 학습한 범위(null이 아닌 구간)만 이어서 그린다.
  if (analyzer.profile) {
    ctx.strokeStyle = withAlpha(f.p.input, 0.85);
    ctx.lineWidth = 1;
    ctx.beginPath();
    let run: { x: number; y: number }[] = [];
    const flush = () => {
      if (run.length > 1) smoothPath(ctx, run);
      run = [];
    };
    analyzer.freqs.forEach((hz, i) => {
      const v = analyzer.profile?.[i];
      if (v === null || v === undefined) flush();
      else run.push({ x: f.xOf(hz), y: yOf(v) });
    });
    flush();
    ctx.stroke();
  }
}

/** 응답 곡선과 0dB선 사이를 칠한다. 올리는 쪽은 초록, 깎는 쪽은 주황이고 각각 단색이다. */
function fillResponse(f: Frame, freqs: readonly number[], db: readonly number[], canvasWidth: number, canvasHeight: number): void {
  const ctx = f.ctx;
  const y0 = f.yOf(0);
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(f.xOf(freqs[0]!), y0);
    freqs.forEach((hz, i) => ctx.lineTo(f.xOf(hz), f.yOf(clampDb(db[i] ?? 0))));
    ctx.lineTo(f.xOf(freqs[freqs.length - 1]!), y0);
    ctx.closePath();
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvasWidth, y0);
  ctx.clip();
  path();
  ctx.fillStyle = withAlpha(f.p.boost, 0.2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y0, canvasWidth, canvasHeight - y0);
  ctx.clip();
  path();
  ctx.fillStyle = withAlpha(f.p.cut, 0.2);
  ctx.fill();
  ctx.restore();
}

/**
 * 다이나믹 밴드의 움직임 범위: 쉴 때와 완전히 작동했을 때의 곡선 사이를 옅은 단색 띠로 칠하고,
 * 완전히 작동했을 때의 곡선은 가는 실선으로 보여 준다. 고른 밴드는 조금 더 진하게 그린다.
 */
function drawDynRange(f: Frame, freqs: readonly number[], r: DynRange): void {
  const ctx = f.ctx;
  ctx.fillStyle = withAlpha(f.p.dyn, r.selected ? 0.2 : 0.1);
  ctx.beginPath();
  freqs.forEach((hz, i) => {
    const x = f.xOf(hz);
    const y = f.yOf(clampDb(r.a[i] ?? 0));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  for (let i = freqs.length - 1; i >= 0; i--) ctx.lineTo(f.xOf(freqs[i]!), f.yOf(clampDb(r.b[i] ?? 0)));
  ctx.closePath();
  ctx.fill();
  polyline(f, freqs, r.b.map(clampDb), withAlpha(f.p.dyn, r.selected ? 0.9 : 0.45), 1);
}

/** 다이나믹 밴드의 손잡이: 노드에서 마름모(완전히 작동했을 때 게인)까지 가는 선, 지금 실제 게인(속 빈 고리) */
function drawDynamics(f: Frame, canvas: HTMLCanvasElement, node: EqNode, emphasized: boolean): void {
  if (node.liveY === undefined || !node.dyn || !node.enabled) return;
  const ctx = f.ctx;
  const d = dynLayout(eqMapper(canvas), node.freq, node.y, node.dyn.range);
  const color = f.p.dyn;
  ctx.save();
  ctx.globalAlpha = emphasized ? 1 : 0.7;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(d.x, d.y);
  ctx.lineTo(d.rangeX, d.rangeY);
  ctx.stroke();
  // 지금 실제 게인
  const ly = f.yOf(clampDb(node.liveY));
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(d.x, d.y);
  ctx.lineTo(d.x, ly);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(d.x, ly, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = f.p.bg;
  ctx.fill();
  ctx.stroke();
  // 범위 손잡이: 마름모
  ctx.beginPath();
  ctx.moveTo(d.rangeX, d.rangeY - 6.5);
  ctx.lineTo(d.rangeX + 6.5, d.rangeY);
  ctx.lineTo(d.rangeX, d.rangeY + 6.5);
  ctx.lineTo(d.rangeX - 6.5, d.rangeY);
  ctx.closePath();
  ctx.fillStyle = emphasized ? color : f.p.bg;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/** 밴드 노드: 단색 원과 번호. 고르면 바깥에 가는 고리가 생긴다. */
function drawNode(f: Frame, node: EqNode, index: number, selected: boolean): void {
  const ctx = f.ctx;
  const x = f.xOf(node.freq);
  const y = f.yOf(clampDb(node.y));
  const base = !node.enabled ? f.p.target : node.auto ? f.p.auto : f.p.result;
  const r = 8.5;
  ctx.beginPath();
  ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = f.p.bg;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = base;
  ctx.fill();
  if (selected) {
    ctx.beginPath();
    ctx.arc(x, y, r + 4, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(f.p.input, 0.9);
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }
  ctx.fillStyle = f.p.bg;
  ctx.font = "bold 10.5px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(index + 1), x, y + 0.5);
}

/** 지금 EQ가 소리에 거는 응답 곡선과 사용자 밴드 노드를 그린다. */
export function drawEqCurve(canvas: HTMLCanvasElement, view: EqView): void {
  const f = frame(canvas, EQ_RANGE_DB, 6);
  const rect = canvas.getBoundingClientRect();
  const ctx = f.ctx;
  drawAnalyzer(f, view.analyzer);
  for (const r of view.ranges ?? []) drawDynRange(f, view.freqs, r);
  fillResponse(f, view.freqs, view.responseDb, rect.width, rect.height);
  if (view.selectedResponseDb) polyline(f, view.freqs, view.selectedResponseDb.map(clampDb), withAlpha(f.p.input, 0.5), 1);
  polyline(f, view.freqs, view.responseDb.map(clampDb), f.p.result, 2);

  if (view.nodes.length === 0) {
    ctx.fillStyle = withAlpha(f.p.text, 0.9);
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Double-click the graph to add an EQ band", PAD.left + f.plotW / 2, PAD.top + 20);
  }
  // 고른 밴드를 맨 위에 그려서 겹쳐도 잡을 수 있게 한다.
  const order = [...view.nodes.keys()].sort(
    (a, b) => Number(view.nodes[a]!.id === view.selectedId) - Number(view.nodes[b]!.id === view.selectedId),
  );
  for (const i of order) {
    const node = view.nodes[i]!;
    const selected = node.id === view.selectedId;
    drawDynamics(f, canvas, node, selected);
    drawNode(f, node, i, selected);
  }
}

/** 노드 반지름(px)보다 약간 넉넉한 클릭 판정 거리 */
export const NODE_HIT_PX = 12;
