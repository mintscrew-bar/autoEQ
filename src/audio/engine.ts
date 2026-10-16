// Web Audio 그래프: <audio> → (분석 탭) + (밴드 필터 체인: 사용자 밴드와 자동 밴드) → 출력
// 필터 체인은 고정 슬롯 SLOT_COUNT개를 한 번만 이어 둔다. 밴드는 id로 슬롯에 배정되고, 쓰지 않는 슬롯은 게인 0(투명)이다.
// 밴드가 늘거나 줄 때 필터를 새로 만들거나 다시 잇지 않으므로 필터 상태가 리셋되어 생기는 클릭이 없다.
// 분석은 EQ 이전 신호에서 한다. 처리 후 신호를 분석하면 보정 결과를 다시 보정하는 되먹임이 생겨
// 값이 계속 흔들리기 때문이다.

import { aggregateBins, type BandLayout } from "../dsp/bands";
import { rmsDb } from "../dsp/dynamics";
import { webAudioQ, webAudioType, type FilterSpec, type FilterType } from "../dsp/response";
import { SlotAllocator } from "./slots";

const FFT_SIZE = 8192;
/** 다이나믹 레벨 검출 창(샘플). 짧을수록 빠르지만 저역에서 흔들린다 */
const DETECT_FFT = 1024;
/** 값이 바뀔 때 필터 파라미터가 따라가는 시정수(초). 짧으면 소리가 지직거리고 길면 굼뜨다. */
const SMOOTHING_SECONDS = 0.05;
/** 동시에 쓸 수 있는 밴드 수(= main.ts의 MAX_BANDS) */
export const SLOT_COUNT = 24;

interface Detector {
  filter: BiquadFilterNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}

interface Slot {
  filter: BiquadFilterNode;
  /** 이 슬롯 필터에 지금 설정된 종류. 투명 상태(게인 0 벨)면 bell */
  type: FilterType;
  /** 다이나믹 밴드의 대역 레벨 검출기. 다이나믹이 아니면 null */
  detector: Detector | null;
  /** 지금 이 슬롯을 쓰는 밴드 id */
  id: number | null;
}

export class Engine {
  readonly context = new AudioContext();
  private readonly analyser: AnalyserNode;
  private readonly input: GainNode;
  private readonly slots: Slot[];
  private readonly allocator = new SlotAllocator(SLOT_COUNT);
  private readonly trim: GainNode;
  private readonly bins: Float32Array<ArrayBuffer>;

  constructor(
    element: HTMLAudioElement,
    private readonly layout: BandLayout,
  ) {
    const source = this.context.createMediaElementSource(element);

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    // 평균은 AutoEq가 직접 내므로 분석기 자체의 시간 평활은 끈다.
    this.analyser.smoothingTimeConstant = 0;
    this.bins = new Float32Array(this.analyser.frequencyBinCount);
    source.connect(this.analyser);

    this.input = this.context.createGain();
    source.connect(this.input);

    // 부스트로 클리핑되지 않도록 출력단에서 실제 응답의 최대치만큼 헤드룸을 깎는다.
    this.trim = this.context.createGain();
    this.trim.connect(this.context.destination);

    // input → 슬롯 0 → … → 슬롯 N-1 → trim. 이 연결은 다시 바뀌지 않는다.
    let node: AudioNode = this.input;
    this.slots = Array.from({ length: SLOT_COUNT }, () => {
      const filter = this.context.createBiquadFilter();
      filter.type = "peaking";
      filter.gain.value = 0;
      node.connect(filter);
      node = filter;
      return { filter, type: "bell" as FilterType, detector: null, id: null };
    });
    node.connect(this.trim);
  }

  /** 지금 입력의 밴드별 레벨(dB) */
  readBands(): number[] {
    this.analyser.getFloatFrequencyData(this.bins);
    return aggregateBins(this.bins, this.context.sampleRate, FFT_SIZE, this.layout);
  }

  private attachDetector(slot: Slot): Detector {
    const filter = this.context.createBiquadFilter();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = DETECT_FFT;
    analyser.smoothingTimeConstant = 0;
    this.input.connect(filter);
    filter.connect(analyser);
    slot.detector = { filter, analyser, buf: new Float32Array(analyser.fftSize) };
    return slot.detector;
  }

  private detachDetector(slot: Slot): void {
    const d = slot.detector;
    if (!d) return;
    this.input.disconnect(d.filter);
    d.filter.disconnect();
    slot.detector = null;
  }

  /** 검출 필터를 밴드의 종류에 맞춘다: 벨은 그 주파수 둘레(대역통과), 로우 쉘프는 그 아래, 하이 쉘프는 그 위 */
  private tuneDetector(d: Detector, u: FilterSpec): void {
    d.filter.type = u.type === "lowshelf" ? "lowpass" : u.type === "highshelf" ? "highpass" : "bandpass";
    d.filter.frequency.value = u.freq;
    d.filter.Q.value = u.type === "bell" || u.type === "notch" ? u.q : webAudioQ("lowpass", Math.SQRT1_2);
  }

