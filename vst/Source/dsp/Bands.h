// 분석 밴드 배치와 FFT 빈 묶기. src/dsp/bands.ts의 C++ 포팅이다.
#pragma once
#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace aeq {

struct BandLayout {
    std::vector<double> centers;
    int bandsPerOctave = 2;
    double q = 2.87;
};

inline BandLayout makeBands(double minHz = 40.0, double maxHz = 16000.0, int bandsPerOctave = 2) {
    BandLayout l;
    l.bandsPerOctave = bandsPerOctave;
    for (int i = 0;; ++i) {
        const double f = minHz * std::pow(2.0, double(i) / bandsPerOctave);
        if (f > maxHz) break;
        l.centers.push_back(f);
    }
    const double n = 1.0 / bandsPerOctave;
    l.q = std::sqrt(std::pow(2.0, n)) / (std::pow(2.0, n) - 1.0);
    return l;
}

/** FFT 빈(dB, 개수 = fftSize/2)을 밴드(dB)로 묶는다. 전력으로 바꿔 평균한 뒤 dB로 돌린다. */
inline std::vector<double> aggregateBins(const float* binDb, int binCount, double sampleRate, int fftSize, const BandLayout& layout) {
    const double binHz = sampleRate / fftSize;
    const double half = std::pow(2.0, 1.0 / (2.0 * layout.bandsPerOctave));
    std::vector<double> out;
    out.reserve(layout.centers.size());
    for (double center : layout.centers) {
        const int first = std::max(1, int(std::ceil(center / half / binHz)));
        const int last = std::min(binCount - 1, int(std::floor(center * half / binHz)));
        double power = 0;
        int count = 0;
        for (int k = first; k <= last; ++k) {
            const double db = binDb[k];
            if (!std::isfinite(db)) continue;
            power += std::pow(10.0, db / 10.0);
            ++count;
        }
        if (count == 0) {
            const int nearest = std::min(binCount - 1, std::max(1, int(std::lround(center / binHz))));
            out.push_back(binDb[nearest]);
        } else {
            out.push_back(10.0 * std::log10(power / count));
        }
    }
    return out;
}

}  // namespace aeq
