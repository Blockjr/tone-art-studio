#include "PluginHost.h"

PluginHost::PluginHost()
{
    audioFormats.registerBasicFormats();
}

// ------------------------------------------------------------------ catalogue

juce::var PluginHost::scan()
{
    error.clear();

    {
        const juce::SpinLock::ScopedLockType guard (songLock);
        song.stop();
    }

    scanner.scan();
    error = scanner.error();
    return catalogue();
}

juce::var PluginHost::catalogue() const
{
    juce::Array<juce::var> items;

    for (const auto& plugin : scanner.plugins())
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("name", plugin.name);
        object->setProperty ("manufacturer", plugin.maker);
        object->setProperty ("category", plugin.category);
        object->setProperty ("identifier", plugin.id);
        object->setProperty ("file", plugin.path);
        object->setProperty ("instrument", plugin.instrument);
        items.add (juce::var (object));
    }

    return juce::var (items);
}

std::unique_ptr<VstInsert> PluginHost::createInsert (const juce::String& identifier)
{
    if (scanner.plugins().empty())
        scanner.scan();

    juce::String createError;
    auto insert = scanner.create (identifier, sampleRate, blockSize, createError);

    if (insert == nullptr)
    {
        error = createError.isNotEmpty() ? createError
                                        : "The plugin could not be instantiated.";
        return nullptr;
    }

    insert->prepare (sampleRate, blockSize);
    return insert;
}

// --------------------------------------------------------------- master chain

juce::var PluginHost::add (const juce::String& identifier)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    error.clear();

    if (masterChain().size() >= kMaxPlugins)
    {
        error = "The master chain is full (" + juce::String (kMaxPlugins) + " slots).";
        return chainState();
    }

    if (auto insert = createInsert (identifier))
        masterChain().add (std::move (insert));

    return chainState();
}

void PluginHost::remove (int index)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    masterChain().remove (index);
}

void PluginHost::move (int fromIndex, int toIndex)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    masterChain().move (fromIndex, toIndex);
}

void PluginHost::clear()
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    masterChain().clear();
}

juce::var PluginHost::chainState() const
{
    return describeChain (masterChain());
}

juce::var PluginHost::describeChain (const InsertChain& chain) const
{
    juce::Array<juce::var> items;

    for (int slot = 0; slot < chain.size(); ++slot)
    {
        auto* insert = chain.at (slot);

        if (insert == nullptr)
            continue;

        auto* object = new juce::DynamicObject();
        object->setProperty ("slot", slot);
        object->setProperty ("index", slot);
        object->setProperty ("name", juce::String (insert->name()));
        object->setProperty ("bypassed", chain.isBypassed (slot));
        object->setProperty ("latencySamples", insert->latencySamples());

        if (const auto* vst = dynamic_cast<const VstInsert*> (insert))
        {
            object->setProperty ("vst3", true);
            object->setProperty ("hasEditor", vst->hasEditor());
        }
        else
        {
            object->setProperty ("vst3", false);
            object->setProperty ("hasEditor", false);
        }

        items.add (juce::var (object));
    }

    return juce::var (items);
}

juce::AudioProcessor* PluginHost::getProcessor (int index) const
{
    const auto* insert = masterChain().at (index);
    const auto* vst = dynamic_cast<const VstInsert*> (insert);
    return vst != nullptr ? const_cast<VstInsert*> (vst)->plugin() : nullptr;
}

// --------------------------------------------------------- per-track VST3s

juce::var PluginHost::trackChains() const
{
    juce::Array<juce::var> tracks;

    for (int index = 0; index < song.mixer().trackCount(); ++index)
    {
        const auto& track = song.mixer().track (index);

        auto* object = new juce::DynamicObject();
        object->setProperty ("id", juce::String (track.id));
        object->setProperty ("name", juce::String (track.name));
        object->setProperty ("gainDb", track.gainDb);
        object->setProperty ("pan", track.pan);
        object->setProperty ("mute", track.mute);
        object->setProperty ("solo", track.solo);
        object->setProperty ("peakLeft", song.mixer().trackPeak (index, 0));
        object->setProperty ("peakRight", song.mixer().trackPeak (index, 1));
        object->setProperty ("chain", describeChain (track.inserts));
        tracks.add (juce::var (object));
    }

    return juce::var (tracks);
}

