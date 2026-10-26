// Headless checks for the native mix graph. No JUCE, no audio device: run with
// ./build-tests.sh (Linux/macOS) or compile the two .cpp files with MSVC.

#include "MixGraph.h"
#include "SongPlayer.h"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

using namespace hybrid;

namespace
{
int failures = 0;
int checks = 0;

void check (bool condition, const std::string& what)
{
    ++checks;

    if (condition)
        return;

    ++failures;
    std::printf ("  FAIL  %s\n", what.c_str());
}

void checkNear (float actual, float expected, const std::string& what, float tolerance = 1.0e-4f)
{
    check (std::abs (actual - expected) <= tolerance,
           what + " (expected " + std::to_string (expected) + ", got " + std::to_string (actual) + ")");
}

struct GainInsert final : Insert
{
    explicit GainInsert (float value) : gain (value) {}

    void prepare (double, int) override {}
    void process (float* const* channels, int numChannels, int numSamples) override
    {
        for (int channel = 0; channel < numChannels; ++channel)
            for (int sample = 0; sample < numSamples; ++sample)
                channels[channel][sample] *= gain;
    }

    const char* name() const noexcept override { return "Gain"; }

    float gain;
};

struct AddInsert final : Insert
{
    explicit AddInsert (float value) : amount (value) {}

    void prepare (double, int) override {}
    void process (float* const* channels, int numChannels, int numSamples) override
    {
        for (int channel = 0; channel < numChannels; ++channel)
            for (int sample = 0; sample < numSamples; ++sample)
                channels[channel][sample] += amount;
    }

    const char* name() const noexcept override { return "Add"; }

    float amount;
};

struct LatencyInsert final : Insert
{
    explicit LatencyInsert (int reportedLatency) : latency (reportedLatency) {}

    void prepare (double, int) override {}
    void process (float* const*, int, int) override {}
    int latencySamples() const noexcept override { return latency; }

    int latency;
};

/** A stereo block the graph can read from. */
struct Source
{
    explicit Source (int frames, float leftValue = 0.0f, float rightValue = 0.0f)
        : left ((size_t) frames, leftValue), right ((size_t) frames, rightValue)
    {
        channels[0] = left.data();
        channels[1] = right.data();
    }

    TrackSource view() const
    {
        TrackSource source;
        source.channels = channels;
        source.numChannels = 2;
        return source;
    }

    std::vector<float> left;
    std::vector<float> right;
    const float* channels[2] { nullptr, nullptr };
};

struct Output
{
    explicit Output (int frames) : left ((size_t) frames, 0.0f), right ((size_t) frames, 0.0f)
    {
        channels[0] = left.data();
        channels[1] = right.data();
    }

    float* const* pointers() { return channels; }

