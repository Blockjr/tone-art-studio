#pragma once

#include <JuceHeader.h>
#include <vector>

#include "PluginHost.h"
#include "VirtualAsioPeer.h"

/**
    Owns the audio device (ASIO on Windows), a stereo input -> plugin chain ->
    output path, a test tone generator and peak metering for the web UI.

    ASIO devices include the user-mode virtual ones (ASIO4ALL, VoiceMeeter,
    FL Studio ASIO, ASIO Link, and our own Tone Art Virtual ASIO), which is
    how a machine without an audio interface still gets a low-latency path.
*/
class AudioEngine final : private juce::AudioIODeviceCallback
{
public:
    AudioEngine();
    ~AudioEngine() override;

    /** Opens an audio device. Pass an empty type to prefer ASIO when present. */
    juce::var openDevice (const juce::String& typeName, const juce::String& deviceName);
    juce::var status() const;
    juce::StringArray deviceTypes();

    /** Every output device on the machine, flagged for ASIO and virtual drivers. */
    juce::var listDevices();

    void setInputGain (float gain);
    void setTestTone (bool shouldPlay, double frequency);
    void preparePlugins();

    /** Routes the virtual ASIO device in and out of the studio master. */
    void setLoopbackEnabled (bool shouldBeEnabled);
    bool isLoopbackEnabled() const noexcept { return loopbackEnabled.load(); }
    void refreshLoopback();
    juce::var loopbackStatus() const;

    float peak (int channel) const noexcept;

    PluginHost& getPluginHost() noexcept { return plugins; }
    const PluginHost& getPluginHost() const noexcept { return plugins; }

    static bool isVirtualDriverName (const juce::String& deviceName);

private:
    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;

    juce::AudioDeviceManager deviceManager;
    PluginHost plugins;
    VirtualAsioPeer loopbackPeer;

    juce::AudioBuffer<float> chainBuffer;
    juce::MidiBuffer midiBuffer;
    std::vector<float> loopbackScratch;

    std::atomic<float> inputGain { 0.8f };
    std::atomic<bool> toneOn { false };
    std::atomic<double> toneFrequency { 440.0 };
    std::atomic<bool> loopbackEnabled { false };
    double tonePhase = 0.0;

    std::atomic<float> peaks[2] { { 0.0f }, { 0.0f } };

    double currentSampleRate = 44100.0;
    int currentBlockSize = 512;
    juce::String lastError;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (AudioEngine)
};
