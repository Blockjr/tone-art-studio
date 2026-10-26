#pragma once

/**
    A VST3 instance as a mix-graph insert.

    The adapter is intentionally thin: prepare the instance, wrap the graph's
    channel pointers in an AudioBuffer view and call processBlock. Bypass and
    chain order live in hybrid::InsertChain, so this class never suspends itself.

    Include the host's plugin module before this header (the desktop app uses
    juce_audio_processors; the headless test build uses the headless module).
*/

#if defined(HYBRID_HEADLESS)
 #include <juce_audio_processors_headless/juce_audio_processors_headless.h>
#else
 #include <juce_audio_processors/juce_audio_processors.h>
#endif

#include "MixGraph.h"

#include <memory>
#include <string>

namespace hybrid
{

class VstInsert final : public Insert
{
public:
    explicit VstInsert (std::unique_ptr<juce::AudioPluginInstance> pluginInstance);

    void prepare (double sampleRate, int maxBlockSize) override;
    void process (float* const* channels, int numChannels, int numSamples) override;
    void reset() override;
    int latencySamples() const noexcept override;
    const char* name() const noexcept override;

    juce::AudioPluginInstance* plugin() noexcept;
    const juce::AudioPluginInstance* plugin() const noexcept;

    bool hasEditor() const;
    juce::AudioProcessorEditor* createEditor();

    /** Base64 state, ready for the bridge or the project file. */
    juce::String saveState() const;
    bool restoreState (const juce::String& base64State);

private:
    std::unique_ptr<juce::AudioPluginInstance> instance;
    juce::MidiBuffer midi;
    std::string label { "VST3" };
};

} // namespace hybrid
