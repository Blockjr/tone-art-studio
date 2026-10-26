#pragma once

#include <JuceHeader.h>
#include "AudioEngine.h"
#include "PluginWindow.h"

class MainComponent final : public juce::Component,
                            private juce::Timer
{
public:
    MainComponent();
    ~MainComponent() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void handleCommand (const juce::var& payload);
    void sendState();
    void sendMeters();

    void openEditor (juce::AudioProcessor* processor);
    void syncEditors();
    bool processorStillLoaded (juce::AudioProcessor* processor) const;

    void loadStems (const juce::File& folder);
    void chooseStemsFolder();

    void locateUi();

    std::optional<juce::WebBrowserComponent::Resource> getResource (const juce::String& path) const;
    static juce::String mimeTypeFor (const juce::String& extension);

    AudioEngine engine;
    std::unique_ptr<juce::WebBrowserComponent> webView;
    juce::File uiDirectory;

    juce::OwnedArray<PluginEditorWindow> editorWindows;
    juce::Array<juce::AudioProcessor*> editorProcessors;
    std::unique_ptr<juce::FileChooser> stemsChooser;
    juce::String uiError;
    int ticks = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};
