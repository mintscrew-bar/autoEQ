// 필터 응답과 계수. src/dsp/response.ts의 C++ 포팅이다(웹 오디오와 같은 RBJ 공식).
#pragma once
#include <cmath>
#include <vector>

namespace aeq {

enum class FilterType { Bell, LowShelf, HighShelf, HighPass, LowPass, Notch };

struct FilterSpec {
    FilterType type = FilterType::Bell;
    double freq = 1000.0;
    double gain = 0.0;  // dB. Bell·Shelf에서만 의미가 있다
    double q = 1.0;
};

/** 정규화된 쌍이차 계수 (a0 = 1) */
struct Coeffs {
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
};

inline bool hasGain(FilterType t) { return t == FilterType::Bell || t == FilterType::LowShelf || t == FilterType::HighShelf; }

inline Coeffs biquadCoeffs(const FilterSpec& s, double sampleRate) {
    const double pi = 3.14159265358979323846;
    const double w0 = 2.0 * pi * s.freq / sampleRate;
    const double cs = std::cos(w0);
    const double sn = std::sin(w0);
    const double alpha = sn / (2.0 * s.q);
    double b0, b1, b2, a0, a1, a2;
    switch (s.type) {
        case FilterType::Bell: {
            const double a = std::pow(10.0, s.gain / 40.0);
            b0 = 1 + alpha * a; b1 = -2 * cs; b2 = 1 - alpha * a;
            a0 = 1 + alpha / a; a1 = -2 * cs; a2 = 1 - alpha / a;
            break;
        }
        case FilterType::LowPass:
            b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2;
            a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
            break;
        case FilterType::HighPass:
            b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2;
            a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
            break;
        case FilterType::Notch:
            b0 = 1; b1 = -2 * cs; b2 = 1;
            a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
            break;
        case FilterType::LowShelf:
        case FilterType::HighShelf:
        default: {
            const double a = std::pow(10.0, s.gain / 40.0);
            const double beta = 2.0 * std::sqrt(a) * (sn / 2.0) * std::sqrt(2.0);  // 쉘프 기울기 S=1
            if (s.type == FilterType::LowShelf) {
                b0 = a * (a + 1 - (a - 1) * cs + beta);
                b1 = 2 * a * (a - 1 - (a + 1) * cs);
                b2 = a * (a + 1 - (a - 1) * cs - beta);
                a0 = a + 1 + (a - 1) * cs + beta;
                a1 = -2 * (a - 1 + (a + 1) * cs);
                a2 = a + 1 + (a - 1) * cs - beta;
            } else {
                b0 = a * (a + 1 + (a - 1) * cs + beta);
                b1 = -2 * a * (a - 1 + (a + 1) * cs);
                b2 = a * (a + 1 + (a - 1) * cs - beta);
                a0 = a + 1 - (a - 1) * cs + beta;
                a1 = 2 * (a - 1 - (a + 1) * cs);
                a2 = a + 1 - (a - 1) * cs - beta;
            }
            break;
        }
    }
    return {b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0};
}

inline double magnitudeDb(const Coeffs& c, double freq, double sampleRate) {
    const double pi = 3.14159265358979323846;
    const double w = 2.0 * pi * freq / sampleRate;
    const double c1 = std::cos(w), s1 = std::sin(w), c2 = std::cos(2 * w), s2 = std::sin(2 * w);
    auto mag2 = [&](double k0, double k1, double k2) {
        const double re = k0 + k1 * c1 + k2 * c2;
        const double im = -(k1 * s1 + k2 * s2);
        return re * re + im * im;
    };
    return 10.0 * std::log10(mag2(c.b0, c.b1, c.b2) / mag2(1.0, c.a1, c.a2));
}

/** 필터들을 직렬로 걸었을 때 freq 지점의 응답(dB) */
inline double responseDb(const std::vector<FilterSpec>& specs, double freq, double sampleRate = 48000.0) {
    double sum = 0;
    for (const auto& s : specs) sum += magnitudeDb(biquadCoeffs(s, sampleRate), freq, sampleRate);
    return sum;
}

}  // namespace aeq