    std::vector<float> left;
    std::vector<float> right;
    float* channels[2] { nullptr, nullptr };
};

void testSilenceAndInfrastructure()
{
    MixGraph graph;
    Output output (16);
    graph.process (nullptr, 0, output.pointers(), 2, 16);

    bool silent = true;
    for (int sample = 0; sample < 16; ++sample)
        silent = silent && output.left[(size_t) sample] == 0.0f && output.right[(size_t) sample] == 0.0f;

    check (silent, "an unprepared graph writes silence");

    graph.prepare (48000.0, 32);
    Source source (16, 1.0f, 1.0f);
    const TrackSource view = source.view();
    graph.addTrack ("t1", "Track 1");
    graph.prepare (48000.0, 32);
    Output second (16);
    graph.process (&view, 1, second.pointers(), 2, 16);
    checkNear (second.left[5], 1.0f, "unity gain at centre pan keeps level");
}

void testGainPanAndPeaks()
{
    MixGraph graph;
    auto& track = graph.addTrack ("t1", "Track 1");
    track.gainDb = -6.0206f; // half
    track.pan = 0.0f;
    graph.prepare (48000.0, 64);

    Source source (32, 0.5f, -0.5f);
    const TrackSource view = source.view();
    Output output (32);
    graph.process (&view, 1, output.pointers(), 2, 32);

    checkNear (output.left[3], 0.25f, "−6 dB halves the left channel");
    checkNear (output.right[3], -0.25f, "−6 dB halves the right channel");
    checkNear (graph.masterPeak (0), 0.25f, "master peak follows the output");
    checkNear (graph.trackPeak (0, 0), 0.25f, "track peak follows the channel");

    track.pan = -1.0f;
    Output hardLeft (32);
    graph.process (&view, 1, hardLeft.pointers(), 2, 32);
    checkNear (hardLeft.left[10], 0.25f, "hard left keeps the left channel");
    checkNear (hardLeft.right[10], 0.0f, "hard left silences the right channel");

    track.pan = 1.0f;
    Output hardRight (32);
    graph.process (&view, 1, hardRight.pointers(), 2, 32);
    checkNear (hardRight.left[10], 0.0f, "hard right silences the left channel");
    checkNear (hardRight.right[10], -0.25f, "hard right keeps the right channel");
}

void testMuteSoloAndMasterGain()
{
    MixGraph graph;
    auto& one = graph.addTrack ("a", "A");
    auto& two = graph.addTrack ("b", "B");
    one.gainDb = 0.0f;
    two.gainDb = 0.0f;
    graph.setMasterGainDb (-6.0206f);
    graph.prepare (48000.0, 64);

    Source a (16, 1.0f, 1.0f);
    Source b (16, 1.0f, 1.0f);
    const TrackSource sources[2] { a.view(), b.view() };

    Output both (16);
    graph.process (sources, 2, both.pointers(), 2, 16);
    checkNear (both.left[4], 1.0f, "two tracks sum before the master gain");

    // Mute and solo ramp over a block, so the last sample of the first block
    // after the change already sits at the new level.
    one.mute = true;
    Output muted (16);
    graph.process (sources, 2, muted.pointers(), 2, 16);
    checkNear (muted.left[15], 0.5f, "a muted track is removed from the sum");

    one.mute = false;
    two.solo = true;
    Output solo (16);
    graph.process (sources, 2, solo.pointers(), 2, 16);
    checkNear (solo.left[15], 0.5f, "solo mutes the other tracks");

    two.mute = true;
    Output soloMuted (16);
    graph.process (sources, 2, soloMuted.pointers(), 2, 16);
    checkNear (soloMuted.left[15], 0.0f, "a muted solo leaves silence");
}

void testInsertChainsAndBypass()
{
    MixGraph graph;
    auto& track = graph.addTrack ("t", "T");
    track.gainDb = 0.0f;
    track.inserts.add (std::make_unique<AddInsert> (1.0f));
    track.inserts.add (std::make_unique<GainInsert> (2.0f));
    graph.prepare (48000.0, 64);

    Source source (8, 0.25f, 0.25f);
    const TrackSource view = source.view();
    Output output (8);
    graph.process (&view, 1, output.pointers(), 2, 8);
    checkNear (output.left[2], 2.5f, "inserts run in chain order");

    track.inserts.move (0, 1);
    Output reversed (8);
    graph.process (&view, 1, reversed.pointers(), 2, 8);
    checkNear (reversed.left[2], 1.5f, "moving a slot changes the chain order");

    track.inserts.setBypassed (0, true);
    Output bypassed (8);
    graph.process (&view, 1, bypassed.pointers(), 2, 8);
    checkNear (bypassed.left[2], 1.25f, "a bypassed insert is skipped");

    track.inserts.clear();
    for (int index = 0; index < InsertChain::kMaxSlots; ++index)
        check (track.inserts.add (std::make_unique<GainInsert> (1.0f)), "slot " + std::to_string (index) + " accepts an insert");

    check (! track.inserts.add (std::make_unique<GainInsert> (1.0f)), "the ninth insert is refused");
    check (track.inserts.remove (3), "an insert can be removed");
    check (track.inserts.size() == InsertChain::kMaxSlots - 1, "removing shortens the chain");
    check (! track.inserts.remove (-1), "a negative index is refused");
}

void testMasterChainAndLatency()
{
    MixGraph graph;
    auto& track = graph.addTrack ("t", "T");
    auto& second = graph.addTrack ("u", "U");
    track.inserts.add (std::make_unique<LatencyInsert> (64));
    second.inserts.add (std::make_unique<LatencyInsert> (10));
    graph.master().add (std::make_unique<GainInsert> (0.5f));
    graph.master().add (std::make_unique<LatencyInsert> (32));
    graph.prepare (48000.0, 64);

    check (graph.latencySamples() == 96, "latency is the longest track plus the master");
    check (graph.track (0).inserts.latencySamples() == 64, "a track reports its own chain latency");

    track.inserts.setBypassed (0, true);
    check (graph.track (0).inserts.latencySamples() == 0, "bypass removes latency");

    Source source (8, 1.0f, 1.0f);
    const TrackSource view = source.view();
    Output output (8);
    graph.process (&view, 1, output.pointers(), 2, 8);
    checkNear (output.left[1], 0.5f, "the master chain runs after the sum");

    graph.master().setBypassed (0, true);
    Output bypassedMaster (8);
    graph.process (&view, 1, bypassedMaster.pointers(), 2, 8);
    checkNear (bypassedMaster.left[1], 1.0f, "a bypassed master insert is skipped");
}

void testSourcesAndOutputShapes()
{
    MixGraph graph;
    graph.addTrack ("a", "A");
    graph.addTrack ("b", "B");
    graph.prepare (48000.0, 64);

    Source onlyOne (16, 0.75f, 0.75f);
    const TrackSource view = onlyOne.view();
    Output output (16);
    graph.process (&view, 1, output.pointers(), 2, 16);
    checkNear (output.left[3], 0.75f, "tracks without a source stay silent");

    // Mono source is upmixed to both sides.
    std::vector<float> mono ((size_t) 16, 0.4f);
    const float* monoChannels[1] { mono.data() };
    TrackSource monoSource;
    monoSource.channels = monoChannels;
    monoSource.numChannels = 1;
    Output monoOut (16);
    graph.process (&monoSource, 1, monoOut.pointers(), 2, 16);
    checkNear (monoOut.left[3], 0.4f, "a mono source fills the left channel");
    checkNear (monoOut.right[3], 0.4f, "a mono source fills the right channel");

    Output monoMaster (16);
    graph.process (&view, 1, monoMaster.pointers(), 1, 16);
    checkNear (monoMaster.left[3], 0.75f, "a mono output sums the stereo master");

    // A silent block must not inherit the previous block's tail.
    Source silent (16, 0.0f, 0.0f);
    const TrackSource silentView = silent.view();
    Output cleared (16);
    graph.process (&silentView, 1, cleared.pointers(), 2, 16);
    checkNear (cleared.left[3], 0.0f, "a silent block clears the previous mix");

    Source longBlock (96, 1.0f, 1.0f);
    const TrackSource longView = longBlock.view();
    Output shortPrepared (96);
    graph.process (&longView, 1, shortPrepared.pointers(), 2, 96);
    checkNear (shortPrepared.left[63], 1.0f, "the prepared block is processed");
    checkNear (shortPrepared.left[80], 0.0f, "blocks past the prepared maximum are cleared");
    check (graph.maxBlockSize() == 64, "the graph reports its block size");
}

void testResetAndTrackManagement()
{
    MixGraph graph;
    graph.addTrack ("a", "A");
    auto& third = graph.addTrack ("b", "B");
    third.gainDb = -12.0f;
    graph.prepare (48000.0, 32);

    check (graph.trackCount() == 2, "tracks are counted");
    check (graph.findTrack ("b") == &third, "a track is found by id");
    check (graph.findTrack ("missing") == nullptr, "a missing id returns nothing");

    graph.reset();
    check (graph.findTrack ("b")->currentGain > 0.0f, "reset restores the track gain");

    check (graph.removeTrack ("a"), "a track can be removed");
    check (! graph.removeTrack ("a"), "removing twice fails");
    check (graph.trackCount() == 1, "removal shrinks the graph");
}

void testSongPlayerTransport()
{
    SongPlayer player;
    player.addTrack ("t1", "Track 1");
    const std::vector<float> left (4800, 0.5f);
    const std::vector<float> right (4800, -0.25f);
    check (player.setStem ("t1", left.data(), right.data(), 4800, 48000.0), "a stem is accepted for a track");
    check (! player.setStem ("missing", left.data(), right.data(), 4800, 48000.0), "a stem needs a real track");

    player.prepare (48000.0, 128);
    player.setLength (0.1);
    player.play();

    Output output (128);
    player.process (output.pointers(), 2, 128);

    checkNear (output.left[0], 0.5f, "the left stem reaches the output");
    checkNear (output.right[127], -0.25f, "the right stem reaches the output");
    checkNear ((float) player.positionSeconds(), 128.0f / 48000.0f, "the transport advances by the block");

    player.locate (0.05);
    checkNear ((float) player.positionSeconds(), 0.05f, "locate moves the transport");

    player.stop();
    Output afterStop (128);
    player.process (afterStop.pointers(), 2, 128);
    checkNear (afterStop.left[0], 0.0f, "stopping silences the output after the tails");

    // A driver may hand over a block larger than the prepared one; it is split
    // rather than dropped.
    player.play();
    Output oversized (256);
    player.process (oversized.pointers(), 2, 256);
    checkNear (oversized.left[0], 0.5f, "an oversized block still plays its first chunk");
    checkNear (oversized.left[255], 0.5f, "an oversized block still plays its last chunk");
}

void testSongPlayerMixerAndInsert()
{
    SongPlayer player;
    auto& track = player.addTrack ("t1", "Track 1");
    track.inserts.add (std::make_unique<GainInsert> (0.5f));
    const std::vector<float> left (4800, 0.8f);
    player.setStem ("t1", left.data(), left.data(), 4800, 48000.0);
    player.prepare (48000.0, 128);
    player.setLength (1.0);
    player.play();

    Output output (128);
    player.process (output.pointers(), 2, 128);
    checkNear (output.left[64], 0.4f, "a track insert processes the stem before the fader");

    track.gainDb = -6.0206f;
    player.mixer().prepare (48000.0, 128);
    Output faded (128);
    player.process (faded.pointers(), 2, 128);
    checkNear (faded.left[127], 0.2f, "the channel fader acts after the insert", 0.002f);

    track.mute = true;
    Output muted (128);
    player.process (muted.pointers(), 2, 128);
    checkNear (muted.left[127], 0.0f, "mute ramps the track to silence", 0.002f);
}

void testSongPlayerLoopAndResample()
{
    SongPlayer player;
    player.addTrack ("t1", "Track 1");
    const std::vector<float> left (48, 0.25f);
    player.setStem ("t1", left.data(), left.data(), 48, 48000.0);
    player.prepare (48000.0, 128);
    player.setLength (0.001);
    player.setLoop (true, 0.0, 0.001);
    player.play();

    Output output (128);
    player.process (output.pointers(), 2, 128);
    checkNear (output.left[0], 0.25f, "a loop plays at the start");
    checkNear (output.left[127], 0.25f, "a loop that wraps inside one block keeps playing");
    check (player.positionSeconds() < 0.001, "a loop keeps the transport inside the loop");

    SongPlayer resampled;
    resampled.addTrack ("t1", "Track 1");
    const std::vector<float> slower (2400, 0.5f);
    resampled.setStem ("t1", slower.data(), slower.data(), 2400, 24000.0);
    resampled.prepare (48000.0, 128);
    resampled.setLength (0.1);
    resampled.play();

    Output rateOutput (128);
    resampled.process (rateOutput.pointers(), 2, 128);
    checkNear (rateOutput.left[0], 0.5f, "a 24 kHz stem plays through a 48 kHz device");
    checkNear (rateOutput.left[127], 0.5f, "resampling holds the stem level");
}

void testGainRamp()
{
    MixGraph graph;
    auto& track = graph.addTrack ("t", "T");
    graph.prepare (48000.0, 32);
    track.gainDb = -6.0206f;

    Source source (32, 1.0f, 1.0f);
    const TrackSource view = source.view();
    Output output (32);
    graph.process (&view, 1, output.pointers(), 2, 32);

    check (output.left[0] < 1.0f, "a gain change ramps instead of jumping");
    check (output.left[31] < output.left[0], "the ramp moves toward the new gain");
    checkNear (output.left[31], 0.5f, "the ramp reaches the target by the block end", 0.001f);
}
} // namespace

int main()
{
    struct Test
    {
        const char* name;
        void (*run)();
    };

    const Test tests[]
    {
        { "silence and infrastructure", testSilenceAndInfrastructure },
        { "gain, pan and peaks", testGainPanAndPeaks },
        { "mute, solo and master gain", testMuteSoloAndMasterGain },
        { "insert chains and bypass", testInsertChainsAndBypass },
        { "master chain and latency", testMasterChainAndLatency },
        { "sources and output shapes", testSourcesAndOutputShapes },
        { "reset and track management", testResetAndTrackManagement },
        { "song player transport", testSongPlayerTransport },
        { "song player mixer and insert", testSongPlayerMixerAndInsert },
        { "song player loop and resample", testSongPlayerLoopAndResample },
        { "gain ramp", testGainRamp },
    };

    for (const auto& test : tests)
    {
        std::printf ("%s\n", test.name);
        test.run();
    }

    std::printf ("\n%d checks, %d failure%s\n", checks, failures, failures == 1 ? "" : "s");
    return failures == 0 ? 0 : 1;
}
