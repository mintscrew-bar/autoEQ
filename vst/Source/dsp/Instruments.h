// 악기별 기준 음색과 스펙트럼 모양으로 악기를 추정하는 함수. src/dsp/instruments.ts의 C++ 포팅이다.
// 곡선은 녹음으로 측정한 값이 아니라 믹싱 일반론으로 그린 근사다(검증 전). 약한 사전 지식으로만 쓴다.
#pragma once
#include <algorithm>
#include <cmath>
#include <vector>

namespace aeq {

struct InstrumentProfile {
    const char* id;
    const char* name;
    std::vector<std::pair<double, double>> anchors;  // 옥타브 밴드 에너지 기준 [Hz, dB]
};

inline const std::vector<InstrumentProfile>& instruments() {
    static const std::vector<InstrumentProfile> list = {
        {"vocal", "Vocal", {{60, -22}, {100, -12}, {200, -2}, {400, 0}, {800, 0}, {1600, 0}, {3000, 1}, {5000, -3}, {8000, -9}, {12000, -16}}},
        {"kick", "Kick", {{30, -10}, {60, 0}, {100, -1}, {200, -8}, {400, -13}, {1000, -15}, {3000, -13}, {8000, -20}, {16000, -32}}},
        {"snare", "Snare", {{60, -18}, {120, -6}, {200, 0}, {400, -2}, {1000, -4}, {2500, -1}, {5000, -4}, {10000, -10}, {16000, -20}}},
        {"bass", "Bass", {{30, -8}, {60, 0}, {100, 0}, {200, -2}, {400, -9}, {800, -17}, {1600, -24}, {4000, -34}}},
        {"eguitar", "Electric Guitar", {{60, -22}, {120, -10}, {250, -1}, {500, 0}, {1000, 0}, {2500, 0}, {4000, -3}, {6000, -10}, {10000, -20}}},
        {"aguitar", "Acoustic Guitar", {{60, -20}, {120, -6}, {250, 0}, {500, -1}, {1000, -3}, {3000, -4}, {6000, -9}, {12000, -17}}},
        {"piano", "Piano", {{40, -16}, {100, -5}, {250, 0}, {500, -1}, {1000, -3}, {2000, -7}, {5000, -13}, {10000, -21}}},
        {"cymbals", "Cymbals / Hi-hat", {{200, -34}, {500, -26}, {1000, -18}, {3000, -8}, {6000, 0}, {10000, 0}, {16000, -7}}},
        {"strings", "Strings / Pad", {{60, -16}, {150, -2}, {300, 0}, {600, -2}, {1500, -6}, {4000, -13}, {8000, -21}}},
    };
    return list;
}

inline double octaveDb(const std::vector<std::pair<double, double>>& a, double hz) {
    if (hz <= a.front().first) return a.front().second;
    if (hz >= a.back().first) return a.back().second;
    for (size_t i = 1; i < a.size(); ++i) {
        if (hz <= a[i].first) {
            const auto& p0 = a[i - 1];
            const auto& p1 = a[i];
            return p0.second + (p1.second - p0.second) * std::log2(hz / p0.first) / std::log2(p1.first / p0.first);
        }
    }
    return a.back().second;
}

/** 밴드 중심별 목표(dB). 분석기와 같은 "빈 평균 전력" 영역이라 밴드 폭만큼 -10log10(f/1000)을 뺀다 */
inline std::vector<double> profileTarget(const InstrumentProfile& p, const std::vector<double>& centers) {
    std::vector<double> t;
    t.reserve(centers.size());
    for (double f : centers) t.push_back(octaveDb(p.anchors, f) - 10.0 * std::log10(f / 1000.0));
    return t;
}

struct InstrumentGuess {
    int index = -1;  // instruments() 안의 위치
    double distance = 0;
};

struct IdentifyResult {
    std::vector<InstrumentGuess> ranking;
    bool confident = false;
};

constexpr double kIdentMinHz = 60, kIdentMaxHz = 12000, kIdentMaxDistance = 5.0, kIdentMinMargin = 0.8;

inline IdentifyResult identifyInstrument(const std::vector<double>& avg, const std::vector<double>& centers) {
    std::vector<size_t> idx;
    for (size_t i = 0; i < centers.size(); ++i)
        if (centers[i] >= kIdentMinHz && centers[i] <= kIdentMaxHz) idx.push_back(i);
    IdentifyResult r;
    const auto& list = instruments();
    for (size_t k = 0; k < list.size(); ++k) {
        const auto target = profileTarget(list[k], centers);
        std::vector<double> diffs;
        for (size_t i : idx) diffs.push_back(avg[i] - target[i]);
        std::vector<double> sorted = diffs;
        std::sort(sorted.begin(), sorted.end());
        const size_t mid = sorted.size() >> 1;
        const double offset = sorted.size() % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0;
        double sum = 0;
        for (double d : diffs) sum += (d - offset) * (d - offset);
        r.ranking.push_back({int(k), std::sqrt(sum / std::max<size_t>(1, diffs.size()))});
    }
    std::sort(r.ranking.begin(), r.ranking.end(), [](const InstrumentGuess& a, const InstrumentGuess& b) { return a.distance < b.distance; });
    r.confident = r.ranking[0].distance <= kIdentMaxDistance && r.ranking[1].distance - r.ranking[0].distance >= kIdentMinMargin;
    return r;
}

}  // namespace aeq
