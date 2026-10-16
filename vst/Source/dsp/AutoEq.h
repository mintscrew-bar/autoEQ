// 자동 EQ 핵심 로직. src/dsp/autoEq.ts의 C++ 포팅이다: 곡 자신의 로컬 추세(로버스트 직선)에서
// 튀거나 꺼진 음역을 찾아 밴드별 보정량(dB)을 계산한다.
#pragma once
#include <algorithm>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <vector>

namespace aeq {

struct AutoEqOptions {
    double smoothOctaves = 1.5;
    double maxCorrectionDb = 3.0;
    double minHz = 50.0;
    double maxHz = 8000.0;
    double amount = 1.0;
    double averageSeconds = 4.0;
    double gateDb = -75.0;
    double confidenceSeconds = 8.0;
    double deadbandDb = 0.5;
};

namespace detail {
inline double median(std::vector<double> v) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const size_t mid = v.size() >> 1;
    return (v.size() % 2) ? v[mid] : (v[mid - 1] + v[mid]) / 2.0;
}
inline double sign(double x) { return x > 0 ? 1.0 : (x < 0 ? -1.0 : 0.0); }

/** Theil–Sen 직선을 (xs, ys)에 맞춰 x0에서의 값을 돌려준다 */
inline double robustLineAt(const std::vector<double>& xs, const std::vector<double>& ys, double x0) {
    if (xs.size() < 4) return median(ys);
    std::vector<double> slopes;
    for (size_t i = 0; i < xs.size(); ++i)
        for (size_t j = i + 1; j < xs.size(); ++j) {
            const double dx = xs[j] - xs[i];
            if (dx > 1e-9) slopes.push_back((ys[j] - ys[i]) / dx);
        }
    const double slope = slopes.empty() ? 0.0 : median(slopes);
    std::vector<double> inter(xs.size());
    for (size_t k = 0; k < xs.size(); ++k) inter[k] = ys[k] - slope * xs[k];
    return median(inter) + slope * x0;
}
}  // namespace detail

class AutoEq {
public:
    explicit AutoEq(std::vector<double> centers, AutoEqOptions options = {})
        : centers_(std::move(centers)), options_(options) {
        resetCurves();
    }

    void setOptions(const AutoEqOptions& o) {
        options_ = o;
        if (average_) recompute();
    }
    const AutoEqOptions& options() const { return options_; }

    void beginLearning() { reset(); cumulative_ = true; }
    void endLearning() { cumulative_ = false; }

    void reset() {
        elapsed_ = 0;
        average_.reset();
        resetCurves();
    }

    bool hasData() const { return average_.has_value(); }

    double confidence() const {
        return options_.confidenceSeconds > 0 ? std::min(1.0, elapsed_ / options_.confidenceSeconds) : 1.0;
    }

    const std::vector<double>& correction() const { return correction_; }
    const std::vector<double>& aligned() const { return aligned_; }
    const std::vector<double>& trend() const { return trend_; }

    /** 한 프레임의 밴드 레벨(dB)을 먹여 평균을 갱신하고 보정량을 다시 계산한다. 무음이면 false */
    bool update(const std::vector<double>& bandDb, double dtSeconds) {
        if (bandDb.size() != centers_.size()) throw std::invalid_argument("band count mismatch");
        double loudest = -1e300;
        for (double v : bandDb) loudest = std::max(loudest, v);
        if (!std::isfinite(loudest) || loudest < options_.gateDb) return false;

        std::vector<double> frame(bandDb.size());
        for (size_t i = 0; i < frame.size(); ++i) frame[i] = std::isfinite(bandDb[i]) ? bandDb[i] : options_.gateDb;

        if (!average_) {
            elapsed_ = dtSeconds;
            average_ = frame;
        } else {
            elapsed_ += dtSeconds;
            const double alpha = cumulative_ ? std::min(1.0, dtSeconds / std::max(dtSeconds, elapsed_))
                                             : 1.0 - std::exp(-dtSeconds / std::max(0.01, options_.averageSeconds));
            for (size_t i = 0; i < frame.size(); ++i) (*average_)[i] += alpha * (frame[i] - (*average_)[i]);
        }
        recompute();
        return true;
    }

private:
    void resetCurves() {
        aligned_.assign(centers_.size(), 0.0);
        trend_.assign(centers_.size(), 0.0);
        correction_.assign(centers_.size(), 0.0);
    }

    void recompute() {
        const auto& avg = *average_;
        const size_t n = centers_.size();
        std::vector<bool> active(n);
        std::vector<size_t> activeIdx;
        for (size_t i = 0; i < n; ++i) {
            active[i] = centers_[i] >= options_.minHz && centers_[i] <= options_.maxHz;
            if (active[i]) activeIdx.push_back(i);
        }

        std::vector<double> target = avg;
        for (size_t i : activeIdx) {
            const double here = std::log2(centers_[i]);
            std::vector<double> xs, ys;
            for (size_t j : activeIdx) {
                const double x = std::log2(centers_[j]);
                if (std::abs(x - here) <= options_.smoothOctaves + 1e-9) {
                    xs.push_back(x);
                    ys.push_back(avg[j]);
                }
            }
            target[i] = detail::robustLineAt(xs, ys, here);
        }
        std::vector<double> levels;
        for (size_t i : activeIdx) levels.push_back(avg[i]);
        const double offset = levels.empty() ? 0.0 : -detail::median(levels);
        for (auto& t : target) t += offset;

        trend_ = target;
        const double conf = confidence();
        for (size_t i = 0; i < n; ++i) {
            aligned_[i] = avg[i] + offset;
            if (!active[i]) {
                correction_[i] = 0.0;
                continue;
            }
            const double dev = target[i] - aligned_[i];
            const double raw = detail::sign(dev) * std::max(0.0, std::abs(dev) - options_.deadbandDb);
            const double clamped = std::max(-options_.maxCorrectionDb, std::min(options_.maxCorrectionDb, raw));
            correction_[i] = clamped * options_.amount * conf;
        }
    }

    std::vector<double> centers_;
    AutoEqOptions options_;
    std::optional<std::vector<double>> average_;
    bool cumulative_ = false;
    double elapsed_ = 0;
    std::vector<double> aligned_, trend_, correction_;
};

}  // namespace aeq
