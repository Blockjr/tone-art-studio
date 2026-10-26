#pragma once

#include <JuceHeader.h>

#include <atomic>

#include "SongPlayer.h"
#include "VstInsert.h"
#include "VstScanner.h"

using SongPlayer = hybrid::SongPlayer;
using VstInsert = hybrid::VstInsert;
using VstScanner = hybrid::VstScanner;
using InsertChain = hybrid::InsertChain;

/**
    Hosts VST3 plugins for the native mixer.

    Two paths share one mix graph:

    - **Live input** (the original behaviour): the ASIO input is processed
      through the master insert chain and sent to the output.
    - **Song**: stems rendered by the web app are played by SongPlayer and each
      track runs its own VST3 chain before the channel fader, exactly like the
      built-in rack.

    Scanning and instantiation happen on the message thread; the audio thread
    only calls process()/processSong() and the transport setters, which are
    plain values read on the next block.
*/
class PluginHost
{
public:
    static constexpr int kMaxPlugins = 8;

    PluginHost();

    // ------------------------------------------------------------- catalogue

    /** Scans the standard VST3 folders. Returns the catalogue. */
    juce::var scan();
    juce::var catalogue() const;
    juce::String lastError() const               { return error; }
    int pluginCount() const                      { return (int) scanner.plugins().size(); }

    // ---------------------------------------------------------- master chain

    /** Appends a scanned plugin to the master chain. */
    juce::var add (const juce::String& identifier);
    void remove (int index);
    void move (int fromIndex, int toIndex);
    void clear();

    /** The loaded master chain, in processing order. */
    juce::var chainState() const;

    juce::AudioProcessor* getProcessor (int index) const;

    /** Processes live input through the master chain. */
    void process (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);

    void prepare (double newSampleRate, int newBlockSize);

    // -------------------------------------------------------- per-track VST3

    /** Adds a plugin to one track's chain. Returns that track's chain state. */
    juce::var addTrackPlugin (const juce::String& trackId, const juce::String& identifier);
    juce::var removeTrackPlugin (const juce::String& trackId, int slot);
    juce::var moveTrackPlugin (const juce::String& trackId, int from, int to);
    juce::var setTrackPluginBypass (const juce::String& trackId, int slot, bool bypassed);
    juce::var trackChains() const;
    juce::AudioProcessor* getTrackProcessor (const juce::String& trackId, int slot) const;

    // ------------------------------------------------------------ song playback

    /** Loads stems.json and its WAVs from a folder. Stops playback first. */
    bool loadStems (const juce::File& folder, juce::String& failure);
    void unloadStems();
    bool songLoaded() const                      { return songReady.load (std::memory_order_acquire); }

    void setSongPlaying (bool shouldPlay);
    void setSongPosition (double seconds);
    void setSongLoop (bool enabled);
    void setTrackMix (const juce::String& trackId, float gainDb, float pan, bool mute, bool solo);

    void processSong (juce::AudioBuffer<float>& buffer, int numSamples);

    juce::var songState() const;

    SongPlayer& getSong() noexcept               { return song; }
    const SongPlayer& getSong() const noexcept   { return song; }

private:
    std::unique_ptr<VstInsert> createInsert (const juce::String& identifier);
    InsertChain& masterChain() noexcept          { return song.mixer().master(); }
    const InsertChain& masterChain() const noexcept { return song.mixer().master(); }
    juce::var describeChain (const InsertChain& chain) const;

    VstScanner scanner;
    SongPlayer song;
    std::atomic<bool> songReady { false };
    /** Guards structural edits against the audio thread, which only try-locks. */
    juce::SpinLock songLock;

    juce::AudioFormatManager audioFormats;
    juce::String error;

    double sampleRate = 44100.0;
    int blockSize = 512;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginHost)
};
