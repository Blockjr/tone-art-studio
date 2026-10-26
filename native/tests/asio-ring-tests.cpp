// Headless checks for the virtual ASIO shared-memory ring protocol.
//
// HybridAsioShared.h is the whole contract between HybridVirtualAsio.dll (a COM
// server living inside some other DAW's process) and Tone Art Studio. It needs no
// Windows, no JUCE and no audio hardware, so unlike "does audio reach a real
// host", the ring maths itself can be checked anywhere - and a defect here is
// silent: the device registers, the host opens it, and the audio is wrong.
//
// Run with ./build-tests.sh (Linux/macOS) or compile this file with MSVC.
// native-core.yml runs it on every change to the protocol.

#include "../Source/HybridAsioShared.h"

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

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

void checkEqual (std::uint64_t actual, std::uint64_t expected, const std::string& what)
{
    check (actual == expected,
           what + " (expected " + std::to_string (expected) + ", got " + std::to_string (actual) + ")");
}

void checkNear (float actual, float expected, const std::string& what)
{
    check (actual == expected,
           what + " (expected " + std::to_string (expected) + ", got " + std::to_string (actual) + ")");
}

using hybridasio::Block;
using hybridasio::Ring;
using hybridasio::ringFrames;

/** A 2 MiB Block does not belong on the stack. */
std::unique_ptr<Block> makeBlock()
{
    return std::make_unique<Block>();
}

/** The producer's signal: exactly representable in float, so comparison is exact. */
float expectedSample (std::uint64_t frame, std::uint32_t channel)
{
    return (float) ((frame * 2u + channel) % 4096u);
}

/** Fills an interleaved stereo buffer with the producer's signal starting at `frame`. */
std::vector<float> signalBlock (std::uint64_t frame, std::uint32_t frames)
{
    std::vector<float> buffer ((size_t) frames * 2u);

    for (std::uint32_t i = 0; i < frames; ++i)
        for (std::uint32_t channel = 0; channel < 2u; ++channel)
            buffer[(size_t) i * 2u + channel] = expectedSample (frame + i, channel);

    return buffer;
}

//==============================================================================
void testEmptyRingIsSilent()
{
    auto block = makeBlock();
    Ring& ring = block->toStudio;

    checkEqual (hybridasio::framesAvailable (ring), 0, "a fresh ring holds nothing");

    std::vector<float> out (256, 1.0f);
    checkEqual (hybridasio::pop (ring, out.data(), 128), 0, "popping an empty ring returns nothing");
    checkNear (out[0], 0.0f, "an underrun is silent, not stale data");
    checkNear (out[255], 0.0f, "the whole shortfall is zero-filled");
    checkEqual (ring.underruns.load(), 1, "one short read counts one underrun");
    checkEqual (ring.overruns.load(), 0, "a read never counts as an overrun");
    checkEqual (ring.writeIndex.load(), 0, "an unread ring advanced no write index");
    checkEqual (ring.readIndex.load(), 0, "a failed read leaves the read index alone");
}

void testRoundTripIsExact()
{
    auto block = makeBlock();
    Ring& ring = block->toStudio;

    const auto sent = signalBlock (0, 512);
    checkEqual (hybridasio::push (ring, sent.data(), 512), 512, "a push into an empty ring writes every frame");
    checkEqual (hybridasio::framesAvailable (ring), 512, "the ring reports what was queued");
    checkEqual (ring.overruns.load(), 0, "a clean push is not an overrun");

    std::vector<float> got (1024, 0.0f);
    checkEqual (hybridasio::pop (ring, got.data(), 512), 512, "a pop returns every queued frame");
    checkEqual (ring.underruns.load(), 0, "a clean read is not an underrun");
    checkEqual (hybridasio::framesAvailable (ring), 0, "the ring empties after a full read");

    for (std::uint32_t i = 0; i < 512u; ++i)
    {
        checkNear (got[(size_t) i * 2u], expectedSample (i, 0), "left channel survives the round trip");
        checkNear (got[(size_t) i * 2u + 1u], expectedSample (i, 1), "right channel survives the round trip");
    }

    // Channel 0 never carries channel 1's value, so a broken interleave cannot pass above.
    checkNear (got[0], expectedSample (0, 0), "frame 0 left is the producer's left");
    checkNear (got[1], expectedSample (0, 1), "frame 0 right is the producer's right");
}

