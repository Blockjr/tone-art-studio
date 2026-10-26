#include "VirtualAsioDriver.h"
#include "VirtualAsioIds.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <type_traits>

#ifndef kSystemTimeValid
 #define kSystemTimeValid (1L << 0)
#endif

#ifndef kSamplePositionValid
 #define kSamplePositionValid (1L << 1)
#endif

namespace
{
constexpr long kMinBufferSize = 64;
constexpr long kMaxBufferSize = 2048;
constexpr long kPreferredBufferSize = 512;

constexpr double kSupportedRates[] { 44100.0, 48000.0, 88200.0, 96000.0, 176400.0, 192000.0 };

/**
    ASIOSamples / ASIOTimeStamp are either a 64-bit integer or a { hi, lo }
    struct, depending on the SDK's NATIVE_INT64 setting, so write both shapes.
*/
template <typename Counter>
void writeCounter (Counter& target, unsigned long long value)
{
    if constexpr (std::is_integral_v<Counter>)
    {
        target = (Counter) value;
    }
    else
    {
        target.hi = (unsigned long) (value >> 32);
        target.lo = (unsigned long) (value & 0xffffffffull);
    }
}

unsigned long long systemTimeInNanoseconds()
{
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    return (unsigned long long) std::chrono::duration_cast<std::chrono::nanoseconds> (now).count();
}

template <typename T>
void copyName (char* destination, const T* text)
{
    if (destination == nullptr)
        return;

    std::memset (destination, 0, 32);
    std::strncpy (destination, text, 31);
}
} // namespace

HybridVirtualDriver::HybridVirtualDriver() = default;

HybridVirtualDriver::~HybridVirtualDriver()
{
    stop();
    disposeBuffers();
    closeSharedBlock();
}

//==============================================================================
HRESULT STDMETHODCALLTYPE HybridVirtualDriver::QueryInterface (REFIID iid, void** object)
{
    if (object == nullptr)
        return E_POINTER;

    *object = nullptr;

    if (iid == __uuidof (IUnknown) || iid == hybridVirtualAsioClsid)
    {
        *object = static_cast<IASIO*> (this);
        AddRef();
        return S_OK;
    }

    return E_NOINTERFACE;
}

ULONG STDMETHODCALLTYPE HybridVirtualDriver::AddRef()
{
    return refCount.fetch_add (1) + 1;
}

ULONG STDMETHODCALLTYPE HybridVirtualDriver::Release()
{
    const auto remaining = refCount.fetch_sub (1) - 1;

    if (remaining == 0)
        delete this;

    return remaining;
}

//==============================================================================
ASIOBool HybridVirtualDriver::init (void*)
{
    if (shared == nullptr && ! openSharedBlock())
        return ASIOFalse;

    publishRate();
    return ASIOTrue;
}

void HybridVirtualDriver::getDriverName (char* name)
{
    copyName (name, "Tone Art Virtual ASIO");
}

long HybridVirtualDriver::getDriverVersion()
{
    // ASIO version 2.3 in the high word.
    return (2L << 16) | 3L;
}

void HybridVirtualDriver::getErrorMessage (char* string)
{
    copyName (string, "Tone Art Virtual ASIO: start Tone Art Studio to route audio");
}

ASIOError HybridVirtualDriver::start()
{
    if (running.load())
        return ASE_OK;

    if (clientBuffers == nullptr || clientCallbacks.bufferSwitchTimeInfo == nullptr)
        return ASE_InvalidMode;

    if (shared == nullptr && ! openSharedBlock())
        return ASE_NotPresent;

    hybridasio::resetRing (shared->toClient);
    hybridasio::resetRing (shared->toStudio);
    shared->driverOnline.store (1);
    publishRate();

    currentBufferIndex = 0;
    position.store (0);
    running.store (true);
    worker = std::thread ([this] { audioThread(); });

    return ASE_OK;
}

