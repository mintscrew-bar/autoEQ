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
#include "dsp/Instruments.h"

namespace autoeq {

struct AutoTarget {
    bool active = false;
    float freq = 1000.f, gain = 0.f, q = 1.f;
};
using AutoTargets = std::array<AutoTarget, kNumAuto>;

/** 오디오 스레드가 분석 스레드에 넘기는 설정 */
struct AnalyzerSettings {
    double maxCorrectionDb = 3.0, smoothOctaves = 1.5;
    int maxAutoBands = 5;
    bool live = false;
    double liveSeconds = 20.0;
    double gateDb = -75.0;
    int instrument = 1;  // 0 끔, 1 자동 판별, 2~ 고정(instruments()[n-2])
    double instrumentMatch = 0.5;
};

class AutoAnalyzer : private juce::Thread {
public:
    AutoAnalyzer();
    ~AutoAnalyzer() override;

    void prepare(double sampleRate);
    /** 오디오 스레드: 모노 샘플을 넘긴다 */
    void push(const float* mono, int numSamples);

    void startLearning();
    void stopLearning();
    void setSettings(const AnalyzerSettings& s);
    /** 지금 적용 중인 악기(instruments() 인덱스, 없으면 -1). 자동 판별이면 판별 결과 */
    int activeInstrument() const { return activeInstrument_.load(); }

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
    std::atomic<double> maxCorrection_{3.0}, smoothOctaves_{1.5}, liveSeconds_{20.0}, gate_{-75.0}, instrumentMatch_{0.5};
    std::atomic<int> maxAuto_{5}, instrumentChoice_{1};
    std::atomic<bool> live_{false};
    std::atomic<int> activeInstrument_{-1};
    // 자동 판별(분석 스레드 전용): 깜박임을 막으려고 같은 후보가 일정 시간 이어져야 바꾼다
    void updateInstrument(double now);
    void applyInstrument(int index);
    int appliedInstrument_ = -1;
    int candidate_ = -1;
    double candidateSince_ = 0, lastConfident_ = 0;
    std::vector<std::vector<double>> instrumentTargets_;
    std::atomic<float> confidence_{0.f};

    std::array<Slot, kNumAuto> slots_{};
    std::map<int, double> proposed_;
    double lastRetarget_ = 0;

    mutable juce::SpinLock lock_;
    AutoTargets published_{};
};

}  // namespace autoeq
