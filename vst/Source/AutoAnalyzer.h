// LEARN 분석 스레드: 입력을 FFT로 분석해 AutoEq로 보정량을 구하고, 그걸 자동 밴드 몇 개로 바꿔 오디오 스레드에 넘긴다.
// 오디오 스레드는 샘플을 FIFO에 밀어 넣고 결과만 읽는다(잠금 없이 시도만 한다).
#pragma once
#include <array>
#include <atomic>
#include <map>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include "Params.h"
#include "dsp/AutoBands.h"
#include "dsp/AutoEq.h"
#include "dsp/Bands.h"

namespace autoeq {

struct AutoTarget {
    bool active = false;
    float freq = 1000.f, gain = 0.f, q = 1.f;
};
using AutoTargets = std::array<AutoTarget, kNumAuto>;

class AutoAnalyzer : private juce::Thread {
public:
    AutoAnalyzer();
    ~AutoAnalyzer() override;

    void prepare(double sampleRate);
    /** 오디오 스레드: 모노 샘플을 넘긴다 */
    void push(const float* mono, int numSamples);

    void startLearning();
    void stopLearning();
    void setOptions(double maxCorrectionDb, double smoothOctaves, int maxAutoBands);

    /** 오디오 스레드: 잠겨 있지 않으면 최신 목표를 복사한다. 복사했으면 true */
    bool tryCopyTargets(AutoTargets& out) const;
    AutoTargets targets() const;
    /** 저장된 상태를 복원한다(LEARN을 끈 채 고정된 자동 밴드) */
    void setLocked(const AutoTargets& t);

    float confidence() const { return confidence_.load(); }
    bool isLearning() const { return learning_.load(); }

private:
    void run() override;
    void analyzeWindow();
    void retarget(double nowSec);
    void publish();

    static constexpr int kFftOrder = 13;
    static constexpr int kFftSize = 1 << kFftOrder;
    static constexpr int kHop = kFftSize / 2;

    struct Slot {
        bool used = false;
        bool dying = false;
        double dieAt = 0;
        aeq::AutoBandFit fit;
        double lastMatched = 0;
    };

    const aeq::BandLayout layout_ = aeq::makeBands();
    aeq::AutoEq eq_{layout_.centers};
    juce::dsp::FFT fft_{kFftOrder};
    juce::dsp::WindowingFunction<float> window_{size_t(kFftSize), juce::dsp::WindowingFunction<float>::blackman};
    double windowSum_ = 1.0;

    juce::AbstractFifo fifo_{1 << 16};
    std::vector<float> fifoBuf_ = std::vector<float>(1 << 16);
    std::vector<float> ring_ = std::vector<float>(kFftSize, 0.f);
    std::vector<float> fftData_ = std::vector<float>(2 * kFftSize, 0.f);
    int ringFilled_ = 0;

    std::atomic<double> sampleRate_{48000.0};
    std::atomic<bool> learning_{false};
    std::atomic<bool> wantStart_{false}, wantStop_{false};
    std::atomic<double> maxCorrection_{3.0}, smoothOctaves_{1.5};
    std::atomic<int> maxAuto_{5};
    std::atomic<float> confidence_{0.f};

    std::array<Slot, kNumAuto> slots_{};
    std::map<int, double> proposed_;
    double lastRetarget_ = 0;

    mutable juce::SpinLock lock_;
    AutoTargets published_{};
};

}  // namespace autoeq
