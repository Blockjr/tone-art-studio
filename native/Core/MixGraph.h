#pragma once

/**
    The native mix graph: tracks, ordered insert chains, pan/gain/mute/solo and
    a master chain.

    This is the first stage of moving the studio's audio engine out of the
    browser so that VST3 plugins can process every track. It is deliberately
    free of JUCE: an insert is an interface, so VST3 instances, built-in
    processors and test doubles are all the same thing to the mixer. The JUCE
    adapter wraps a juce::AudioPluginInstance as an Insert.

    Threading: one thread owns the graph while processing. Prepare and edit the
    graph between blocks, never inside process().
*/

#include <cstddef>
#include <memory>
#include <string>
#include <vector>

namespace hybrid
{

/** One processor in a chain. Implementations must be real-time safe in process(). */
class Insert
{
public:
    virtual ~Insert() = default;

    /** Allocates and configures for the stream. Called off the audio thread. */
    virtual void prepare (double sampleRate, int maxBlockSize) = 0;

    /** Processes in place. `channels` holds numChannels pointers of numSamples. */
    virtual void process (float* const* channels, int numChannels, int numSamples) = 0;

    /** Clears tails, delay lines and meters. Called off the audio thread. */
    virtual void reset() {}

    /** Reported latency, used for the graph's latency figure. */
    virtual int latencySamples() const noexcept { return 0; }

    /** A short label for logs and the bridge. */
    virtual const char* name() const noexcept { return "Insert"; }
};

/** A position in a chain: the processor plus its bypass switch. */
struct InsertSlot
{
    std::unique_ptr<Insert> insert;
    bool bypassed = false;
};

/** Up to kMaxSlots processors in signal order. */
class InsertChain
{
public:
    static constexpr int kMaxSlots = 8;

    bool add (std::unique_ptr<Insert> insert);
    bool insertAt (int index, std::unique_ptr<Insert> insert);
    bool remove (int index);
    bool move (int from, int to);
    void clear();

    int size() const noexcept                  { return (int) slots.size(); }
    bool empty() const noexcept                { return slots.empty(); }
    Insert* at (int index) noexcept;
    const Insert* at (int index) const noexcept;

    bool setBypassed (int index, bool shouldBeBypassed);
    bool isBypassed (int index) const noexcept;

    void prepare (double sampleRate, int maxBlockSize);
    void process (float* const* channels, int numChannels, int numSamples);
    void reset();

    /** Sum of the active inserts' reported latency. */
    int latencySamples() const noexcept;

private:
    std::vector<InsertSlot> slots;
};

/** A track's mixer state and insert chain. Sources are supplied per block. */
struct Track
{
    std::string id;
    std::string name;

    InsertChain inserts;

    /** Channel gain in decibels, applied after the inserts. */
    float gainDb = 0.0f;

    /** -1 hard left, 0 centre, +1 hard right. Balance law: centre is unity. */
    float pan = 0.0f;

    bool mute = false;
    bool solo = false;

    // Owned by MixGraph; do not touch from outside.
    std::vector<float> scratch;
    float currentGain = 1.0f;
    float peak[2] { 0.0f, 0.0f };
};

/** A block of audio for one track; null channels mean silence. */
struct TrackSource
{
    const float* const* channels = nullptr;
    int numChannels = 0;
};

class MixGraph
{
public:
    static constexpr int kChannels = 2;
    static constexpr int kMaxTracks = 64;

    /** Reserves the track slots so references stay valid as tracks are added. */
    MixGraph();

    Track& addTrack (const std::string& id, const std::string& name);
    bool removeTrack (const std::string& id);
    Track* findTrack (const std::string& id) noexcept;
    const Track* findTrack (const std::string& id) const noexcept;
    int trackCount() const noexcept            { return (int) tracks.size(); }
    Track& track (int index)                   { return tracks[(size_t) index]; }
    const Track& track (int index) const       { return tracks[(size_t) index]; }

    InsertChain& master() noexcept             { return masterChain; }
    const InsertChain& master() const noexcept { return masterChain; }

    void setMasterGainDb (float db) noexcept   { masterGainValueDb = db; }
    float masterGain() const noexcept          { return masterGainValueDb; }

    double sampleRate() const noexcept         { return currentSampleRate; }
    int maxBlockSize() const noexcept          { return currentMaxBlock; }

    /** Allocates scratch space. Safe to call again when the device changes. */
    void prepare (double newSampleRate, int newMaxBlockSize);

    /**
        Runs one block.

        sources[i] feeds tracks[i]; missing or silent sources are ignored. The
        result is written to `output` (at least one channel). Blocks larger than
        the prepared maximum are truncated, never reallocated.
    */
    void process (const TrackSource* sources, int numSources,
                  float* const* output, int numOutputChannels, int numSamples);

    /** Peak of the last processed block, per channel. */
    float masterPeak (int channel) const noexcept;
    float trackPeak (int index, int channel) const noexcept;

    /** Longest track chain plus the master chain. */
    int latencySamples() const noexcept;

    void reset();

private:
    std::vector<Track> tracks;
    InsertChain masterChain;
    float masterGainValueDb = 0.0f;

    std::vector<float> masterScratch;
    float masterCurrentGain = 1.0f;
    float masterPeakValue[2] { 0.0f, 0.0f };

    double currentSampleRate = 48000.0;
    int currentMaxBlock = 0;
    bool prepared = false;

    void allocateTrack (Track& track) const;
    void clearOutput (float* const* output, int numOutputChannels, int numSamples) const;
};

} // namespace hybrid
