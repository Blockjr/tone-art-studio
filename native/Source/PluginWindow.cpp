#include "PluginWindow.h"

PluginEditorWindow::PluginEditorWindow (juce::AudioProcessor& pluginProcessor,
                                        std::function<void()> onClosed)
    : DocumentWindow (pluginProcessor.getName(),
                      juce::Colour (0xff14161c),
                      DocumentWindow::allButtons),
      processor (pluginProcessor),
      closedCallback (std::move (onClosed))
{
    setUsingNativeTitleBar (true);
    setResizable (true, false);

    if (auto* editor = processor.createEditorIfNeeded())
    {
        setContentOwned (editor, true);

        const auto width = juce::jmax (320, editor->getWidth());
        const auto height = juce::jmax (200, editor->getHeight());

        setResizeLimits (juce::jmax (320, width / 2), juce::jmax (200, height / 2), 4000, 3000);
        centreWithSize (width, height);
    }
    else
    {
        // A plugin without a GUI still gets a window so the user sees something.
        auto* placeholder = new juce::Label ({},
                                             pluginProcessor.getName()
                                                 + "\n\nThis plugin has no editor, but it is in the chain and processing.");
        placeholder->setJustificationType (juce::Justification::centred);
        placeholder->setFont (juce::Font (juce::FontOptions (15.0f)));
        setContentOwned (placeholder, true);
        centreWithSize (460, 240);
    }

    setVisible (true);
}

PluginEditorWindow::~PluginEditorWindow()
{
    if (auto* editor = dynamic_cast<juce::AudioProcessorEditor*> (getContentComponent()))
        processor.editorBeingDeleted (editor);

    clearContentComponent();
}

void PluginEditorWindow::closeButtonPressed()
{
    if (closedCallback)
        closedCallback();
}
