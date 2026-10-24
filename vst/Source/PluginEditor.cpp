#include "PluginEditor.h"

namespace autoeq {

namespace {
constexpr float kPadL = 38.f, kPadR = 10.f, kPadT = 10.f, kPadB = 22.f;
constexpr double kMinHz = 20.0, kMaxHz = 20000.0, kRangeDb = 18.0;
constexpr float kPi = juce::MathConstants<float>::pi;

juce::String fmtFreq(double hz) { return hz >= 1000.0 ? juce::String(hz / 1000.0, 2) + "k" : juce::String(int(std::round(hz))); }
juce::String fmtDb(double v) { return (v > 0.05 ? "+" : "") + juce::String(v, 1); }
juce::String fmtQ(double v) { return juce::String(v, 2); }
juce::String fmtMs(double v) { return juce::String(int(std::round(v))); }
juce::String fmtPct(double v) { return juce::String(int(std::round(v * 100.0))) + "%"; }
juce::String fmtInt(double v) { return juce::String(int(std::round(v))); }
juce::String fmtSec(double v) { return juce::String(int(std::round(v))) + "s"; }
juce::String fmtOct(double v) { return juce::String(v, 1); }

float getParam(AutoEQProcessor& p, const juce::String& id) { return p.apvts.getRawParameterValue(id)->load(); }
void setParam(AutoEQProcessor& p, const juce::String& id, float plain) {
    if (auto* pr = p.apvts.getParameter(id)) pr->setValueNotifyingHost(pr->convertTo0to1(plain));
}
}  // namespace

// ---------------------------------------------------------------- 룩앤필

AeqLook::AeqLook() {
    setColour(juce::ComboBox::textColourId, pal::text);
    setColour(juce::ComboBox::arrowColourId, pal::muted);
    setColour(juce::PopupMenu::backgroundColourId, pal::raised);
    setColour(juce::PopupMenu::textColourId, pal::text);
    setColour(juce::PopupMenu::highlightedBackgroundColourId, pal::line2);
    setColour(juce::PopupMenu::highlightedTextColourId, pal::text);
    setColour(juce::TextButton::textColourOffId, pal::muted);
    setColour(juce::TextButton::textColourOnId, pal::text);
    setColour(juce::Label::textColourId, pal::muted);
}

void AeqLook::drawRotarySlider(juce::Graphics& g, int x, int y, int w, int h, float pos, float start, float end, juce::Slider& s) {
    const float side = float(std::min(w, h));
    const juce::Point<float> c(float(x) + float(w) * 0.5f, float(y) + float(h) * 0.5f);
    const float r = side * 0.5f - 3.f;
    const auto fill = s.findColour(juce::Slider::rotarySliderFillColourId);
    const float stroke = side > 60.f ? 4.4f : 3.6f;

    juce::Path track;
    track.addCentredArc(c.x, c.y, r, r, 0.f, start, end, true);
    g.setColour(juce::Colour(0xff232a35));
    g.strokePath(track, juce::PathStrokeType(stroke, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));

    if (s.isEnabled() && pos > 0.001f) {
        juce::Path value;
        value.addCentredArc(c.x, c.y, r, r, 0.f, start, start + pos * (end - start), true);
        g.setColour(fill);
        g.strokePath(value, juce::PathStrokeType(stroke, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    }
    const float br = r - stroke - 1.f;
    g.setColour(juce::Colour(0xff1d232d));
    g.fillEllipse(c.x - br, c.y - br, br * 2, br * 2);
    g.setColour(s.isMouseOverOrDragging() ? pal::muted : juce::Colour(0xff2e3643));
    g.drawEllipse(c.x - br, c.y - br, br * 2, br * 2, 1.f);

    const auto* ks = dynamic_cast<KnobSlider*>(&s);
    const juce::String text = ks && ks->format ? ks->format(s.getValue()) : s.getTextFromValue(s.getValue());
    g.setColour(s.isEnabled() ? pal::text : pal::muted);
    g.setFont(juce::Font(juce::FontOptions(side > 60.f ? 13.f : 11.f, juce::Font::bold)));
    g.drawText(text, juce::Rectangle<float>(c.x - br, c.y - 9.f, br * 2, 18.f), juce::Justification::centred, false);
}

void AeqLook::drawComboBox(juce::Graphics& g, int w, int h, bool, int, int, int, int, juce::ComboBox& box) {
    const auto r = juce::Rectangle<float>(0.5f, 0.5f, float(w) - 1.f, float(h) - 1.f);
    g.setColour(pal::plugin);
    g.fillRoundedRectangle(r, 6.f);
    g.setColour(box.isMouseOver() ? pal::muted : pal::line2);
    g.drawRoundedRectangle(r, 6.f, 1.f);
    juce::Path arrow;
    const float ax = float(w) - 14.f, ay = float(h) * 0.5f;
    arrow.addTriangle(ax - 4.f, ay - 2.f, ax + 4.f, ay - 2.f, ax, ay + 3.f);
    g.setColour(pal::muted);
    g.fillPath(arrow);
}

void AeqLook::positionComboBoxText(juce::ComboBox& box, juce::Label& label) {
    label.setBounds(8, 1, box.getWidth() - 26, box.getHeight() - 2);
    label.setFont(getComboBoxFont(box));
}

void AeqLook::drawButtonBackground(juce::Graphics& g, juce::Button& b, const juce::Colour&, bool hover, bool) {
    const auto r = b.getLocalBounds().toFloat().reduced(0.5f);
    g.setColour(hover ? pal::muted : pal::line2);
    g.drawRoundedRectangle(r, 6.f, 1.f);
}

void AeqLook::drawButtonText(juce::Graphics& g, juce::TextButton& b, bool hover, bool) {
    g.setColour(hover ? pal::text : pal::muted);
    g.setFont(juce::Font(juce::FontOptions(12.f)));
    g.drawText(b.getButtonText(), b.getLocalBounds(), juce::Justification::centred, false);
}

void AeqLook::drawToggleButton(juce::Graphics& g, juce::ToggleButton& b, bool hover, bool) {
    const auto area = b.getLocalBounds().toFloat();
    const bool on = b.getToggleState();
    const auto id = b.getComponentID();
    if (id == "learn") {
        const auto r = area.reduced(0.5f);
        g.setColour(on ? pal::autoc : (hover ? pal::muted : pal::line2));
        g.drawRoundedRectangle(r, r.getHeight() / 2, 1.f);
        const float d = 8.f;
        const float cx = r.getX() + 16.f, cy = r.getCentreY();
        g.setColour(on ? pal::autoc : pal::cut);
        if (on) g.fillRoundedRectangle(cx - d / 2, cy - d / 2, d, d, 2.f);
        else g.fillEllipse(cx - d / 2, cy - d / 2, d, d);
        g.setColour(on ? pal::autoc : pal::text);
        g.setFont(juce::Font(juce::FontOptions(11.f, juce::Font::bold)));
        g.drawText(on ? "STOP" : "LEARN", r.withTrimmedLeft(28.f), juce::Justification::centredLeft, false);
    } else if (id == "pill") {
        const auto r = area.reduced(0.5f);
        g.setColour(on ? pal::dyn : (hover ? pal::muted : pal::line2));
        if (on) g.fillRoundedRectangle(r, r.getHeight() / 2);
        else g.drawRoundedRectangle(r, r.getHeight() / 2, 1.f);
        g.setColour(on ? pal::bg : pal::muted);
        g.setFont(juce::Font(juce::FontOptions(10.f, juce::Font::bold)));
        g.drawText(b.getButtonText(), r, juce::Justification::centred, false);
    } else {  // switch
        const float sw = 28.f, sh = 16.f, y = area.getCentreY() - sh / 2;
        g.setColour(on ? pal::cut : pal::line2);
        g.fillRoundedRectangle(area.getX(), y, sw, sh, sh / 2);
        g.setColour(on ? pal::bg : pal::muted);
        g.fillEllipse(area.getX() + (on ? 14.f : 2.f), y + 2.f, 12.f, 12.f);
        g.setColour(on ? pal::text : pal::muted);
        g.setFont(juce::Font(juce::FontOptions(10.5f)));
        g.drawText(b.getButtonText(), area.withTrimmedLeft(sw + 7.f), juce::Justification::centredLeft, false);
    }
}

// ---------------------------------------------------------------- 노브

Knob::Knob(const juce::String& caption, std::function<juce::String(double)> fmt, juce::Colour colour) {
    slider.format = std::move(fmt);
    slider.setSliderStyle(juce::Slider::RotaryVerticalDrag);
    slider.setTextBoxStyle(juce::Slider::NoTextBox, true, 0, 0);
    slider.setRotaryParameters(kPi * 1.25f, kPi * 2.75f, true);
    slider.setMouseDragSensitivity(220);
    slider.setColour(juce::Slider::rotarySliderFillColourId, colour);
    addAndMakeVisible(slider);
    label_.setText(caption.toUpperCase(), juce::dontSendNotification);
    label_.setJustificationType(juce::Justification::centred);
    label_.setFont(juce::Font(juce::FontOptions(9.5f)));
    label_.setInterceptsMouseClicks(false, false);
    addAndMakeVisible(label_);
}

void Knob::bind(juce::AudioProcessorValueTreeState& s, const juce::String& id) {
    att_.reset();
    att_ = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(s, id, slider);
}

void Knob::resized() {
    auto r = getLocalBounds();
    label_.setBounds(r.removeFromBottom(14));
    slider.setBounds(r);
}

// ---------------------------------------------------------------- 그래프

EqGraph::EqGraph(AutoEQProcessor& p) : proc_(p) {
    setWantsKeyboardFocus(true);
    spec_.fill(-200.f);
}

juce::Rectangle<float> EqGraph::plot() const {
    return {kPadL, kPadT, float(getWidth()) - kPadL - kPadR, float(getHeight()) - kPadT - kPadB};
}
float EqGraph::xOf(double hz) const {
    const auto p = plot();
    return p.getX() + float(std::log(hz / kMinHz) / std::log(kMaxHz / kMinHz)) * p.getWidth();
}
float EqGraph::yOf(double db) const {
    const auto p = plot();
    return p.getCentreY() - float(db / kRangeDb) * p.getHeight() * 0.5f;
}
double EqGraph::hzOf(float x) const {
    const auto p = plot();
    return kMinHz * std::exp(double((x - p.getX()) / p.getWidth()) * std::log(kMaxHz / kMinHz));
}
double EqGraph::dbOf(float y) const {
    const auto p = plot();
    return double((p.getCentreY() - y) / (p.getHeight() * 0.5f)) * kRangeDb;
}

float EqGraph::get(int b, const char* n) const { return getParam(proc_, bandId(b, n)); }
void EqGraph::set(int b, const char* n, float v) { setParam(proc_, bandId(b, n), v); }
bool EqGraph::bandOn(int b) const { return get(b, "on") > 0.5f; }

void EqGraph::gesture(int b, bool begin) {
    for (const char* n : {"freq", "gain", "range", "q"})
        if (auto* pr = proc_.apvts.getParameter(bandId(b, n))) {
            if (begin) pr->beginChangeGesture(); else pr->endChangeGesture();
        }
}

EqGraph::Hit EqGraph::hitTest(juce::Point<float> pt) const {
    auto nodePos = [&](int b) {
        const auto type = typeFromIndex(int(get(b, "type")));
        return juce::Point<float>(xOf(get(b, "freq")), yOf(aeq::hasGain(type) ? get(b, "gain") : 0.f));
    };
    std::vector<int> order;
    if (selected >= 0 && selected < kNumBands && bandOn(selected)) order.push_back(selected);
    for (int b = kNumBands - 1; b >= 0; --b)
        if (b != selected && bandOn(b)) order.push_back(b);
    for (int b : order) {
        if (get(b, "dyn") > 0.5f) {
            const double db = std::clamp<double>(get(b, "gain") + get(b, "range"), -kRangeDb, kRangeDb);
            if (pt.getDistanceFrom({nodePos(b).x, yOf(db)}) <= 10.f) return {b, true};
        }
    }
    Hit best;
    float bestD = 13.f;
    for (int b : order) {
        const float d = pt.getDistanceFrom(nodePos(b));
        if (d < bestD) { bestD = d; best = {b, false}; }
    }
    return best;
}

int EqGraph::addBand(double hz, double db) {
    for (int b = 0; b < kNumBands; ++b) {
        if (bandOn(b)) continue;
        set(b, "type", 0.f);
        set(b, "freq", float(std::clamp(hz, kMinHz, kMaxHz)));
        set(b, "gain", float(std::clamp(db, -kRangeDb, kRangeDb)));
        set(b, "q", 1.f);
        set(b, "dyn", 0.f);
        set(b, "on", 1.f);
        selected = b;
        if (onSelect) onSelect();
        return b;
    }
    return -1;
}

void EqGraph::removeBand(int b) {
    if (b < 0 || b >= kNumBands) return;
    set(b, "on", 0.f);
    set(b, "dyn", 0.f);
    set(b, "gain", 0.f);
    if (onSelect) onSelect();
}

void EqGraph::mouseDown(const juce::MouseEvent& e) {
    grabKeyboardFocus();
    const auto hit = hitTest(e.position);
    if (hit.band < 0) return;
    if (e.mods.isPopupMenu()) { removeBand(hit.band); return; }
    selected = hit.band;
    dragBand_ = hit.band;
    drag_ = hit.range ? Drag::Range : Drag::Node;
    gesture(dragBand_, true);
    if (onSelect) onSelect();
}

void EqGraph::mouseDrag(const juce::MouseEvent& e) {
    if (drag_ == Drag::None || dragBand_ < 0) return;
    const auto p = plot();
    const float x = std::clamp(e.position.x, p.getX(), p.getRight());
    const float y = std::clamp(e.position.y, p.getY(), p.getBottom());
    const auto type = typeFromIndex(int(get(dragBand_, "type")));
    if (drag_ == Drag::Node) {
        set(dragBand_, "freq", float(std::clamp(hzOf(x), kMinHz, kMaxHz)));
        if (aeq::hasGain(type)) set(dragBand_, "gain", float(std::round(std::clamp(dbOf(y), -kRangeDb, kRangeDb) * 10.0) / 10.0));
    } else {
        const double r = std::clamp(dbOf(y) - double(get(dragBand_, "gain")), -kRangeDb, kRangeDb);
        set(dragBand_, "range", float(std::round(r * 10.0) / 10.0));
    }
}

void EqGraph::mouseUp(const juce::MouseEvent&) {
    if (drag_ != Drag::None && dragBand_ >= 0) gesture(dragBand_, false);
    drag_ = Drag::None;
    dragBand_ = -1;
}

void EqGraph::mouseDoubleClick(const juce::MouseEvent& e) {
    const auto hit = hitTest(e.position);
    if (hit.band >= 0) { removeBand(hit.band); return; }
    if (plot().contains(e.position)) addBand(hzOf(e.position.x), dbOf(e.position.y));
}

void EqGraph::mouseWheelMove(const juce::MouseEvent& e, const juce::MouseWheelDetails& w) {
    int b = hitTest(e.position).band;
    if (b < 0) b = selected;
    if (b < 0 || b >= kNumBands || !bandOn(b)) return;
    const double q = std::clamp(double(get(b, "q")) * std::exp(double(w.deltaY) * 2.0), 0.1, 18.0);
    if (auto* pr = proc_.apvts.getParameter(bandId(b, "q"))) {
        pr->beginChangeGesture();
        set(b, "q", float(q));
        pr->endChangeGesture();
    }
}

bool EqGraph::keyPressed(const juce::KeyPress& k) {
    if (k == juce::KeyPress::deleteKey || k == juce::KeyPress::backspaceKey) {
        if (selected >= 0 && bandOn(selected)) removeBand(selected);
        return true;
    }
    return false;
}

void EqGraph::updateSpectrum() {
    constexpr int N = AutoEQProcessor::kScope;
    const double sr = proc_.getSampleRate() > 0 ? proc_.getSampleRate() : 48000.0;
    proc_.copyScope(data_.data());
    std::fill(data_.begin() + N, data_.end(), 0.f);
    window_.multiplyWithWindowingTable(data_.data(), size_t(N));
    fft_.performFrequencyOnlyForwardTransform(data_.data());
    auto magAt = [&](double bin) {
        const int i0 = std::clamp(int(std::floor(bin)), 0, N / 2 - 1);
        const double fr = std::clamp(bin - i0, 0.0, 1.0);
        return double(data_[size_t(i0)]) * (1 - fr) + double(data_[size_t(i0 + 1)]) * fr;
    };
    for (int i = 0; i < kPoints; ++i) {
        const double f = kMinHz * std::pow(kMaxHz / kMinHz, double(i) / (kPoints - 1));
        const double lo = f * std::pow(2.0, -1.0 / 8) * N / sr, hi = f * std::pow(2.0, 1.0 / 8) * N / sr;
        double mag;
        if (hi - lo < 1.0) mag = magAt(f * N / sr);
        else {
            mag = 0;
            for (int b = std::max(1, int(std::floor(lo))); b <= std::min(N / 2 - 1, int(std::ceil(hi))); ++b) mag = std::max(mag, double(data_[size_t(b)]));
        }
        const float db = float(20.0 * std::log10(mag / (N / 4.0) + 1e-9) + 10.0 * std::log10(f / 1000.0));
        float& s = spec_[size_t(i)];
        s = s < -150.f ? db : (db > s ? s + 0.5f * (db - s) : s + 0.12f * (db - s));
    }
    haveSpec_ = true;
}

void EqGraph::paint(juce::Graphics& g) {
    g.fillAll(pal::graphBg);
    const auto p = plot();
    const float bottom = p.getBottom(), right = p.getRight();

    // 격자
    for (double base : {10.0, 100.0, 1000.0, 10000.0})
        for (int k = 1; k <= 9; ++k) {
            const double hz = base * k;
            if (hz < kMinHz || hz > kMaxHz) continue;
            const bool decade = hz == 100 || hz == 1000 || hz == 10000;
            g.setColour(pal::muted.withAlpha(decade ? 0.28f : 0.1f));
            g.drawVerticalLine(int(xOf(hz)), p.getY(), bottom);
        }
    g.setFont(juce::Font(juce::FontOptions(10.f)));
    for (int db = -int(kRangeDb); db <= int(kRangeDb); db += 6) {
        const int y = int(yOf(db));
        g.setColour(pal::muted.withAlpha(db == 0 ? 0.45f : 0.1f));
        g.drawHorizontalLine(y, p.getX(), right);
        g.setColour(pal::muted.withAlpha(db == 0 ? 1.f : 0.7f));
        g.drawText((db > 0 ? "+" : "") + juce::String(db), 0, y - 6, int(kPadL) - 6, 12, juce::Justification::centredRight, false);
    }
    for (double hz : {20.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0, 20000.0}) {
        g.setColour(pal::muted.withAlpha(0.8f));
        const float tx = std::clamp(xOf(hz), p.getX() + 8.f, right - 8.f);
        g.drawText(hz >= 1000 ? juce::String(int(hz / 1000)) + "k" : juce::String(int(hz)), int(tx) - 20, int(bottom) + 5, 40, 12, juce::Justification::centred, false);
    }

    // 스펙트럼(입력)
    if (haveSpec_) {
        constexpr float kFloor = -90.f, kSpan = 70.f;
        juce::Path line;
        for (int i = 0; i < kPoints; ++i) {
            const double f = kMinHz * std::pow(kMaxHz / kMinHz, double(i) / (kPoints - 1));
            const float v = std::clamp((spec_[size_t(i)] - kFloor) / kSpan, 0.f, 1.f);
            const float x = xOf(f), y = bottom - v * p.getHeight();
            if (i == 0) line.startNewSubPath(x, y); else line.lineTo(x, y);
        }
        juce::Path area(line);
        area.lineTo(right, bottom);
        area.lineTo(p.getX(), bottom);
        area.closeSubPath();
        g.setColour(pal::analyzer.withAlpha(0.2f));
        g.fillPath(area);
        g.setColour(pal::analyzer.withAlpha(0.75f));
        g.strokePath(line, juce::PathStrokeType(1.f));
    }

    // 곡선: 수동 밴드 + 자동 밴드
    std::vector<aeq::FilterSpec> specs;
    for (int b = 0; b < kNumBands; ++b) {
        if (!bandOn(b)) continue;
        const auto type = typeFromIndex(int(get(b, "type")));
        specs.push_back({type, double(get(b, "freq")), aeq::hasGain(type) ? double(get(b, "gain")) : 0.0, double(get(b, "q"))});
    }
    const double amount = double(getParam(proc_, "auto_amount"));
    const auto autos = proc_.autoTargets();
    for (const auto& t : autos)
        if (t.active) specs.push_back({aeq::FilterType::Bell, double(t.freq), double(t.gain) * amount, double(t.q)});

    const int steps = std::max(2, int(p.getWidth() / 2));
    juce::Path curve;
    std::vector<float> ys(size_t(steps + 1));
    for (int i = 0; i <= steps; ++i) {
        const double hz = kMinHz * std::pow(kMaxHz / kMinHz, double(i) / steps);
        const double db = std::clamp(aeq::responseDb(specs, hz), -kRangeDb, kRangeDb);
        const float x = p.getX() + p.getWidth() * float(i) / steps, y = yOf(db);
        ys[size_t(i)] = y;
        if (i == 0) curve.startNewSubPath(x, y); else curve.lineTo(x, y);
    }
    const float y0 = yOf(0);
    juce::Path fillPath(curve);
    fillPath.lineTo(right, y0);
    fillPath.lineTo(p.getX(), y0);
    fillPath.closeSubPath();
    {
        juce::Graphics::ScopedSaveState s(g);
        g.reduceClipRegion(juce::Rectangle<float>(p.getX(), p.getY(), p.getWidth(), y0 - p.getY()).toNearestInt());
        g.setColour(pal::accent.withAlpha(0.2f));
        g.fillPath(fillPath);
    }
    {
        juce::Graphics::ScopedSaveState s(g);
        g.reduceClipRegion(juce::Rectangle<float>(p.getX(), y0, p.getWidth(), bottom - y0).toNearestInt());
        g.setColour(pal::cut.withAlpha(0.2f));
        g.fillPath(fillPath);
    }
    if (selected >= 0 && selected < kNumBands && bandOn(selected)) {
        const auto type = typeFromIndex(int(get(selected, "type")));
        std::vector<aeq::FilterSpec> one{{type, double(get(selected, "freq")), aeq::hasGain(type) ? double(get(selected, "gain")) : 0.0, double(get(selected, "q"))}};
        juce::Path sel;
        for (int i = 0; i <= steps; ++i) {
            const double hz = kMinHz * std::pow(kMaxHz / kMinHz, double(i) / steps);
            const float x = p.getX() + p.getWidth() * float(i) / steps, y = yOf(std::clamp(aeq::responseDb(one, hz), -kRangeDb, kRangeDb));
            if (i == 0) sel.startNewSubPath(x, y); else sel.lineTo(x, y);
        }
        g.setColour(pal::text.withAlpha(0.5f));
        g.strokePath(sel, juce::PathStrokeType(1.f));
    }
    g.setColour(pal::accent);
    g.strokePath(curve, juce::PathStrokeType(2.f, juce::PathStrokeType::curved));

    // 자동 밴드(읽기 전용)
    for (const auto& t : autos) {
        if (!t.active) continue;
        const float x = xOf(t.freq), y = yOf(std::clamp<double>(double(t.gain) * amount, -kRangeDb, kRangeDb));
        g.setColour(pal::autoc.withAlpha(0.35f));
        g.fillEllipse(x - 5.f, y - 5.f, 10.f, 10.f);
        g.setColour(pal::autoc);
        g.drawEllipse(x - 5.f, y - 5.f, 10.f, 10.f, 1.2f);
    }

    bool any = false;
    for (int b = 0; b < kNumBands; ++b) any = any || bandOn(b);
    if (!any) {
        g.setColour(pal::muted);
        g.setFont(juce::Font(juce::FontOptions(12.f)));
        g.drawText("Double-click the graph to add an EQ band", p.withHeight(40.f).toNearestInt(), juce::Justification::centred, false);
    }

    // 밴드 노드(고른 것을 맨 위에)
    std::vector<int> order;
    for (int b = 0; b < kNumBands; ++b) if (bandOn(b) && b != selected) order.push_back(b);
    if (selected >= 0 && selected < kNumBands && bandOn(selected)) order.push_back(selected);
    for (int b : order) {
        const auto type = typeFromIndex(int(get(b, "type")));
        const float x = xOf(get(b, "freq")), y = yOf(aeq::hasGain(type) ? get(b, "gain") : 0.f);
        if (get(b, "dyn") > 0.5f) {  // 다이나믹: 범위 손잡이(마름모)
            const float ry = yOf(std::clamp<double>(get(b, "gain") + get(b, "range"), -kRangeDb, kRangeDb));
            g.setColour(pal::dyn);
            g.drawLine(x, y, x, ry, 1.f);
            juce::Path d;
            d.addQuadrilateral(x, ry - 6.5f, x + 6.5f, ry, x, ry + 6.5f, x - 6.5f, ry);
            g.setColour(b == selected ? pal::dyn : pal::graphBg);
            g.fillPath(d);
            g.setColour(pal::dyn);
            g.strokePath(d, juce::PathStrokeType(1.5f));
        }
        g.setColour(pal::graphBg);
        g.fillEllipse(x - 10.f, y - 10.f, 20.f, 20.f);
        g.setColour(pal::accent);
        g.fillEllipse(x - 8.5f, y - 8.5f, 17.f, 17.f);
        if (b == selected) {
            g.setColour(pal::text.withAlpha(0.9f));
            g.drawEllipse(x - 12.5f, y - 12.5f, 25.f, 25.f, 1.25f);
        }
        g.setColour(pal::graphBg);
        g.setFont(juce::Font(juce::FontOptions(10.5f, juce::Font::bold)));
        g.drawText(juce::String(b + 1), juce::Rectangle<float>(x - 9.f, y - 9.f, 18.f, 18.f), juce::Justification::centred, false);
    }
}

// ---------------------------------------------------------------- 밴드 알약

void BandTab::paint(juce::Graphics& g) {
    auto& s = proc_.apvts;
    const auto r = getLocalBounds().toFloat().reduced(0.5f);
    g.setColour(selected ? pal::accent : pal::line);
    g.drawRoundedRectangle(r, r.getHeight() / 2, 1.f);
    const float d = r.getHeight() - 6.f;
    g.setColour(pal::accent);
    g.fillEllipse(r.getX() + 3.f, r.getY() + 3.f, d, d);
    g.setColour(pal::bg);
    g.setFont(juce::Font(juce::FontOptions(10.f, juce::Font::bold)));
    g.drawText(juce::String(band_ + 1), juce::Rectangle<float>(r.getX() + 3.f, r.getY() + 3.f, d, d), juce::Justification::centred, false);

    const auto type = typeFromIndex(int(s.getRawParameterValue(bandId(band_, "type"))->load()));
    g.setColour(pal::text);
    g.setFont(juce::Font(juce::FontOptions(11.f)));
    g.drawText(fmtFreq(s.getRawParameterValue(bandId(band_, "freq"))->load()), r.withTrimmedLeft(d + 8.f).withTrimmedRight(40.f), juce::Justification::centredLeft, false);
    if (aeq::hasGain(type)) {
        g.setColour(pal::muted);
        g.drawText(fmtDb(s.getRawParameterValue(bandId(band_, "gain"))->load()), r.withTrimmedRight(8.f), juce::Justification::centredRight, false);
    }
}

// ---------------------------------------------------------------- 에디터

AutoEQEditor::AutoEQEditor(AutoEQProcessor& p)
    : AudioProcessorEditor(&p), proc_(p), graph_(p),
      freq_("Freq", fmtFreq), gain_("Gain", fmtDb), q_("Q", fmtQ),
      thr_("Thresh", fmtDb, pal::dyn), range_("Range", fmtDb, pal::dyn), att_("Attack", fmtMs, pal::dyn), rel_("Release", fmtMs, pal::dyn),
      amount_("Amount", fmtPct), max_("Max dB", fmtDb), bands_("Bands", fmtInt),
      match_("Inst. match", fmtPct), liveSec_("Live window", fmtSec), smooth_("Smooth oct", fmtOct), output_("Output", fmtDb) {
    setLookAndFeel(&look_);
    setSize(900, wantedHeight());

    addAndMakeVisible(graph_);
    graph_.onSelect = [this] { selectBand(graph_.selected); };

    bypass_.setComponentID("switch");
    addAndMakeVisible(bypass_);
    bypassA_ = std::make_unique<ButtonAtt>(p.apvts, "bypass", bypass_);

    for (int b = 0; b < kNumBands; ++b) {
        auto t = std::make_unique<BandTab>(p, b);
        t->onClick = [this](int band) { selectBand(band); };
        addChildComponent(*t);
        tabs_.push_back(std::move(t));
    }
    addAndMakeVisible(add_);
    addAndMakeVisible(clear_);
    add_.onClick = [this] {
        double hz = 1000;
        for (double cand : {1000.0, 200.0, 5000.0, 80.0, 10000.0, 500.0, 2500.0, 16000.0}) {
            bool free = true;
            for (int b = 0; b < kNumBands; ++b)
                if (graph_.bandOn(b) && std::abs(std::log2(cand / double(getParam(proc_, bandId(b, "freq"))))) < 0.5) free = false;
            if (free) { hz = cand; break; }
        }
        if (graph_.addBand(hz, 0.0) >= 0) selectBand(graph_.selected);
    };
    clear_.onClick = [this] { for (int b = 0; b < kNumBands; ++b) if (graph_.bandOn(b)) graph_.removeBand(b); };

    type_.addItemList({"Bell", "Low Shelf", "High Shelf", "High Pass", "Low Pass", "Notch"}, 1);
    mode_.addItemList({"Over", "Under"}, 1);
    dyn_.setComponentID("pill");
    del_.onClick = [this] { graph_.removeBand(graph_.selected); };
    for (juce::Component* c : std::initializer_list<juce::Component*>{&type_, &mode_, &dyn_, &del_, &freq_, &gain_, &q_, &thr_, &range_, &att_, &rel_})
        addChildComponent(*c);

    learn_.setComponentID("learn");
    addAndMakeVisible(learn_);
    learnA_ = std::make_unique<ButtonAtt>(p.apvts, "learn", learn_);
    info_.setFont(juce::Font(juce::FontOptions(11.f)));
    addAndMakeVisible(info_);
    amount_.bind(p.apvts, "auto_amount");
    max_.bind(p.apvts, "auto_max");
    bands_.bind(p.apvts, "auto_bands");
    for (auto* k : {&amount_, &max_, &bands_}) addAndMakeVisible(*k);
    addAndMakeVisible(options_);
    options_.onClick = [this] { setDrawer(!drawer_); };

    autoMode_.addItemList({"Learn (then lock)", "Live (keeps following)"}, 1);
    instrument_.addItem("Off (whole mix)", 1);
    instrument_.addItem("Auto", 2);
    {
        int id = 3;
        for (const auto& inst : aeq::instruments()) instrument_.addItem(inst.name, id++);
    }
    {
        int id = 1;
        for (const auto& st : aeq::styles()) style_.addItem(st.name, id++);
    }
    autoModeA_ = std::make_unique<ComboAtt>(p.apvts, "auto_mode", autoMode_);
    instrumentA_ = std::make_unique<ComboAtt>(p.apvts, "instrument", instrument_);
    styleA_ = std::make_unique<ComboAtt>(p.apvts, "style", style_);
    match_.bind(p.apvts, "inst_match");
    liveSec_.bind(p.apvts, "live_seconds");
    smooth_.bind(p.apvts, "auto_smooth");
    output_.bind(p.apvts, "output");
    for (auto* c : {&autoMode_, &instrument_, &style_}) addChildComponent(*c);
    for (auto* k : {&match_, &liveSec_, &smooth_, &output_}) addChildComponent(*k);
    modeL_.setText("Mode", juce::dontSendNotification);
    instL_.setText("Instrument", juce::dontSendNotification);
    styleL_.setText("Style", juce::dontSendNotification);
    for (auto* l : {&modeL_, &instL_, &styleL_}) { l->setFont(juce::Font(juce::FontOptions(10.5f))); addChildComponent(*l); }

    selectBand(0);
    startTimerHz(30);
}

AutoEQEditor::~AutoEQEditor() { setLookAndFeel(nullptr); }

int AutoEQEditor::wantedHeight() const { return kTitle + kGraph + kStrip + kBar + kGap + kAuto + (drawer_ ? kDrawer : 0) + kGap + kFoot; }

void AutoEQEditor::setDrawer(bool open) {
    drawer_ = open;
    options_.setButtonText(open ? "Options  -" : "Options  +");
    for (juce::Component* c : std::initializer_list<juce::Component*>{&autoMode_, &instrument_, &style_, &match_, &liveSec_, &smooth_, &output_, &modeL_, &instL_, &styleL_})
        c->setVisible(open);
    setSize(getWidth(), wantedHeight());
}

void AutoEQEditor::selectBand(int band) {
    band = std::clamp(band, 0, kNumBands - 1);
    graph_.selected = band;
    for (int b = 0; b < kNumBands; ++b) tabs_[size_t(b)]->selected = (b == band);
    auto& s = proc_.apvts;
    typeA_.reset(); modeA_.reset(); dynA_.reset();
    typeA_ = std::make_unique<ComboAtt>(s, bandId(band, "type"), type_);
    modeA_ = std::make_unique<ComboAtt>(s, bandId(band, "mode"), mode_);
    dynA_ = std::make_unique<ButtonAtt>(s, bandId(band, "dyn"), dyn_);
    freq_.bind(s, bandId(band, "freq"));
    gain_.bind(s, bandId(band, "gain"));
    q_.bind(s, bandId(band, "q"));
    thr_.bind(s, bandId(band, "thr"));
    range_.bind(s, bandId(band, "range"));
    att_.bind(s, bandId(band, "att"));
    rel_.bind(s, bandId(band, "rel"));
    barHasBand_ = !graph_.bandOn(band);  // 보이기 상태를 반드시 다시 계산하게 한다
    refreshBar();
    repaint();
}

void AutoEQEditor::refreshBar() {
    const int b = graph_.selected;
    const bool has = graph_.bandOn(b);
    const bool dyn = has && getParam(proc_, bandId(b, "dyn")) > 0.5f;
    const bool gainType = has && aeq::hasGain(typeFromIndex(int(getParam(proc_, bandId(b, "type")))));
    if (has != barHasBand_ || dyn != barDyn_) {
        barHasBand_ = has;
        barDyn_ = dyn;
        for (juce::Component* c : std::initializer_list<juce::Component*>{&type_, &dyn_, &del_, &freq_, &gain_, &q_}) c->setVisible(has);
        for (juce::Component* c : std::initializer_list<juce::Component*>{&mode_, &thr_, &range_, &att_, &rel_}) c->setVisible(dyn);
        repaint();
    }
    gain_.slider.setEnabled(gainType);
    gain_.setAlpha(gainType ? 1.f : 0.35f);
    dyn_.setEnabled(gainType);
}

void AutoEQEditor::layoutStrip() {
    if (tabs_.size() < size_t(kNumBands)) return;  // 생성 중 setSize가 먼저 resized를 부른다
    int x = 14;
    int count = 0;
    for (int b = 0; b < kNumBands; ++b) {
        const bool on = graph_.bandOn(b);
        auto& t = *tabs_[size_t(b)];
        t.setVisible(on);
        if (on) { t.setBounds(x, kTitle + kGraph + 10, 108, 24); x += 112; ++count; }
    }
    add_.setVisible(count < kNumBands);
    add_.setBounds(x, kTitle + kGraph + 10, 26, 24);
    clear_.setVisible(count > 0);
}

void AutoEQEditor::timerCallback() {
    graph_.updateSpectrum();
    graph_.repaint();

    int mask = 0;
    for (int b = 0; b < kNumBands; ++b) if (graph_.bandOn(b)) mask |= 1 << b;
    if (mask != tabMask_) {
        tabMask_ = mask;
        if (!graph_.bandOn(graph_.selected) && mask != 0) {
            for (int b = 0; b < kNumBands; ++b) if (mask & (1 << b)) { selectBand(b); break; }
        }
        layoutStrip();
    }
    for (auto& t : tabs_) if (t->isVisible()) t->repaint();
    refreshBar();

    if (proc_.analyzer.isLearning()) {
        const int inst = proc_.analyzer.activeInstrument();
        const juce::String name = inst >= 0 ? juce::String(aeq::instruments()[size_t(inst)].name) : juce::String("whole mix");
        info_.setText(juce::String(autoMode_.getSelectedId() == 2 ? "Live" : "Learning") + "  " + juce::String(int(proc_.analyzer.confidence() * 100)) + "%  |  " + name, juce::dontSendNotification);
    } else {
        info_.setText(learn_.getToggleState() ? "Starting..." : "Press LEARN, play a section, press again to lock", juce::dontSendNotification);
    }
}

void AutoEQEditor::paint(juce::Graphics& g) {
    g.fillAll(pal::plugin);
    g.setColour(pal::line);
    g.drawHorizontalLine(kTitle - 1, 0.f, float(getWidth()));

    g.setColour(pal::text);
    g.setFont(juce::Font(juce::FontOptions(12.f, juce::Font::bold)));
    g.drawText("AUTO", 14, 0, 44, kTitle, juce::Justification::centredLeft, false);
    g.setColour(pal::accent);
    g.drawText("EQ", 14 + 38, 0, 30, kTitle, juce::Justification::centredLeft, false);

    auto card = [&](juce::Rectangle<float> r) {
        g.setColour(pal::raised);
        g.fillRoundedRectangle(r, 8.f);
        g.setColour(pal::line);
        g.drawRoundedRectangle(r.reduced(0.5f), 8.f, 1.f);
    };
    const float cw = float(getWidth()) - 28.f;

    // 선택한 밴드 카드
    const auto bar = juce::Rectangle<float>(14.f, float(barTop()), cw, float(kBar));
    card(bar);
    if (!barHasBand_) {
        g.setColour(pal::muted);
        g.setFont(juce::Font(juce::FontOptions(12.f)));
        g.drawText("No band selected. Press + or double-click the graph.", bar.toNearestInt(), juce::Justification::centred, false);
    } else {
        const float cx = bar.getX() + 30.f, cy = bar.getY() + 24.f;
        g.setColour(pal::accent);
        g.fillEllipse(cx - 11.f, cy - 11.f, 22.f, 22.f);
        g.setColour(pal::bg);
        g.setFont(juce::Font(juce::FontOptions(11.f, juce::Font::bold)));
        g.drawText(juce::String(graph_.selected + 1), juce::Rectangle<float>(cx - 11.f, cy - 11.f, 22.f, 22.f), juce::Justification::centred, false);
        g.setColour(pal::line);
        g.drawVerticalLine(int(bar.getX()) + kKnobX - 14, bar.getY() + 14.f, bar.getBottom() - 14.f);
        if (barDyn_) {
            const auto box = juce::Rectangle<float>(bar.getX() + float(kDynX), bar.getY() + 12.f, float(kDynW), bar.getHeight() - 22.f);
            g.setColour(pal::dyn.withAlpha(0.4f));
            g.drawRoundedRectangle(box, 8.f, 1.f);
            g.setColour(pal::raised);
            g.fillRect(box.getX() + 10.f, box.getY() - 5.f, 66.f, 10.f);
            g.setColour(pal::dyn);
            g.setFont(juce::Font(juce::FontOptions(9.f, juce::Font::bold)));
            g.drawText("DYNAMICS", int(box.getX()) + 10, int(box.getY()) - 6, 66, 12, juce::Justification::centred, false);
        }
    }

    // 자동 학습 카드(옵션을 열면 아래로 늘어난다)
    const auto autoCard = juce::Rectangle<float>(14.f, float(autoTop()), cw, float(kAuto + (drawer_ ? kDrawer : 0)));
    card(autoCard);
    if (drawer_) {
        g.setColour(pal::line);
        g.drawHorizontalLine(autoTop() + kAuto, autoCard.getX() + 14.f, autoCard.getRight() - 14.f);
    }

    g.setColour(pal::line);
    g.drawHorizontalLine(getHeight() - kFoot, 0.f, float(getWidth()));
    g.setColour(pal::muted);
    g.setFont(juce::Font(juce::FontOptions(10.5f)));
    g.drawText("Double-click: add / remove   |   Drag: move   |   Wheel: Q   |   Right-click or Delete: remove   |   Knobs: drag, double-click resets",
               14, getHeight() - kFoot, getWidth() - 28, kFoot, juce::Justification::centredLeft, false);
}

void AutoEQEditor::resized() {
    const int W = getWidth();
    bypass_.setBounds(W - 14 - 84, 9, 84, 16);
    graph_.setBounds(0, kTitle, W, kGraph);
    clear_.setBounds(W - 14 - 74, kTitle + kGraph + 10, 74, 24);
    layoutStrip();

    // 밴드 카드
    const int bx = 14, by = barTop();
    type_.setBounds(bx + 54, by + 11, 128, 26);
    dyn_.setBounds(bx + 14, by + 52, 56, 24);
    del_.setBounds(bx + 76, by + 52, 62, 24);
    int kx = bx + kKnobX;
    for (auto* k : {&freq_, &gain_, &q_}) { k->setBounds(kx, by + 6, 74, 80); kx += 78; }
    int dx = bx + kDynX + 14;
    for (auto* k : {&thr_, &range_, &att_, &rel_}) { k->setBounds(dx, by + 14, 58, 70); dx += 60; }
    mode_.setBounds(dx + 6, by + 30, 84, 26);

    // 자동 학습 카드
    const int ay = autoTop();
    learn_.setBounds(14 + 14, ay + 24, 104, 30);
    info_.setBounds(14 + 130, ay + 24, 270, 30);
    int ax = 14 + 420;
    for (auto* k : {&amount_, &max_, &bands_}) { k->setBounds(ax, ay + 4, 70, 70); ax += 74; }
    options_.setBounds(W - 14 - 14 - 96, ay + 26, 96, 26);

    if (drawer_) {
        const int dy = ay + kAuto;
        modeL_.setBounds(14 + 14, dy + 8, 100, 16);
        autoMode_.setBounds(14 + 14, dy + 26, 190, 26);
        instL_.setBounds(14 + 14, dy + 56, 100, 16);
        instrument_.setBounds(14 + 14, dy + 72 - 4, 190, 26);
        styleL_.setBounds(14 + 214, dy + 56, 100, 16);
        style_.setBounds(14 + 214, dy + 72 - 4, 150, 26);
        int ox = 14 + 420;
        for (auto* k : {&match_, &liveSec_, &smooth_, &output_}) { k->setBounds(ox, dy + 10, 70, 80); ox += 74; }
    }
}

}  // namespace autoeq
