#include "PluginEditor.h"

namespace autoeq {

namespace {
void setupKnob(juce::Component& parent, juce::Slider& s, juce::Label& l, const juce::String& text, const juce::String& suffix = {}) {
    s.setSliderStyle(juce::Slider::RotaryHorizontalVerticalDrag);
    s.setTextBoxStyle(juce::Slider::TextBoxBelow, false, 70, 18);
    s.setTextValueSuffix(suffix);
    l.setText(text, juce::dontSendNotification);
    l.setJustificationType(juce::Justification::centred);
    parent.addAndMakeVisible(s);
    parent.addAndMakeVisible(l);
}
void place(juce::Slider& s, juce::Label& l, juce::Rectangle<int> r) {
    l.setBounds(r.removeFromTop(16));
    s.setBounds(r);
}
}  // namespace

void CurveView::paint(juce::Graphics& g) {
    const auto area = getLocalBounds().toFloat();
    g.setColour(juce::Colour(0xff15171c));
    g.fillRect(area);

    constexpr double kMinHz = 20.0, kMaxHz = 20000.0, kRange = 18.0;
    auto xOf = [&](double hz) { return float(area.getX() + area.getWidth() * std::log(hz / kMinHz) / std::log(kMaxHz / kMinHz)); };
    auto yOf = [&](double db) { return float(area.getCentreY() - area.getHeight() * 0.5 * db / kRange); };

    g.setColour(juce::Colour(0xff2a2e37));
    for (double f : {50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0}) g.drawVerticalLine(int(xOf(f)), area.getY(), area.getBottom());
    for (double d : {-12.0, -6.0, 0.0, 6.0, 12.0}) g.drawHorizontalLine(int(yOf(d)), area.getX(), area.getRight());

    // 켜져 있는 밴드(수동 + 자동)의 응답을 합친다.
    std::vector<aeq::FilterSpec> specs;
    auto& s = proc_.apvts;
    for (int b = 0; b < kNumBands; ++b) {
        if (s.getRawParameterValue(bandId(b, "on"))->load() < 0.5f) continue;
        const auto type = typeFromIndex(int(s.getRawParameterValue(bandId(b, "type"))->load()));
        specs.push_back({type, double(s.getRawParameterValue(bandId(b, "freq"))->load()),
                         aeq::hasGain(type) ? double(s.getRawParameterValue(bandId(b, "gain"))->load()) : 0.0,
                         double(s.getRawParameterValue(bandId(b, "q"))->load())});
    }
    const double amount = double(s.getRawParameterValue("auto_amount")->load());
    for (const auto& t : proc_.autoTargets())
        if (t.active) specs.push_back({aeq::FilterType::Bell, t.freq, t.gain * amount, t.q});

    juce::Path path;
    const int steps = int(area.getWidth());
    for (int i = 0; i <= steps; ++i) {
        const double hz = kMinHz * std::pow(kMaxHz / kMinHz, double(i) / steps);
        const double db = std::clamp(aeq::responseDb(specs, hz), -kRange, kRange);
        const float x = area.getX() + float(i), y = yOf(db);
        if (i == 0) path.startNewSubPath(x, y); else path.lineTo(x, y);
    }
    g.setColour(juce::Colour(0xff5ac8a8));
    g.strokePath(path, juce::PathStrokeType(1.5f));

    g.setColour(juce::Colours::grey);
    g.setFont(11.f);
    for (double f : {100.0, 1000.0, 10000.0}) g.drawText(f >= 1000 ? juce::String(int(f / 1000)) + "k" : juce::String(int(f)), int(xOf(f)) + 2, int(area.getBottom()) - 14, 30, 12, juce::Justification::left);
}

AutoEQEditor::AutoEQEditor(AutoEQProcessor& p)
    : AudioProcessorEditor(&p), proc_(p), curve_(p),
      outputA_(p.apvts, "output", output_), amountA_(p.apvts, "auto_amount", amount_), maxA_(p.apvts, "auto_max", maxDb_),
      smoothA_(p.apvts, "auto_smooth", smooth_), autoBandsA_(p.apvts, "auto_bands", autoBands_),
      bypassA_(p.apvts, "bypass", bypass_), learnA_(p.apvts, "learn", learn_) {
    setSize(820, 520);
    addAndMakeVisible(curve_);
    addAndMakeVisible(bypass_);
    addAndMakeVisible(learn_);
    addAndMakeVisible(status_);
    status_.setJustificationType(juce::Justification::centredLeft);
    setupKnob(*this, output_, outputL_, "Output", " dB");
    setupKnob(*this, amount_, amountL_, "Auto Amount");
    setupKnob(*this, maxDb_, maxL_, "Max", " dB");
    setupKnob(*this, smooth_, smoothL_, "Smooth", " oct");
    setupKnob(*this, autoBands_, autoBandsL_, "Auto Bands");

    for (int b = 0; b < kNumBands; ++b) bandSelect_.addItem("Band " + juce::String(b + 1), b + 1);
    bandSelect_.onChange = [this] { bindBand(bandSelect_.getSelectedId() - 1); };
    addAndMakeVisible(bandSelect_);
    type_.addItemList({"Bell", "Low Shelf", "High Shelf", "High Pass", "Low Pass", "Notch"}, 1);
    mode_.addItemList({"Over", "Under"}, 1);
    for (auto* c : {&type_, &mode_}) addAndMakeVisible(c);
    addAndMakeVisible(on_);
    addAndMakeVisible(dyn_);
    setupKnob(*this, freq_, freqL_, "Freq", " Hz");
    setupKnob(*this, gain_, gainL_, "Gain", " dB");
    setupKnob(*this, q_, qL_, "Q");
    setupKnob(*this, thr_, thrL_, "Thresh", " dB");
    setupKnob(*this, range_, rangeL_, "Range", " dB");
    setupKnob(*this, att_, attL_, "Attack", " ms");
    setupKnob(*this, rel_, relL_, "Release", " ms");

    bandSelect_.setSelectedId(1, juce::sendNotification);
    startTimerHz(10);
}

void AutoEQEditor::bindBand(int band) {
    auto& s = proc_.apvts;
    onA_ = std::make_unique<ButtonAttachment>(s, bandId(band, "on"), on_);
    dynA_ = std::make_unique<ButtonAttachment>(s, bandId(band, "dyn"), dyn_);
    typeA_ = std::make_unique<ComboAttachment>(s, bandId(band, "type"), type_);
    modeA_ = std::make_unique<ComboAttachment>(s, bandId(band, "mode"), mode_);
    freqA_ = std::make_unique<SliderAttachment>(s, bandId(band, "freq"), freq_);
    gainA_ = std::make_unique<SliderAttachment>(s, bandId(band, "gain"), gain_);
    qA_ = std::make_unique<SliderAttachment>(s, bandId(band, "q"), q_);
    thrA_ = std::make_unique<SliderAttachment>(s, bandId(band, "thr"), thr_);
    rangeA_ = std::make_unique<SliderAttachment>(s, bandId(band, "range"), range_);
    attA_ = std::make_unique<SliderAttachment>(s, bandId(band, "att"), att_);
    relA_ = std::make_unique<SliderAttachment>(s, bandId(band, "rel"), rel_);
}

void AutoEQEditor::timerCallback() {
    curve_.repaint();
    if (proc_.analyzer.isLearning())
        status_.setText("Learning… confidence " + juce::String(int(proc_.analyzer.confidence() * 100)) + "%", juce::dontSendNotification);
    else
        status_.setText(learn_.getToggleState() ? "Starting…" : "Press LEARN, play a representative section, then press LEARN again to lock.", juce::dontSendNotification);
}

void AutoEQEditor::paint(juce::Graphics& g) { g.fillAll(juce::Colour(0xff1d2026)); }

void AutoEQEditor::resized() {
    auto r = getLocalBounds().reduced(10);
    auto top = r.removeFromTop(34);
    learn_.setBounds(top.removeFromLeft(90));
    bypass_.setBounds(top.removeFromLeft(90));
    status_.setBounds(top);

    curve_.setBounds(r.removeFromTop(230));
    r.removeFromTop(8);

    auto autoRow = r.removeFromTop(104);
    const int w = autoRow.getWidth() / 5;
    place(amount_, amountL_, autoRow.removeFromLeft(w));
    place(maxDb_, maxL_, autoRow.removeFromLeft(w));
    place(smooth_, smoothL_, autoRow.removeFromLeft(w));
    place(autoBands_, autoBandsL_, autoRow.removeFromLeft(w));
    place(output_, outputL_, autoRow);

    auto sel = r.removeFromTop(28);
    bandSelect_.setBounds(sel.removeFromLeft(110));
    on_.setBounds(sel.removeFromLeft(60));
    type_.setBounds(sel.removeFromLeft(120).reduced(4, 0));
    dyn_.setBounds(sel.removeFromLeft(100));
    mode_.setBounds(sel.removeFromLeft(90).reduced(4, 0));

    auto knobs = r.removeFromTop(104);
    const int kw = knobs.getWidth() / 7;
    place(freq_, freqL_, knobs.removeFromLeft(kw));
    place(gain_, gainL_, knobs.removeFromLeft(kw));
    place(q_, qL_, knobs.removeFromLeft(kw));
    place(thr_, thrL_, knobs.removeFromLeft(kw));
    place(range_, rangeL_, knobs.removeFromLeft(kw));
    place(att_, attL_, knobs.removeFromLeft(kw));
    place(rel_, relL_, knobs);
}

}  // namespace autoeq
