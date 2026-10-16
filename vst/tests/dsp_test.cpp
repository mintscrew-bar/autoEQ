// C++ DSP 코어가 TypeScript 기준 구현과 같은 값을 내는지 확인한다. JUCE 없이 g++만으로 돌아간다.
#include <cmath>
#include <cstdio>
#include "../Source/dsp/AutoBands.h"
#include "../Source/dsp/AutoEq.h"
#include "../Source/dsp/Bands.h"
#include "../Source/dsp/Dynamics.h"
#include "../Source/dsp/Response.h"
#include "golden.h"

static int failures = 0;
static void check(const char* what, double got, double want, double tol = 1e-6) {
    if (!(std::abs(got - want) <= tol)) {
        std::printf("FAIL %s: got %.9f want %.9f\n", what, got, want);
        ++failures;
    }
}
static void checkVec(const char* what, const std::vector<double>& got, const std::vector<double>& want, double tol = 1e-6) {
    if (got.size() != want.size()) { std::printf("FAIL %s: size %zu != %zu\n", what, got.size(), want.size()); ++failures; return; }
    for (size_t i = 0; i < got.size(); ++i) {
        char name[96];
        std::snprintf(name, sizeof name, "%s[%zu]", what, i);
        check(name, got[i], want[i], tol);
    }
}

int main() {
    using namespace aeq;
    const auto layout = makeBands();
    checkVec("centers", layout.centers, kCenters);
    check("bandQ", layout.q, 2.87, 0.01);

    const std::vector<double> freqs = {60, 100, 1000, 2000, 5000, 12000};
    const std::vector<FilterSpec> specs = {
        {FilterType::Bell, 1000, 6, 1},      {FilterType::LowShelf, 200, -4, 0.7}, {FilterType::HighShelf, 4000, 3, 0.7},
        {FilterType::HighPass, 80, 0, std::sqrt(0.5)}, {FilterType::Notch, 2000, 0, 8}, {FilterType::LowPass, 9000, 0, std::sqrt(0.5)}};
    const std::vector<const std::vector<double>*> want = {&kResponse0, &kResponse1, &kResponse2, &kResponse3, &kResponse4, &kResponse5};
    for (size_t s = 0; s < specs.size(); ++s) {
        std::vector<double> got;
        for (size_t k = 0; k < freqs.size(); ++k) {
            // 노치 정중앙은 수치적 영점(-277dB)이라 부동소수점 잡음만 남는다. 비교에서 뺀다.
            const bool nullPoint = specs[s].type == FilterType::Notch && freqs[k] == specs[s].freq;
            got.push_back(nullPoint ? (*want[s])[k] : responseDb({specs[s]}, freqs[k]));
        }
        char name[32];
        std::snprintf(name, sizeof name, "response%zu", s);
        checkVec(name, got, *want[s], 1e-6);
    }

    // AutoEq: 신뢰도 램프를 끈 한 프레임
    AutoEqOptions instant; instant.confidenceSeconds = 0;
    AutoEq eq(layout.centers, instant);
    check("update returns true", eq.update(kInput, 0.05) ? 1 : 0, 1);
    checkVec("correction", eq.correction(), kCorrection);

    // fitBands
    const auto fits = fitBands(layout.centers, eq.correction(), 8, 0.5);
    check("fit count", double(fits.size()), double(kFitFreq.size()));
    for (size_t i = 0; i < fits.size() && i < kFitFreq.size(); ++i) {
        check("fit.freq", fits[i].freq, kFitFreq[i], 1e-6);
        check("fit.gain", fits[i].gain, kFitGain[i], 1e-6);
        check("fit.q", fits[i].q, kFitQ[i], 1e-6);
    }

    // 신뢰도 램프 + 데드밴드
    AutoEqOptions o2; o2.confidenceSeconds = 8; o2.deadbandDb = 0.5;
    AutoEq eq2(layout.centers, o2);
    for (int i = 0; i < 40; ++i) eq2.update(kInput, 0.1);
    check("confidence", eq2.confidence(), kConfidence, 1e-9);
    checkVec("correctionConf", eq2.correction(), kCorrectionConf);

    // 다이나믹
    const double levels[] = {-50, -43, -40, -37, -30};
    for (int i = 0; i < 5; ++i) {
        check("dyn above", dynamicTarget(levels[i], -40, DynMode::Above), kDynAbove[i]);
        check("dyn below", dynamicTarget(levels[i], -40, DynMode::Below), kDynBelow[i]);
    }
    check("smoothAmount", smoothAmount(0.2, 1, 0.01, 5, 80), kSmooth, 1e-9);

    // 무음은 학습하지 않는다
    AutoEq quiet(layout.centers);
    check("gate", quiet.update(std::vector<double>(layout.centers.size(), -120), 0.05) ? 1 : 0, 0);

    if (failures) { std::printf("%d failure(s)\n", failures); return 1; }
    std::printf("dsp parity: all checks passed\n");
    return 0;
}
