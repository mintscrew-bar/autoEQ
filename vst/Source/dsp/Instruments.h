// 악기별 기준 음색, 스타일(장르) 보정, 스펙트럼 모양으로 악기를 추정하는 함수. src/dsp/instruments.ts의 C++ 포팅이다.
// 곡선은 녹음으로 측정한 값이 아니라 믹싱 일반론으로 그린 근사다(검증 전). 약한 사전 지식으로만 쓴다.
#pragma once
#include <algorithm>
#include <cmath>
#include <string>
#include <utility>
#include <vector>

namespace aeq {

using Anchors = std::vector<std::pair<double, double>>;  // [Hz, dB]

enum class Category { Vocal, Guitar, Bass, Drums, Keys, Strings };

inline const char* categoryName(Category c) {
    switch (c) {
        case Category::Vocal: return "Vocal";
        case Category::Guitar: return "Guitar";
        case Category::Bass: return "Bass";
        case Category::Drums: return "Drums";
        case Category::Keys: return "Keys";
        case Category::Strings: return "Strings / Pad";
    }
    return "";
}

struct InstrumentProfile {
    const char* id;
    const char* name;
    Category category;
    bool generic;     // 묶음 전체를 아우르는 프로파일(기타 통합, 드럼 킷 버스)
    Anchors anchors;  // 옥타브 밴드 에너지 기준
};

inline const std::vector<InstrumentProfile>& instruments() {
    static const std::vector<InstrumentProfile> list = {
        {"vocal", "Vocal", Category::Vocal, false, {{60, -22}, {100, -12}, {200, -2}, {400, 0}, {800, 0}, {1600, 0}, {3000, 1}, {5000, -3}, {8000, -9}, {12000, -16}}},
        {"guitar", "Guitar (any)", Category::Guitar, true, {{60, -21}, {120, -8}, {250, -0.5}, {500, -0.5}, {1000, -1.5}, {2500, -2}, {4000, -3.5}, {6000, -9.5}, {10000, -18.5}}},
        {"eguitar", "Electric Guitar", Category::Guitar, false, {{60, -22}, {120, -10}, {250, -1}, {500, 0}, {1000, 0}, {2500, 0}, {4000, -3}, {6000, -10}, {10000, -20}}},
        {"aguitar", "Acoustic Guitar", Category::Guitar, false, {{60, -20}, {120, -6}, {250, 0}, {500, -1}, {1000, -3}, {3000, -4}, {6000, -9}, {12000, -17}}},
        {"bass", "Bass", Category::Bass, false, {{30, -8}, {60, 0}, {100, 0}, {200, -2}, {400, -9}, {800, -17}, {1600, -24}, {4000, -34}}},
        {"drums", "Drums (full kit)", Category::Drums, true, {{40, -6}, {60, 0}, {100, -1}, {200, -3}, {400, -8}, {1000, -9}, {3000, -6}, {6000, -4}, {10000, -6}, {16000, -14}}},
        {"kick", "Kick", Category::Drums, false, {{30, -10}, {60, 0}, {100, -1}, {200, -8}, {400, -13}, {1000, -15}, {3000, -13}, {8000, -20}, {16000, -32}}},
        {"snare", "Snare", Category::Drums, false, {{60, -18}, {120, -6}, {200, 0}, {400, -2}, {1000, -4}, {2500, -1}, {5000, -4}, {10000, -10}, {16000, -20}}},
        {"cymbals", "Cymbals / Hi-hat", Category::Drums, false, {{200, -34}, {500, -26}, {1000, -18}, {3000, -8}, {6000, 0}, {10000, 0}, {16000, -7}}},
        {"piano", "Piano", Category::Keys, false, {{40, -16}, {100, -5}, {250, 0}, {500, -1}, {1000, -3}, {2000, -7}, {5000, -13}, {10000, -21}}},
        {"strings", "Strings / Pad", Category::Strings, false, {{60, -16}, {150, -2}, {300, 0}, {600, -2}, {1500, -6}, {4000, -13}, {8000, -21}}},
    };
    return list;
}

struct Style {
    const char* id;
    const char* name;
    Anchors anchors;
};

/** 프로파일 위에 얹는 작은 보정(±3dB 이내). 장르별 실제 녹음으로 구한 값이 아니라 추정이다(검증 전). 0번이 none */
inline const std::vector<Style>& styles() {
    static const std::vector<Style> list = {
        {"none", "None", {{20, 0}, {20000, 0}}},
        {"rock", "Rock", {{60, 0}, {120, 1}, {250, 0}, {1000, 1}, {3000, 2}, {8000, 0}, {16000, -2}}},
        {"pop", "Pop", {{60, 0}, {200, 0}, {1000, 0}, {5000, 1.5}, {12000, 2}}},
        {"hiphop", "Hip-hop", {{40, 3}, {80, 3}, {200, 0}, {1000, 0}, {5000, 0}, {12000, -1}}},
        {"edm", "EDM", {{40, 3}, {80, 2}, {250, -1}, {1000, 0}, {6000, 2}, {14000, 3}}},
        {"jazz", "Jazz", {{60, 0}, {200, 1}, {1000, 0}, {5000, -1.5}, {12000, -3}}},
        {"acoustic", "Acoustic / Folk", {{60, -1}, {200, 1}, {1000, 0}, {4000, 1}, {10000, 0}}},
    };
    return list;
}

inline double octaveDb(const Anchors& a, double hz) {
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
inline std::vector<double> profileTarget(const InstrumentProfile& p, const std::vector<double>& centers, size_t styleIndex = 0) {
    const auto& delta = styles()[styleIndex].anchors;
    std::vector<double> t;
    t.reserve(centers.size());
    for (double f : centers) t.push_back(octaveDb(p.anchors, f) + octaveDb(delta, f) - 10.0 * std::log10(f / 1000.0));
    return t;
}

struct InstrumentGuess {
    int index = -1;  // instruments() 안의 위치
    double distance = 0;
};

struct CategoryGuess {
    Category category = Category::Vocal;
    int bestIndex = -1;
    double distance = 0;
};

struct IdentifyResult {
    std::vector<InstrumentGuess> ranking;
    std::vector<CategoryGuess> categories;
    bool confident = false;
    int appliedIndex = -1;  // confident일 때 적용할 프로파일, 아니면 -1
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
    std::stable_sort(r.ranking.begin(), r.ranking.end(), [](const InstrumentGuess& a, const InstrumentGuess& b) { return a.distance < b.distance; });
    for (const auto& g : r.ranking) {
        const Category c = list[size_t(g.index)].category;
        const bool seen = std::any_of(r.categories.begin(), r.categories.end(), [&](const CategoryGuess& x) { return x.category == c; });
        if (!seen) r.categories.push_back({c, g.index, g.distance});
    }
    const auto& best = r.categories[0];
    r.confident = best.distance <= kIdentMaxDistance && (r.categories.size() < 2 || r.categories[1].distance - best.distance >= kIdentMinMargin);
    r.appliedIndex = r.confident ? best.bestIndex : -1;
    return r;
}

}  // namespace aeq
