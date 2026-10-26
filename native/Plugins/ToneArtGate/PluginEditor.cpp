#include "PluginEditor.h"
#include "PluginProcessor.h"

namespace
{
    const juce::Colour kBackground { 0xff0b0d12 };
    const juce::Colour kPanel      { 0xff121620 };
    const juce::Colour kLine       { 0xff242833 };
    const juce::Colour kText       { 0xffe4e7ef };
    const juce::Colour kDim        { 0xff8b93a7 };
    const juce::Colour kAccent     { 0xfff43f5e };
    const juce::Colour kGreen      { 0xff34d399 };
}

ToneArtGateEditor::ToneArtGateEditor (ToneArtGateProcessor& p)
    : AudioProcessorEditor (&p), processor (p)
{
    setSize (480, 250);

    title.setText ("TONE ART GATE", juce::dontSendNotification);
    title.setFont (juce::Font (juce::FontOptions (15.0f, juce::Font::bold)));
    title.setColour (juce::Label::textColourId, kText);
    addAndMakeVisible (title);

    subtitle.setText ("tempo-synced gate", juce::dontSendNotification);
    subtitle.setFont (juce::Font (juce::FontOptions (11.0f)));
    subtitle.setColour (juce::Label::textColourId, kDim);
    addAndMakeVisible (subtitle);

    for (auto* slider : { &depth, &phase, &smooth, &mix, &bpm })
    {
        slider->setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
        slider->setTextBoxStyle (juce::Slider::TextBoxBelow, false, 62, 16);
        slider->setColour (juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
        styleKnob (*slider);
        addAndMakeVisible (slider);
    }

    depth.setName ("Depth");
    phase.setName ("Phase");
    smooth.setName ("Smooth");
    mix.setName ("Mix");
    bpm.setName ("Fallback BPM");

    rate.addItemList ({ "1/1", "1/2", "1/4", "1/8", "1/16", "1/32" }, 1);
    shape.addItemList ({ "Sine", "Square", "Saw", "Triangle" }, 1);
    styleMenu (rate);
    styleMenu (shape);
    addAndMakeVisible (rate);
    addAndMakeVisible (shape);

    styleCaption (rateLabel, "RATE");
    styleCaption (shapeLabel, "SHAPE");
    styleCaption (depthLabel, "DEPTH");
    styleCaption (phaseLabel, "PHASE");
    styleCaption (smoothLabel, "SMOOTH");
    styleCaption (mixLabel, "MIX");
    styleCaption (bpmLabel, "BPM");

    // Knob captions sit above their knob and are centred on it.
    for (auto* label : { &depthLabel, &phaseLabel, &smoothLabel, &mixLabel, &bpmLabel })
        label->setJustificationType (juce::Justification::centred);

    for (auto* label : { &depthLabel, &phaseLabel, &smoothLabel, &mixLabel, &bpmLabel, &rateLabel, &shapeLabel })
        addAndMakeVisible (label);

    auto& state = processor.parameters;
    depthAttachment  = std::make_unique<SliderAttachment> (state, "depth", depth);
    phaseAttachment  = std::make_unique<SliderAttachment> (state, "phase", phase);
    smoothAttachment = std::make_unique<SliderAttachment> (state, "smooth", smooth);
    mixAttachment    = std::make_unique<SliderAttachment> (state, "mix", mix);
    bpmAttachment    = std::make_unique<SliderAttachment> (state, "bpm", bpm);
    rateAttachment   = std::make_unique<MenuAttachment> (state, "rate", rate);
    shapeAttachment  = std::make_unique<MenuAttachment> (state, "shape", shape);

    startTimerHz (30);
}

ToneArtGateEditor::~ToneArtGateEditor()
{
    stopTimer();
}

void ToneArtGateEditor::styleKnob (juce::Slider& slider)
{
    slider.setColour (juce::Slider::rotarySliderFillColourId, kAccent);
    slider.setColour (juce::Slider::rotarySliderOutlineColourId, kLine);
    slider.setColour (juce::Slider::thumbColourId, kText);
    slider.setColour (juce::Slider::textBoxTextColourId, kText);
    slider.setColour (juce::Slider::textBoxBackgroundColourId, juce::Colours::transparentBlack);
}

void ToneArtGateEditor::styleCaption (juce::Label& label, const juce::String& text)
{
    label.setText (text, juce::dontSendNotification);
    label.setFont (juce::Font (juce::FontOptions (10.0f, juce::Font::bold)));
    label.setColour (juce::Label::textColourId, kDim);
    label.setJustificationType (juce::Justification::centredLeft);
}

void ToneArtGateEditor::styleMenu (juce::ComboBox& box)
{
    box.setColour (juce::ComboBox::backgroundColourId, kPanel);
    box.setColour (juce::ComboBox::outlineColourId, kLine);
    box.setColour (juce::ComboBox::textColourId, kText);
    box.setColour (juce::ComboBox::arrowColourId, kDim);
}

void ToneArtGateEditor::timerCallback()
{
    const float next = processor.displayGain();

    // Only repaint when the meter actually moved, so an idle editor is free.
    if (std::abs (next - shownGain) > 0.004f)
    {
        shownGain = next;
        repaint();
    }
}

void ToneArtGateEditor::paint (juce::Graphics& g)
{
    g.fillAll (kBackground);

    auto panel = getLocalBounds().toFloat().reduced (10.0f);
    g.setColour (kPanel);
    g.fillRoundedRectangle (panel, 8.0f);
    g.setColour (kLine);
    g.drawRoundedRectangle (panel, 8.0f, 1.0f);

    // Header rule under the name.
    g.setColour (kLine);
    g.fillRect (16, 46, getWidth() - 32, 1);

    // Gate meter: a bar that opens with the gain, with the beat ticks behind it.
    const auto meter = juce::Rectangle<int> (16, getHeight() - 26, getWidth() - 32, 10);
    g.setColour (kLine);
    g.fillRoundedRectangle (meter.toFloat(), 3.0f);

    const float width = juce::jlimit (0.0f, 1.0f, shownGain) * (float) meter.getWidth();
    if (width > 0.0f)
    {
        g.setColour (kAccent.withAlpha (0.85f));
        g.fillRoundedRectangle (meter.toFloat().withWidth (width), 3.0f);
    }

    g.setColour (kGreen);
    g.fillRect (meter.getRight() - 2, meter.getY(), 2, meter.getHeight());
}

void ToneArtGateEditor::resized()
{
    auto area = getLocalBounds().reduced (16, 12);

    auto header = area.removeFromTop (30);
    title.setBounds (header.removeFromLeft (220));
    subtitle.setBounds (header.removeFromRight (150).withTrimmedTop (7));

    area.removeFromTop (10);

    auto menus = area.removeFromTop (46);
    auto rateArea = menus.removeFromLeft (120);
    rateLabel.setBounds (rateArea.removeFromTop (14));
    rate.setBounds (rateArea.removeFromTop (26));
    menus.removeFromLeft (12);
    auto shapeArea = menus.removeFromLeft (150);
    shapeLabel.setBounds (shapeArea.removeFromTop (14));
    shape.setBounds (shapeArea.removeFromTop (26));

    area.removeFromTop (10);

    const int knobWidth = area.getWidth() / 5;
    auto captions = area.removeFromTop (12);
    auto knobs = area.removeFromTop (juce::jmin (area.getHeight() - 6, 108));

    const std::pair<juce::Label*, juce::Slider*> knobsAndLabels[] = {
        { &depthLabel, &depth },
        { &phaseLabel, &phase },
        { &smoothLabel, &smooth },
        { &mixLabel, &mix },
        { &bpmLabel, &bpm },
    };

    for (auto& [label, slider] : knobsAndLabels)
    {
        label->setBounds (captions.removeFromLeft (knobWidth));
        slider->setBounds (knobs.removeFromLeft (knobWidth).reduced (2, 0));
    }
}
