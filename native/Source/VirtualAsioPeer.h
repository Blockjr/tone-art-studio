#pragma once

#include <JuceHeader.h>

#if JUCE_WINDOWS
 #include <windows.h>
 #include "HybridAsioShared.h"
#endif

/**
    Engine side of the Tone Art Virtual ASIO device.

    When the loopback is enabled the engine pulls audio other ASIO applications
    play into the studio (their outputs land in the toStudio ring) and publishes
    the studio master into the toClient ring, where those applications can
    record it. If the driver DLL is not installed or no host has opened it, the
    peer simply stays detached and the studio behaves normally.
*/
class VirtualAsioPeer
{
public:
    VirtualAsioPeer();
    ~VirtualAsioPeer();

    /** Opens the driver's shared block. Safe to call repeatedly. */
    bool attach();
    void detach();
    void refresh();

    bool isAttached() const noexcept          { return shared != nullptr; }
    bool isDriverOnline() const noexcept;

    /** Reads interleaved stereo frames from other applications (zero-fills on starvation). */
    void readInput (float* interleavedStereo, int numFrames);

    /** Publishes interleaved stereo frames for other applications to record. */
    void writeOutput (const float* interleavedStereo, int numFrames);

    juce::var status() const;

private:
   #if JUCE_WINDOWS
    hybridasio::Block* shared = nullptr;
    HANDLE mapHandle = nullptr;
   #endif

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (VirtualAsioPeer)
};
