#include "MainComponent.h"

#include <cstring>

MainComponent::MainComponent()
{
    setOpaque (true);
    locateUi();

    auto options = juce::WebBrowserComponent::Options{}
                       .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
                       .withNativeIntegrationEnabled()
                       .withKeepPageLoadedWhenBrowserIsHidden()
                       .withInitialisationData ("hybridNative", juce::var (true))
                       .withEventListener ("hybridCommand", [this] (juce::var payload)
                                           { handleCommand (payload); });

    if (uiDirectory.isDirectory())
        options = options.withResourceProvider ([this] (const juce::String& path)
                                                 { return getResource (path); });

    webView = std::make_unique<juce::WebBrowserComponent> (options);
    addAndMakeVisible (*webView);

    if (uiDirectory.isDirectory())
        webView->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());
    else
        webView->goToURL (hostedUiUrl());

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

    // Only visible when the web view has not painted over the window yet, i.e.
    // during a slow first load. It is deliberately plain so a failure reads as
    // a message instead of an unexplained white window.
    graphics.setColour (juce::Colour (0xff93a0b8));
    graphics.setFont (juce::FontOptions (14.0f));
    graphics.drawText (uiDirectory.isDirectory()
                           ? "Loading Tone Art Studio\xe2\x80\xa6"
                           : "Loading Tone Art Studio from the web\xe2\x80\xa6",
                       getLocalBounds().reduced (24).removeFromTop (40),
                       juce::Justification::centredTop);
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
