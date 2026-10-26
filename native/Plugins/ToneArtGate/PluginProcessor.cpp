#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace
{
    /** Beats spanned by one gate cycle, matching the rate choices below. */
    constexpr double kBeatsPerCycle[] = { 4.0, 2.0, 1.0, 0.5, 0.25, 0.125 };

    constexpr double kTwoPi = 6.283185307179586;
}

ToneArtGateProcessor::ToneArtGateProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      parameters (*this, nullptr, "TONE_ART_GATE", createLayout())
{
    rateParam   = parameters.getRawParameterValue ("rate");
    shapeParam  = parameters.getRawParameterValue ("shape");
    depthParam  = parameters.getRawParameterValue ("depth");
    phaseParam  = parameters.getRawParameterValue ("phase");
    smoothParam = parameters.getRawParameterValue ("smooth");
    mixParam    = parameters.getRawParameterValue ("mix");
    bpmParam    = parameters.getRawParameterValue ("bpm");
}

ToneArtGateProcessor::~ToneArtGateProcessor() = default;

juce::AudioProcessorValueTreeState::ParameterLayout ToneArtGateProcessor::createLayout()
{
    juce::AudioProcessorValueTreeState::ParameterLayout layout;

    layout.add (std::make_unique<juce::AudioParameterChoice> (
        juce::ParameterID { "rate", 1 }, "Rate",
        juce::StringArray { "1/1", "1/2", "1/4", "1/8", "1/16", "1/32" }, 2));

    layout.add (std::make_unique<juce::AudioParameterChoice> (
        juce::ParameterID { "shape", 1 }, "Shape",
        juce::StringArray { "Sine", "Square", "Saw", "Triangle" }, 0));

    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "depth", 1 }, "Depth",
        juce::NormalisableRange<float> (0.0f, 100.0f, 0.1f), 100.0f));

    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "phase", 1 }, "Phase",
        juce::NormalisableRange<float> (0.0f, 360.0f, 1.0f), 0.0f));

    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "smooth", 1 }, "Smooth",
        juce::NormalisableRange<float> (0.0f, 80.0f, 0.1f), 8.0f));

    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "mix", 1 }, "Mix",
        juce::NormalisableRange<float> (0.0f, 100.0f, 0.1f), 100.0f));

    // Only used when the host does not report a tempo; the host value wins.
    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "bpm", 1 }, "Fallback BPM",
        juce::NormalisableRange<float> (40.0f, 240.0f, 0.1f), 120.0f));

    return layout;
}

void ToneArtGateProcessor::prepareToPlay (double newSampleRate, int)
{
    sampleRate = newSampleRate > 0.0 ? newSampleRate : 44100.0;
    phase = 0.0;
    smoothed = 1.0f;
    meter.store (1.0f, std::memory_order_relaxed);
}

void ToneArtGateProcessor::releaseResources()
{
    // prepareToPlay allocates nothing, so there is nothing to free; the meter
    // simply goes back to unity so a fresh transport does not start gated.
    smoothed = 1.0f;
    meter.store (1.0f, std::memory_order_relaxed);
}

bool ToneArtGateProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();
    const auto& in = layouts.getMainInputChannelSet();

    if (in != out) return false;
    return out == juce::AudioChannelSet::mono() || out == juce::AudioChannelSet::stereo();
}

float ToneArtGateProcessor::shapeAt (double p, int shape) noexcept
{
    switch (shape)
    {
        case 1:  return p < 0.5 ? 1.0f : 0.0f;                       // square
        case 2:  return (float) (1.0 - p);                           // saw
        case 3:  return (float) std::abs (2.0 * p - 1.0);            // triangle
        default: return (float) (0.5 + 0.5 * std::cos (kTwoPi * p)); // sine
    }
}

void ToneArtGateProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused (midi);
    juce::ScopedNoDenormals noDenormals;

    const int channels = buffer.getNumChannels();
    const int samples = buffer.getNumSamples();
    if (samples <= 0 || channels <= 0) return;

    const int rateIndex = juce::jlimit (0, 5, (int) rateParam->load());
    const int shapeIndex = juce::jlimit (0, 3, (int) shapeParam->load());
    const double beatsPerCycle = kBeatsPerCycle[rateIndex];

    const float depth = juce::jlimit (0.0f, 1.0f, depthParam->load() * 0.01f);
    const float mix = juce::jlimit (0.0f, 1.0f, mixParam->load() * 0.01f);
    const double phaseOffset = (double) phaseParam->load() / 360.0;

    const double smoothMs = juce::jmax (0.0, (double) smoothParam->load());
    const float coeff = smoothMs <= 0.01
        ? 1.0f
        : (float) (1.0 - std::exp (-1.0 / (smoothMs * 0.001 * sampleRate)));

    // The host's tempo and play position keep the gate on the bar; a stopped
    // transport or a host without those values falls back to free running.
    double bpm = bpmParam->load();
    double ppq = 0.0;
    bool synced = false;

    if (auto* head = getPlayHead())
    {
        if (const auto position = head->getPosition())
        {
            if (const auto hostBpm = position->getBpm(); hostBpm.hasValue() && *hostBpm > 20.0)
                bpm = *hostBpm;

            if (const auto hostPpq = position->getPpqPosition(); hostPpq.hasValue())
            {
                ppq = *hostPpq;
                synced = true;
            }
        }
    }

    bpm = juce::jlimit (20.0, 300.0, bpm);

    if (synced)
    {
        const double cycles = ppq / beatsPerCycle;
        phase = cycles - std::floor (cycles);
    }

    const double step = bpm / (60.0 * sampleRate) / beatsPerCycle;

    float peak = 0.0f;

    for (int i = 0; i < samples; ++i)
    {
        double wrapped = phase + phaseOffset;
        wrapped -= std::floor (wrapped);

        const float curve = shapeAt (wrapped, shapeIndex);
        const float target = 1.0f - depth * (1.0f - curve);

        smoothed += (target - smoothed) * coeff;
        if (smoothed < 0.0f) smoothed = 0.0f;
        if (smoothed > 1.0f) smoothed = 1.0f;
        peak = juce::jmax (peak, smoothed);

        const float gain = (1.0f - mix) + mix * smoothed;

        for (int channel = 0; channel < channels; ++channel)
            buffer.getWritePointer (channel)[i] *= gain;

        phase += step;
        if (phase >= 1.0)
            phase -= std::floor (phase);
    }

    meter.store (peak, std::memory_order_relaxed);
}

juce::AudioProcessorEditor* ToneArtGateProcessor::createEditor()
{
    return new ToneArtGateEditor (*this);
}

void ToneArtGateProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    const auto state = parameters.copyState();
    const std::unique_ptr<juce::XmlElement> xml (state.createXml());

    if (xml != nullptr)
        copyXmlToBinary (*xml, destData);
}

void ToneArtGateProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    // Braces, not parentheses: `if (T x (args))` is parsed as a function
    // declaration, which is what MSVC reports as C4430 here.
    if (const auto xml = std::unique_ptr<juce::XmlElement> { getXmlFromBinary (data, sizeInBytes) })
    {
        if (xml->hasTagName (parameters.state.getType()))
            parameters.replaceState (juce::ValueTree::fromXml (*xml));
    }
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new ToneArtGateProcessor();
}