void testFullRingDropsAndCounts()
{
    auto block = makeBlock();
    Ring& ring = block->toClient;

    const auto full = signalBlock (0, ringFrames);
    checkEqual (hybridasio::push (ring, full.data(), ringFrames), ringFrames, "the ring can be filled exactly");
    checkEqual (hybridasio::framesAvailable (ring), ringFrames, "a full ring reports its full depth");
    checkEqual (ring.overruns.load(), 0, "filling the ring exactly is not an overrun");

    // A full ring must never overwrite unread audio, and must not open a gap.
    const auto extra = signalBlock (ringFrames, 256);
    const auto before = ring.writeIndex.load();
    checkEqual (hybridasio::push (ring, extra.data(), 256), 0, "a full ring accepts nothing");
    checkEqual (ring.writeIndex.load(), before, "a rejected push does not move the write index");
    checkEqual (ring.overruns.load(), 1, "a rejected push counts one overrun");
    checkEqual (hybridasio::framesAvailable (ring), ringFrames, "a rejected push does not change depth");

    // Freeing room lets exactly that much through, and no more.
    std::vector<float> out (1024, 0.0f);
    checkEqual (hybridasio::pop (ring, out.data(), 100), 100, "a partial drain frees the room it takes");

    const auto partial = signalBlock (ringFrames, 250);
    checkEqual (hybridasio::push (ring, partial.data(), 250), 100, "a push into the freed room writes only what fits");
    checkEqual (ring.overruns.load(), 2, "a short write counts an overrun");
    checkEqual (hybridasio::framesAvailable (ring), ringFrames, "the ring is full again");
}

void testWraparoundKeepsContinuity()
{
    auto block = makeBlock();
    Ring& ring = block->toStudio;

    // Neither size divides the ring depth, and the read is split unevenly, so most
    // blocks straddle a wrap and the split points land all over the ring.
    constexpr std::uint32_t sendFrames = 1000;
    constexpr std::uint32_t readChunk = 411;   // 411 + 411 + 178 = 1000
    constexpr std::uint32_t passes = 400;      // ~12 turns of the ring

    std::uint64_t produced = 0;
    std::uint64_t consumed = 0;

    for (std::uint32_t pass = 0; pass < passes; ++pass)
    {
        const auto sent = signalBlock (produced, sendFrames);
        checkEqual (hybridasio::push (ring, sent.data(), sendFrames), sendFrames,
                    "a balanced producer always finds room in the wraparound run");
        produced += sendFrames;

        // The consumer keeps pace, so the backlog returns to zero every pass and
        // the ring depth is exercised by the indices wrapping, not by filling up.
        for (std::uint32_t left = sendFrames; left > 0u; )
        {
            const auto chunk = left < readChunk ? left : readChunk;
            left -= chunk;

            std::vector<float> got ((size_t) chunk * 2u);
            const auto read = hybridasio::pop (ring, got.data(), chunk);
            checkEqual (read, chunk, "a balanced consumer always has work in the wraparound run");

            for (std::uint32_t i = 0; i < chunk; ++i)
            {
                if (got[(size_t) i * 2u] != expectedSample (consumed + i, 0)
                    || got[(size_t) i * 2u + 1u] != expectedSample (consumed + i, 1))
                {
                    check (false, "frame " + std::to_string (consumed + i) + " came back corrupted across the wrap");
                    std::printf ("  ... first bad frame at consumer offset %u of the run\n", i);
                    return;   // one report per run; the rest would be noise
                }
            }

            consumed += chunk;
        }
    }

    check (produced > 2u * ringFrames, "the run really did wrap the indices more than once");
    checkEqual (produced, consumed + hybridasio::framesAvailable (ring),
                "queued audio accounts for every frame the producer wrote");
    checkEqual (ring.readIndex.load(), consumed, "the read index is the frames actually read");
}

