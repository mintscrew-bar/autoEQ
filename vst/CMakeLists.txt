cmake_minimum_required(VERSION 3.22)
project(AutoEQ VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# JUCE 없이 돌아가는 DSP 코어 검증(TypeScript 기준값과 같은 값을 내는지)
enable_testing()
add_executable(dsp_test tests/dsp_test.cpp)
add_test(NAME dsp_parity COMMAND dsp_test)

include(FetchContent)
FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.6
    GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(JUCE)

juce_add_plugin(AutoEQ
    COMPANY_NAME "mintscrew-bar"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    PLUGIN_MANUFACTURER_CODE Mnsc
    PLUGIN_CODE Aeq1
    FORMATS VST3
    PRODUCT_NAME "AutoEQ"
    COPY_PLUGIN_AFTER_BUILD FALSE)

target_sources(AutoEQ PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
    Source/AutoAnalyzer.cpp)

target_compile_options(AutoEQ PRIVATE $<$<CXX_COMPILER_ID:MSVC>:/utf-8>)
target_compile_definitions(AutoEQ PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0)

target_link_libraries(AutoEQ
    PRIVATE
        juce::juce_audio_utils
        juce::juce_dsp
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

# 에디터를 PNG로 저장하는 도구(확인용). cmake -DAUTOEQ_SNAPSHOT=ON
option(AUTOEQ_SNAPSHOT "Build editor_snapshot" OFF)
if(AUTOEQ_SNAPSHOT)
    juce_add_console_app(editor_snapshot PRODUCT_NAME "editor_snapshot")
    target_sources(editor_snapshot PRIVATE
        tools/snapshot.cpp Source/PluginProcessor.cpp Source/PluginEditor.cpp Source/AutoAnalyzer.cpp)
    target_compile_options(editor_snapshot PRIVATE $<$<CXX_COMPILER_ID:MSVC>:/utf-8>)
    target_compile_definitions(editor_snapshot PUBLIC JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_MODAL_LOOPS_PERMITTED=1)
    target_link_libraries(editor_snapshot PRIVATE juce::juce_audio_utils juce::juce_dsp juce::juce_recommended_config_flags)
endif()
