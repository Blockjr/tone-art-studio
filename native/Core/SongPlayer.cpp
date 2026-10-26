#include "SongPlayer.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>

namespace hybrid
{

namespace
{
/** Catmull-Rom read with zero padding outside the stem. */
float cubicAt (const std::vector<float>& data, double index) noexcept
{
    const auto base = (long long) std::floor (index);
    const auto fraction = (float) (index - (double) base);
    const auto size = (long long) data.size();

    const auto at = [&data, size] (long long position) -> float
    {
        return position >= 0 && position < size ? data[(size_t) position] : 0.0f;
    };

    const auto y0 = at (base - 1);
    const auto y1 = at (base);
    const auto y2 = at (base + 1);
    const auto y3 = at (base + 2);

    const auto a = -0.5f * y0 + 1.5f * y1 - 1.5f * y2 + 0.5f * y3;
    const auto b = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
    const auto c = -0.5f * y0 + 0.5f * y2;

    return ((a * fraction + b) * fraction + c) * fraction + y1;
}

void clearChannels (float* const* output, int numChannels, int numSamples) noexcept
{
    for (int channel = 0; channel < numChannels; ++channel)
        if (output[channel] != nullptr)
            std::memset (output[channel], 0, sizeof (float) * (size_t) numSamples);
}
} // namespace

void SongPlayer::prepare (double sampleRate, int maxBlockSize)
{
    currentSampleRate = sampleRate > 0.0 ? sampleRate : 48000.0;
    maxBlock = std::max (1, maxBlockSize);

    graph.prepare (currentSampleRate, maxBlock);

    blockBuffers.resize ((size_t) graph.trackCount());

    for (auto& buffers : blockBuffers)
    {
        buffers.left.assign ((size_t) maxBlock, 0.0f);
        buffers.right.assign ((size_t) maxBlock, 0.0f);
    }

    sources.assign ((size_t) graph.trackCount(), TrackSource{});
    sourcePointers.assign ((size_t) graph.trackCount(), { nullptr, nullptr });
    prepared = true;
}

Track& SongPlayer::addTrack (const std::string& id, const std::string& name)
{
    auto& track = graph.addTrack (id, name);

    if (prepared)
    {
        blockBuffers.resize ((size_t) graph.trackCount());

        auto& buffers = blockBuffers.back();
        buffers.left.assign ((size_t) maxBlock, 0.0f);
        buffers.right.assign ((size_t) maxBlock, 0.0f);

        sources.assign ((size_t) graph.trackCount(), TrackSource{});
        sourcePointers.assign ((size_t) graph.trackCount(), { nullptr, nullptr });
        graph.prepare (currentSampleRate, maxBlock);
    }

    return track;
}

void SongPlayer::clearTracks()
{
    while (graph.trackCount() > 0)
        graph.removeTrack (graph.track (graph.trackCount() - 1).id);

    blockBuffers.clear();
    sources.clear();
    sourcePointers.clear();
    stems.clear();
    position = 0.0;
    playing = false;
    tailFrames = 0;
}

bool SongPlayer::setStem (const std::string& trackId, const float* left, const float* right,
                          int numFrames, double sourceRate)
{
    if (graph.findTrack (trackId) == nullptr || left == nullptr || numFrames <= 0 || sourceRate <= 0.0)
        return false;

    Stem stem;
    stem.sourceRate = sourceRate;
    stem.left.assign (left, left + numFrames);
    stem.right.assign (right != nullptr ? right : left, (right != nullptr ? right : left) + numFrames);

    for (auto& entry : stems)
    {
        if (entry.first == trackId)
        {
            entry.second = std::move (stem);
            return true;
        }
    }

    stems.emplace_back (trackId, std::move (stem));
    return true;
}

void SongPlayer::clearStems()
{
    stems.clear();
    position = 0.0;
    playing = false;
    tailFrames = 0;
}

bool SongPlayer::hasStem (const std::string& trackId) const
{
    for (const auto& entry : stems)
        if (entry.first == trackId)
            return true;

    return false;
}

namespace
{
const SongPlayer::Stem* findStem (const std::vector<std::pair<std::string, SongPlayer::Stem>>& stems,
                                  const std::string& id) noexcept
{
    for (const auto& entry : stems)
        if (entry.first == id)
            return &entry.second;

    return nullptr;
}
} // namespace

bool SongPlayer::trackHasAudio (const std::string& id) const
{
    return findStem (stems, id) != nullptr;
}

void SongPlayer::setLength (double seconds)
{
    length = std::max (0.0, seconds);

    if (loop && loopEnd > length)
        loopEnd = length;

    if (position > length)
        position = length;
}

void SongPlayer::play()
{
    playing = true;
    tailFrames = 0;

    if (length > 0.0 && position >= length - 1e-9)
        position = loop ? loopStart : 0.0;
}

void SongPlayer::stop()
{
    playing = false;
    tailFrames = (int) std::ceil (currentSampleRate * 3.0);
}

void SongPlayer::locate (double seconds)
{
    position = std::max (0.0, std::min (length > 0.0 ? length : seconds, seconds));
}

void SongPlayer::setLoop (bool enabled, double startSeconds, double endSeconds)
{
    loop = enabled;
    loopStart = std::max (0.0, startSeconds);
    loopEnd = std::max (loopStart + 0.01, endSeconds);

    if (length > 0.0)
        loopEnd = std::min (loopEnd, length);

    if (loopEnd <= loopStart && length > 0.0)
    {
        loopStart = 0.0;
        loopEnd = length;
    }
}

void SongPlayer::process (float* const* output, int numOutputChannels, int numSamples)
{
    if (output == nullptr || numOutputChannels <= 0 || numSamples <= 0)
        return;

    if (! prepared)
    {
        clearChannels (output, numOutputChannels, numSamples);
        return;
    }

    if (! playing && tailFrames <= 0)
    {
        clearChannels (output, numOutputChannels, numSamples);
        return;
    }

    if (! playing)
        tailFrames = std::max (0, tailFrames - numSamples);

    if (blockBuffers.size() != (size_t) graph.trackCount()
        || sourcePointers.size() != (size_t) graph.trackCount())
        return;

    int done = 0;

    while (done < numSamples)
    {
        // The graph's scratch buffers and the plugins are prepared for
        // maxBlock; a driver that hands us a bigger block is split, not dropped.
        int chunk = std::min (numSamples - done, maxBlock);

        if (playing)
        {
            const auto boundary = loop ? loopEnd : length;

            if (boundary > 0.0)
            {
                if (loop && position >= boundary - 1e-9)
                    position = loopStart;

                const auto framesLeft = (int) std::ceil ((boundary - position) * currentSampleRate - 1e-6);

                if (framesLeft <= 0)
                {
                    if (loop)
                    {
                        position = loopStart;
                        continue;
                    }

                    // The song ended: let the insert tails ring out.
                    playing = false;
                    tailFrames = (int) std::ceil (currentSampleRate * 3.0);
                    break;
                }

                chunk = std::min (chunk, framesLeft);
            }
        }

        if (chunk <= 0)
            break;

        // Fill one block of stem audio for every track at this position.
        for (int index = 0; index < graph.trackCount(); ++index)
        {
            auto& buffers = blockBuffers[(size_t) index];
            std::memset (buffers.left.data(), 0, sizeof (float) * (size_t) chunk);
            std::memset (buffers.right.data(), 0, sizeof (float) * (size_t) chunk);

            const auto* stem = playing ? findStem (stems, graph.track (index).id) : nullptr;

            if (stem != nullptr)
            {
                const auto step = stem->sourceRate / currentSampleRate;
                const auto start = position * stem->sourceRate;

                for (int sample = 0; sample < chunk; ++sample)
                {
                    const auto readPosition = start + (double) sample * step;
                    buffers.left[(size_t) sample] = cubicAt (stem->left, readPosition);
                    buffers.right[(size_t) sample] = cubicAt (stem->right, readPosition);
                }
            }

            sourcePointers[(size_t) index] = { buffers.left.data(), buffers.right.data() };
            sources[(size_t) index].channels = sourcePointers[(size_t) index].data();
            sources[(size_t) index].numChannels = 2;
        }

        const auto outChannels = std::min (2, numOutputChannels);

        float* segment[2]
        {
            output[0] != nullptr ? output[0] + done : nullptr,
            outChannels > 1 && output[1] != nullptr ? output[1] + done : nullptr,
        };

        graph.process (sources.data(), (int) sources.size(), segment, outChannels, chunk);

        done += chunk;

        if (playing)
        {
            position += (double) chunk / currentSampleRate;

            if (loop && position >= loopEnd - 1e-9)
                position = loopStart;
        }
    }
}

} // namespace hybrid
