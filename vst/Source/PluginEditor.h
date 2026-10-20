#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "PluginProcessor.h"

namespace autoeq {

/** 지금 적용 중인 EQ 곡선(수동 밴드 + 자동 밴드)을 그린다 */
class CurveView : public juce::Component {
public:
    explicit CurveView(AutoEQProcessor& p) : proc_(p) {}
    void paint(juce::Graphics& g) override;

private:
    AutoEQProcessor& proc_;
};

class AutoEQEditor : public juce::AudioProcessorEditor, private juce::Timer {
public:
    explicit AutoEQEditor(AutoEQProcessor&);
    ~AutoEQEditor() override = default;

    void paint(juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void bindBand(int band);

    using Slider = juce::Slider;
    using SliderAttachment = juce::AudioProcessorValueTreeState::SliderAttachment;
    using ButtonAttachment = juce::AudioProcessorValueTreeState::ButtonAttachment;
    using ComboAttachment = juce::AudioProcessorValueTreeState::ComboBoxAttachment;

    AutoEQProcessor& proc_;
    CurveView curve_;

    // 전체
    juce::ToggleButton bypass_{"Bypass"}, learn_{"LEARN"};
    Slider output_, amount_, maxDb_, smooth_, autoBands_, match_, liveSec_;
    juce::Label outputL_, amountL_, maxL_, smoothL_, autoBandsL_, matchL_, liveSecL_, status_;
    juce::ComboBox instrument_, autoMode_;
    SliderAttachment outputA_, amountA_, maxA_, smoothA_, autoBandsA_, matchA_, liveSecA_;
    std::unique_ptr<ComboAttachment> instrumentA_, autoModeA_;  // 항목을 채운 뒤에 붙인다
    ButtonAttachment bypassA_, learnA_;

    // 선택한 밴드
    juce::ComboBox bandSelect_, type_, mode_;
    juce::ToggleButton on_{"On"}, dyn_{"Dynamic"};
    Slider freq_, gain_, q_, thr_, range_, att_, rel_;
    juce::Label freqL_, gainL_, qL_, thrL_, rangeL_, attL_, relL_;
    std::unique_ptr<ButtonAttachment> onA_, dynA_;
    std::unique_ptr<ComboAttachment> typeA_, modeA_;
    std::unique_ptr<SliderAttachment> freqA_, gainA_, qA_, thrA_, rangeA_, attA_, relA_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AutoEQEditor)
};

}  // namespace autoeq
