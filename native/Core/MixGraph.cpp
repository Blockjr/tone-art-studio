#include "MixGraph.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace hybrid
{
namespace
{
constexpr float kSilentDb = -96.0f;

float dbToGain (float db) noexcept
{
    return db <= kSilentDb ? 0.0f : std::pow (10.0f, db / 20.0f);
}

float clampFloat (float value, float min, float max) noexcept
{
    return std::min (max, std::max (min, value));
}

/** Balance law: centre keeps both channels at unity, hard pan silences one. */
void panGains (float pan, float& left, float& right) noexcept
{
    const auto position = clampFloat (pan, -1.0f, 1.0f);
    left = position <= 0.0f ? 1.0f : 1.0f - position;
    right = position >= 0.0f ? 1.0f : 1.0f + position;
}
} // namespace

bool InsertChain::add (std::unique_ptr<Insert> insert)
{
    if (insert == nullptr || (int) slots.size() >= kMaxSlots)
        return false;

    slots.push_back ({ std::move (insert), false });
    return true;
}

bool InsertChain::insertAt (int index, std::unique_ptr<Insert> insert)
{
    if (insert == nullptr || (int) slots.size() >= kMaxSlots)
        return false;

    const auto position = std::clamp (index, 0, (int) slots.size());
    slots.insert (slots.begin() + position, { std::move (insert), false });
    return true;
}

bool InsertChain::remove (int index)
{
    if (index < 0 || index >= (int) slots.size())
        return false;

    slots.erase (slots.begin() + index);
    return true;
}

bool InsertChain::move (int from, int to)
{
    if (from < 0 || from >= (int) slots.size())
        return false;

    const auto target = std::clamp (to, 0, (int) slots.size() - 1);

    if (target == from)
        return false;

    auto slot = std::move (slots[(size_t) from]);
    slots.erase (slots.begin() + from);
    slots.insert (slots.begin() + target, std::move (slot));
    return true;
}

void InsertChain::clear()
{
    slots.clear();
}

Insert* InsertChain::at (int index) noexcept
{
    if (index < 0 || index >= (int) slots.size())
        return nullptr;

    return slots[(size_t) index].insert.get();
}

const Insert* InsertChain::at (int index) const noexcept
{
    if (index < 0 || index >= (int) slots.size())
        return nullptr;

    return slots[(size_t) index].insert.get();
}

bool InsertChain::setBypassed (int index, bool shouldBeBypassed)
{
    if (index < 0 || index >= (int) slots.size())
        return false;

    slots[(size_t) index].bypassed = shouldBeBypassed;
    return true;
}

bool InsertChain::isBypassed (int index) const noexcept
{
    if (index < 0 || index >= (int) slots.size())
        return false;

    return slots[(size_t) index].bypassed;
}

void InsertChain::prepare (double sampleRate, int maxBlockSize)
{
    for (auto& slot : slots)
        if (slot.insert != nullptr)
            slot.insert->prepare (sampleRate, maxBlockSize);
}

void InsertChain::process (float* const* channels, int numChannels, int numSamples)
{
    for (auto& slot : slots)
    {
        if (slot.bypassed || slot.insert == nullptr)
            continue;

        slot.insert->process (channels, numChannels, numSamples);
    }
}

void InsertChain::reset()
{
    for (auto& slot : slots)
        if (slot.insert != nullptr)
            slot.insert->reset();
}

int InsertChain::latencySamples() const noexcept
{
    int total = 0;

    for (const auto& slot : slots)
        if (! slot.bypassed && slot.insert != nullptr)
            total += std::max (0, slot.insert->latencySamples());

    return total;
}

MixGraph::MixGraph()
{
    tracks.reserve ((size_t) kMaxTracks);
}

Track& MixGraph::addTrack (const std::string& id, const std::string& name)
{
    if ((int) tracks.size() >= kMaxTracks)
        return tracks.back();

    tracks.push_back (Track {});
    auto& created = tracks.back();
    created.id = id;
    created.name = name;
    created.currentGain = 1.0f;

    if (prepared)
        allocateTrack (created);

    return created;
}

bool MixGraph::removeTrack (const std::string& id)
{
    const auto match = std::find_if (tracks.begin(), tracks.end(),
                                     [&id] (const Track& track) { return track.id == id; });

    if (match == tracks.end())
        return false;

    tracks.erase (match);
    return true;
}

Track* MixGraph::findTrack (const std::string& id) noexcept
{
    for (auto& track : tracks)
        if (track.id == id)
            return &track;

    return nullptr;
}

const Track* MixGraph::findTrack (const std::string& id) const noexcept
{
    for (const auto& track : tracks)
        if (track.id == id)
            return &track;

    return nullptr;
}

void MixGraph::prepare (double newSampleRate, int newMaxBlockSize)
{
    currentSampleRate = newSampleRate > 0.0 ? newSampleRate : 48000.0;
    currentMaxBlock = std::max (1, newMaxBlockSize);

    masterScratch.assign ((size_t) currentMaxBlock * kChannels, 0.0f);

    for (auto& track : tracks)
    {
        allocateTrack (track);
        track.inserts.prepare (currentSampleRate, currentMaxBlock);
        track.currentGain = dbToGain (track.gainDb);
    }

    masterChain.prepare (currentSampleRate, currentMaxBlock);
    masterCurrentGain = dbToGain (masterGainValueDb);
    prepared = true;
}

void MixGraph::allocateTrack (Track& track) const
{
    track.scratch.assign ((size_t) currentMaxBlock * kChannels, 0.0f);
}

void MixGraph::clearOutput (float* const* output, int numOutputChannels, int numSamples) const
{
    if (output == nullptr)
        return;

    for (int channel = 0; channel < numOutputChannels; ++channel)
        if (output[channel] != nullptr)
            std::memset (output[channel], 0, sizeof (float) * (size_t) numSamples);
}

void MixGraph::process (const TrackSource* sources, int numSources,
                        float* const* output, int numOutputChannels, int numSamples)
{
    if (output == nullptr || numOutputChannels <= 0 || numSamples <= 0)
        return;

    clearOutput (output, numOutputChannels, numSamples);

    if (! prepared)
        return;

    const int samples = std::min (numSamples, currentMaxBlock);

    if (samples <= 0)
        return;

    // Channels are stored with a maxBlock stride, so clear each one separately.
    std::fill (masterScratch.begin(), masterScratch.begin() + currentMaxBlock, 0.0f);
    std::fill (masterScratch.begin() + currentMaxBlock,
               masterScratch.begin() + (size_t) currentMaxBlock * kChannels, 0.0f);

    const bool anySolo = std::any_of (tracks.begin(), tracks.end(),
                                      [] (const Track& track) { return track.solo; });

    for (int index = 0; index < (int) tracks.size(); ++index)
    {
        auto& track = tracks[(size_t) index];
        track.peak[0] = 0.0f;
        track.peak[1] = 0.0f;

        if (track.scratch.size() < (size_t) samples * kChannels)
            continue;

        std::fill (track.scratch.begin(), track.scratch.begin() + currentMaxBlock, 0.0f);
        std::fill (track.scratch.begin() + currentMaxBlock,
                   track.scratch.begin() + (size_t) currentMaxBlock * kChannels, 0.0f);

        const auto* source = index < numSources ? &sources[index] : nullptr;

        if (source != nullptr && source->channels != nullptr && source->numChannels > 0)
        {
            for (int channel = 0; channel < kChannels; ++channel)
            {
                const auto sourceChannel = std::min (channel, source->numChannels - 1);
                const auto* input = source->channels[sourceChannel];

                if (input != nullptr)
                    std::memcpy (track.scratch.data() + (size_t) channel * currentMaxBlock,
                                 input, sizeof (float) * (size_t) samples);
            }
        }

        float* channelPointers[kChannels]
        {
            track.scratch.data(),
            track.scratch.data() + currentMaxBlock,
        };

        track.inserts.process (channelPointers, kChannels, samples);

        const bool audible = ! track.mute && (! anySolo || track.solo);
        const auto targetGain = audible ? dbToGain (track.gainDb) : 0.0f;
        const auto startGain = track.currentGain;
        const auto gainStep = (targetGain - startGain) / (float) samples;

        float leftPan = 1.0f;
        float rightPan = 1.0f;
        panGains (track.pan, leftPan, rightPan);

        const auto* left = track.scratch.data();
        const auto* right = track.scratch.data() + currentMaxBlock;
        auto* masterLeft = masterScratch.data();
        auto* masterRight = masterScratch.data() + currentMaxBlock;

        for (int sample = 0; sample < samples; ++sample)
        {
            const auto gain = startGain + gainStep * (float) (sample + 1);
            const auto leftSample = left[sample] * gain * leftPan;
            const auto rightSample = right[sample] * gain * rightPan;

            masterLeft[sample] += leftSample;
            masterRight[sample] += rightSample;

            track.peak[0] = std::max (track.peak[0], std::abs (leftSample));
            track.peak[1] = std::max (track.peak[1], std::abs (rightSample));
        }

        track.currentGain = targetGain;
    }

    float* masterPointers[kChannels]
    {
        masterScratch.data(),
        masterScratch.data() + currentMaxBlock,
    };

    masterChain.process (masterPointers, kChannels, samples);

    const auto masterTarget = dbToGain (masterGainValueDb);
    const auto masterStep = (masterTarget - masterCurrentGain) / (float) samples;

    masterPeakValue[0] = 0.0f;
    masterPeakValue[1] = 0.0f;

    for (int sample = 0; sample < samples; ++sample)
    {
        const auto gain = masterCurrentGain + masterStep * (float) (sample + 1);
        masterPointers[0][sample] *= gain;
        masterPointers[1][sample] *= gain;

        masterPeakValue[0] = std::max (masterPeakValue[0], std::abs (masterPointers[0][sample]));
        masterPeakValue[1] = std::max (masterPeakValue[1], std::abs (masterPointers[1][sample]));
    }

    masterCurrentGain = masterTarget;

    for (int channel = 0; channel < numOutputChannels; ++channel)
    {
        auto* destination = output[channel];

        if (destination == nullptr)
            continue;

        if (numOutputChannels == 1)
        {
            for (int sample = 0; sample < samples; ++sample)
                destination[sample] = 0.5f * (masterPointers[0][sample] + masterPointers[1][sample]);
        }
        else
        {
            const auto source = std::min (channel, kChannels - 1);
            std::memcpy (destination, masterPointers[source], sizeof (float) * (size_t) samples);
        }
    }
}

float MixGraph::masterPeak (int channel) const noexcept
{
    return channel >= 0 && channel < kChannels ? masterPeakValue[channel] : 0.0f;
}

float MixGraph::trackPeak (int index, int channel) const noexcept
{
    if (index < 0 || index >= (int) tracks.size() || channel < 0 || channel >= kChannels)
        return 0.0f;

    return tracks[(size_t) index].peak[channel];
}

int MixGraph::latencySamples() const noexcept
{
    int longestTrack = 0;

    for (const auto& track : tracks)
        longestTrack = std::max (longestTrack, track.inserts.latencySamples());

    return longestTrack + masterChain.latencySamples();
}

void MixGraph::reset()
{
    for (auto& track : tracks)
    {
        track.inserts.reset();
        std::fill (track.scratch.begin(), track.scratch.end(), 0.0f);
        track.peak[0] = 0.0f;
        track.peak[1] = 0.0f;
        track.currentGain = dbToGain (track.gainDb);
    }

    masterChain.reset();
    std::fill (masterScratch.begin(), masterScratch.end(), 0.0f);
    masterPeakValue[0] = 0.0f;
    masterPeakValue[1] = 0.0f;
    masterCurrentGain = dbToGain (masterGainValueDb);
}

} // namespace hybrid
