#include "VirtualAsioPeer.h"

VirtualAsioPeer::VirtualAsioPeer() = default;

VirtualAsioPeer::~VirtualAsioPeer()
{
    detach();
}

bool VirtualAsioPeer::attach()
{
   #if JUCE_WINDOWS
    if (shared != nullptr)
        return true;

    mapHandle = OpenFileMappingA (FILE_MAP_ALL_ACCESS, FALSE, hybridasio::sharedMemoryName);

    if (mapHandle == nullptr)
        return false;

    shared = static_cast<hybridasio::Block*> (MapViewOfFile (mapHandle,
                                                             FILE_MAP_ALL_ACCESS,
                                                             0,
                                                             0,
                                                             sizeof (hybridasio::Block)));

    if (shared == nullptr)
    {
        detach();
        return false;
    }

    if (shared->magic.load() != hybridasio::magicValue)
    {
        detach();
        return false;
    }

    shared->studioOnline.store (1);
    return true;
   #else
    return false;
   #endif
}

void VirtualAsioPeer::detach()
{
   #if JUCE_WINDOWS
    if (shared != nullptr)
    {
        shared->studioOnline.store (0);
        UnmapViewOfFile (shared);
        shared = nullptr;
    }

    if (mapHandle != nullptr)
    {
        CloseHandle (mapHandle);
        mapHandle = nullptr;
    }
   #endif
}

void VirtualAsioPeer::refresh()
{
    if (! isAttached())
        attach();
}

bool VirtualAsioPeer::isDriverOnline() const noexcept
{
   #if JUCE_WINDOWS
    return shared != nullptr && shared->driverOnline.load() != 0;
   #else
    return false;
   #endif
}

void VirtualAsioPeer::readInput (float* interleavedStereo, int numFrames)
{
    if (interleavedStereo == nullptr || numFrames <= 0)
        return;

   #if JUCE_WINDOWS
    if (shared != nullptr)
    {
        hybridasio::pop (shared->toStudio, interleavedStereo, (unsigned int) numFrames);
        return;
    }
   #endif

    juce::FloatVectorOperations::clear (interleavedStereo, numFrames * 2);
}

void VirtualAsioPeer::writeOutput (const float* interleavedStereo, int numFrames)
{
    if (interleavedStereo == nullptr || numFrames <= 0)
        return;

   #if JUCE_WINDOWS
    if (shared != nullptr)
        hybridasio::push (shared->toClient, interleavedStereo, (unsigned int) numFrames);
   #else
    juce::ignoreUnused (interleavedStereo, numFrames);
   #endif
}

juce::var VirtualAsioPeer::status() const
{
    auto* object = new juce::DynamicObject();

    object->setProperty ("attached", isAttached());
    object->setProperty ("driverOnline", isDriverOnline());

   #if JUCE_WINDOWS
    if (shared != nullptr)
    {
        object->setProperty ("sampleRate", (int) shared->sampleRate.load());
        object->setProperty ("blockSize", (int) shared->blockSize.load());
        object->setProperty ("inputOverruns", (int) shared->toStudio.overruns.load());
        object->setProperty ("inputUnderruns", (int) shared->toStudio.underruns.load());
        object->setProperty ("outputOverruns", (int) shared->toClient.overruns.load());
        object->setProperty ("outputUnderruns", (int) shared->toClient.underruns.load());
        object->setProperty ("queuedFromDrivers", (int) hybridasio::framesAvailable (shared->toStudio));
    }
   #endif

    return juce::var (object);
}
