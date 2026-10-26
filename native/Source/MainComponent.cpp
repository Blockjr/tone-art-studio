#include "MainComponent.h"

#include <cstring>

#if JUCE_WINDOWS
/**
 * Version of the WebView2 Evergreen runtime, or empty when it is not installed.
 *
 * The runtime is what actually draws this app's interface. When it is missing
 * JUCE cannot create a browser at all, so the window stays a blank white
 * rectangle with nothing to click. Reading the version up front lets the app
 * say so instead, and lets setup install it before the first launch.
 */
static juce::String findWebView2Version()
{
    // Both machine-wide and per-user installs are valid, and 64-bit Windows
    // keeps the machine-wide key under WOW6432Node.
    const juce::String keys[]
    {
        "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    };

    for (const auto& key : keys)
    {
        const auto version = juce::WindowsRegistry::getValue (key + "\\pv");

        if (version.isNotEmpty() && version != "0.0.0.0")
            return version;
    }

    return {};
}
#else
static juce::String findWebView2Version() { return "not applicable on this platform"; }
#endif

MainComponent::MainComponent()
{
    setOpaque (true);
    startedAt = juce::Time::getMillisecondCounterHiRes();
    locateUi();
    webView2Version = findWebView2Version();

    writeLog ("Tone Art Studio starting");
    writeLog ("interface folder: "
              + (uiDirectory.isDirectory() ? uiDirectory.getFullPathName()
                                           : juce::String ("not installed")));
    writeLog ("WebView2 runtime: "
              + (webView2Version.isEmpty() ? juce::String ("not installed") : webView2Version));

    if (webView2Version.isEmpty())
    {
        uiError = "The Microsoft Edge WebView2 runtime is not installed.";
        writeLog ("no browser created: the WebView2 runtime is missing");
        setMouseCursor (juce::MouseCursor::PointingHandCursor);
    }
    else
    {
        auto options = juce::WebBrowserComponent::Options{}
                           .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
                           .withNativeIntegrationEnabled()
                           .withKeepPageLoadedWhenBrowserIsHidden()
                           .withInitialisationData ("hybridNative", juce::var (true))
                           .withEventListener ("hybridCommand", [this] (juce::var payload)
                                               { handleCommand (payload); })
                           .withEventListener ("hybridReady", [this] (juce::var payload)
                                               {
                                                   uiReady = true;
                                                   writeLog ("interface ready: " + payload.toString());
                                                   repaint();
                                               });

        if (uiDirectory.isDirectory())
            options = options.withResourceProvider ([this] (const juce::String& path)
                                                     { return getResource (path); });

        webView = std::make_unique<juce::WebBrowserComponent> (options);
        addAndMakeVisible (*webView);
        webView->setBounds (getLocalBounds());

        if (uiDirectory.isDirectory())
            webView->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());
        else
            webView->goToURL (hostedUiUrl());
    }

    engine.openDevice ({}, {});
    setSize (1500, 950);
    startTimerHz (15);
}

MainComponent::~MainComponent()
{
    stopTimer();
    editorProcessors.clear();
    editorWindows.clear();
}

void MainComponent::locateUi()
{
    const auto configured = juce::SystemStats::getEnvironmentVariable ("HYBRID_UI_DIR", {});

    if (configured.isNotEmpty() && juce::File (configured).getChildFile ("index.html").existsAsFile())
    {
        uiDirectory = juce::File (configured);
        return;
    }

    const auto executableDirectory = juce::File::getSpecialLocation (juce::File::currentExecutableFile)
                                         .getParentDirectory();

    const juce::Array<juce::File> candidates
    {
        executableDirectory.getChildFile ("ui"),
        executableDirectory.getParentDirectory().getChildFile ("ui"),
        executableDirectory.getChildFile ("dist")
    };

    for (const auto& candidate : candidates)
    {
        if (candidate.getChildFile ("index.html").existsAsFile())
        {
            uiDirectory = candidate;
            return;
        }
    }

    uiDirectory = juce::File();
}

/**
 * Where the window goes when no local ui/ folder is next to the executable.
 *
 * This used to be http://localhost:3000, which is only correct on a developer's
 * machine: an installed copy without its ui/ folder then opened to a blank
 * white page with nothing to click. The hosted build is the same interface, so
 * an installed app always has something usable to show, and the native bridge
 * still works because the resource provider is not involved.
 */
juce::String MainComponent::hostedUiUrl()
{
    const auto override = juce::SystemStats::getEnvironmentVariable ("HYBRID_UI_URL", {});

    if (override.isNotEmpty())
        return override;

    return "https://site-f5f03b496a2a42d89332792b1c0dd1e5.freebuff.page/";
}

