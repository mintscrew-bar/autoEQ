// 분석·보정에 쓰는 주파수 밴드 배치와, FFT 빈을 밴드로 묶는 함수

export interface BandLayout {
  /** 각 밴드의 중심 주파수(Hz) */
  centers: number[];
  /** 옥타브당 밴드 수 */
  bandsPerOctave: number;
  /** 인접 밴드가 자연스럽게 이어지도록 계산한 피킹 필터 Q */
  q: number;
}

/**
 * 로그 간격 밴드를 만든다.
 * 폭 N옥타브 피킹 필터의 Q는 sqrt(2^N) / (2^N - 1) 이다.
 */
export function makeBands(minHz = 40, maxHz = 16000, bandsPerOctave = 2): BandLayout {
  const centers: number[] = [];
  for (let i = 0; ; i++) {
    const f = minHz * 2 ** (i / bandsPerOctave);
    if (f > maxHz) break;
    centers.push(f);
  }
  const n = 1 / bandsPerOctave;
  const q = Math.sqrt(2 ** n) / (2 ** n - 1);
  return { centers, bandsPerOctave, q };
}

/**
 * FFT 빈(dB)을 밴드(dB)로 묶는다.
 * dB 값을 그대로 평균 내면 작은 값에 끌려가므로, 전력으로 바꿔 평균한 뒤 다시 dB로 돌린다.
 * 저역에서는 빈 해상도가 거칠어 밴드 안에 빈이 하나도 없을 수 있어, 그때는 가장 가까운 빈을 쓴다.
 */
export function aggregateBins(
  binDb: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
  layout: BandLayout,
): number[] {
  const binHz = sampleRate / fftSize;
  const half = 2 ** (1 / (2 * layout.bandsPerOctave));
  return layout.centers.map((center) => {
    const lo = center / half;
    const hi = center * half;
    const first = Math.max(1, Math.ceil(lo / binHz));
    const last = Math.min(binDb.length - 1, Math.floor(hi / binHz));
    let power = 0;
    let count = 0;
    for (let k = first; k <= last; k++) {
      const db = binDb[k] ?? -Infinity;
      if (!Number.isFinite(db)) continue;
      power += 10 ** (db / 10);
      count++;
    }
    if (count === 0) {
      const nearest = Math.min(binDb.length - 1, Math.max(1, Math.round(center / binHz)));
      return binDb[nearest] ?? -Infinity;
    }
    return 10 * Math.log10(power / count);
  });
}
