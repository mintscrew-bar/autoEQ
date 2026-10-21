#pragma once
#include <array>
#include <functional>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>
#include "PluginProcessor.h"

namespace autoeq {

// 웹 버전(index.html)과 같은 색
namespace pal {
inline const juce::Colour bg{0xff0c0f14}, plugin{0xff11151b}, raised{0xff171c24}, line{0xff232a34}, line2{0xff323b48},
    text{0xffe4e8ee}, muted{0xff7f8a99}, accent{0xff3ddc97}, cut{0xffff9a5c}, analyzer{0xff5b86ff}, autoc{0xff6aa8ff},
    dyn{0xffa08cff}, graphBg{0xff0e1217};
}

/** 웹 버전과 같은 모양의 노브·버튼·콤보 */
class AeqLook : public juce::LookAndFeel_V4 {
public:
    AeqLook();
    void drawRotarySlider(juce::Graphics&, int x, int y, int w, int h, float pos, float start, float end, juce::Slider&) override;
    void drawComboBox(juce::Graphics&, int w, int h, bool, int, int, int, int, juce::ComboBox&) override;
    void positionComboBoxText(juce::ComboBox&, juce::Label&) override;
    juce::Font getComboBoxFont(juce::ComboBox&) override { return juce::Font(juce::FontOptions(12.f)); }
    void drawButtonBackground(juce::Graphics&, juce::Button&, const juce::Colour&, bool hover, bool down) override;
    void drawButtonText(juce::Graphics&, juce::TextButton&, bool, bool) override;
    void drawToggleButton(juce::Graphics&, juce::ToggleButton&, bool hover, bool down) override;
};

/** 노브 + 이름표. 값 글자는 노브 안쪽에 그린다. */
class KnobSlider : public juce::Slider {
public:
    std::function<juce::String(double)> format;
};

class Knob : public juce::Component {
public:
    Knob(const juce::String& caption, std::function<juce::String(double)> fmt, juce::Colour colour = pal::accent);
    void bind(juce::AudioProcessorValueTreeState&, const juce::String& id);
    void unbind() { att_.reset(); }
    void resized() override;
    KnobSlider slider;

private:
    juce::Label label_;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> att_;
};

/** EQ 그래프: 스펙트럼 위에 곡선을 그리고, 노드를 끌어 밴드를 직접 편집한다 */
class EqGraph : public juce::Component {
public:
    explicit EqGraph(AutoEQProcessor& p);
    void paint(juce::Graphics&) override;
    void mouseDown(const juce::MouseEvent&) override;
    void mouseDrag(const juce::MouseEvent&) override;
    void mouseUp(const juce::MouseEvent&) override;
    void mouseDoubleClick(const juce::MouseEvent&) override;
    void mouseWheelMove(const juce::MouseEvent&, const juce::MouseWheelDetails&) override;
    bool keyPressed(const juce::KeyPress&) override;
    void updateSpectrum();

    int addBand(double hz, double db);
    void removeBand(int b);
    bool bandOn(int b) const;

    int selected = 0;
    std::function<void()> onSelect;

private:
    enum class Drag { None, Node, Range };
    struct Hit { int band = -1; bool range = false; };

    float xOf(double hz) const;
    float yOf(double db) const;
    double hzOf(float x) const;
    double dbOf(float y) const;
    juce::Rectangle<float> plot() const;
    Hit hitTest(juce::Point<float>) const;
    float get(int b, const char* n) const;
    void set(int b, const char* n, float v);
    void gesture(int b, bool begin);

    AutoEQProcessor& proc_;
    Drag drag_ = Drag::None;
    int dragBand_ = -1;

    static constexpr int kPoints = 200;
    juce::dsp::FFT fft_{12};
    juce::dsp::WindowingFunction<float> window_{size_t(AutoEQProcessor::kScope), juce::dsp::WindowingFunction<float>::hann};
    std::vector<float> data_ = std::vector<float>(2 * AutoEQProcessor::kScope, 0.f);
    std::array<float, kPoints> spec_{};
    bool haveSpec_ = false;
};

/** 밴드 목록의 알약 하나 */
class BandTab : public juce::Component {
public:
    BandTab(AutoEQProcessor& p, int band) : proc_(p), band_(band) {}
    void paint(juce::Graphics&) override;
    void mouseDown(const juce::MouseEvent&) override { if (onClick) onClick(band_); }
    std::function<void(int)> onClick;
    bool selected = false;

private:
    AutoEQProcessor& proc_;
    int band_;
};

class AutoEQEditor : public juce::AudioProcessorEditor, private juce::Timer {
public:
    explicit AutoEQEditor(AutoEQProcessor&);
    ~AutoEQEditor() override;

    void paint(juce::Graphics&) override;
    void resized() override;
    void showOptions(bool open) { setDrawer(open); }

private:
    void timerCallback() override;
    void selectBand(int band);
    void refreshBar();
    void layoutStrip();
    void setDrawer(bool open);
    int wantedHeight() const;

    using SliderAtt = juce::AudioProcessorValueTreeState::SliderAttachment;
    using ButtonAtt = juce::AudioProcessorValueTreeState::ButtonAttachment;
    using ComboAtt = juce::AudioProcessorValueTreeState::ComboBoxAttachment;

    AutoEQProcessor& proc_;
    AeqLook look_;
    EqGraph graph_;

    juce::ToggleButton bypass_{"BYPASS"};
    std::unique_ptr<ButtonAtt> bypassA_;

    // 밴드 목록
    std::vector<std::unique_ptr<BandTab>> tabs_;
    juce::TextButton add_{"+"}, clear_{"Clear all"};
    int tabMask_ = -1;

    // 선택한 밴드
    juce::ComboBox type_, mode_;
    juce::ToggleButton dyn_{"DYN"};
    juce::TextButton del_{"Delete"};
    Knob freq_, gain_, q_, thr_, range_, att_, rel_;
    std::unique_ptr<ComboAtt> typeA_, modeA_;
    std::unique_ptr<ButtonAtt> dynA_;
    bool barHasBand_ = false, barDyn_ = false;

    // 자동(LEARN)
    juce::ToggleButton learn_{"LEARN"};
    std::unique_ptr<ButtonAtt> learnA_;
    juce::Label info_;
    Knob amount_, max_, bands_;
    juce::TextButton options_{"Options"};

    // 옵션
    bool drawer_ = false;
    juce::ComboBox autoMode_, instrument_, style_;
    juce::Label modeL_, instL_, styleL_;
    Knob match_, liveSec_, smooth_, output_;
    std::unique_ptr<ComboAtt> autoModeA_, instrumentA_, styleA_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AutoEQEditor)
};

}  // namespace autoeq
