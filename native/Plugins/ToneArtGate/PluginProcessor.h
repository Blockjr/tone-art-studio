#pragma once

#include <JuceHeader.h>

/**
    Tone Art Gate — the bundled VST3.

    A tempo-synced volume gate: it follows the host's BPM and play position so
    the pattern stays locked to the bar, with the usual trance-gate shapes and
    a smooth control so hard shapes do not click.

    It is deliberately small and self-contained: the desktop host can load it
    like any third-party VST3, and it also works in any other VST3 DAW. The
    Standalone format is not built.
*/
class ToneArtGateProcessor final : public juce::AudioProcessor
{
public:
    ToneArtGateProcessor();
    ~ToneArtGateProcessor() override;

    // ------------------------------------------------------------ AudioProcessor
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override                     { return true; }

    const juce::String getName() const override         { return JucePlugin_Name; }
    bool acceptsMidi() const override                   { return false; }
    bool producesMidi() const override                  { return false; }
    bool isMidiEffect() const override                  { return false; }
    double getTailLengthSeconds() const override        { return 0.0; }

    int getNumPrograms() override                       { return 1; }
    int getCurrentProgram() override                    { return 0; }
    void setCurrentProgram (int) override               {}
    const juce::String getProgramName (int) override    { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    /** Latest gain applied to the signal, for the editor's meter. */
    float displayGain() const noexcept                  { return meter.load (std::memory_order_relaxed); }

    juce::AudioProcessorValueTreeState parameters;

private:
    juce::AudioProcessorValueTreeState::ParameterLayout createLayout();

    static float shapeAt (double phase, int shape) noexcept;

    std::atomic<float>* rateParam = nullptr;
    std::atomic<float>* shapeParam = nullptr;
    std::atomic<float>* depthParam = nullptr;
    std::atomic<float>* phaseParam = nullptr;
    std::atomic<float>* smoothParam = nullptr;
    std::atomic<float>* mixParam = nullptr;
    std::atomic<float>* bpmParam = nullptr;

    std::atomic<float> meter { 1.0f };

    double sampleRate = 44100.0;
    /** Position inside the gate cycle, 0..1. */
    double phase = 0.0;
    /** One-pole smoothing state for the gain. */
    float smoothed = 1.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ToneArtGateProcessor)
};