juce::var PluginHost::addTrackPlugin (const juce::String& trackId, const juce::String& identifier)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    error.clear();

    auto* track = song.mixer().findTrack (trackId.toStdString());

    if (track == nullptr)
    {
        error = "That track is not loaded in the native mixer.";
        return trackChains();
    }

    if (track->inserts.size() >= InsertChain::kMaxSlots)
    {
        error = "That track's insert chain is full (" + juce::String (InsertChain::kMaxSlots) + " slots).";
        return trackChains();
    }

    if (auto insert = createInsert (identifier))
        track->inserts.add (std::move (insert));

    return trackChains();
}

juce::var PluginHost::removeTrackPlugin (const juce::String& trackId, int slot)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    error.clear();

    if (auto* track = song.mixer().findTrack (trackId.toStdString()))
        track->inserts.remove (slot);

    return trackChains();
}

juce::var PluginHost::moveTrackPlugin (const juce::String& trackId, int from, int to)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    error.clear();

    if (auto* track = song.mixer().findTrack (trackId.toStdString()))
        track->inserts.move (from, to);

    return trackChains();
}

juce::var PluginHost::setTrackPluginBypass (const juce::String& trackId, int slot, bool bypassed)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    error.clear();

    if (auto* track = song.mixer().findTrack (trackId.toStdString()))
        track->inserts.setBypassed (slot, bypassed);

    return trackChains();
}

juce::AudioProcessor* PluginHost::getTrackProcessor (const juce::String& trackId, int slot) const
{
    const auto* track = song.mixer().findTrack (trackId.toStdString());

    if (track == nullptr)
        return nullptr;

    const auto* insert = track->inserts.at (slot);
    const auto* vst = dynamic_cast<const VstInsert*> (insert);
    return vst != nullptr ? const_cast<VstInsert*> (vst)->plugin() : nullptr;
}

// ------------------------------------------------------------- song playback

bool PluginHost::loadStems (const juce::File& folder, juce::String& failure)
{
    failure.clear();

    const auto manifestFile = folder.getChildFile ("stems.json");

    if (! manifestFile.existsAsFile())
    {
        failure = "stems.json is missing from " + folder.getFullPathName();
        return false;
    }

    juce::var manifest;
    const auto parsed = juce::JSON::parse (manifestFile.loadFileAsString(), manifest);

    if (parsed.failed())
    {
        failure = "stems.json is not valid JSON: " + parsed.getErrorMessage();
        return false;
    }

    auto* object = manifest.getDynamicObject();
    const auto* tracks = object != nullptr ? object->getProperty ("tracks").getArray() : nullptr;

    if (object == nullptr || tracks == nullptr || tracks->isEmpty())
    {
        failure = "stems.json has no tracks.";
        return false;
    }

    // The audio callback try-locks this; while the swap runs it outputs silence
    // rather than touching a track list that is being rebuilt.
    const juce::SpinLock::ScopedLockType guard (songLock);
    songReady.store (false);
    song.stop();
    song.clearStems();
    song.clearTracks();

    double longest = 0.0;

    for (const auto& entry : *tracks)
    {
        auto* source = entry.getDynamicObject();

        if (source == nullptr)
            continue;

        const auto id = source->getProperty ("id").toString();
        const auto name = source->getProperty ("name").toString();

        if (id.isEmpty())
            continue;

        const auto file = folder.getChildFile (source->getProperty ("file").toString());
        juce::AudioBuffer<float> buffer;
        std::unique_ptr<juce::AudioFormatReader> reader;

        if (file.existsAsFile())
            reader.reset (audioFormats.createReaderFor (file));

        if (reader != nullptr)
        {
            const auto frames = (int) juce::jmin (reader->lengthInSamples,
                                                  (juce::int64) (60.0 * 60.0 * 48000.0));

            buffer.setSize (2, juce::jmax (1, frames), false, true, true);
            reader->read (&buffer, 0, frames, 0, true, true);

            if (reader->numChannels == 1)
                buffer.copyFrom (1, 0, buffer, 0, 0, frames);
        }

        auto& track = song.addTrack (id.toStdString(), name.isNotEmpty() ? name.toStdString() : id.toStdString());
        track.gainDb = (float) (double) source->getProperty ("gainDb");
        track.pan = (float) (double) source->getProperty ("pan");
        track.mute = (bool) source->getProperty ("mute");
        track.solo = (bool) source->getProperty ("solo");

        if (buffer.getNumSamples() > 1 && reader != nullptr)
        {
            song.setStem (id.toStdString(),
                          buffer.getReadPointer (0),
                          buffer.getReadPointer (1),
                          buffer.getNumSamples(),
                          reader->sampleRate);

            longest = juce::jmax (longest, (double) buffer.getNumSamples() / reader->sampleRate);
        }
    }

    if (song.mixer().trackCount() == 0)
    {
        failure = "stems.json did not list a usable track.";
        song.clearTracks();
        return false;
    }

    song.mixer().setMasterGainDb ((float) (double) object->getProperty ("masterGainDb"));
    song.setLength (longest);
    song.prepare (sampleRate, blockSize);
    songReady.store (true);
    return true;
}

