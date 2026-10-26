#pragma once

#include <JuceHeader.h>

class ToneArtGateProcessor;

/**
    Faceplate for Tone Art Gate: five knobs, two menus and a gain meter that
    shows the gate opening and closing while the transport runs.
*/
class ToneArtGateEditor final : public juce::AudioProcessorEditor,
                                 private juce::Timer
{
public:
    explicit ToneArtGateEditor (ToneArtGateProcessor& processor);
    ~ToneArtGateEditor() override;

    void paint (juce::Graphics& g) override;
    void resized() override;

private:
    void timerCallback() override;
    void styleKnob (juce::Slider& slider);
    void styleMenu (juce::ComboBox& box);
    void styleCaption (juce::Label& label, const juce::String& text);

    ToneArtGateProcessor& processor;

    juce::Label title;
    juce::Label subtitle;
    juce::Label rateLabel;
    juce::Label shapeLabel;
    juce::Label depthLabel;
    juce::Label phaseLabel;
    juce::Label smoothLabel;
    juce::Label mixLabel;
    juce::Label bpmLabel;

    juce::Slider depth;
    juce::Slider phase;
    juce::Slider smooth;
    juce::Slider mix;
    juce::Slider bpm;

    juce::ComboBox rate;
    juce::ComboBox shape;

    using SliderAttachment = juce::AudioProcessorValueTreeState::SliderAttachment;
    using MenuAttachment = juce::AudioProcessorValueTreeState::ComboBoxAttachment;

    std::unique_ptr<SliderAttachment> depthAttachment;
    std::unique_ptr<SliderAttachment> phaseAttachment;
    std::unique_ptr<SliderAttachment> smoothAttachment;
    std::unique_ptr<SliderAttachment> mixAttachment;
    std::unique_ptr<SliderAttachment> bpmAttachment;
    std::unique_ptr<MenuAttachment> rateAttachment;
    std::unique_ptr<MenuAttachment> shapeAttachment;

    float shownGain = 1.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ToneArtGateEditor)
};
