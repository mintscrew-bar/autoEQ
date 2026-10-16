#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace autoeq {

namespace {
/** 대역통과(웹 오디오 bandpass와 같은 0dB 피크 RBJ) — 다이나믹의 대역 레벨 검출용 */
aeq::Coeffs bandpassCoeffs(double freq, double q, double sr) {
    const double w0 = 2.0 * juce::MathConstants<double>::pi * freq / sr;
    const double alpha = std::sin(w0) / (2.0 * q);
    const double a0 = 1.0 + alpha;
    return {alpha / a0, 0.0, -alpha / a0, -2.0 * std::cos(w0) / a0, (1.0 - alpha) / a0};
}

inline double runBiquad(const aeq::Coeffs& c, double x, double& z1, double& z2) {
    const double y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    return y;
}
}  // namespace

AutoEQProcessor::AutoEQProcessor()
    : AudioProcessor(BusesProperties().withInput("Input", juce::AudioChannelSet::stereo(), true).withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      apvts(*this, nullptr, "STATE", createLayout()) {
    bypass_ = apvts.getRawParameterValue("bypass");
    learn_ = apvts.getRawParameterValue("learn");
    output_p_ = apvts.getRawParameterValue("output");
    autoAmount_ = apvts.getRawParameterValue("auto_amount");
    autoMax_ = apvts.getRawParameterValue("auto_max");
    autoSmooth_ = apvts.getRawParameterValue("auto_smooth");
    autoBands_ = apvts.getRawParameterValue("auto_bands");
    for (int b = 0; b < kNumBands; ++b) {
        auto get = [&](const char* n) { return apvts.getRawParameterValue(bandId(b, n)); };
        bandParams_[size_t(b)] = {get("on"), get("type"), get("freq"), get("gain"), get("q"), get("dyn"), get("thr"), get("range"), get("att"), get("rel"), get("mode")};
    }
}

bool AutoEQProcessor::isBusesLayoutSupported(const BusesLayout& l) const {
    const auto& out = l.getMainOutputChannelSet();
    return (out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono()) && out == l.getMainInputChannelSet();
}

void AutoEQProcessor::prepareToPlay(double sampleRate, int samplesPerBlock) {
    sampleRate_ = sampleRate;
    analyzer.prepare(sampleRate);
    mono_.assign(size_t(std::max(samplesPerBlock, 1)), 0.f);
    for (auto& s : slots_) s = {};
    for (auto& d : detectors_) d = {};
    for (int b = 0; b < kNumBands; ++b) {
        auto& sm = smoothed_[size_t(b)];
        sm.freq.reset(sampleRate, 0.03);
        sm.q.reset(sampleRate, 0.03);
        sm.gain.reset(sampleRate, 0.03);
        sm.freq.setCurrentAndTargetValue(double(bandParams_[size_t(b)].freq->load()));
        sm.q.setCurrentAndTargetValue(double(bandParams_[size_t(b)].q->load()));
        sm.gain.setCurrentAndTargetValue(0.0);
    }
    for (auto& a : autoState_) a = {};
    trim_.reset(sampleRate, 0.15);
    trim_.setCurrentAndTargetValue(1.0);
    output_.reset(sampleRate, 0.05);
    output_.setCurrentAndTargetValue(juce::Decibels::decibelsToGain(double(output_p_->load())));
    chain_.clear();
    chain_.reserve(slots_.size());
    headroomDb_ = 0;
    headroomCounter_ = 0;
}

void AutoEQProcessor::updateAutoSlots(double dt, double amount) {
    const double a = 1.0 - std::exp(-dt / 0.25);
    for (size_t i = 0; i < autoState_.size(); ++i) {
        auto& s = autoState_[i];
        const auto& t = lastTargets_[i];
        if (t.active) {
            if (!s.active) {  // 새 밴드는 그 자리에서 게인 0으로 시작해 서서히 커진다
                s.active = true;
                s.freq = t.freq;
                s.q = t.q;
                s.gain = 0.0;
            }
            s.freq += a * (t.freq - s.freq);
            s.q += a * (t.q - s.q);
            s.gain += a * (t.gain * amount - s.gain);
        } else if (s.active) {
            s.gain += a * (0.0 - s.gain);
            if (std::abs(s.gain) < 0.05) s = {};
        }
    }
}

double AutoEQProcessor::computeHeadroom(const std::vector<aeq::FilterSpec>& specs) const {
    if (specs.empty()) return 0.0;
    double peak = 0.0;
    for (int i = 0; i < 48; ++i) {
        const double f = 20.0 * std::pow(1000.0, i / 47.0);
        peak = std::max(peak, aeq::responseDb(specs, f, sampleRate_));
    }
    return peak;
}

void AutoEQProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) {
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    const int numChannels = std::min(2, buffer.getNumChannels());
    if (numChannels == 0 || numSamples == 0) return;

    // 분석은 EQ 이전 신호에서 한다(처리 후 신호를 분석하면 보정 결과를 다시 보정하는 되먹임이 생긴다).
    const bool learning = learn_->load() > 0.5f;
    if (learning != wasLearning_) {
        wasLearning_ = learning;
        if (learning) analyzer.startLearning(); else analyzer.stopLearning();
    }
    analyzer.setOptions(double(autoMax_->load()), double(autoSmooth_->load()), int(autoBands_->load()));
    if (learning) {
        if (mono_.size() < size_t(numSamples)) mono_.resize(size_t(numSamples));
        const float* l = buffer.getReadPointer(0);
        const float* r = buffer.getReadPointer(numChannels > 1 ? 1 : 0);
        for (int i = 0; i < numSamples; ++i) mono_[size_t(i)] = 0.5f * (l[i] + r[i]);
        analyzer.push(mono_.data(), numSamples);
    }

    if (bypass_->load() > 0.5f) return;

    analyzer.tryCopyTargets(lastTargets_);
    const double autoAmount = double(autoAmount_->load());
    output_.setTargetValue(juce::Decibels::decibelsToGain(double(output_p_->load())));

    // 밴드 파라미터 스냅샷
    struct Band {
        bool on; aeq::FilterType type; double freq, gain, q; bool dyn; double thr, range, att, rel; aeq::DynMode mode;
    };
    std::array<Band, kNumBands> bands{};
    for (int b = 0; b < kNumBands; ++b) {
        const auto& p = bandParams_[size_t(b)];
        bands[size_t(b)] = {p.on->load() > 0.5f, typeFromIndex(int(p.type->load())), double(p.freq->load()), double(p.gain->load()),
                            double(p.q->load()), p.dyn->load() > 0.5f, double(p.thr->load()), double(p.range->load()),
                            double(p.att->load()), double(p.rel->load()),
                            int(p.mode->load()) == 1 ? aeq::DynMode::Below : aeq::DynMode::Above};
    }

    float* ch[2] = {buffer.getWritePointer(0), buffer.getWritePointer(numChannels > 1 ? 1 : 0)};
    const double rmsK = 1.0 - std::exp(-1.0 / (0.02 * sampleRate_));  // 대역 레벨의 평균 창 약 20ms

    for (int pos = 0; pos < numSamples; pos += kSub) {
        const int len = std::min(kSub, numSamples - pos);
        const double dt = double(len) / sampleRate_;
        updateAutoSlots(dt, autoAmount);

        auto& chain = chain_;
        chain.clear();

        for (int b = 0; b < kNumBands; ++b) {
            auto& bd = bands[size_t(b)];
            auto& sm = smoothed_[size_t(b)];
            auto& slot = slots_[size_t(b)];
            const bool gainType = aeq::hasGain(bd.type);

            sm.freq.setTargetValue(bd.freq);
            sm.q.setTargetValue(bd.q);
            sm.gain.setTargetValue(bd.on && gainType ? bd.gain : 0.0);
            sm.freq.skip(len);
            const double q = sm.q.skip(len);
            const double baseGain = sm.gain.skip(len);

            // 다이나믹: 대역 레벨 → 작동 정도(어택·릴리즈) → 실제 게인
            double gain = baseGain;
            if (bd.on && bd.dyn && gainType) {
                auto& det = detectors_[size_t(b)];
                det.c = bd.type == aeq::FilterType::Bell ? bandpassCoeffs(bd.freq, bd.q, sampleRate_)
                       : aeq::biquadCoeffs({bd.type == aeq::FilterType::LowShelf ? aeq::FilterType::LowPass : aeq::FilterType::HighPass, bd.freq, 0.0, std::sqrt(0.5)}, sampleRate_);
                for (int i = 0; i < len; ++i) {
                    const double x = 0.5 * (double(ch[0][pos + i]) + double(ch[1][pos + i]));
                    const double y = runBiquad(det.c, x, det.z1, det.z2);
                    det.meanSquare += rmsK * (y * y - det.meanSquare);
                }
                const double level = aeq::powerToDb(det.meanSquare);
                det.amount = aeq::smoothAmount(det.amount, aeq::dynamicTarget(level, bd.thr, bd.mode), dt, bd.att, bd.rel);
                gain = baseGain + bd.range * det.amount;
            }

            const double smoothedFreq = sm.freq.getCurrentValue();
            const bool audible = bd.on || (gainType && std::abs(baseGain) > 0.01);
            slot.active = audible;
            if (audible) {
                const aeq::FilterSpec spec{bd.type, smoothedFreq, gainType ? gain : 0.0, q};
                slot.c = aeq::biquadCoeffs(spec, sampleRate_);
                chain.push_back(spec);
            } else {
                slot.z1[0] = slot.z1[1] = slot.z2[0] = slot.z2[1] = 0;
            }
        }
        for (int i = 0; i < kNumAuto; ++i) {
            auto& slot = slots_[size_t(kNumBands + i)];
            const auto& s = autoState_[size_t(i)];
            slot.active = s.active;
            if (s.active) {
                const aeq::FilterSpec spec{aeq::FilterType::Bell, s.freq, s.gain, s.q};
                slot.c = aeq::biquadCoeffs(spec, sampleRate_);
                chain.push_back(spec);
            } else {
                slot.z1[0] = slot.z1[1] = slot.z2[0] = slot.z2[1] = 0;
            }
        }

        // 부스트로 클리핑되지 않도록 응답의 최대치만큼 출력을 줄인다(가끔만 계산).
        if (headroomCounter_ <= 0) {
            headroomDb_ = std::max(0.0, computeHeadroom(chain));
            headroomCounter_ = int(sampleRate_ / 20.0);
        }
        headroomCounter_ -= len;
        trim_.setTargetValue(juce::Decibels::decibelsToGain(-headroomDb_));

        for (auto& slot : slots_) {
            if (!slot.active) continue;
            for (int c = 0; c < numChannels; ++c) {
                float* d = ch[c] + pos;
                double z1 = slot.z1[c], z2 = slot.z2[c];
                for (int i = 0; i < len; ++i) d[i] = float(runBiquad(slot.c, double(d[i]), z1, z2));
                slot.z1[c] = z1;
                slot.z2[c] = z2;
            }
        }
        for (int i = 0; i < len; ++i) {
            const float g = float(trim_.getNextValue() * output_.getNextValue());
            for (int c = 0; c < numChannels; ++c) ch[c][pos + i] *= g;
        }
    }
}