void MainComponent::paint (juce::Graphics& graphics)
{
    graphics.fillAll (juce::Colour (0xff08090c));

    // A window that never painted its interface has to say why: a missing
    // WebView2 runtime, an app installed without its ui folder, or a page that
    // threw before it rendered. Twelve seconds is long enough that a slow disk
    // is not mistaken for a failure.
    const auto waited = juce::Time::getMillisecondCounterHiRes() - startedAt;

    if (webView == nullptr || (! uiReady && waited > 12000.0))
    {
        drawProblem (graphics);
        return;
    }

    // Only visible while the page is still loading: it is deliberately plain so
    // that a slow start reads as progress, not as a hang.
    graphics.setColour (juce::Colour (0xff93a0b8));
    graphics.setFont (juce::FontOptions (14.0f));
    graphics.drawText (uiDirectory.isDirectory()
                           ? "Loading Tone Art Studio\xe2\x80\xa6"
                           : "Loading Tone Art Studio from the web\xe2\x80\xa6",
                       getLocalBounds().reduced (24).removeFromTop (40),
                       juce::Justification::centredTop);
}

void MainComponent::drawProblem (juce::Graphics& graphics) const
{
    auto area = getLocalBounds().reduced (40);
    const auto missingRuntime = webView2Version.isEmpty();

    graphics.setColour (juce::Colour (0xffe8ecf5));
    graphics.setFont (juce::FontOptions (19.0f));
    graphics.drawText (missingRuntime ? "Tone Art Studio needs its drawing engine"
                                      : "Tone Art Studio could not load its interface",
                       area.removeFromTop (30), juce::Justification::centredTop);

    graphics.setColour (juce::Colour (0xff93a0b8));
    graphics.setFont (juce::FontOptions (14.0f));
    area.removeFromTop (10);

    const auto body = missingRuntime
        ? juce::String ("Windows draws this app with the Microsoft Edge WebView2 runtime, and it is\n"
                        "not installed on this PC. It is free, made by Microsoft, and takes about\n"
                        "a minute to install.\n\n"
                        "Click anywhere in this window to open the download page, install the\n"
                        "runtime, then start Tone Art Studio again.")
        : juce::String ("The page did not finish loading. This is what the app found:\n\n"
                        "    interface folder: ")
              + (uiDirectory.isDirectory() ? uiDirectory.getFullPathName()
                                           : juce::String ("not installed"))
              + "\n    WebView2 runtime: " + webView2Version
              + "\n    log: " + logPath
              + "\n\nClick anywhere in this window to open the WebView2 page. Installing or\n"
                "repairing that runtime fixes this most of the time.";

    graphics.drawFittedText (body, area.removeFromTop (200), juce::Justification::centredTop, 12);
}

void MainComponent::writeLog (const juce::String& line)
{
    const auto folder = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                            .getChildFile ("Tone Art Studio");

    if (! folder.isDirectory() && ! folder.createDirectory().wasOk())
        return;

    const auto file = folder.getChildFile ("webview.log");
    logPath = file.getFullPathName();

    if (file.getSize() > 256 * 1024)
        file.deleteFile();

    file.appendText (juce::Time::getCurrentTime().toString (true, true) + "  " + line + "\n");
}

void MainComponent::mouseDown (const juce::MouseEvent&)
{
    if (webView != nullptr && uiReady)
        return;

    writeLog ("opened the WebView2 download page");
    juce::URL ("https://developer.microsoft.com/microsoft-edge/webview2/")
        .launchInDefaultBrowser();
}

void MainComponent::resized()
{
    if (webView != nullptr)
        webView->setBounds (getLocalBounds());
}

void MainComponent::timerCallback()
{
    ++ticks;
    engine.refreshLoopback();
    sendMeters();

    // The page can take a moment to load; repeat the full state for a few
    // seconds so the Studio Rig panel always receives an initial snapshot.
    if (ticks <= 160 && ticks % 20 == 0)
        sendState();

    // About once a second, so the diagnostic panel appears on its own if the
    // interface never reports ready.
    if (! uiReady && ticks % 15 == 0)
        repaint();
}

void MainComponent::sendMeters()
{
    if (webView == nullptr)
        return;

    auto* meters = new juce::DynamicObject();
    meters->setProperty ("left", engine.peak (0));
    meters->setProperty ("right", engine.peak (1));
    meters->setProperty ("loopback", engine.loopbackStatus());

    const auto& song = engine.getPluginHost().getSong();
    auto* transport = new juce::DynamicObject();
    transport->setProperty ("loaded", song.hasStems());
    transport->setProperty ("playing", song.isPlaying());
    transport->setProperty ("position", song.positionSeconds());
    transport->setProperty ("length", song.lengthSeconds());
    transport->setProperty ("loop", song.loopEnabled());
    transport->setProperty ("left", song.mixer().masterPeak (0));
    transport->setProperty ("right", song.mixer().masterPeak (1));
    meters->setProperty ("song", juce::var (transport));

    webView->emitEventIfBrowserIsVisible ("hybridMeters", juce::var (meters));
}

