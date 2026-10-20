#include "AutoAnalyzer.h"

namespace autoeq {

namespace {
constexpr double kSpawnDelay = 0.6;   // 새 밴드는 이만큼(초) 계속 제안돼야 놓는다
constexpr double kGrace = 2.0;        // 짝이 사라진 밴드가 자리를 지키는 시간(초)
constexpr double kFade = 1.5;         // 0으로 줄어든 뒤 슬롯을 비우기까지(초)
constexpr double kMatchOct = 0.75;    // 같은 밴드로 이어지는 최대 거리(옥타브)
constexpr double kRetargetEvery = 0.15;
constexpr double kDetectMinConfidence = 0.5;  // 분석 시간 신뢰도가 이 값을 넘어야 악기를 판별한다
constexpr double kDetectHold = 3.0;           // 같은 후보가 이만큼(초) 이어져야 악기를 바꾼다
constexpr double kDetectDrop = 8.0;           // 확신이 이만큼(초) 없으면 악기 보정을 끈다
double nowSeconds() { return juce::Time::getMillisecondCounterHiRes() / 1000.0; }
}  // namespace

AutoAnalyzer::AutoAnalyzer() : juce::Thread("AutoEQ analysis") {
    for (const auto& p : aeq::instruments()) instrumentTargets_.push_back(aeq::profileTarget(p, layout_.centers));
    std::vector<float> ones(kFftSize, 1.f);
    window_.multiplyWithWindowingTable(ones.data(), size_t(kFftSize));
    double sum = 0;
    for (float w : ones) sum += w;
    windowSum_ = sum;
    startThread(juce::Thread::Priority::low);
}

AutoAnalyzer::~AutoAnalyzer() { stopThread(2000); }

void AutoAnalyzer::prepare(double sampleRate) { sampleRate_ = sampleRate; }

void AutoAnalyzer::push(const float* mono, int numSamples) {
    int start1, size1, start2, size2;
    fifo_.prepareToWrite(numSamples, start1, size1, start2, size2);
    if (size1 > 0) std::copy(mono, mono + size1, fifoBuf_.begin() + start1);
    if (size2 > 0) std::copy(mono + size1, mono + size1 + size2, fifoBuf_.begin() + start2);
    fifo_.finishedWrite(size1 + size2);  // 가득 차면 넘치는 샘플은 버린다
}

void AutoAnalyzer::startLearning() { wantStart_ = true; }
void AutoAnalyzer::stopLearning() { wantStop_ = true; }

void AutoAnalyzer::setSettings(const AnalyzerSettings& st) {
    maxCorrection_ = st.maxCorrectionDb;
    smoothOctaves_ = st.smoothOctaves;
    maxAuto_ = st.maxAutoBands;
    live_ = st.live;
    liveSeconds_ = st.liveSeconds;
    gate_ = st.gateDb;
    instrumentChoice_ = st.instrument;
    instrumentMatch_ = st.instrumentMatch;
}

void AutoAnalyzer::applyInstrument(int index) {
    if (index == appliedInstrument_) return;
    appliedInstrument_ = index;
    eq_.setInstrument(index >= 0 ? instrumentTargets_[size_t(index)] : std::vector<double>{});
    activeInstrument_ = index;
}

/** 악기 선택(끔/자동/고정)에 따라 프로파일을 정한다. 자동이면 평균 스펙트럼 모양으로 판별하고 히스테리시스를 둔다. */
void AutoAnalyzer::updateInstrument(double now) {
    const int choice = instrumentChoice_.load();
    if (choice == 0) { applyInstrument(-1); candidate_ = -1; return; }
    if (choice >= 2) { applyInstrument(std::min(choice - 2, int(instrumentTargets_.size()) - 1)); return; }

    const auto* avg = eq_.averageLevels();
    if (!avg || eq_.confidence() < kDetectMinConfidence) return;
    const auto r = aeq::identifyInstrument(*avg, layout_.centers);
    if (!r.confident) {
        candidate_ = -1;
        if (appliedInstrument_ >= 0 && now - lastConfident_ > kDetectDrop) applyInstrument(-1);
        return;
    }
    const int best = r.ranking[0].index;
    lastConfident_ = now;
    if (best == appliedInstrument_) { candidate_ = -1; return; }
    if (best != candidate_) { candidate_ = best; candidateSince_ = now; return; }
    if (now - candidateSince_ >= kDetectHold) { applyInstrument(best); candidate_ = -1; }
}

bool AutoAnalyzer::tryCopyTargets(AutoTargets& out) const {
    const juce::SpinLock::ScopedTryLockType l(lock_);
    if (!l.isLocked()) return false;
    out = published_;
    return true;
}

AutoTargets AutoAnalyzer::targets() const {
    const juce::SpinLock::ScopedLockType l(lock_);
    return published_;
}

void AutoAnalyzer::setLocked(const AutoTargets& t) {
    {
        const juce::SpinLock::ScopedLockType l(lock_);
        published_ = t;
    }
    // 분석 스레드의 슬롯도 맞춰 두어야 다음 LEARN 때 겹치지 않는다. 시작할 때 모두 비워지므로 여기서는 게시값만 바꾼다.
}

void AutoAnalyzer::publish() {
    AutoTargets t{};
    for (size_t i = 0; i < slots_.size(); ++i) {
        const auto& s = slots_[i];
        if (!s.used) continue;
        t[i] = {true, float(s.fit.freq), s.dying ? 0.f : float(s.fit.gain), float(s.fit.q)};
    }
    const juce::SpinLock::ScopedLockType l(lock_);
    published_ = t;
}

void AutoAnalyzer::run() {
    while (!threadShouldExit()) {
        wait(15);

        if (wantStart_.exchange(false)) {
            auto o0 = eq_.options();
            o0.averageSeconds = liveSeconds_.load();
            eq_.setOptions(o0);
            if (live_.load()) eq_.beginAdaptive(); else eq_.beginLearning();
            appliedInstrument_ = -2;  // 새 학습이므로 악기를 다시 정한다
            candidate_ = -1;
            lastConfident_ = nowSeconds();
            slots_ = {};
            proposed_.clear();
            ringFilled_ = 0;
            fifo_.reset();
            lastRetarget_ = 0;
            learning_ = true;
            publish();  // 이전 자동 밴드는 오디오 스레드에서 서서히 0으로 줄어든다
        }
        if (wantStop_.exchange(false)) {
            learning_ = false;
            eq_.endLearning();
            // 줄어들던 밴드는 버리고 나머지는 지금 목표 위치에 고정한다.
            for (auto& s : slots_)
                if (s.dying || s.fit.gain == 0.0) s = {};
            publish();
        }

        if (!learning_) {
            fifo_.reset();
            continue;
        }

        // 옵션 반영
        auto o = eq_.options();
        const double mc = maxCorrection_.load(), so = smoothOctaves_.load(), gate = gate_.load(), im = instrumentMatch_.load() * (instrumentChoice_.load() == 1 ? 0.5 : 1.0);  // Auto 판별은 틀릴 수 있어 절반만 적용
        if (o.maxCorrectionDb != mc || o.smoothOctaves != so || o.gateDb != gate || o.instrumentMatch != im) {
            o.maxCorrectionDb = mc;
            o.smoothOctaves = so;
            o.gateDb = gate;
            o.instrumentMatch = im;
            eq_.setOptions(o);
        }

        while (fifo_.getNumReady() >= kHop && !threadShouldExit()) {
            std::vector<float> block(kHop);
            int start1, size1, start2, size2;
            fifo_.prepareToRead(kHop, start1, size1, start2, size2);
            std::copy(fifoBuf_.begin() + start1, fifoBuf_.begin() + start1 + size1, block.begin());
            if (size2 > 0) std::copy(fifoBuf_.begin() + start2, fifoBuf_.begin() + start2 + size2, block.begin() + size1);
            fifo_.finishedRead(size1 + size2);

            std::copy(ring_.begin() + kHop, ring_.end(), ring_.begin());
            std::copy(block.begin(), block.end(), ring_.begin() + kHop);
            ringFilled_ = std::min(kFftSize, ringFilled_ + kHop);
            if (ringFilled_ >= kFftSize) analyzeWindow();
        }

        const double now = nowSeconds();
        if (eq_.hasData() && now - lastRetarget_ >= kRetargetEvery) {
            lastRetarget_ = now;
            updateInstrument(now);
            retarget(now);
            confidence_ = float(eq_.confidence());
        }
    }
}

void AutoAnalyzer::analyzeWindow() {
    std::copy(ring_.begin(), ring_.end(), fftData_.begin());
    std::fill(fftData_.begin() + kFftSize, fftData_.end(), 0.f);
    window_.multiplyWithWindowingTable(fftData_.data(), size_t(kFftSize));
    fft_.performFrequencyOnlyForwardTransform(fftData_.data());
    std::vector<float> binDb(kFftSize / 2);
    for (int k = 0; k < kFftSize / 2; ++k)
        binDb[size_t(k)] = 20.f * std::log10(std::max(fftData_[size_t(k)] / float(windowSum_), 1e-12f));
    const auto bands = aeq::aggregateBins(binDb.data(), kFftSize / 2, sampleRate_.load(), kFftSize, layout_);
    eq_.update(bands, double(kHop) / sampleRate_.load());
}

void AutoAnalyzer::retarget(double now) {
    const int room = std::clamp(maxAuto_.load(), 1, kNumAuto);
    const auto wanted = aeq::fitBands(layout_.centers, eq_.correction(), room, 0.5);

    struct Pair { size_t slot; size_t fit; double d; };
    std::vector<Pair> pairs;
    for (size_t s = 0; s < slots_.size(); ++s) {
        if (!slots_[s].used) continue;
        for (size_t f = 0; f < wanted.size(); ++f)
            pairs.push_back({s, f, std::abs(std::log2(wanted[f].freq / slots_[s].fit.freq))});
    }
    std::sort(pairs.begin(), pairs.end(), [](const Pair& a, const Pair& b) { return a.d < b.d; });
    std::array<bool, kNumAuto> slotMatched{};
    std::vector<bool> fitUsed(wanted.size(), false);
    for (const auto& p : pairs) {
        if (p.d > kMatchOct || slotMatched[p.slot] || fitUsed[p.fit]) continue;
        slotMatched[p.slot] = fitUsed[p.fit] = true;
        auto& s = slots_[p.slot];
        s.fit = wanted[p.fit];
        s.lastMatched = now;
        s.dying = false;
    }

    // 짝이 없는 제안은 한동안 계속 나올 때만 새 밴드로 놓는다(깜박임 방지).
    std::map<int, double> keys;
    for (size_t f = 0; f < wanted.size(); ++f) {
        if (fitUsed[f]) continue;
        const int key = int(std::lround(std::log2(wanted[f].freq) * 3));
        const double since = proposed_.count(key) ? proposed_[key] : now;
        keys[key] = since;
        if (now - since < kSpawnDelay) continue;
        for (size_t s = 0; s < slots_.size(); ++s) {
            if (slots_[s].used) continue;
            slots_[s] = {true, false, 0, wanted[f], now};
            slotMatched[s] = true;
            keys.erase(key);
            break;
        }
    }
    proposed_ = keys;

    // 짝이 없어진 밴드는 잠시 자리를 지키다가 서서히 사라진다.
    for (size_t s = 0; s < slots_.size(); ++s) {
        auto& sl = slots_[s];
        if (!sl.used || slotMatched[s]) continue;
        if (!sl.dying && now - sl.lastMatched > kGrace) {
            sl.dying = true;
            sl.dieAt = now + kFade;
        }
        if (sl.dying && now > sl.dieAt) sl = {};
    }
    publish();
}

}  // namespace autoeq
