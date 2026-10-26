#include <JuceHeader.h>
#include "MainComponent.h"

class HybridStudioApplication final : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return "Tone Art Studio"; }

    // The version comes from package.json through CMake (see native/CMakeLists.txt
    // and the JUCE_APPLICATION_VERSION_STRING define): a literal here is how this
    // host went on reporting 0.1.0 long after the app shipped 0.5.x.
    const juce::String getApplicationVersion() override { return JUCE_APPLICATION_VERSION_STRING; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise (const juce::String&) override
    {
        mainWindow = std::make_unique<MainWindow> (getApplicationName());
    }

    void shutdown() override
    {
        mainWindow.reset();
    }

    void systemRequestedQuit() override
    {
        quit();
    }

    class MainWindow final : public juce::DocumentWindow
    {
    public:
        explicit MainWindow (const juce::String& name)
            : DocumentWindow (name,
                              juce::Colour (0xff08090c),
                              DocumentWindow::allButtons)
        {
            setUsingNativeTitleBar (true);
            setContentOwned (new MainComponent(), true);
            setResizable (true, false);
            setResizeLimits (1100, 700, 10000, 10000);
            centreWithSize (1500, 950);
            setVisible (true);
        }

        void closeButtonPressed() override
        {
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }
    };

private:
    std::unique_ptr<MainWindow> mainWindow;
};

START_JUCE_APPLICATION (HybridStudioApplication)