void MainComponent::handleCommand (const juce::var& payload)
{
    auto* object = payload.getDynamicObject();

    if (object == nullptr)
        return;

    auto& pluginHost = engine.getPluginHost();
    const auto type = object->getProperty ("type").toString();

    if (type == "openDevice")
    {
        engine.openDevice (object->getProperty ("deviceType").toString(),
                           object->getProperty ("deviceName").toString());
    }
    else if (type == "listDevices")
    {
        // Nothing to do: sendState() refreshes the list.
    }
    else if (type == "scanPlugins")
    {
        pluginHost.scan();
    }
    else if (type == "addPlugin")
    {
        pluginHost.add (object->getProperty ("identifier").toString());
    }
    else if (type == "removePlugin")
    {
        pluginHost.remove ((int) object->getProperty ("index"));
        syncEditors();
    }
    else if (type == "movePlugin")
    {
        pluginHost.move ((int) object->getProperty ("from"), (int) object->getProperty ("to"));
    }
    else if (type == "clearPlugins")
    {
        pluginHost.clear();
        syncEditors();
    }
    else if (type == "openPluginEditor")
    {
        openEditor (pluginHost.getProcessor ((int) object->getProperty ("index")));
    }
    else if (type == "addTrackPlugin")
    {
        pluginHost.addTrackPlugin (object->getProperty ("trackId").toString(),
                                   object->getProperty ("identifier").toString());
    }
    else if (type == "removeTrackPlugin")
    {
        pluginHost.removeTrackPlugin (object->getProperty ("trackId").toString(),
                                      (int) object->getProperty ("slot"));
        syncEditors();
    }
    else if (type == "moveTrackPlugin")
    {
        pluginHost.moveTrackPlugin (object->getProperty ("trackId").toString(),
                                    (int) object->getProperty ("from"),
                                    (int) object->getProperty ("to"));
    }
    else if (type == "setTrackPluginBypass")
    {
        pluginHost.setTrackPluginBypass (object->getProperty ("trackId").toString(),
                                         (int) object->getProperty ("slot"),
                                         (bool) object->getProperty ("bypassed"));
    }
    else if (type == "openTrackPluginEditor")
    {
        openEditor (pluginHost.getTrackProcessor (object->getProperty ("trackId").toString(),
                                                  (int) object->getProperty ("slot")));
    }
    else if (type == "chooseStemsFolder")
    {
        chooseStemsFolder();
    }
    else if (type == "loadStems")
    {
        loadStems (juce::File (object->getProperty ("path").toString()));
    }
    else if (type == "unloadStems")
    {
        pluginHost.unloadStems();
        uiError.clear();
        syncEditors();
    }
    else if (type == "songPlay")
    {
        pluginHost.setSongPlaying ((bool) object->getProperty ("playing"));
    }
    else if (type == "songLocate")
    {
        pluginHost.setSongPosition ((double) object->getProperty ("seconds"));
    }
    else if (type == "songLoop")
    {
        pluginHost.setSongLoop ((bool) object->getProperty ("enabled"));
    }
    else if (type == "setTrackMix")
    {
        pluginHost.setTrackMix (object->getProperty ("trackId").toString(),
                                (float) (double) object->getProperty ("gainDb"),
                                (float) (double) object->getProperty ("pan"),
                                (bool) object->getProperty ("mute"),
                                (bool) object->getProperty ("solo"));
    }
    else if (type == "setLoopback")
    {
        engine.setLoopbackEnabled ((bool) object->getProperty ("enabled"));
    }
    else if (type == "setGain")
    {
        engine.setInputGain ((float) (double) object->getProperty ("value"));
    }
    else if (type == "testTone")
    {
        engine.setTestTone ((bool) object->getProperty ("on"),
                            (double) object->getProperty ("frequency"));
    }

    sendState();
}

void MainComponent::chooseStemsFolder()
{
    stemsChooser = std::make_unique<juce::FileChooser> (
        "Choose the folder that holds stems.json and the stem WAVs",
        juce::File::getSpecialLocation (juce::File::userMusicDirectory),
        "*");

    stemsChooser->launchAsync (juce::FileBrowserComponent::openMode
                                   | juce::FileBrowserComponent::canSelectDirectories,
                               [this] (const juce::FileChooser& chooser)
                               {
                                   const auto folder = chooser.getResult();

                                   if (folder.isDirectory())
                                       loadStems (folder);
                               });
}

void MainComponent::loadStems (const juce::File& folder)
{
    auto& pluginHost = engine.getPluginHost();
    juce::String failure;

    if (pluginHost.loadStems (folder, failure))
    {
        uiError.clear();
    }
    else
    {
        uiError = failure.isNotEmpty() ? failure : "The stems folder could not be loaded.";
    }

    syncEditors();
    sendState();
}

