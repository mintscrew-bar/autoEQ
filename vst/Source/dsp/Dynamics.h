// 다이나믹 EQ 계산. src/dsp/dynamics.ts의 C++ 포팅이다.
#pragma once
#include <algorithm>
#include <cmath>

namespace aeq {

enum class DynMode { Above, Below };

constexpr double kKneeDb = 6.0;

/** 대역 레벨에서 작동 정도 0~1(소프트니). 문턱값에서 0.5 */
inline double dynamicTarget(double levelDb, double threshold, DynMode mode) {
    const double x = mode == DynMode::Above ? levelDb - (threshold - kKneeDb / 2) : threshold + kKneeDb / 2 - levelDb;
    return std::max(0.0, std::min(1.0, x / kKneeDb));
}

/** 작동 정도를 목표 쪽으로 옮긴다. 커질 때는 attack, 작아질 때는 release 시간 규모 */
inline double smoothAmount(double prev, double target, double dtSeconds, double attackMs, double releaseMs) {
    const double ms = target > prev ? attackMs : releaseMs;
    const double alpha = 1.0 - std::exp(-dtSeconds / std::max(0.001, ms / 1000.0));
    return prev + (target - prev) * alpha;
}

/** 제곱 평균 에너지(선형)를 dB로. 무음은 바닥값 -100 */
inline double powerToDb(double meanSquare) {
    return std::max(-100.0, 10.0 * std::log10(meanSquare + 1e-18));
}

}  // namespace aeq
