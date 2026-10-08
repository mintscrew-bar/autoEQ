import { Engine } from "./audio/engine";
import { AutoEq } from "./dsp/autoEq";
import { makeBands } from "./dsp/bands";
import { drawCorrection, drawSpectrum } from "./ui/curves";

const layout = makeBands();
const eq = new AutoEq(layout.centers);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const player = $<HTMLAudioElement>("player");
const fileInput = $<HTMLInputElement>("file");
const bypassBox = $<HTMLInputElement>("bypass");
const resetButton = $<HTMLButtonElement>("reset");
const statusText = $("status");
const spectrum = $<HTMLCanvasElement>("spectrum");
const correction = $<HTMLCanvasElement>("correction");

let engine: Engine | null = null;
let lastFrame = performance.now();
let objectUrl: string | null = null;

/** 슬라이더와 값 표시, AutoEq 옵션을 연결한다. */
function bindSlider(
  id: string,
  outId: string,
  format: (v: number) => string,
  apply: (v: number) => void,
): void {
  const input = $<HTMLInputElement>(id);
  const out = $(outId);
  const sync = () => {
    const v = Number(input.value);
    out.textContent = format(v);
    apply(v);
  };
  input.addEventListener("input", sync);
  sync();
}

bindSlider("amount", "amount-out", (v) => `${v}%`, (v) => eq.setOptions({ amount: v / 100 }));
bindSlider("slope", "slope-out", (v) => `${v.toFixed(1)} dB`, (v) => eq.setOptions({ slopeDbPerOct: v }));
bindSlider("max", "max-out", (v) => `±${v} dB`, (v) => eq.setOptions({ maxCorrectionDb: v }));
bindSlider("avg", "avg-out", (v) => `${v}초`, (v) => eq.setOptions({ averageSeconds: v }));

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  player.src = objectUrl;
  // 소스가 바뀌면 이전 곡의 평균이 새 곡의 보정에 섞이지 않도록 비운다.
  eq.reset();
  statusText.textContent = `${file.name} — 재생하면 분석을 시작합니다.`;
});

resetButton.addEventListener("click", () => {
  eq.reset();
  statusText.textContent = "학습을 초기화했습니다.";
});

player.addEventListener("play", async () => {
  // AudioContext와 MediaElementSource는 사용자 조작 이후에 한 번만 만든다.
  engine ??= new Engine(player, layout);
  await engine.context.resume();
});

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;

  if (engine && !player.paused && !player.ended) {
    const learned = eq.update(engine.readBands(), dt);
    statusText.textContent = learned ? "분석 중" : "무음 구간 — 학습을 건너뜁니다.";
  }
  engine?.apply(eq.correction(), bypassBox.checked);

  drawSpectrum(spectrum, layout.centers, eq.target(), eq.aligned(), bypassBox.checked ? layout.centers.map(() => 0) : eq.correction());
  drawCorrection(correction, layout.centers, bypassBox.checked ? layout.centers.map(() => 0) : eq.correction(), eq.getOptions().maxCorrectionDb);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