void MainComponent::openEditor (juce::AudioProcessor* processor)
{
    if (processor == nullptr)
        return;

    for (int i = 0; i < editorWindows.size(); ++i)
    {
        if (editorProcessors[i] == processor)
        {
            editorWindows[i]->toFront (true);
            return;
        }
    }

    auto* window = new PluginEditorWindow (*processor, [this, processor]
    {
        // Deferred: the window is still on the stack inside this callback.
        juce::MessageManager::callAsync ([this, processor]
        {
            for (int i = editorWindows.size(); --i >= 0;)
            {
                if (editorProcessors[i] == processor)
                {
                    editorWindows.remove (i);
                    editorProcessors.remove (i);
                }
            }
        });
    });

    editorWindows.add (window);
    editorProcessors.add (processor);
}

void MainComponent::syncEditors()
{
    for (int i = editorWindows.size(); --i >= 0;)
    {
        if (! processorStillLoaded (editorProcessors[i]))
        {
            editorWindows.remove (i);
            editorProcessors.remove (i);
        }
    }
}

bool MainComponent::processorStillLoaded (juce::AudioProcessor* processor) const
{
    auto& pluginHost = engine.getPluginHost();

    for (int slot = 0; slot < PluginHost::kMaxPlugins; ++slot)
        if (pluginHost.getProcessor (slot) == processor)
            return true;

    const auto& mixer = pluginHost.getSong().mixer();

    for (int track = 0; track < mixer.trackCount(); ++track)
    {
        const auto& inserts = mixer.track (track).inserts;

        for (int slot = 0; slot < inserts.size(); ++slot)
        {
            const auto* insert = inserts.at (slot);
            const auto* vst = dynamic_cast<const VstInsert*> (insert);

            if (vst != nullptr && vst->plugin() == processor)
                return true;
        }
    }

    return false;
}

void MainComponent::sendState()
{
    if (webView == nullptr)
        return;

    auto& pluginHost = engine.getPluginHost();

    auto* state = new juce::DynamicObject();
    state->setProperty ("available", true);
    state->setProperty ("platform", juce::SystemStats::getOperatingSystemName());
    state->setProperty ("device", engine.status());
    state->setProperty ("loopback", engine.loopbackStatus());

    juce::Array<juce::var> types;

    for (const auto& name : engine.deviceTypes())
        types.add (name);

    state->setProperty ("deviceTypes", juce::var (types));
    state->setProperty ("devices", engine.listDevices());
    state->setProperty ("plugins", pluginHost.catalogue());
    state->setProperty ("chain", pluginHost.chainState());
    state->setProperty ("song", pluginHost.songState());
    state->setProperty ("pluginCount", pluginHost.pluginCount());
    state->setProperty ("lastError", uiError.isNotEmpty() ? uiError : pluginHost.lastError());
    state->setProperty ("uiSource",
                        uiDirectory.isDirectory() ? uiDirectory.getFullPathName()
                                                  : juce::String ("http://localhost:3000"));

    webView->emitEventIfBrowserIsVisible ("hybridState", juce::var (state));
}

std::optional<juce::WebBrowserComponent::Resource> MainComponent::getResource (const juce::String& path) const
{
    if (! uiDirectory.isDirectory())
        return std::nullopt;

    auto cleanPath = path.upToFirstOccurrenceOf ("?", false, false);

    if (cleanPath.isEmpty() || cleanPath == "/")
        cleanPath = "/index.html";

    if (cleanPath.contains (".."))
        return std::nullopt;

    const auto relativePath = cleanPath.startsWith ("/") ? cleanPath.substring (1) : cleanPath;
    const auto file = uiDirectory.getChildFile (relativePath);

    if (! file.existsAsFile())
        return std::nullopt;

    juce::MemoryBlock block;

    if (! file.loadFileAsData (block))
        return std::nullopt;

    std::vector<std::byte> bytes (block.getSize());

    if (block.getSize() > 0)
        std::memcpy (bytes.data(), block.getData(), block.getSize());

    return juce::WebBrowserComponent::Resource
    {
        std::move (bytes),
        mimeTypeFor (file.getFileExtension())
    };
}

juce::String MainComponent::mimeTypeFor (const juce::String& extension)
{
    const auto ext = extension.toLowerCase();

    if (ext == ".html" || ext == ".htm") return "text/html";
    if (ext == ".js" || ext == ".mjs") return "text/javascript";
    if (ext == ".css") return "text/css";
    if (ext == ".json") return "application/json";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".png") return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".ico") return "image/x-icon";
    if (ext == ".woff2") return "font/woff2";

    return "application/octet-stream";
}
