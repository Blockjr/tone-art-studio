/*
    Tone Art Virtual ASIO bridge self-test.

    Registering the driver and creating it proves the COM plumbing and nothing
    else: a device can appear in every DAW, open without complaint and still be
    an empty pipe. What is actually hard to get right is the bridge - the shared
    block, the two rings, the block bookkeeping and the direction of flow between
    the studio and an ASIO host - and that used to need two applications, a sound
    card and a human listening.

    It does not. This program is the second application. It loads the driver the
    way an ASIO host does (through DllGetClassObject, so no registration and no
    administrator rights are involved), then plays the studio's half of the
    protocol against it in the same process:

        our 440 Hz master  ->  toClient ring  ->  driver's inputs
        driver's outputs   ->  toStudio ring  ->  our recorder

    If the audio comes back bit-identical in both directions, the bridge works,
    and the only thing left that needs real hardware is a physical sound card.

    Exit code 0 means every check passed. Run it by hand from the folder holding
    HybridVirtualAsio.dll, or point it at one:

        ToneArtVirtualAsioTest.exe
        ToneArtVirtualAsioTest.exe --pause
        ToneArtVirtualAsioTest.exe C:\path\to\HybridVirtualAsio.dll
*/

#include <windows.h>
#include <objbase.h>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// iasiodrv.h declares `interface IASIO : public IUnknown`. Neither the
// `interface` macro nor IUnknown comes from windows.h, so COM's header has to be
// in front of the SDK or every member reads as a syntax error. Same order as
// VirtualAsioDriver.h.
#ifndef interface
 #define interface struct
#endif

#include "iasiodrv.h"
#include "VirtualAsioIds.h"
#include "../Source/HybridAsioShared.h"

namespace
{
constexpr double kPi = 3.14159265358979323846;
constexpr double kMasterFrequency = 440.0;      // what the "studio" plays
constexpr double kLoopbackFrequency = 330.0;    // what the "host" records back

int checks = 0;
int failures = 0;
bool pauseAtEnd = false;

//==============================================================================
void check (bool passed, const char* what)
{
    ++checks;

    if (passed)
    {
        std::printf ("  ok    %s\n", what);
    }
    else
    {
        ++failures;
        std::printf ("  FAIL  %s\n", what);
    }
}

void checkLong (long actual, long expected, const char* what)
{
    ++checks;

    if (actual == expected)
    {
        std::printf ("  ok    %s (%ld)\n", what, actual);
    }
    else
    {
        ++failures;
        std::printf ("  FAIL  %s: expected %ld, got %ld\n", what, expected, actual);
    }
}

void checkNumber (long long actual, long long expected, const char* what)
{
    ++checks;

    if (actual == expected)
    {
        std::printf ("  ok    %s (%lld)\n", what, actual);
    }
    else
    {
        ++failures;
        std::printf ("  FAIL  %s: expected %lld, got %lld\n", what, expected, actual);
    }
}

void checkText (const char* actual, const char* expected, const char* what)
{
    ++checks;

    if (std::strncmp (actual, expected, 31) == 0)
    {
        std::printf ("  ok    %s (\"%s\")\n", what, actual);
    }
    else
    {
        ++failures;
        std::printf ("  FAIL  %s: expected \"%s\", got \"%s\"\n", what, expected, actual);
    }
}

/** Index of the first differing sample, or -1 when the two are bit-identical. */
int firstDifference (const std::vector<float>& left, const std::vector<float>& right)
{
    const auto count = left.size() < right.size() ? left.size() : right.size();

    for (std::size_t i = 0; i < count; ++i)
        if (std::memcmp (&left[i], &right[i], sizeof (float)) != 0)
            return (int) i;

    return left.size() == right.size() ? -1 : (int) count;
}

void checkBlock (const std::vector<float>& actual,
                 const std::vector<float>& expected,
                 const char* what)
{
    ++checks;
    const auto difference = firstDifference (actual, expected);

    if (difference < 0)
    {
        std::printf ("  ok    %s (%zu samples, bit-identical)\n", what, actual.size());
    }
    else
    {
        ++failures;

        const auto index = difference < (int) actual.size() ? (std::size_t) difference : actual.size();
        const auto got = index < actual.size() ? actual[index] : 0.0f;
        const auto wanted = index < expected.size() ? expected[index] : 0.0f;

        std::printf ("  FAIL  %s: sample %d of %zu is %.9g, expected %.9g\n",
                     what, difference, actual.size(), (double) got, (double) wanted);
    }
}

void checkCount (const std::vector<std::vector<float>>& blocks,
                 std::size_t expected,
                 const char* what)
{
    ++checks;

    if (blocks.size() == expected)
    {
        std::printf ("  ok    %s (%zu blocks)\n", what, blocks.size());
    }
    else
    {
        ++failures;
        std::printf ("  FAIL  %s: expected %zu blocks, got %zu\n", what, expected, blocks.size());
    }
}

/** One block of a stereo sine, with the right channel inverted so a swapped
    channel cannot pass unnoticed. */
void makeBlock (std::vector<float>& out,
                double frequency,
                double amplitude,
                double startFrame,
                double sampleRate,
                long frames)
{
    out.resize ((std::size_t) frames * 2);

    for (long frame = 0; frame < frames; ++frame)
    {
        const auto value = (float) (amplitude * std::sin (2.0 * kPi * frequency
                                                          * (startFrame + (double) frame) / sampleRate));

        out[(std::size_t) frame * 2] = value;
        out[(std::size_t) frame * 2 + 1] = -value;
    }
}

//==============================================================================
/** The studio's view of the shared block. */
struct SharedBlock
{
    hybridasio::Block* block = nullptr;
    HANDLE handle = nullptr;

