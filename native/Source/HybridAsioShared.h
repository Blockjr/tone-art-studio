#pragma once

/**
    Shared-memory protocol between the Tone Art Studio virtual ASIO driver and the
    Tone Art Studio application.

    Both sides are MSVC/x64 (or clang-cl), so the std::atomic fields below are
    lock-free and safe to place in a shared mapping. Sizes are fixed and the
    layout must never change without bumping protocolVersion.

    Direction of flow:

      other ASIO applications  --(their outputs)-->  toStudio ring  -->  Tone Art Studio
      Tone Art Studio            --(studio master)-->  toClient ring  -->  other applications

    The driver is the producer of toStudio and the consumer of toClient;
    Tone Art Studio is the mirror image.
*/

#include <atomic>
#include <cstdint>
#include <cstddef>

namespace hybridasio
{
inline constexpr char sharedMemoryName[] = "Local\\HybridStudioVirtualAsio";
inline constexpr char toStudioEventName[] = "Local\\HybridStudioVirtualAsioToStudio";
inline constexpr char toClientEventName[] = "Local\\HybridStudioVirtualAsioToClient";

inline constexpr std::uint32_t magicValue = 0x48534131u;   // "HSA1"
inline constexpr std::uint32_t protocolVersion = 1u;
inline constexpr std::uint32_t channelCount = 2u;
inline constexpr std::uint32_t ringFrames = 1u << 15;      // 32768 frames (~0.7 s at 44.1 kHz)
inline constexpr std::uint32_t ringMask = ringFrames - 1u;

struct Ring
{
    std::atomic<std::uint64_t> writeIndex { 0 };
    std::atomic<std::uint64_t> readIndex { 0 };
    std::atomic<std::uint32_t> overruns { 0 };
    std::atomic<std::uint32_t> underruns { 0 };
    float samples[ringFrames * channelCount];
};

struct Block
{
    std::atomic<std::uint32_t> magic { 0 };
    std::atomic<std::uint32_t> version { 0 };
    std::atomic<std::uint32_t> sampleRate { 0 };
    std::atomic<std::uint32_t> blockSize { 0 };
    std::atomic<std::uint32_t> channels { 0 };
    std::atomic<std::uint32_t> driverOnline { 0 };
    std::atomic<std::uint32_t> studioOnline { 0 };
    std::atomic<std::uint64_t> samplePosition { 0 };

    Ring toStudio;
    Ring toClient;
};

inline std::uint32_t framesAvailable (const Ring& ring) noexcept
{
    const auto written = ring.writeIndex.load (std::memory_order_acquire);
    const auto read = ring.readIndex.load (std::memory_order_relaxed);
    return written > read ? static_cast<std::uint32_t> (written - read) : 0u;
}

/** Pushes interleaved stereo frames. Returns the number written. */
inline std::uint32_t push (Ring& ring, const float* interleaved, std::uint32_t frames) noexcept
{
    const auto written = ring.writeIndex.load (std::memory_order_relaxed);
    const auto read = ring.readIndex.load (std::memory_order_acquire);
    const auto used = static_cast<std::uint32_t> (written - read);
    const auto space = ringFrames - used;
    const auto count = frames < space ? frames : space;

    for (std::uint32_t frame = 0; frame < count; ++frame)
    {
        const auto index = static_cast<std::uint32_t> (written + frame) & ringMask;

        for (std::uint32_t channel = 0; channel < channelCount; ++channel)
            ring.samples[index * channelCount + channel] = interleaved[frame * channelCount + channel];
    }

    ring.writeIndex.store (written + count, std::memory_order_release);

    if (count < frames)
        ring.overruns.fetch_add (1, std::memory_order_relaxed);

    return count;
}

/** Pops interleaved stereo frames, zero-filling any shortfall. Returns frames filled. */
inline std::uint32_t pop (Ring& ring, float* interleaved, std::uint32_t frames) noexcept
{
    const auto read = ring.readIndex.load (std::memory_order_relaxed);
    const auto written = ring.writeIndex.load (std::memory_order_acquire);
    const auto used = static_cast<std::uint32_t> (written > read ? written - read : 0);
    const auto count = frames < used ? frames : used;

    for (std::uint32_t frame = 0; frame < count; ++frame)
    {
        const auto index = static_cast<std::uint32_t> (read + frame) & ringMask;

        for (std::uint32_t channel = 0; channel < channelCount; ++channel)
            interleaved[frame * channelCount + channel] = ring.samples[index * channelCount + channel];
    }

    for (std::uint32_t frame = count; frame < frames; ++frame)
        for (std::uint32_t channel = 0; channel < channelCount; ++channel)
            interleaved[frame * channelCount + channel] = 0.0f;

    ring.readIndex.store (read + count, std::memory_order_release);

    if (count < frames)
        ring.underruns.fetch_add (1, std::memory_order_relaxed);

    return count;
}

inline void resetRing (Ring& ring) noexcept
{
    ring.readIndex.store (ring.writeIndex.load (std::memory_order_acquire), std::memory_order_release);
    ring.overruns.store (0, std::memory_order_relaxed);
    ring.underruns.store (0, std::memory_order_relaxed);
}
} // namespace hybridasio