  /**
   * 다이나믹 밴드의 대역 레벨(dB)을 밴드 id별로. 다이나믹이 아닌 밴드는 들어 있지 않다.
   * 재생 중이 아니면 마지막 버퍼가 남아 있으므로 무음(-100)으로 돌려준다.
   */
  readDetectorLevels(playing: boolean): Map<number, number> {
    const levels = new Map<number, number>();
    for (const slot of this.slots) {
      if (slot.id === null || !slot.detector) continue;
      if (!playing) {
        levels.set(slot.id, -100);
        continue;
      }
      slot.detector.analyser.getFloatTimeDomainData(slot.detector.buf);
      levels.set(slot.id, rmsDb(slot.detector.buf));
    }
    return levels;
  }

  /**
   * 화면용 스펙트럼: 로그 간격 주파수 격자(freqs)마다 ±1/6옥타브 안 FFT 빈의 전력 평균을 dB로 돌려준다.
   * 저역처럼 창 안에 빈이 하나도 없는 곳은 이웃한 두 빈을 보간한다.
   */
  readSpectrum(freqs: readonly number[]): number[] {
    this.analyser.getFloatFrequencyData(this.bins);
    const binHz = this.context.sampleRate / FFT_SIZE;
    const n = this.bins.length;
    const power = (i: number) => {
      const db = this.bins[i] ?? -Infinity;
      return Number.isFinite(db) ? 10 ** (db / 10) : 0;
    };
    return freqs.map((f) => {
      const lo = Math.max(1, Math.ceil((f * 2 ** (-1 / 6)) / binHz));
      const hi = Math.min(n - 1, Math.floor((f * 2 ** (1 / 6)) / binHz));
      let sum = 0;
      let count = 0;
      for (let k = lo; k <= hi; k++) {
        sum += power(k);
        count++;
      }
      if (count === 0) {
        const x = f / binHz;
        const i0 = Math.max(1, Math.min(n - 2, Math.floor(x)));
        const t = x - i0;
        sum = power(i0) * (1 - t) + power(i0 + 1) * t;
        count = 1;
      }
      return 10 * Math.log10(Math.max(sum / count, 1e-12));
    });
  }

  /** 주인을 잃은 슬롯을 투명하게 되돌린다. 벨·쉘프는 게인을 부드럽게 0으로 내리고, 그 밖의 종류는 어쩔 수 없이 바로 바꾼다. */
  private release(slot: Slot, now: number): void {
    slot.id = null;
    this.detachDetector(slot);
    if (slot.type === "bell" || slot.type === "lowshelf" || slot.type === "highshelf") {
      slot.filter.gain.setTargetAtTime(0, now, SMOOTHING_SECONDS);
    } else {
      slot.filter.type = "peaking";
      slot.filter.gain.value = 0;
      slot.type = "bell";
    }
  }

  /**
   * 사용자 밴드(자동 밴드 포함)를 필터에 반영한다. 밴드는 id로 슬롯에 배정되어 늘거나 줄어도 나머지는 그대로다.
   * @param headroomDb 응답이 0dB를 넘어 커지는 만큼. 출력을 이만큼만 줄인다.
   */
  apply(user: readonly FilterSpec[], headroomDb: number): void {
    const now = this.context.currentTime;
    const { slotOf, fresh, freed } = this.allocator.assign(user.map((u, i) => u.id ?? -(i + 1)));
    for (const s of freed) this.release(this.slots[s]!, now);

    user.forEach((u, i) => {
      const s = slotOf[i]!;
      if (s < 0) return; // 슬롯이 모자라는 밴드는 건너뛴다
      const slot = this.slots[s]!;
      const { filter } = slot;
      slot.id = u.id ?? -(i + 1);

      if (fresh[i] || slot.type !== u.type) {
        // 새로 배정된 슬롯은 투명(게인 0)이므로 종류·주파수·Q를 바로 정해도 소리가 변하지 않는다. 게인은 아래에서 서서히 올라간다.
        filter.type = webAudioType(u.type);
        filter.frequency.value = u.freq;
        filter.Q.value = webAudioQ(u.type, u.q);
        slot.type = u.type;
      }
      filter.frequency.setTargetAtTime(u.freq, now, SMOOTHING_SECONDS);
      filter.Q.setTargetAtTime(webAudioQ(u.type, u.q), now, SMOOTHING_SECONDS);
      filter.gain.setTargetAtTime(u.gain, now, SMOOTHING_SECONDS);

      if (u.dynamic) {
        this.tuneDetector(slot.detector ?? this.attachDetector(slot), u);
      } else {
        this.detachDetector(slot);
      }
    });
    this.trim.gain.setTargetAtTime(10 ** (-headroomDb / 20), now, SMOOTHING_SECONDS * 3);
  }
}