    bool open()
    {
        if (block != nullptr)
            return true;

        handle = OpenFileMappingA (FILE_MAP_ALL_ACCESS, FALSE, hybridasio::sharedMemoryName);

        if (handle == nullptr)
            return false;

        block = static_cast<hybridasio::Block*> (MapViewOfFile (handle, FILE_MAP_ALL_ACCESS, 0, 0,
                                                               sizeof (hybridasio::Block)));

        if (block == nullptr)
        {
            close();
            return false;
        }

        return true;
    }

    void close()
    {
        if (block != nullptr)
        {
            UnmapViewOfFile (block);
            block = nullptr;
        }

        if (handle != nullptr)
        {
            CloseHandle (handle);
            handle = nullptr;
        }
    }
};

/** One ASIO session: the buffers a host hands over, plus everything the bridge
    carried while it ran. */
struct Session
{
    SharedBlock shared;
    double rate = 48000.0;
    long frames = 0;
    int wantedBlocks = 0;

    ASIOBufferInfo infos[4] {};
    ASIOCallbacks callbacks {};

    std::atomic<int> blocks { 0 };
    std::atomic<int> legacyBlocks { 0 };

    std::vector<std::vector<float>> heard;    // driver inputs, per block
    std::vector<std::vector<float>> master;   // what we published, per block
    std::vector<std::vector<float>> played;   // what we wrote to the outputs, per block

    /** Runs on the driver's audio thread, once per block. */
    void onBlock (long doubleBufferIndex)
    {
        const int block = blocks.fetch_add (1);
        const auto half = doubleBufferIndex != 0 ? 1 : 0;

        // 1. The driver has already popped the toClient ring: what it hands us as
        //    input is the studio master published during the previous block.
        std::vector<float> inBlock ((std::size_t) frames * 2, 0.0f);

        for (int channel = 0; channel < 2; ++channel)
        {
            const auto* source = static_cast<const float*> (infos[(std::size_t) channel].buffers[half]);

            if (source == nullptr)
                continue;

            for (long frame = 0; frame < frames; ++frame)
                inBlock[(std::size_t) frame * 2 + (std::size_t) channel] = source[frame];
        }

        heard.push_back (std::move (inBlock));

        // 2. Publish the studio master for the driver's next block. The amplitude
        //    changes per block so a reordered or repeated block stands out.
        std::vector<float> masterBlock;
        makeBlock (masterBlock, kMasterFrequency, 0.6, (double) block * (double) frames, rate, frames);
        master.push_back (masterBlock);

        if (shared.block != nullptr)
            hybridasio::push (shared.block->toClient, masterBlock.data(), (std::uint32_t) frames);

        // 3. Fill the device's outputs for this block; the driver pushes them into
        //    the toStudio ring as soon as we return.
        std::vector<float> playedBlock;
        makeBlock (playedBlock, kLoopbackFrequency, 0.1 + 0.05 * (double) block,
                   (double) block * (double) frames, rate, frames);
        played.push_back (playedBlock);

        for (int channel = 0; channel < 2; ++channel)
        {
            auto* destination = static_cast<float*> (infos[(std::size_t) (2 + channel)].buffers[half]);

            if (destination == nullptr)
                continue;

            for (long frame = 0; frame < frames; ++frame)
                destination[frame] = playedBlock[(std::size_t) frame * 2 + (std::size_t) channel];
        }
    }

