#include "VstInsert.h"

namespace hybrid
{

VstInsert::VstInsert (std::unique_ptr<juce::AudioPluginInstance> pluginInstance)
    : instance (std::move (pluginInstance))
{
    if (instance != nullptr)
    {
        // Some VST3s expose their full mono->stereo bus matrix only after this
        // call; doing it before prepare makes sure all buses are active.
        instance->enableAllBuses();
        const auto pluginName = instance->getName();
        if (pluginName.isNotEmpty())
            label = pluginName.toStdString();
    }
}

void VstInsert::prepare (double sampleRate, int maxBlockSize)
{
    if (instance == nullptr)
        return;

    instance->setRateAndBufferSizeDetails (sampleRate, maxBlockSize);
    instance->prepareToPlay (sampleRate, maxBlockSize);
}

void VstInsert::process (float* const* channels, int numChannels, int numSamples)
{
    if (instance == nullptr || numChannels <= 0 || numSamples <= 0)
        return;

    juce::AudioBuffer<float> buffer (channels, numChannels, numSamples);
    midi.clear();
    instance->processBlock (buffer, midi);
}

void VstInsert::reset()
{
    if (instance != nullptr)
        instance->reset();
}

int VstInsert::latencySamples() const noexcept
{
    return instance != nullptr ? instance->getLatencySamples() : 0;
}

const char* VstInsert::name() const noexcept
{
    return label.c_str();
}

juce::AudioPluginInstance* VstInsert::plugin() noexcept
{
    return instance.get();
}

const juce::AudioPluginInstance* VstInsert::plugin() const noexcept
{
    return instance.get();
}

bool VstInsert::hasEditor() const
{
    return instance != nullptr && instance->hasEditor();
}

juce::AudioProcessorEditor* VstInsert::createEditor()
{
    if (instance == nullptr)
        return nullptr;

    return instance->createEditorAndMakeActive();
}

juce::String VstInsert::saveState() const
{
    if (instance == nullptr)
        return {};

    juce::MemoryBlock block;
    instance->getStateInformation (block);
    return block.toBase64Encoding();
}

bool VstInsert::restoreState (const juce::String& base64State)
{
    if (instance == nullptr || base64State.isEmpty())
        return false;

    juce::MemoryBlock block;
    if (! block.fromBase64Encoding (base64State))
        return false;

    instance->setStateInformation (block.getData(), static_cast<int> (block.getSize()));
    return true;
}

} // namespace hybrid
