#pragma once

/**
    Finds VST3 plug-ins on this machine and creates instances for the mixer.

    Scanning happens on demand from the UI command thread, never from the audio
    thread. Only the VST3 format is registered: it is the one format the app
    documents and the one with a predictable bundle layout on every platform.
*/

#if defined(HYBRID_HEADLESS)
 #include <juce_audio_processors_headless/juce_audio_processors_headless.h>
#else
 #include <juce_audio_processors/juce_audio_processors.h>
#endif

#include "VstInsert.h"

#include <memory>
#include <vector>

namespace hybrid
{

class VstScanner
{
public:
    struct Entry
    {
        juce::String id;          // PluginDescription::createIdentifierString()
        juce::String name;        // "Pro-Q 3"
        juce::String maker;       // "FabFilter"
        juce::String category;    // "EQ", "Dynamics", "Instrument"
        juce::String path;        // bundle on disk
        bool instrument = false;
    };

    VstScanner() = default;

    /** Re-scans the standard folders. Safe to call repeatedly. */
    void scan();

    const std::vector<Entry>& plugins() const noexcept { return entries; }
    const juce::String& error() const noexcept { return errorMessage; }

    /** Instantiates a scanned plug-in. Returns nullptr and fills error on failure. */
    std::unique_ptr<VstInsert> create (const juce::String& identifier,
                                       double sampleRate,
                                       int blockSize,
                                       juce::String& error);

    /** The folders a VST3 scan looks in, in order. */
    static juce::StringArray defaultFolders();

private:
    void ensureFormats();

    juce::AudioPluginFormatManager manager;
    std::vector<Entry> entries;
    std::vector<juce::PluginDescription> descriptions;
    juce::String errorMessage;
};

} // namespace hybrid