void testResetRingDiscardsWithoutCorrupting()
{
    auto block = makeBlock();
    Ring& ring = block->toStudio;

    const auto stale = signalBlock (0, 4096);
    hybridasio::push (ring, stale.data(), 4096);
    std::vector<float> drained (2048, 0.0f);
    hybridasio::pop (ring, drained.data(), 1024);   // leave a partial backlog

    check (hybridasio::framesAvailable (ring) > 0, "there is a backlog to discard");

    hybridasio::resetRing (ring);

    checkEqual (hybridasio::framesAvailable (ring), 0, "a reset discards the backlog");
    checkEqual (ring.writeIndex.load(), 4096, "a reset keeps the producer's position");
    checkEqual (ring.readIndex.load(), 4096, "a reset fast-forwards the consumer to the producer");
    checkEqual (ring.overruns.load(), 0, "a reset clears overruns");
    checkEqual (ring.underruns.load(), 0, "a reset clears underruns");

    // A fresh reading on top of a stale mapping must still be sample-exact.
    const auto fresh = signalBlock (900000, 2048);
    checkEqual (hybridasio::push (ring, fresh.data(), 2048), 2048, "the ring is usable straight after a reset");

    std::vector<float> got (4096, 0.0f);
    checkEqual (hybridasio::pop (ring, got.data(), 2048), 2048, "the post-reset audio comes back whole");
    checkNear (got[0], expectedSample (900000, 0), "a reset does not shift the signal");
    checkNear (got[2], expectedSample (900001, 0), "the second post-reset frame is still aligned");
}

/** A deterministic LCG: the same run fails the same way every time. */
struct Lcg
{
    std::uint32_t next (std::uint32_t range)
    {
        state = state * 1664525u + 1013904223u;
        return range == 0u ? 0u : (state >> 8) % range;
    }

    std::uint32_t state = 0x5eed1234u;
};

void testRandomisedStreamMatchesAReferenceModel()
{
    auto block = makeBlock();
    Ring& ring = block->toStudio;
    Lcg rng;

    // The oracle: exactly the frames a correct FIFO of ringFrames depth would hold.
    std::vector<float> reference;

    std::uint64_t produced = 0;
    std::uint64_t consumed = 0;

    for (int step = 0; step < 4000; ++step)
    {
        const bool produce = rng.next (100) < 55;

        if (produce)
        {
            const auto requested = rng.next (900) + 1u;
            const auto space = ringFrames - hybridasio::framesAvailable (ring);
            const auto acceptable = requested < space ? requested : space;
            const auto sent = signalBlock (produced, requested);

            const auto wrote = hybridasio::push (ring, sent.data(), requested);
            checkEqual (wrote, acceptable, "push writes exactly the room available");

            for (std::uint32_t i = 0; i < wrote; ++i)
            {
                reference.push_back (expectedSample (produced + i, 0));
                reference.push_back (expectedSample (produced + i, 1));
            }

            produced += wrote;
        }
        else
        {
            const auto requested = rng.next (900) + 1u;
            const auto available = hybridasio::framesAvailable (ring);
            const auto expectedFilled = requested < available ? requested : available;

            std::vector<float> got ((size_t) requested * 2u, -1.0f);
            const auto read = hybridasio::pop (ring, got.data(), requested);
            checkEqual (read, expectedFilled, "pop fills exactly what was queued");

            for (std::uint32_t i = 0; i < expectedFilled; ++i)
            {
                checkNear (got[(size_t) i * 2u], reference[(size_t) i * 2u], "the left channel matches the reference FIFO");
                checkNear (got[(size_t) i * 2u + 1u], reference[(size_t) i * 2u + 1u], "the right channel matches the reference FIFO");
            }

            for (std::uint32_t i = expectedFilled; i < requested; ++i)
            {
                checkNear (got[(size_t) i * 2u], 0.0f, "the popped shortfall is silence");
                checkNear (got[(size_t) i * 2u + 1u], 0.0f, "both channels of the shortfall are silence");
            }

            reference.erase (reference.begin(), reference.begin() + (long) expectedFilled * 2L);
            // pop advances the read index by what it found, not by what was asked
            // for: the zero-fill that covers a shortfall is not consumed audio.
            consumed += expectedFilled;
        }

        checkEqual (hybridasio::framesAvailable (ring), reference.size() / 2u,
                    "the ring's own accounting matches the reference FIFO");
        check (hybridasio::framesAvailable (ring) <= ringFrames, "the ring never over-reports its depth");
        checkEqual (ring.writeIndex.load(), produced, "the write index is the producer's running total");
        checkEqual (ring.readIndex.load(), consumed, "the read index is the consumer's running total");
    }

    check (produced > 100000u, "the randomised run moved enough audio to be meaningful");
    checkEqual (hybridasio::framesAvailable (ring), reference.size() / 2u,
                "the run ends with the reference and the ring still agreeing");
}

