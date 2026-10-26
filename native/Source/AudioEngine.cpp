#include "AudioEngine.h"

namespace
{
const char* const virtualDriverMarkers[]
{
    "asio4all",
    "voicemeeter",
    "vb-audio",
    "virtual",
    "loopback",
    "fl studio asio",
    "asio link",
    "jack router",
    "my studio virtual",
    "reastream"
};
} // namespace

AudioEngine::AudioEngine()
{
    deviceManager.addAudioCallback (this);
}

AudioEngine::~AudioEngine()
{
    deviceManager.removeAudioCallback (this);
    deviceManager.closeAudioDevice();
}

bool AudioEngine::isVirtualDriverName (const juce::String& deviceName)
{
    const auto lower = deviceName.toLowerCase();

    for (const auto* marker : virtualDriverMarkers)
        if (lower.contains (marker))
            return true;

    return false;
}

juce::StringArray AudioEngine::deviceTypes()
{
    juce::StringArray names;

    for (auto* type : deviceManager.getAvailableDeviceTypes())
    {
        if (type != nullptr)
        {
            type->scanForDevices();
            names.add (type->getTypeName());
        }
    }

    return names;
}

juce::var AudioEngine::listDevices()
{
    juce::Array<juce::var> items;

    const auto* current = deviceManager.getCurrentAudioDevice();
    const auto currentType = deviceManager.getCurrentAudioDeviceType();
    const auto currentName = current != nullptr ? current->getName() : juce::String();

    for (auto* type : deviceManager.getAvailableDeviceTypes())
    {
        if (type == nullptr)
            continue;

        type->scanForDevices();

        const auto typeName = type->getTypeName();

        for (const auto& name : type->getDeviceNames (false))
        {
            auto* object = new juce::DynamicObject();
            object->setProperty ("type", typeName);
            object->setProperty ("name", name);
            object->setProperty ("isAsio", typeName.containsIgnoreCase ("ASIO"));
            object->setProperty ("isVirtual", isVirtualDriverName (name));
            object->setProperty ("selected", name == currentName && typeName == currentType);
            items.add (juce::var (object));
        }
    }

    return juce::var (items);
}

juce::var AudioEngine::openDevice (const juce::String& typeName, const juce::String& deviceName)
{
    lastError.clear();

    auto resolvedType = typeName;

    if (resolvedType.isEmpty())
    {
        // Prefer ASIO when the machine has it: that is the low-latency path and
        // it is the only backend that can reach our virtual device.
        for (auto* type : deviceManager.getAvailableDeviceTypes())
        {
            if (type != nullptr && type->getTypeName().containsIgnoreCase ("ASIO"))
            {
                resolvedType = type->getTypeName();
                break;
            }
        }
    }

    if (resolvedType.isNotEmpty())
        deviceManager.setCurrentAudioDeviceType (resolvedType, true);

    auto error = deviceManager.initialiseWithDefaultDevices (2, 2);

    // Many virtual ASIO drivers expose no inputs; retry output-only.
    if (error.isNotEmpty())
    {
        lastError = error;
        error = deviceManager.initialiseWithDefaultDevices (0, 2);
    }

    auto* device = deviceManager.getCurrentAudioDevice();

    if (device == nullptr)
    {
        if (lastError.isEmpty())
            lastError = "No audio device could be opened. Is an ASIO driver installed?";
        return status();
    }

    if (deviceName.isNotEmpty() && device->getName() != deviceName)
    {
        auto setup = deviceManager.getAudioDeviceSetup();
        setup.outputDeviceName = deviceName;

        if (device->getTypeName().containsIgnoreCase ("ASIO"))
            setup.inputDeviceName = deviceName;

        const auto setupError = deviceManager.setAudioDeviceSetup (setup, true);

        if (setupError.isNotEmpty())
            lastError = setupError;
    }

    if (error.isNotEmpty())
        lastError = error;

    preparePlugins();
    return status();
}

juce::var AudioEngine::status() const
{
    auto* object = new juce::DynamicObject();
    auto* device = deviceManager.getCurrentAudioDevice();

    object->setProperty ("open", device != nullptr);
    object->setProperty ("name", device != nullptr ? device->getName() : juce::String());
    object->setProperty ("type", device != nullptr ? device->getTypeName() : juce::String());
    object->setProperty ("sampleRate", device != nullptr ? device->getCurrentSampleRate() : 0.0);
    object->setProperty ("bufferSize", device != nullptr ? device->getCurrentBufferSizeSamples() : 0);
    object->setProperty ("latencySamples", device != nullptr ? device->getOutputLatencyInSamples() : 0);
    object->setProperty ("isAsio", device != nullptr && device->getTypeName().containsIgnoreCase ("ASIO"));
    object->setProperty ("isVirtual", device != nullptr && isVirtualDriverName (device->getName()));
    object->setProperty ("error", lastError);

    return juce::var (object);
}

void AudioEngine::setInputGain (float gain)
{
    inputGain.store (juce::jlimit (0.0f, 2.0f, gain));
}