juce::AudioProcessorEditor* AutoEQProcessor::createEditor() { return new AutoEQEditor(*this); }

void AutoEQProcessor::getStateInformation(juce::MemoryBlock& dest) {
    auto state = apvts.copyState();
    // LEARN을 끈 채 고정된 자동 밴드도 함께 저장한다.
    juce::String autos;
    for (const auto& t : analyzer.targets())
        if (t.active && t.gain != 0.f) autos << t.freq << "," << t.gain << "," << t.q << ";";
    state.setProperty("autoBands", autos, nullptr);
    if (auto xml = state.createXml()) copyXmlToBinary(*xml, dest);
}

void AutoEQProcessor::setStateInformation(const void* data, int size) {
    if (auto xml = getXmlFromBinary(data, size)) {
        if (xml->hasTagName(apvts.state.getType())) {
            auto tree = juce::ValueTree::fromXml(*xml);
            apvts.replaceState(tree);
            AutoTargets t{};
            size_t i = 0;
            for (const auto& item : juce::StringArray::fromTokens(tree.getProperty("autoBands").toString(), ";", "")) {
                const auto parts = juce::StringArray::fromTokens(item, ",", "");
                if (parts.size() == 3 && i < t.size()) t[i++] = {true, parts[0].getFloatValue(), parts[1].getFloatValue(), parts[2].getFloatValue()};
            }
            analyzer.setLocked(t);
        }
    }
}

}  // namespace autoeq

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new autoeq::AutoEQProcessor(); }
