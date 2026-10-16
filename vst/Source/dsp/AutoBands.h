// 보정량 곡선을 EQ 밴드 몇 개로 바꾼다(매칭 추적). src/dsp/autoBands.ts의 C++ 포팅이다.
#pragma once
#include <algorithm>
#include <cmath>
#include <vector>
#include "AutoEq.h"
#include "Response.h"

namespace aeq {

struct AutoBandFit {
    double freq = 1000, gain = 0, q = 1;
};

inline double qFromOctaves(double octaves) {
    const double n = std::pow(2.0, octaves);
    return std::sqrt(n) / (n - 1.0);
}

namespace detail {
inline double halfCrossing(const std::vector<double>& logs, const std::vector<double>& r, int peak, int dir, double stepOct) {
    const double sgn = sign(r[peak]);
    const double half = std::abs(r[peak]) / 2.0;
    int j = peak;
    for (;;) {
        const int next = j + dir;
        if (next < 0 || next >= int(r.size())) return logs[j] + dir * stepOct * 0.5;
        const double v = sign(r[next]) == sgn ? std::abs(r[next]) : 0.0;
        if (v < half) {
            const double cur = std::abs(r[j]);
            const double t = cur == v ? 0.5 : (cur - half) / (cur - v);
            return logs[j] + t * (logs[next] - logs[j]);
        }
        j = next;
    }
}
}  // namespace detail

inline std::vector<AutoBandFit> fitBands(const std::vector<double>& centers, const std::vector<double>& correction, int maxBands, double minGainDb) {
    const int n = int(centers.size());
    if (n < 3) return {};
    constexpr double kMinBw = 0.5, kMaxBw = 4.0;
    std::vector<double> logs(n);
    for (int i = 0; i < n; ++i) logs[i] = std::log2(centers[i]);
    const double stepOct = (logs[n - 1] - logs[0]) / (n - 1);
    std::vector<double> residual = correction;
    std::vector<AutoBandFit> fits;
    double strongest = 0;
    for (double v : correction) strongest = std::max(strongest, std::abs(v));
    const double stopDb = std::max(minGainDb, strongest * 0.4);

    while (int(fits.size()) < maxBands) {
        int peak = 0;
        for (int i = 1; i < n; ++i)
            if (std::abs(residual[i]) > std::abs(residual[peak])) peak = i;
        const double value = residual[peak];
        if (std::abs(value) < stopDb) break;
        const double sgn = detail::sign(value);

        double delta = 0, vertex = std::abs(value);
        if (peak > 0 && peak < n - 1) {
            const double a = sgn * residual[peak - 1], b = std::abs(value), c = sgn * residual[peak + 1];
            const double denom = a - 2 * b + c;
            if (denom < 0) {
                delta = std::max(-0.5, std::min(0.5, (0.5 * (a - c)) / denom));
                vertex = b - 0.25 * (a - c) * delta;
            }
        }
        const double logFreq = logs[peak] + delta * stepOct;
        const double bw = std::max(kMinBw, std::min(kMaxBw, detail::halfCrossing(logs, residual, peak, 1, stepOct) -
                                                               detail::halfCrossing(logs, residual, peak, -1, stepOct)));
        AutoBandFit fit{std::pow(2.0, logFreq), sgn * std::min(vertex, std::abs(value) * 1.25), qFromOctaves(bw)};
        fits.push_back(fit);

        for (int i = 0; i < n; ++i)
            residual[i] -= responseDb({FilterSpec{FilterType::Bell, fit.freq, fit.gain, fit.q}}, centers[i]);
    }
    std::vector<AutoBandFit> kept;
    for (const auto& f : fits)
        if (std::abs(f.gain) >= minGainDb) kept.push_back(f);
    std::sort(kept.begin(), kept.end(), [](const AutoBandFit& a, const AutoBandFit& b) { return a.freq < b.freq; });
    return kept;
}

}  // namespace aeq