ASIOError HybridVirtualDriver::stop()
{
    running.store (false);

    if (worker.joinable())
        worker.join();

    if (shared != nullptr)
        shared->driverOnline.store (0);

    return ASE_OK;
}

ASIOError HybridVirtualDriver::getChannels (long* numInputChannels, long* numOutputChannels)
{
    if (numInputChannels != nullptr)
        *numInputChannels = 2;

    if (numOutputChannels != nullptr)
        *numOutputChannels = 2;

    return ASE_OK;
}

ASIOError HybridVirtualDriver::getLatencies (long* inputLatency, long* outputLatency)
{
    // One block each way, plus the shared-memory ring depth used by the studio.
    const auto latency = bufferFrames > 0 ? bufferFrames : kPreferredBufferSize;

    if (inputLatency != nullptr)
        *inputLatency = latency;

    if (outputLatency != nullptr)
        *outputLatency = latency;

    return ASE_OK;
}

ASIOError HybridVirtualDriver::getBufferSize (long* minSize, long* maxSize, long* preferredSize, long* granularity)
{
    if (minSize != nullptr)       *minSize = kMinBufferSize;
    if (maxSize != nullptr)       *maxSize = kMaxBufferSize;
    if (preferredSize != nullptr) *preferredSize = kPreferredBufferSize;
    if (granularity != nullptr)   *granularity = 0;

    return ASE_OK;
}

ASIOError HybridVirtualDriver::canSampleRate (ASIOSampleRate sampleRate)
{
    for (const auto rate : kSupportedRates)
        if (std::fabs (sampleRate - rate) < 0.5)
            return ASE_OK;

    return ASE_NoClock;
}

ASIOError HybridVirtualDriver::getSampleRate (ASIOSampleRate* sampleRate)
{
    if (sampleRate == nullptr)
        return ASE_InvalidParameter;

    *sampleRate = currentSampleRate;
    return ASE_OK;
}

ASIOError HybridVirtualDriver::setSampleRate (ASIOSampleRate sampleRate)
{
    if (running.load())
        return ASE_InvalidMode;

    if (canSampleRate (sampleRate) != ASE_OK)
        return ASE_NoClock;

    currentSampleRate = sampleRate;
    publishRate();
    return ASE_OK;
}

ASIOError HybridVirtualDriver::getClockSources (ASIOClockSource* clocks, long* numSources)
{
    if (numSources == nullptr)
        return ASE_InvalidParameter;

    if (clocks != nullptr)
    {
        clocks[0].index = 0;
        clocks[0].associatedChannel = -1;
        clocks[0].associatedGroup = -1;
        clocks[0].isCurrentSource = ASIOTrue;
        copyName (clocks[0].name, "Internal");
    }

    *numSources = 1;
    return ASE_OK;
}

ASIOError HybridVirtualDriver::setClockSource (long reference)
{
    return reference == 0 ? ASE_OK : ASE_InvalidParameter;
}

ASIOError HybridVirtualDriver::getSamplePosition (ASIOSamples* sPos, ASIOTimeStamp* tStamp)
{
    const auto samples = position.load();

    if (sPos != nullptr)
        writeCounter (*sPos, samples);

    if (tStamp != nullptr)
        writeCounter (*tStamp, systemTimeInNanoseconds());

    return ASE_OK;
}

ASIOError HybridVirtualDriver::getChannelInfo (ASIOChannelInfo* info)
{
    if (info == nullptr)
        return ASE_InvalidParameter;

    if (info->channel < 0 || info->channel > 1)
        return ASE_InvalidParameter;

    info->channelGroup = 0;
    info->type = ASIOSTFloat32LSB;
    info->isActive = clientBuffers != nullptr ? ASIOTrue : ASIOFalse;

    if (info->isInput == ASIOTrue)
        copyName (info->name, info->channel == 0 ? "Tone Art Virtual In L" : "Tone Art Virtual In R");
    else
        copyName (info->name, info->channel == 0 ? "Tone Art Virtual Out L" : "Tone Art Virtual Out R");

    return ASE_OK;
}