    void prepareInfos()
    {
        for (long channel = 0; channel < 2; ++channel)
        {
            infos[(std::size_t) channel].isInput = ASIOTrue;
            infos[(std::size_t) channel].channelNum = channel;
            infos[(std::size_t) channel].buffers[0] = nullptr;
            infos[(std::size_t) channel].buffers[1] = nullptr;

            infos[(std::size_t) (2 + channel)].isInput = ASIOFalse;
            infos[(std::size_t) (2 + channel)].channelNum = channel;
            infos[(std::size_t) (2 + channel)].buffers[0] = nullptr;
            infos[(std::size_t) (2 + channel)].buffers[1] = nullptr;
        }

        callbacks.bufferSwitch = &Session::onLegacyBufferSwitch;
        callbacks.sampleRateDidChange = &Session::onSampleRateDidChange;
        callbacks.asioMessage = &Session::onAsioMessage;
        callbacks.bufferSwitchTimeInfo = &Session::onBufferSwitchTimeInfo;
    }

    static void onLegacyBufferSwitch (long, ASIOBool);
    static void onSampleRateDidChange (ASIOSampleRate);
    static long onAsioMessage (long selector, long, void*, double*);
    static ASIOTime* onBufferSwitchTimeInfo (ASIOTime*, long doubleBufferIndex, ASIOBool);

