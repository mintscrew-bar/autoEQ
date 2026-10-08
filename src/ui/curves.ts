// 캔버스에 스펙트럼 곡선과 밴드별 보정량을 그린다.

const MIN_HZ = 20;
const MAX_HZ = 20000;

interface Palette {
  grid: string;
  text: string;
  target: string;
  input: string;
  result: string;
  boost: string;
  cut: string;
}

function palette(): Palette {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return dark
    ? { grid: "#2c3038", text: "#8b93a1", target: "#6b7380", input: "#c7ccd6", result: "#5ad1a5", boost: "#5ad1a5", cut: "#f2915f" }
    : { grid: "#e3e6eb", text: "#6a7280", target: "#9aa1ad", input: "#3b4250", result: "#0e9f6e", boost: "#0e9f6e", cut: "#d9622b" };
}

/** 고해상도 화면에서 선이 흐려지지 않게 캔버스 크기를 맞추고 CSS 크기 기준 좌표계를 돌려준다. */
function prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

const xOf = (hz: number, width: number) =>
  (Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ)) * width;

function drawFreqGrid(ctx: CanvasRenderingContext2D, width: number, height: number, p: Palette): void {
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = p.text;
  ctx.strokeStyle = p.grid;
  ctx.lineWidth = 1;
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOf(hz, width)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x + 3, height - 4);
  }
}

function line(
  ctx: CanvasRenderingContext2D,
  centers: readonly number[],
  values: readonly number[],
  yOf: (db: number) => number,
  width: number,
  color: string,
  dash: number[] = [],
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dash);
  ctx.beginPath();
  centers.forEach((hz, i) => {
    const x = xOf(hz, width);
    const y = yOf(values[i] ?? 0);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

/** 목표 곡선, 정렬된 입력, 보정 후 예상 곡선을 그린다. 모두 상대 dB다. */
export function drawSpectrum(
  canvas: HTMLCanvasElement,
  centers: readonly number[],
  target: readonly number[],
  aligned: readonly number[],
  correction: readonly number[],
): void {
  const { ctx, width, height } = prepare(canvas);
  const p = palette();
  const range = 20; // 가운데 0dB 기준 ±20dB
  const yOf = (db: number) => height / 2 - (db / range) * (height / 2);

  drawFreqGrid(ctx, width, height, p);
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = Math.round(yOf(db)) + 0.5;
    ctx.strokeStyle = p.grid;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillStyle = p.text;
    ctx.fillText(`${db > 0 ? "+" : ""}${db}`, 4, y - 3);
  }

  const result = aligned.map((db, i) => db + (correction[i] ?? 0));
  line(ctx, centers, target, yOf, width, p.target, [6, 5]);
  line(ctx, centers, aligned, yOf, width, p.input);
  line(ctx, centers, result, yOf, width, p.result);
}

/** 밴드별 보정량을 막대로 그린다. 위는 부스트, 아래는 컷이다. */
export function drawCorrection(
  canvas: HTMLCanvasElement,
  centers: readonly number[],
  correction: readonly number[],
  maxDb: number,
): void {
  const { ctx, width, height } = prepare(canvas);
  const p = palette();
  const range = Math.max(1, maxDb);
  drawFreqGrid(ctx, width, height, p);

  ctx.strokeStyle = p.grid;
  ctx.beginPath();
  ctx.moveTo(0, height / 2 + 0.5);
  ctx.lineTo(width, height / 2 + 0.5);
  ctx.stroke();

  const barWidth = Math.max(4, (width / centers.length) * 0.6);
  centers.forEach((hz, i) => {
    const db = correction[i] ?? 0;
    const h = (Math.abs(db) / range) * (height / 2 - 14);
    const x = xOf(hz, width) - barWidth / 2;
    ctx.fillStyle = db >= 0 ? p.boost : p.cut;
    if (db >= 0) ctx.fillRect(x, height / 2 - h, barWidth, h);
    else ctx.fillRect(x, height / 2, barWidth, h);
  });
  ctx.fillStyle = p.text;
  ctx.fillText(`+${range} dB`, 4, 12);
  ctx.fillText(`-${range} dB`, 4, height - 16);
}
