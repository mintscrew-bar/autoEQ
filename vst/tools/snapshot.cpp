// 에디터를 화면 없이 그려 PNG로 저장한다(문서·확인용). 사용: editor_snapshot <출력.png> [옵션열기:0|1]
#include <juce_audio_processors/juce_audio_processors.h>
#include "../Source/PluginEditor.h"

int main(int argc, char** argv) {
    juce::ScopedJuceInitialiser_GUI gui;
    const juce::File out = juce::File::getCurrentWorkingDirectory().getChildFile(argc > 1 ? argv[1] : "editor.png");

    autoeq::AutoEQProcessor proc;
    proc.setPlayConfigDetails(2, 2, 48000.0, 512);
    proc.prepareToPlay(48000.0, 512);

    auto set = [&](const juce::String& id, float v) {
        if (auto* p = proc.apvts.getParameter(id)) p->setValueNotifyingHost(p->convertTo0to1(v));
    };
    struct B { float f, g, q; int type; };
    const B bands[] = {{90.f, 2.5f, 0.8f, 1}, {320.f, -3.f, 1.4f, 0}, {2800.f, 3.5f, 1.2f, 0}, {9500.f, -2.f, 0.9f, 2}};
    for (int i = 0; i < 4; ++i) {
        set(autoeq::bandId(i, "type"), float(bands[i].type));
        set(autoeq::bandId(i, "freq"), bands[i].f);
        set(autoeq::bandId(i, "gain"), bands[i].g);
        set(autoeq::bandId(i, "q"), bands[i].q);
        set(autoeq::bandId(i, "on"), 1.f);
    }
    set(autoeq::bandId(2, "dyn"), 1.f);

    std::unique_ptr<juce::AudioProcessorEditor> ed(proc.createEditor());
    if (argc > 2 && std::string(argv[2]) == "1")
        if (auto* e = dynamic_cast<autoeq::AutoEQEditor*>(ed.get())) e->showOptions(true);

    // 스펙트럼이 보이도록 분홍빛 잡음을 흘려 보낸다
    juce::Random rnd(7);
    juce::AudioBuffer<float> buf(2, 512);
    juce::MidiBuffer midi;
    float b0 = 0, b1 = 0, b2 = 0;
    auto* mm = juce::MessageManager::getInstance();
    for (int blk = 0; blk < 60; ++blk) {
        for (int i = 0; i < 512; ++i) {
            const float w = rnd.nextFloat() * 2.f - 1.f;
            b0 = 0.99765f * b0 + w * 0.0990460f; b1 = 0.96300f * b1 + w * 0.2965164f; b2 = 0.57000f * b2 + w * 1.0526913f;
            const float v = 0.12f * (b0 + b1 + b2 + w * 0.1848f);
            buf.setSample(0, i, v); buf.setSample(1, i, v);
        }
        proc.processBlock(buf, midi);
        mm->runDispatchLoopUntil(20);
    }

    const auto img = ed->createComponentSnapshot(ed->getLocalBounds(), true, 2.0f);
    out.deleteFile();
    juce::FileOutputStream os(out);
    juce::PNGImageFormat png;
    if (!os.openedOk() || !png.writeImageToStream(img, os)) return 1;
    return 0;
}