    /** Waits for the driver to have rendered at least `wantedBlocks` blocks. */
    int waitForBlocks()
    {
        const auto deadline = GetTickCount64() + 15000;

        while (blocks.load() < wantedBlocks && GetTickCount64() < deadline)
            Sleep (2);

        return blocks.load();
    }
};

// ASIO callbacks carry no user data, so the session under test is reached
// through this. Only one session runs at a time.
Session* activeSession = nullptr;

// The driver calls bufferSwitchTimeInfo; bufferSwitch is counted only so that a
// driver which silently fell back to the old callback is caught instead of
// looking like a hang.
void Session::onLegacyBufferSwitch (long, ASIOBool)
{
    if (activeSession != nullptr)
        activeSession->legacyBlocks.fetch_add (1);
}

void Session::onSampleRateDidChange (ASIOSampleRate) {}

long Session::onAsioMessage (long selector, long, void*, double*)
{
    return selector == kAsioSelectorSupported ? kAsioSupportsTimeInfo : 0;
}

ASIOTime* Session::onBufferSwitchTimeInfo (ASIOTime*, long doubleBufferIndex, ASIOBool)
{
    if (activeSession != nullptr)
        activeSession->onBlock (doubleBufferIndex);

    return nullptr;
}

//==============================================================================
using GetClassObjectFn = HRESULT (__stdcall*) (REFCLSID, REFIID, void**);

std::wstring moduleDirectory()
{
    std::vector<wchar_t> buffer (MAX_PATH * 4);

    while (true)
    {
        const auto length = GetModuleFileNameW (nullptr, buffer.data(), (DWORD) buffer.size());

        if (length == 0)
            return {};

        if ((std::size_t) length < buffer.size() - 1)
        {
            std::wstring path (buffer.data(), (std::size_t) length);
            const auto slash = path.find_last_of (L'\\');

            return slash == std::wstring::npos ? std::wstring {} : path.substr (0, slash);
        }

        buffer.resize (buffer.size() * 2);
    }
}

std::wstring fromUtf8 (const std::string& text)
{
    if (text.empty())
        return {};

    const auto size = MultiByteToWideChar (CP_UTF8, 0, text.c_str(), (int) text.size(), nullptr, 0);

    if (size <= 0)
        return {};

    std::wstring out ((std::size_t) size, L'\0');
    MultiByteToWideChar (CP_UTF8, 0, text.c_str(), (int) text.size(), out.data(), size);
    return out;
}

std::string toUtf8 (const std::wstring& text)
{
    if (text.empty())
        return {};

    const auto size = WideCharToMultiByte (CP_UTF8, 0, text.c_str(), (int) text.size(),
                                           nullptr, 0, nullptr, nullptr);

    if (size <= 0)
        return {};

    std::string out ((std::size_t) size, '\0');

    if (WideCharToMultiByte (CP_UTF8, 0, text.c_str(), (int) text.size(),
                             out.data(), size, nullptr, nullptr) <= 0)
        return {};

    return out;
}

//==============================================================================
/** Everything that needs no running driver: the queries an ASIO host makes while
    the user is still picking the device. */
void auditQueries (IASIO* driver)
{
    std::printf ("device queries\n");

    char name[64] {};
    driver->getDriverName (name);
    checkText (name, "Tone Art Virtual ASIO", "the driver reports its name");

    checkLong (driver->getDriverVersion(), (2L << 16) | 3L, "the driver reports ASIO 2.3");

    // ASIODriverInfo carries 124 bytes for the error message, so that is what a
    // host hands over, and the whole message has to survive it.
    char error[124] {};
    driver->getErrorMessage (error);
    check (std::strstr (error, "Tone Art Studio") != nullptr,
           "the error message survives intact and names the studio to start");

    long inputs = -1;
    long outputs = -1;
    checkLong (driver->getChannels (&inputs, &outputs), ASE_OK, "getChannels succeeds");
    checkLong (inputs, 2, "two input channels");
    checkLong (outputs, 2, "two output channels");

    long minSize = 0;
    long maxSize = 0;
    long preferred = 0;
    long granularity = -1;
    checkLong (driver->getBufferSize (&minSize, &maxSize, &preferred, &granularity), ASE_OK,
               "getBufferSize succeeds");
    checkLong (minSize, 64, "smallest block");
    checkLong (maxSize, 2048, "largest block");
    checkLong (preferred, 512, "preferred block");
    checkLong (granularity, 0, "the block size is not constrained to a granularity");

    long inputLatency = 0;
    long outputLatency = 0;
    checkLong (driver->getLatencies (&inputLatency, &outputLatency), ASE_OK, "getLatencies succeeds");
    check (inputLatency > 0 && outputLatency > 0, "both latencies are non-zero");

    const double supported[] { 44100.0, 48000.0, 88200.0, 96000.0, 176400.0, 192000.0 };

    for (const auto rate : supported)
        checkLong (driver->canSampleRate (rate), ASE_OK, "a standard sample rate is accepted");

    checkLong (driver->canSampleRate (12345.0), ASE_NoClock, "an impossible sample rate is refused");

    ASIOSampleRate rate = 0.0;
    checkLong (driver->getSampleRate (&rate), ASE_OK, "getSampleRate succeeds");
    check (rate == 44100.0, "the device starts at 44100");

    checkLong (driver->setSampleRate (12345.0), ASE_NoClock, "setSampleRate refuses an impossible rate");
    checkLong (driver->setSampleRate (48000.0), ASE_OK, "setSampleRate accepts a supported rate");
    checkLong (driver->getSampleRate (&rate), ASE_OK, "getSampleRate succeeds after a change");
    check (rate == 48000.0, "the new sample rate is in effect");
    checkLong (driver->setSampleRate (44100.0), ASE_OK, "the sample rate can be set back");

    ASIOClockSource clock {};
    long sources = 0;
    checkLong (driver->getClockSources (&clock, &sources), ASE_OK, "getClockSources succeeds");
    checkLong (sources, 1, "the device has one clock source");
    checkText (clock.name, "Internal", "the clock source is the internal clock");
    check (clock.isCurrentSource == ASIOTrue, "the internal clock is the current source");
    checkLong (driver->setClockSource (0), ASE_OK, "the internal clock can be selected");
    checkLong (driver->setClockSource (7), ASE_InvalidParameter, "an unknown clock is refused");

    ASIOChannelInfo info {};
    info.channel = -1;
    checkLong (driver->getChannelInfo (&info), ASE_InvalidParameter, "channel -1 is refused");
    info.channel = 3;
    checkLong (driver->getChannelInfo (&info), ASE_InvalidParameter, "channel 3 does not exist");

    info.channel = 0;
    info.isInput = ASIOTrue;
    checkLong (driver->getChannelInfo (&info), ASE_OK, "input channel 0 can be described");
    checkText (info.name, "Tone Art Virtual In L", "input channel 0 has a name");
    checkLong (info.type, ASIOSTFloat32LSB, "input channel 0 is 32-bit float");
    check (info.isActive == ASIOFalse, "no channel is active before buffers are created");

    info.channel = 1;
    info.isInput = ASIOFalse;
    checkLong (driver->getChannelInfo (&info), ASE_OK, "output channel 1 can be described");
    checkText (info.name, "Tone Art Virtual Out R", "output channel 1 has a name");
    checkLong (info.type, ASIOSTFloat32LSB, "output channel 1 is 32-bit float");

    checkLong (driver->outputReady(), ASE_OK, "outputReady succeeds");
    checkLong (driver->future (0, nullptr), ASE_NotPresent, "an unsupported future selector is refused");

    ASIOSamples samples {};
    ASIOTimeStamp stamp {};
    checkLong (driver->getSamplePosition (&samples, &stamp), ASE_OK, "getSamplePosition succeeds");
}

/** One complete start-to-stop session at a given rate and block size, ending with
    every byte that crossed the bridge accounted for. */
void auditSession (IASIO* driver, double rate, long frames, int wantedBlocks, const char* label)
{
    std::printf ("%s: %.0f Hz, %ld frames\n", label, rate, frames);

    Session session;
    session.rate = rate;
    session.frames = frames;
    session.wantedBlocks = wantedBlocks;
    session.prepareInfos();

    activeSession = &session;

    // The studio side of the handshake: the driver created the block when it was
    // initialised, so this is an open, not a create.
    check (session.shared.open(), "the studio can open the driver's shared block");

    if (session.shared.block == nullptr)
    {
        activeSession = nullptr;
        return;
    }

    check (session.shared.block->magic.load() == hybridasio::magicValue,
           "the shared block carries the expected magic");
    checkLong ((long) session.shared.block->version.load(), (long) hybridasio::protocolVersion,
               "the shared block carries the expected protocol version");
    checkLong ((long) session.shared.block->channels.load(), 2, "the shared block is stereo");

    // Only the studio may claim the studio is online. A driver that sets this
    // itself would tell the UI a studio was attached when none is.
    check (session.shared.block->studioOnline.load() == 0,
           "the driver does not claim the studio is online");

    session.shared.block->studioOnline.store (1);

    // A session cannot start before the host has handed over buffers.
    checkLong (driver->start(), ASE_InvalidMode, "start before createBuffers is refused");

    // A host picks the rate while the device is stopped. The second session runs
    // at a different rate and block size on purpose: reconfiguring is where a
    // stale ring or an un-republished header would show up.
    checkLong (driver->setSampleRate (rate), ASE_OK, "the session's sample rate is accepted");

    checkLong (driver->createBuffers (session.infos, 4, frames, &session.callbacks), ASE_OK,
               "createBuffers succeeds");

    bool buffersValid = true;

    for (int channel = 0; channel < 4; ++channel)
        if (session.infos[(std::size_t) channel].buffers[0] == nullptr
            || session.infos[(std::size_t) channel].buffers[1] == nullptr)
            buffersValid = false;

    check (buffersValid, "every channel gets both halves of its double buffer");
    check (session.infos[0].buffers[0] != session.infos[0].buffers[1],
           "the two halves of a double buffer are different memory");

    ASIOChannelInfo info {};
    info.channel = 0;
    info.isInput = ASIOTrue;
    driver->getChannelInfo (&info);
    check (info.isActive == ASIOTrue, "the channel is active once buffers exist");

    checkLong (driver->start(), ASE_OK, "start succeeds");

    check (session.shared.block->driverOnline.load() == 1, "the driver reports itself online");
    checkLong ((long) session.shared.block->sampleRate.load(), (long) rate,
               "the driver publishes its sample rate to the studio");
    checkLong ((long) session.shared.block->blockSize.load(), frames,
               "the driver publishes its block size to the studio");

    // Reconfiguring a running device has to be refused: a host that swapped the
    // block size mid-stream would desynchronise the rings silently.
    checkLong (driver->setSampleRate (44100.0), ASE_InvalidMode,
               "the sample rate cannot change while running");
    checkLong (driver->createBuffers (session.infos, 4, frames, &session.callbacks), ASE_InvalidMode,
               "buffers cannot be recreated while running");

    const auto seen = session.waitForBlocks();

    check (seen >= wantedBlocks, "the driver rendered the blocks it was asked for");

    check (session.legacyBlocks.load() == 0, "the driver uses the time-info callback");

    checkLong (driver->stop(), ASE_OK, "stop succeeds");
    check (session.shared.block->driverOnline.load() == 0, "the driver reports itself offline once stopped");

    const int total = session.blocks.load();

    std::printf ("  ..    %d blocks, %ld frames each, %ld frames of audio\n",
                 total, frames, (long) total * frames);

    checkCount (session.heard, (std::size_t) total, "every rendered block reached the host");
    checkCount (session.master, (std::size_t) total, "the studio published a block for every block");
    checkCount (session.played, (std::size_t) total, "the host filled every output block");

    // ---------------------------------------------------------------- studio -> host
    // The driver pops the toClient ring before it calls us, so block n hands over
    // the master published during block n-1, and the first block has nothing
    // behind it but silence.
    std::vector<float> silence ((std::size_t) frames * 2, 0.0f);

    for (int block = 0; block < total; ++block)
    {
        const auto& expected = block == 0 ? silence : session.master[(std::size_t) (block - 1)];

        checkBlock (session.heard[(std::size_t) block], expected,
                    block == 0 ? "the first block of driver input is silence"
                               : "driver input carries the studio master");
    }

    // ----------------------------------------------------------------- host -> studio
    std::vector<float> expectedLoopback;

    for (const auto& block : session.played)
        expectedLoopback.insert (expectedLoopback.end(), block.begin(), block.end());

    const auto queued = (long) hybridasio::framesAvailable (session.shared.block->toStudio);

    checkLong (queued, (long) total * frames, "the studio has exactly as much audio as the host played");

    // Counters first: the drain below is the first read of this ring, so an
    // underrun here would be the test's own doing.
    checkLong ((long) session.shared.block->toStudio.overruns.load(), 0,
               "the studio's input ring never overflowed");
    checkLong ((long) session.shared.block->toStudio.underruns.load(), 0,
               "the studio's input ring never starved");

    // The first block could not have been played before the host had it, so the
    // studio's output ring starves exactly once per session.
    checkLong ((long) session.shared.block->toClient.overruns.load(), 0,
               "the studio master ring never overflowed");
    checkLong ((long) session.shared.block->toClient.underruns.load(), 1,
               "the studio master ring starved exactly once, before the first block");

    std::vector<float> recorded ((std::size_t) queued, 0.0f);
    const auto drained = (long) hybridasio::pop (session.shared.block->toStudio, recorded.data(),
                                                 (std::uint32_t) queued);

    checkLong (drained, queued, "the studio can drain everything the driver queued");
    checkBlock (recorded, expectedLoopback, "the audio the host played arrives intact");
    checkLong ((long) session.shared.block->toStudio.underruns.load(), 0,
               "draining exactly what was available is not an underrun");

    // ------------------------------------------------------------------- transport
    checkNumber ((long long) session.shared.block->samplePosition.load(), (long long) total * frames,
                 "the published sample position counts every frame rendered");

    checkLong (driver->disposeBuffers(), ASE_OK, "disposeBuffers succeeds");

    info.channel = 0;
    info.isInput = ASIOTrue;
    driver->getChannelInfo (&info);
    check (info.isActive == ASIOFalse, "the channel is inactive again once the buffers are gone");

    checkLong (driver->stop(), ASE_OK, "stopping an already stopped device is harmless");
    checkLong (driver->start(), ASE_InvalidMode, "a disposed device cannot be restarted");

    activeSession = nullptr;

    session.shared.block->studioOnline.store (0);
    session.shared.close();
}
} // namespace