void PluginHost::unloadStems()
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    songReady.store (false);
    song.stop();
    song.clearStems();
    song.clearTracks();
    song.setLength (0.0);
    song.prepare (sampleRate, blockSize);
}

void PluginHost::setSongPlaying (bool shouldPlay)
{
    const juce::SpinLock::ScopedLockType guard (songLock);

    if (shouldPlay)
        song.play();
    else
        song.stop();
}

void PluginHost::setSongPosition (double seconds)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    song.locate (seconds);
}

void PluginHost::setSongLoop (bool enabled)
{
    const juce::SpinLock::ScopedLockType guard (songLock);

    if (song.lengthSeconds() <= 0.0)
        return;

    song.setLoop (enabled, 0.0, song.lengthSeconds());
}

void PluginHost::setTrackMix (const juce::String& trackId, float gainDb, float pan, bool mute, bool solo)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    auto* track = song.mixer().findTrack (trackId.toStdString());

    if (track == nullptr)
        return;

    track->gainDb = gainDb;
    track->pan = pan;
    track->mute = mute;
    track->solo = solo;
}

void PluginHost::processSong (juce::AudioBuffer<float>& buffer, int numSamples)
{
    const juce::SpinLock::ScopedTryLockType guard (songLock);

    if (! guard.isLocked())
    {
        buffer.clear();
        return;
    }

    song.process (buffer.getArrayOfWritePointers(), buffer.getNumChannels(), numSamples);
}

juce::var PluginHost::songState() const
{
    auto* object = new juce::DynamicObject();
    object->setProperty ("loaded", songLoaded());
    object->setProperty ("playing", song.isPlaying());
    object->setProperty ("position", song.positionSeconds());
    object->setProperty ("length", song.lengthSeconds());
    object->setProperty ("loop", song.loopEnabled());
    object->setProperty ("latencySamples", song.mixer().latencySamples());
    object->setProperty ("masterPeakLeft", song.mixer().masterPeak (0));
    object->setProperty ("masterPeakRight", song.mixer().masterPeak (1));
    object->setProperty ("masterChain", describeChain (masterChain()));
    object->setProperty ("tracks", trackChains());
    return juce::var (object);
}

// ------------------------------------------------------------------- device

void PluginHost::prepare (double newSampleRate, int newBlockSize)
{
    const juce::SpinLock::ScopedLockType guard (songLock);
    sampleRate = newSampleRate > 0.0 ? newSampleRate : 44100.0;
    blockSize = juce::jmax (16, newBlockSize);

    song.prepare (sampleRate, blockSize);

    for (int slot = 0; slot < masterChain().size(); ++slot)
        if (auto* insert = masterChain().at (slot))
            insert->prepare (sampleRate, blockSize);

    for (int index = 0; index < song.mixer().trackCount(); ++index)
    {
        auto& track = song.mixer().track (index);

        for (int slot = 0; slot < track.inserts.size(); ++slot)
            if (auto* insert = track.inserts.at (slot))
                insert->prepare (sampleRate, blockSize);
    }
}

void PluginHost::process (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused (midi);

    masterChain().process (buffer.getArrayOfWritePointers(),
                           juce::jmin (2, buffer.getNumChannels()),
                           buffer.getNumSamples());
}