ASIOError HybridVirtualDriver::createBuffers (ASIOBufferInfo* bufferInfos,
                                              long numChannels,
                                              long bufferSize,
                                              ASIOCallbacks* callbacks)
{
    if (running.load())
        return ASE_InvalidMode;

    if (bufferInfos == nullptr || callbacks == nullptr || numChannels <= 0)
        return ASE_InvalidParameter;

    if (bufferSize < kMinBufferSize || bufferSize > kMaxBufferSize)
        return ASE_InvalidParameter;

    disposeBuffers();

    const auto frames = (size_t) bufferSize;

    inputStorage.assign (2, std::vector<float> (frames * 2, 0.0f));
    outputStorage.assign (2, std::vector<float> (frames * 2, 0.0f));
    interleavedTemp.assign (frames * hybridasio::channelCount, 0.0f);

    bufferFrames = bufferSize;
    clientBuffers = bufferInfos;
    clientBufferCount = numChannels;
    clientCallbacks = *callbacks;
    currentBufferIndex = 0;

    for (long i = 0; i < numChannels; ++i)
    {
        const auto channel = (size_t) (bufferInfos[i].channelNum & 1);
        auto& storage = bufferInfos[i].isInput == ASIOTrue ? inputStorage : outputStorage;

        bufferInfos[i].buffers[0] = storage[channel].data();
        bufferInfos[i].buffers[1] = storage[channel].data() + frames;
    }

    return ASE_OK;
}

ASIOError HybridVirtualDriver::disposeBuffers()
{
    stop();

    if (clientBuffers != nullptr)
        for (long i = 0; i < clientBufferCount; ++i)
        {
            clientBuffers[i].buffers[0] = nullptr;
            clientBuffers[i].buffers[1] = nullptr;
        }

    clientBuffers = nullptr;
    clientBufferCount = 0;
    clientCallbacks = ASIOCallbacks {};
    bufferFrames = 0;
    inputStorage.clear();
    outputStorage.clear();
    interleavedTemp.clear();

    return ASE_OK;
}

ASIOError HybridVirtualDriver::controlPanel()
{
    MessageBoxA (nullptr,
                 "Tone Art Virtual ASIO is a 2-in / 2-out loopback device.\n\n"
                 "Audio this application plays arrives on the device's inputs, and audio it\n"
                 "records from the device's outputs is monitored by Tone Art Studio's master.\n\n"
                 "Open the Studio Rig panel in Tone Art Studio to enable the loopback and watch\n"
                 "the ring-buffer status.",
                 "Tone Art Virtual ASIO",
                 MB_OK | MB_ICONINFORMATION);

    return ASE_OK;
}

ASIOError HybridVirtualDriver::future (long, void*)
{
    return ASE_NotPresent;
}

ASIOError HybridVirtualDriver::outputReady()
{
    return ASE_OK;
}

//==============================================================================
bool HybridVirtualDriver::openSharedBlock()
{
    if (shared != nullptr)
        return true;

    mapHandle = CreateFileMappingA (INVALID_HANDLE_VALUE,
                                    nullptr,
                                    PAGE_READWRITE,
                                    0,
                                    (DWORD) sizeof (hybridasio::Block),
                                    hybridasio::sharedMemoryName);

    if (mapHandle == nullptr)
        return false;

    shared = static_cast<hybridasio::Block*> (MapViewOfFile (mapHandle,
                                                             FILE_MAP_ALL_ACCESS,
                                                             0,
                                                             0,
                                                             sizeof (hybridasio::Block)));

    if (shared == nullptr)
    {
        closeSharedBlock();
        return false;
    }

    if (shared->magic.load() != hybridasio::magicValue
        || shared->version.load() != hybridasio::protocolVersion)
    {
        // A stale mapping from an older build: re-initialise the header.
        shared->version.store (hybridasio::protocolVersion);
        shared->channels.store (hybridasio::channelCount);
        hybridasio::resetRing (shared->toStudio);
        hybridasio::resetRing (shared->toClient);
        shared->magic.store (hybridasio::magicValue);
    }

    toStudioEvent = CreateEventA (nullptr, FALSE, FALSE, hybridasio::toStudioEventName);
    toClientEvent = CreateEventA (nullptr, FALSE, FALSE, hybridasio::toClientEventName);

    return true;
}