//==============================================================================
int main (int argc, char** argv)
{
    std::wstring dllPath;

    for (int i = 1; i < argc; ++i)
    {
        const std::string argument = argv[i];

        if (argument == "--pause")
        {
            pauseAtEnd = true;
        }
        else if (argument == "--help" || argument == "-h")
        {
            std::printf ("usage: ToneArtVirtualAsioTest.exe [--pause] [path to HybridVirtualAsio.dll]\n");
            return 0;
        }
        else
        {
            dllPath = fromUtf8 (argument);
        }
    }

    if (dllPath.empty())
        dllPath = moduleDirectory() + L"\\HybridVirtualAsio.dll";

    std::printf ("Tone Art Virtual ASIO bridge self-test\n");
    std::printf ("driver: %s\n\n", toUtf8 (dllPath).c_str());

    const auto dll = LoadLibraryW (dllPath.c_str());

    if (dll == nullptr)
    {
        std::printf ("FAIL  the driver DLL could not be loaded (error %lu).\n", GetLastError());
        std::printf ("      Build the driver first, or pass the path to HybridVirtualAsio.dll.\n");

        if (pauseAtEnd)
            std::system ("pause");

        return 1;
    }

    const auto getClassObject = reinterpret_cast<GetClassObjectFn> (
        GetProcAddress (dll, "DllGetClassObject"));

    if (getClassObject == nullptr)
    {
        std::printf ("FAIL  the driver DLL does not export DllGetClassObject.\n");
        FreeLibrary (dll);
        return 1;
    }

    IClassFactory* factory = nullptr;
    auto result = getClassObject (hybridVirtualAsioClsid, __uuidof (IClassFactory),
                                  reinterpret_cast<void**> (&factory));

    if (result != S_OK || factory == nullptr)
    {
        std::printf ("FAIL  DllGetClassObject refused the driver's class id (0x%08lx).\n", (unsigned long) result);
        FreeLibrary (dll);
        return 1;
    }

    // An ASIO host asks for the driver by passing the class id as the interface
    // id, which is why the driver accepts it in QueryInterface.
    IASIO* driver = nullptr;
    result = factory->CreateInstance (nullptr, hybridVirtualAsioClsid, reinterpret_cast<void**> (&driver));
    factory->Release();

    if (result != S_OK || driver == nullptr)
    {
        std::printf ("FAIL  the driver could not be created (0x%08lx).\n", (unsigned long) result);
        FreeLibrary (dll);
        return 1;
    }

    // Opening the device is what a DAW does when the user picks it. It also
    // creates the shared block the studio attaches to.
    if (driver->init (nullptr) != ASIOTrue)
    {
        std::printf ("FAIL  the driver refused to initialise, so no studio could attach to it.\n");
        driver->Release();
        FreeLibrary (dll);
        return 1;
    }

    auditQueries (driver);
    auditSession (driver, 48000.0, 256, 24, "session A");
    auditSession (driver, 44100.0, 1024, 8, "session B (a different rate and block size)");

    driver->Release();
    FreeLibrary (dll);

    std::printf ("\n%d checks, %d failure%s\n", checks, failures, failures == 1 ? "" : "s");

    if (pauseAtEnd)
        std::system ("pause");

    return failures == 0 ? 0 : 1;
}
