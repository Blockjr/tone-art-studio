#pragma once

#include <JuceHeader.h>

/** Floating window that hosts one VST3 editor. */
class PluginEditorWindow final : public juce::DocumentWindow
{
public:
    PluginEditorWindow (juce::AudioProcessor& processor, std::function<void()> onClosed);
    ~PluginEditorWindow() override;

    void closeButtonPressed() override;

    juce::AudioProcessor& getProcessor() const noexcept { return processor; }

private:
    juce::AudioProcessor& processor;
    std::function<void()> closedCallback;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginEditorWindow)
};