void testTheTwoRingsAreIndependent()
{
    auto block = makeBlock();

    // The driver produces toStudio and consumes toClient; the studio is the mirror.
    // Both must be able to move audio at once without touching each other's state.
    const auto forStudio = signalBlock (10, 300);
    const auto forClient = signalBlock (7000, 400);

    checkEqual (hybridasio::push (block->toStudio, forStudio.data(), 300), 300, "the studio ring accepts audio");
    checkEqual (hybridasio::push (block->toClient, forClient.data(), 400), 400, "the client ring accepts audio");

    std::vector<float> studio (1024, 0.0f);
    checkEqual (hybridasio::pop (block->toStudio, studio.data(), 300), 300, "the studio ring drains");
    checkNear (studio[0], expectedSample (10, 0), "the studio ring carries its own signal");

    std::vector<float> client (1024, 0.0f);
    checkEqual (hybridasio::pop (block->toClient, client.data(), 400), 400, "the client ring drains");
    checkNear (client[0], expectedSample (7000, 0), "the client ring carries its own signal");

    checkEqual (hybridasio::framesAvailable (block->toStudio), 0, "draining one ring leaves the other alone");
    checkEqual (hybridasio::framesAvailable (block->toClient), 0, "both rings are independent");

    hybridasio::resetRing (block->toStudio);
    checkEqual (block->toClient.readIndex.load(), 400, "resetting one ring does not move the other");
}

void testProtocolVersionAndLayoutAreStable()
{
    // These two constants are baked into a DLL that lives in other people's
    // processes. Changing either without republishing both sides breaks every
    // installed host, so the values are pinned here on purpose.
    checkEqual (hybridasio::protocolVersion, 1u, "the protocol version only moves with a deliberate bump");
    checkEqual (hybridasio::magicValue, 0x48534131u, "the magic value stays HSA1");
    checkEqual (hybridasio::channelCount, 2u, "the protocol is stereo");
    checkEqual (hybridasio::ringFrames, 32768u, "the ring depth is part of the contract");
    checkEqual (hybridasio::ringMask, 32767u, "the mask matches the depth");
    check (hybridasio::ringMask == hybridasio::ringFrames - 1u, "the mask is depth minus one (a power of two)");

    // The layout is load-bearing: a DLL built from a different header must map
    // the same bytes. Padding is the compiler's business, but the field order and
    // the two rings' offsets are not.
    auto block = makeBlock();
    const auto* base = reinterpret_cast<const char*> (block.get());
    const auto studioOffset = (std::ptrdiff_t) (reinterpret_cast<const char*> (&block->toStudio) - base);
    const auto clientOffset = (std::ptrdiff_t) (reinterpret_cast<const char*> (&block->toClient) - base);

    check (clientOffset == studioOffset + (std::ptrdiff_t) sizeof (Ring),
           "the client ring starts exactly one Ring after the studio ring");
    check (studioOffset >= (std::ptrdiff_t) (7u * sizeof (std::uint32_t) + sizeof (std::uint64_t)),
           "all seven header fields precede the rings");

    block->toClient.samples[0] = 1.0f;
    checkNear (block->toStudio.samples[0], 0.0f, "the two rings do not overlap in the mapping");
    checkNear (block->toClient.samples[0], 1.0f, "the client ring holds its own samples");
    checkNear (block->toClient.samples[hybridasio::ringFrames * 2u - 1u], 0.0f,
               "the last frame of the client ring is still inside the mapping");
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
        { "empty ring is silent", testEmptyRingIsSilent },
        { "round trip is sample exact", testRoundTripIsExact },
        { "full ring drops and counts", testFullRingDropsAndCounts },
        { "wraparound keeps continuity", testWraparoundKeepsContinuity },
        { "reset discards without corrupting", testResetRingDiscardsWithoutCorrupting },
        { "randomised stream matches a reference model", testRandomisedStreamMatchesAReferenceModel },
        { "the two rings are independent", testTheTwoRingsAreIndependent },
        { "protocol version and layout are stable", testProtocolVersionAndLayoutAreStable },
    };

    for (const auto& test : tests)
    {
        std::printf ("%s\n", test.name);
        test.run();
    }

    std::printf ("\n%d checks, %d failure%s\n", checks, failures, failures == 1 ? "" : "s");
    return failures == 0 ? 0 : 1;
}
