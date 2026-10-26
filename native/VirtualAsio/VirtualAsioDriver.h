#pragma once

#include <windows.h>

// iasiodrv.h declares `interface IASIO : public IUnknown`. Neither the
// `interface` macro nor IUnknown comes from windows.h, so the SDK has to be
// included after COM's own header or every member reads as a syntax error.
#include <objbase.h>

#include <atomic>
#include <thread>
#include <vector>

#ifndef interface
 #define interface struct
#endif

#include "iasiodrv.h"
#include "../Source/HybridAsioShared.h"

/**
    A user-mode virtual ASIO device ("Tone Art Virtual ASIO").

    ASIO drivers on Windows are in-process COM servers, not kernel drivers, so
    this needs no WDK, no test signing and no driver signature. It presents a
    2-in / 2-out float32 device and moves audio through the shared-memory rings
    described in HybridAsioShared.h:

      - its *inputs*  come from Tone Art Studio's master output (toClient ring)
      - its *outputs* are handed to Tone Art Studio as loopback input (toStudio ring)

    Any ASIO application can therefore record what Tone Art Studio plays and feed
    audio back into the studio, with timing driven by our own clock.
*/
class HybridVirtualDriver final : public IASIO
{
public:
    HybridVirtualDriver();

    //============================================================ IUnknown
    HRESULT STDMETHODCALLTYPE QueryInterface (REFIID iid, void** object) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;

    //============================================================ IASIO
    ASIOBool init (void* sysHandle) override;
    void getDriverName (char* name) override;
    long getDriverVersion() override;
    void getErrorMessage (char* string) override;
    ASIOError start() override;
    ASIOError stop() override;
    ASIOError getChannels (long* numInputChannels, long* numOutputChannels) override;
    ASIOError getLatencies (long* inputLatency, long* outputLatency) override;
    ASIOError getBufferSize (long* minSize, long* maxSize, long* preferredSize, long* granularity) override;
    ASIOError canSampleRate (ASIOSampleRate sampleRate) override;
    ASIOError getSampleRate (ASIOSampleRate* sampleRate) override;
    ASIOError setSampleRate (ASIOSampleRate sampleRate) override;
    ASIOError getClockSources (ASIOClockSource* clocks, long* numSources) override;
    ASIOError setClockSource (long reference) override;
    ASIOError getSamplePosition (ASIOSamples* sPos, ASIOTimeStamp* tStamp) override;
    ASIOError getChannelInfo (ASIOChannelInfo* info) override;
    ASIOError createBuffers (ASIOBufferInfo* bufferInfos,
                             long numChannels,
                             long bufferSize,
                             ASIOCallbacks* callbacks) override;
    ASIOError disposeBuffers() override;
    ASIOError controlPanel() override;
    ASIOError future (long selector, void* opt) override;
    ASIOError outputReady() override;

private:
    // IASIO has no virtual destructor: instances are destroyed through Release().
    ~HybridVirtualDriver();

    bool openSharedBlock();
    void closeSharedBlock();
    void audioThread();
    void renderBlock();
    double hostSampleRate() const;
    void publishRate();

    std::atomic<ULONG> refCount { 1 };
    std::atomic<bool> running { false };
    std::thread worker;

    ASIOCallbacks clientCallbacks {};
    ASIOBufferInfo* clientBuffers = nullptr;
    long clientBufferCount = 0;
    long bufferFrames = 0;          // frames per block, set by createBuffers
    long currentBufferIndex = 0;    // 0 or 1: which half of the double buffer is live

    std::vector<std::vector<float>> inputStorage;   // planar, [channel][2 * frames]
    std::vector<std::vector<float>> outputStorage;
    std::vector<float> interleavedTemp;

    hybridasio::Block* shared = nullptr;
    HANDLE mapHandle = nullptr;
    HANDLE toStudioEvent = nullptr;
    HANDLE toClientEvent = nullptr;

    ASIOSampleRate currentSampleRate = 44100.0;
    std::atomic<unsigned long long> position { 0 };
};
