// 플러그인 파라미터 정의. 밴드 8개(수동) + 자동 보정(LEARN) 설정.
#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "dsp/Instruments.h"
#include "dsp/Response.h"

namespace autoeq {

constexpr int kNumBands = 8;  // 수동 밴드 수
constexpr int kNumAuto = 8;   // 자동 밴드 최대 수

inline juce::String bandId(int band, const char* name) { return "b" + juce::String(band + 1) + "_" + name; }

inline aeq::FilterType typeFromIndex(int i) {
    switch (i) {
        case 1: return aeq::FilterType::LowShelf;
        case 2: return aeq::FilterType::HighShelf;
        case 3: return aeq::FilterType::HighPass;
        case 4: return aeq::FilterType::LowPass;
        case 5: return aeq::FilterType::Notch;
        default: return aeq::FilterType::Bell;
    }
}

inline juce::AudioProcessorValueTreeState::ParameterLayout createLayout() {
    using P = juce::ParameterID;
    juce::AudioProcessorValueTreeState::ParameterLayout layout;
    const juce::NormalisableRange<float> freqRange(20.f, 20000.f, 0.f, 0.25f);
    const juce::NormalisableRange<float> qRange(0.1f, 18.f, 0.f, 0.4f);
    const juce::StringArray types{"Bell", "Low Shelf", "High Shelf", "High Pass", "Low Pass", "Notch"};
    const float defaultFreq[kNumBands] = {80.f, 200.f, 500.f, 1000.f, 2500.f, 5000.f, 10000.f, 16000.f};

    layout.add(std::make_unique<juce::AudioParameterBool>(P{"bypass", 1}, "Bypass", false));
    layout.add(std::make_unique<juce::AudioParameterFloat>(P{"output", 1}, "Output", juce::NormalisableRange<float>(-18.f, 18.f, 0.1f), 0.f));
    layout.add(std::make_unique<juce::AudioParameterBool>(P{"learn", 1}, "Learn", false));
    layout.add(std::make_unique<juce::AudioParameterFloat>(P{"auto_amount", 1}, "Auto Amount", juce::NormalisableRange<float>(0.f, 1.f, 0.01f), 1.f));
    layout.add(std::make_unique<juce::AudioParameterFloat>(P{"auto_max", 1}, "Auto Max dB", juce::NormalisableRange<float>(0.5f, 6.f, 0.1f), 3.f));
    layout.add(std::make_unique<juce::AudioParameterFloat>(P{"auto_smooth", 1}, "Auto Smooth Oct", juce::NormalisableRange<float>(0.5f, 3.f, 0.1f), 1.5f));
    layout.add(std::make_unique<juce::AudioParameterInt>(P{"auto_bands", 1}, "Auto Bands", 1, kNumAuto, 5));
    // Learn: 시작부터의 전체 평균으로 학습한 뒤 고정. Live: 입력을 계속 천천히 따라간다(라이브 모니터링).
    layout.add(std::make_unique<juce::AudioParameterChoice>(P{"auto_mode", 1}, "Auto Mode", juce::StringArray{"Learn", "Live"}, 0));
    layout.add(std::make_unique<juce::AudioParameterFloat>(P{"live_seconds", 1}, "Live Window", juce::NormalisableRange<float>(5.f, 120.f, 1.f, 0.5f), 20.f));
    layout.add(std::make_unique<juce::AudioParameterFloat>(P{"auto_gate", 1}, "Gate dB", juce::NormalisableRange<float>(-100.f, -40.f, 1.f), -75.f));
    juce::StringArray instNames{"Off", "Auto"};
    for (const auto& inst : aeq::instruments()) instNames.add(inst.name);
    layout.add(std::make_unique<juce::AudioParameterChoice>(P{"instrument", 1}, "Instrument", instNames, 1));
    juce::StringArray styleNames;
    for (const auto& st : aeq::styles()) styleNames.add(st.name);
    layout.add(std::make_unique<juce::AudioParameterChoice>(P{"style", 1}, "Style", styleNames, 0));
    layout.add(std::make_unique<juce::AudioParameterFloat>(P{"inst_match", 1}, "Instrument Match", juce::NormalisableRange<float>(0.f, 1.f, 0.01f), 0.3f));

    for (int b = 0; b < kNumBands; ++b) {
        const juce::String n = "Band " + juce::String(b + 1) + " ";
        layout.add(std::make_unique<juce::AudioParameterBool>(P{bandId(b, "on"), 1}, n + "On", false));
        layout.add(std::make_unique<juce::AudioParameterChoice>(P{bandId(b, "type"), 1}, n + "Type", types, 0));
        layout.add(std::make_unique<juce::AudioParameterFloat>(P{bandId(b, "freq"), 1}, n + "Freq", freqRange, defaultFreq[b]));
        layout.add(std::make_unique<juce::AudioParameterFloat>(P{bandId(b, "gain"), 1}, n + "Gain", juce::NormalisableRange<float>(-18.f, 18.f, 0.1f), 0.f));
        layout.add(std::make_unique<juce::AudioParameterFloat>(P{bandId(b, "q"), 1}, n + "Q", qRange, 1.f));
        layout.add(std::make_unique<juce::AudioParameterBool>(P{bandId(b, "dyn"), 1}, n + "Dynamic", false));
        layout.add(std::make_unique<juce::AudioParameterFloat>(P{bandId(b, "thr"), 1}, n + "Threshold", juce::NormalisableRange<float>(-90.f, 0.f, 0.1f), -40.f));
        layout.add(std::make_unique<juce::AudioParameterFloat>(P{bandId(b, "range"), 1}, n + "Range", juce::NormalisableRange<float>(-18.f, 18.f, 0.1f), -6.f));
        layout.add(std::make_unique<juce::AudioParameterFloat>(P{bandId(b, "att"), 1}, n + "Attack", juce::NormalisableRange<float>(1.f, 200.f, 0.f, 0.4f), 10.f));
        layout.add(std::make_unique<juce::AudioParameterFloat>(P{bandId(b, "rel"), 1}, n + "Release", juce::NormalisableRange<float>(10.f, 2000.f, 0.f, 0.4f), 150.f));
        layout.add(std::make_unique<juce::AudioParameterChoice>(P{bandId(b, "mode"), 1}, n + "Mode", juce::StringArray{"Over", "Under"}, 0));
    }
    return layout;
}

}  // namespace autoeq