void AudioEngine::setTestTone (bool shouldPlay, double frequency)
{
    toneFrequency.store (frequency > 20.0 ? frequency : 440.0);
    toneOn.store (shouldPlay);
}

void AudioEngine::preparePlugins()
{
    plugins.prepare (currentSampleRate, currentBlockSize);
}

void AudioEngine::setLoopbackEnabled (bool shouldBeEnabled)
{
    loopbackEnabled.store (shouldBeEnabled);

    if (shouldBeEnabled)
        loopbackPeer.attach();
    else
        loopbackPeer.detach();
}

void AudioEngine::refreshLoopback()
{
    if (loopbackEnabled.load())
        loopbackPeer.refresh();
}

juce::var AudioEngine::loopbackStatus() const
{
    auto result = loopbackPeer.status();

    if (auto* object = result.getDynamicObject())
        object->setProperty ("enabled", loopbackEnabled.load());

    return result;
}

float AudioEngine::peak (int channel) const noexcept
{
    return peaks[juce::jlimit (0, 1, channel)].load();
}

void AudioEngine::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    if (device == nullptr)
        return;

    currentSampleRate = device->getCurrentSampleRate();
    currentBlockSize = device->getCurrentBufferSizeSamples();
    chainBuffer.setSize (2, juce::jmax (32, currentBlockSize), false, false, true);
    loopbackScratch.assign ((size_t) juce::jmax (32, currentBlockSize) * 2, 0.0f);
    tonePhase = 0.0;
    preparePlugins();
}

void AudioEngine::audioDeviceStopped()
{
}

void AudioEngine::audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                                    int numInputChannels,
                                                    float* const* outputChannelData,
                                                    int numOutputChannels,
                                                    int numSamples,
                                                    const juce::AudioIODeviceCallbackContext&)
{
    for (int channel = 0; channel < numOutputChannels; ++channel)
        if (outputChannelData[channel] != nullptr)
            juce::FloatVectorOperations::clear (outputChannelData[channel], numSamples);

    if (numSamples <= 0)
        return;

    if (chainBuffer.getNumSamples() < numSamples)
        chainBuffer.setSize (2, numSamples, false, false, true);

    chainBuffer.clear();

    // Song mode owns the output: the stems are already the browser's mix, so the
    // live input and its monitor chain stay out of the way until the stems are
    // unloaded.
    const auto songMode = plugins.songLoaded();

    if (songMode)
    {
        plugins.processSong (chainBuffer, numSamples);
    }
    else if (toneOn.load())
    {
        const auto increment = juce::MathConstants<double>::twoPi * toneFrequency.load()
                                 / juce::jmax (1.0, currentSampleRate);

        for (int i = 0; i < numSamples; ++i)
        {
            const auto value = (float) (std::sin (tonePhase) * 0.12);
            chainBuffer.setSample (0, i, value);
            chainBuffer.setSample (1, i, value);
            tonePhase += increment;
        }

        tonePhase = std::fmod (tonePhase, juce::MathConstants<double>::twoPi);
    }
    else
    {
        for (int channel = 0; channel < juce::jmin (2, numInputChannels); ++channel)
            if (inputChannelData[channel] != nullptr)
                chainBuffer.copyFrom (channel, 0, inputChannelData[channel], numSamples);
    }

    const auto canLoopback = loopbackEnabled.load()
                             && loopbackPeer.isAttached()
                             && (int) loopbackScratch.size() >= numSamples * 2;

    if (! songMode)
    {
        chainBuffer.applyGain (inputGain.load());

        if (canLoopback)
        {
            loopbackPeer.readInput (loopbackScratch.data(), numSamples);

            for (int channel = 0; channel < 2; ++channel)
            {
                auto* destination = chainBuffer.getWritePointer (channel);

                for (int i = 0; i < numSamples; ++i)
                    destination[i] += loopbackScratch[(size_t) i * 2 + (size_t) channel] * 0.9f;
            }
        }

        midiBuffer.clear();

        {
            juce::AudioBuffer<float> view (chainBuffer.getArrayOfWritePointers(), 2, numSamples);
            plugins.process (view, midiBuffer);
        }
    }

    for (int channel = 0; channel < numOutputChannels; ++channel)
    {
        if (outputChannelData[channel] == nullptr)
            continue;

        const auto source = juce::jmin (channel, chainBuffer.getNumChannels() - 1);
        juce::FloatVectorOperations::copy (outputChannelData[channel],
                                           chainBuffer.getReadPointer (source),
                                           numSamples);
    }

    if (canLoopback)
    {
        for (int i = 0; i < numSamples; ++i)
        {
            loopbackScratch[(size_t) i * 2] = chainBuffer.getSample (0, i);
            loopbackScratch[(size_t) i * 2 + 1] = chainBuffer.getSample (1, i);
        }

        loopbackPeer.writeOutput (loopbackScratch.data(), numSamples);
    }

    for (int channel = 0; channel < 2; ++channel)
    {
        const auto level = chainBuffer.getMagnitude (channel, 0, numSamples);
        const auto previous = peaks[channel].load();
        peaks[channel].store (juce::jmax (level, previous * 0.88f));
    }
}
