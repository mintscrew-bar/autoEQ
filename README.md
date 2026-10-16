# autoEQ

곡의 스펙트럼을 분석해 주변보다 튀거나 꺼진 음역만 다듬는 자동 EQ. 웹 프로토타입(`src/`)과 VST3 플러그인(`vst/`)이 있다.

## 웹 프로토타입

```
pnpm install
pnpm dev      # 개발 서버
pnpm test     # DSP·엔진 테스트
pnpm build
```

MP3를 불러와 재생하면서 **LEARN**을 누르면 분석이 쌓이고 자동 밴드가 곡을 따라 움직인다. 다시 누르면 그 값으로 고정된다. 밴드마다 다이나믹 EQ를 켤 수 있다.

## VST3 (`vst/`)

JUCE 8 + CMake. 수동 밴드 8개(벨/쉘프/패스/노치, 다이나믹), 자동 보정(LEARN) 최대 8밴드.

```
cmake -S vst -B vst/build -DCMAKE_BUILD_TYPE=Release
cmake --build vst/build --config Release
ctest --test-dir vst/build -C Release     # C++ DSP가 TypeScript 기준값과 같은지
```

결과물은 `vst/build/AutoEQ_artefacts/Release/VST3/`. GitHub Actions(`.github/workflows/ci.yml`)가 Linux·Windows·macOS에서 빌드해 아티팩트로 올린다.

`src/dsp/`가 기준 구현이고 `vst/Source/dsp/`가 그 C++ 포팅이다. 한쪽을 바꾸면 다른 쪽과 `vst/tests/golden.h`를 같이 맞춘다.

## 알려진 한계

설계와 실험 기록은 [NOTES.md](NOTES.md). 요약:

- 직선 목표 곡선은 실제 음악에 맞지 않아 곡 자신의 로컬 추세를 목표로 쓴다.
- 보컬 프레즌스 불룩이나 쉘프처럼 넓게 휘어진 스펙트럼에서는 결함과 곡률을 구분하지 못한다.
- 합성 신호와 앰비언트 2곡으로만 검증했고, 귀로 확인하지 못했다.
