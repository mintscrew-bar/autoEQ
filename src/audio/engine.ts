// Web Audio 그래프: <audio> → (분석 탭) + (피킹 필터 체인) → 출력
// 분석은 EQ 이전 신호에서 한다. 처리 후 신호를 분석하면 보정 결과를 다시 보정하는 되먹임이 생겨
// 값이 계속 흔들리기 때문이다.

import { aggregateBins, type BandLayout } from "../dsp/bands";

const FFT_SIZE = 8192;
/** 보정량이 바뀔 때 필터 게인이 따라가는 시정수(초). 짧으면 소리가 지직거리고 길면 굼뜨다. */
const GAIN_SMOOTHING_SECONDS = 0.15;

export class Engine {
  readonly context = new AudioContext();
  private readonly analyser: AnalyserNode;
  private readonly filters: BiquadFilterNode[];
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

    this.filters = layout.centers.map((frequency) => {
      const filter = this.context.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = frequency;
      filter.Q.value = layout.q;
      filter.gain.value = 0;
      return filter;
    });

    // 부스트가 겹쳐 클리핑되지 않도록 출력단에서 헤드룸을 깎는다.
    this.trim = this.context.createGain();

    let node: AudioNode = source;
    for (const filter of this.filters) {
      node.connect(filter);
      node = filter;
    }
    node.connect(this.trim);
    this.trim.connect(this.context.destination);
  }

  /** 지금 입력의 밴드별 레벨(dB) */
  readBands(): number[] {
    this.analyser.getFloatFrequencyData(this.bins);
    return aggregateBins(this.bins, this.context.sampleRate, FFT_SIZE, this.layout);
  }

  /** 밴드별 보정량(dB)을 필터에 반영한다. bypass면 모두 0으로 되돌린다. */
  apply(correctionDb: readonly number[], bypass: boolean): void {
    const now = this.context.currentTime;
    let maxBoost = 0;
    this.filters.forEach((filter, i) => {
      const gain = bypass ? 0 : (correctionDb[i] ?? 0);
      maxBoost = Math.max(maxBoost, gain);
      filter.gain.setTargetAtTime(gain, now, GAIN_SMOOTHING_SECONDS);
    });
    const trimLinear = 10 ** (-maxBoost / 20);
    this.trim.gain.setTargetAtTime(trimLinear, now, GAIN_SMOOTHING_SECONDS);
  }
}