void HybridVirtualDriver::closeSharedBlock()
{
    if (toStudioEvent != nullptr)
    {
        CloseHandle (toStudioEvent);
        toStudioEvent = nullptr;
    }

    if (toClientEvent != nullptr)
    {
        CloseHandle (toClientEvent);
        toClientEvent = nullptr;
    }

    if (shared != nullptr)
    {
        UnmapViewOfFile (shared);
        shared = nullptr;
    }

    if (mapHandle != nullptr)
    {
        CloseHandle (mapHandle);
        mapHandle = nullptr;
    }
}

double HybridVirtualDriver::hostSampleRate() const
{
    return currentSampleRate > 0.0 ? currentSampleRate : 44100.0;
}

void HybridVirtualDriver::publishRate()
{
    if (shared == nullptr)
        return;

    shared->sampleRate.store ((unsigned int) std::lround (hostSampleRate()));
    shared->blockSize.store ((unsigned int) (bufferFrames > 0 ? bufferFrames : kPreferredBufferSize));
    shared->channels.store (hybridasio::channelCount);
    shared->studioOnline.store (1);
}

void HybridVirtualDriver::audioThread()
{
    const auto frames = bufferFrames > 0 ? bufferFrames : kPreferredBufferSize;
    const auto blockDuration = std::chrono::duration_cast<std::chrono::steady_clock::duration> (
        std::chrono::duration<double> ((double) frames / hostSampleRate()));

    auto next = std::chrono::steady_clock::now();

    while (running.load())
    {
        renderBlock();

        next += blockDuration;

        const auto now = std::chrono::steady_clock::now();

        if (next < now)
            next = now;                 // we fell behind: resync instead of spinning
        else
            std::this_thread::sleep_until (next);
    }
}

void HybridVirtualDriver::renderBlock()
{
    if (clientBuffers == nullptr || clientCallbacks.bufferSwitchTimeInfo == nullptr || bufferFrames <= 0)
        return;

    const auto frames = (size_t) bufferFrames;
    const auto offset = (size_t) currentBufferIndex * frames;

    // 1. Studio master -> this device's inputs.
    if (shared != nullptr)
        hybridasio::pop (shared->toClient, interleavedTemp.data(), (unsigned int) frames);
    else
        std::fill (interleavedTemp.begin(), interleavedTemp.end(), 0.0f);

    for (size_t channel = 0; channel < 2; ++channel)
        for (size_t frame = 0; frame < frames; ++frame)
            inputStorage[channel][offset + frame] = interleavedTemp[frame * 2 + channel];

    // 2. Let the host render into this device's outputs.
    ASIOTime time {};
    time.timeInfo.speed = 1.0;
    writeCounter (time.timeInfo.systemTime, systemTimeInNanoseconds());
    writeCounter (time.timeInfo.samplePosition, position.load());
    time.timeInfo.flags = kSystemTimeValid | kSamplePositionValid;

    clientCallbacks.bufferSwitchTimeInfo (&time, currentBufferIndex, ASIOTrue);

    // 3. This device's outputs -> studio loopback input.
    for (size_t channel = 0; channel < 2; ++channel)
        for (size_t frame = 0; frame < frames; ++frame)
            interleavedTemp[frame * 2 + channel] = outputStorage[channel][offset + frame];

    if (shared != nullptr)
    {
        hybridasio::push (shared->toStudio, interleavedTemp.data(), (unsigned int) frames);
        shared->samplePosition.store (position.load() + frames);

        if (toStudioEvent != nullptr)
            SetEvent (toStudioEvent);
    }

    position.fetch_add (frames);
    currentBufferIndex ^= 1;
}
