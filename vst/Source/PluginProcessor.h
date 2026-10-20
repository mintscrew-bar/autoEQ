#pragma once
#include <array>
#include <atomic>
#include <vector>
#include <juce_audio_processors/juce_audio_processors.h>
#include "AutoAnalyzer.h"
#include "Params.h"
#include "dsp/Dynamics.h"
#include "dsp/Response.h"

namespace autoeq {

class AutoEQProcessor : public juce::AudioProcessor {
public:
    AutoEQProcessor();
    ~AutoEQProcessor() override = default;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "AutoEQ"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    juce::AudioProcessorValueTreeState apvts;
    AutoAnalyzer analyzer;

    /** 에디터가 곡선을 그릴 때 쓰는, 지금 적용 중인 자동 밴드 */
    AutoTargets autoTargets() const { return analyzer.targets(); }

private:
    static constexpr int kSub = 64;  // 파라미터·다이나믹을 갱신하는 단위(샘플)

    struct Slot {
        aeq::Coeffs c;
        bool active = false;
        double z1[2] = {0, 0}, z2[2] = {0, 0};
    };
    struct Detector {
        aeq::Coeffs c;
        double z1 = 0, z2 = 0;
        double meanSquare = 0;
        double amount = 0;  // 다이나믹 작동 정도 0~1
    };
    struct Smoothed {
        juce::SmoothedValue<double, juce::ValueSmoothingTypes::Multiplicative> freq, q;
        juce::SmoothedValue<double> gain;
    };

    void updateAutoSlots(double dt, double amount);
    double computeHeadroom(const std::vector<aeq::FilterSpec>& specs) const;

    double sampleRate_ = 48000.0;
    std::array<Slot, kNumBands + kNumAuto> slots_{};
    std::array<Detector, kNumBands> detectors_{};
    std::array<Smoothed, kNumBands> smoothed_{};
    juce::SmoothedValue<double> trim_, output_;
    bool wasLearning_ = false;
    int headroomCounter_ = 0;
    double headroomDb_ = 0;

    // 자동 밴드의 현재(부드럽게 따라가는) 값
    struct AutoState { bool active = false; double freq = 1000, gain = 0, q = 1; };
    std::array<AutoState, kNumAuto> autoState_{};
    AutoTargets lastTargets_{};

    std::vector<float> mono_;
    std::vector<aeq::FilterSpec> chain_;  // 헤드룸 계산용(켜져 있는 필터). 오디오 스레드에서 할당하지 않도록 재사용한다

    // 파라미터 포인터는 생성 때 한 번만 찾아 둔다(오디오 스레드에서 문자열을 만들지 않으려고)
    struct BandParams {
        std::atomic<float> *on, *type, *freq, *gain, *q, *dyn, *thr, *range, *att, *rel, *mode;
    };
    std::array<BandParams, kNumBands> bandParams_{};
    std::atomic<float> *bypass_ = nullptr, *learn_ = nullptr, *output_p_ = nullptr, *autoAmount_ = nullptr,
                       *autoMax_ = nullptr, *autoSmooth_ = nullptr, *autoBands_ = nullptr, *autoMode_ = nullptr,
                       *liveSeconds_ = nullptr, *autoGate_ = nullptr, *instrument_ = nullptr, *instMatch_ = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AutoEQProcessor)
};

}  // namespace autoeq
