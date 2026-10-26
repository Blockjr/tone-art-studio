#pragma once

/**
    Plays previously rendered stems through the mix graph.

    The browser mixes the song; when you want VST3s on every track, the app
    renders one stem per track (after the built-in inserts, before the fader)
    and the native host plays those stems through MixGraph, whose per-track
    chains can hold a VST3 each. The stems are at a fixed rate, so the player
    resamples to the device rate; the transport stays sample-accurate because
    every stem is read from the same position.

    No JUCE here: tests drive it with synthetic buffers. The WAV loader lives in
    PluginHost so this file stays buildable on any machine.
*/

#include "MixGraph.h"

#include <array>
#include <memory>
#include <string>
#include <vector>

namespace hybrid
{

class SongPlayer
{
public:
    static constexpr int kChannels = 2;

    struct Stem
    {
        std::vector<float> left;
        std::vector<float> right;
        double sourceRate = 48000.0;

        int frames() const noexcept { return (int) left.size(); }
        double seconds() const noexcept { return sourceRate > 0.0 ? (double) frames() / sourceRate : 0.0; }
    };

    void prepare (double sampleRate, int maxBlockSize);

    Track& addTrack (const std::string& id, const std::string& name);
    void clearTracks();

    /** Copies a rendered stem. Call off the audio thread. */
    bool setStem (const std::string& trackId, const float* left, const float* right,
                  int numFrames, double sourceRate);
    void clearStems();
    bool hasStems() const noexcept { return ! stems.empty(); }
    bool hasStem (const std::string& trackId) const;

    /** Longest stem in seconds; the transport clamps to it. */
    void setLength (double seconds);
    double lengthSeconds() const noexcept { return length; }

    void play();
    void stop();
    bool isPlaying() const noexcept { return playing; }

    double positionSeconds() const noexcept { return position; }
    void locate (double seconds);

    void setLoop (bool enabled, double startSeconds = 0.0, double endSeconds = 0.0);
    bool loopEnabled() const noexcept { return loop; }

    /**
        Renders the current block. Output is cleared and left silent when the
        transport is stopped and the insert tails have decayed.
    */
    void process (float* const* output, int numOutputChannels, int numSamples);

    MixGraph& mixer() noexcept             { return graph; }
    const MixGraph& mixer() const noexcept { return graph; }

    double sampleRate() const noexcept { return currentSampleRate; }

private:
    struct TrackBuffers
    {
        std::vector<float> left;
        std::vector<float> right;
    };

    static float readSample (const std::vector<float>& data, double index) noexcept;
    bool trackHasAudio (const std::string& id) const;

    MixGraph graph;
    std::vector<TrackBuffers> blockBuffers;
    std::vector<std::array<const float*, 2>> sourcePointers;
    std::vector<TrackSource> sources;

    std::vector<std::pair<std::string, Stem>> stems;

    double currentSampleRate = 48000.0;
    int maxBlock = 0;
    bool prepared = false;

    bool playing = false;
    double position = 0.0;
    double length = 0.0;
    bool loop = false;
    double loopStart = 0.0;
    double loopEnd = 0.0;

    int tailFrames = 0;
};

} // namespace hybrid
