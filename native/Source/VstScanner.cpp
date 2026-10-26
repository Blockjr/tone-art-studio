#include "VstScanner.h"

namespace hybrid
{

namespace
{
    juce::AudioPluginFormat* findVst3Format (juce::AudioPluginFormatManager& manager)
    {
        for (auto* format : manager.getFormats())
            if (format->getName().containsIgnoreCase ("VST3"))
                return format;

        return nullptr;
    }

    void collectBundles (const juce::File& folder, std::vector<juce::File>& found, int depth)
    {
        if (! folder.isDirectory() || depth > 6)
            return;

        for (const auto& entry : juce::RangedDirectoryIterator (folder, false))
        {
            const auto file = entry.getFile();

            if (file.isDirectory())
            {
                // On Windows and macOS a VST3 is a bundle directory; treat it as
                // one plug-in and do not descend into its Contents folder.
                if (file.hasFileExtension ("vst3"))
                    found.push_back (file);
                else
                    collectBundles (file, found, depth + 1);
            }
            else if (file.hasFileExtension ("vst3"))
            {
                found.push_back (file);
            }
        }
    }

    juce::String normaliseCategory (const juce::String& category)
    {
        if (category.isEmpty())
            return "Effect";

        return category.upToFirstOccurrenceOf ("|", false, false).trim();
    }
}

juce::StringArray VstScanner::defaultFolders()
{
    juce::StringArray folders;

    const auto add = [&folders] (const juce::File& folder)
    {
        if (folder.isDirectory() && ! folders.contains (folder.getFullPathName()))
            folders.add (folder.getFullPathName());
    };

   #if JUCE_WINDOWS
    // JUCE 9 renamed the special location to windowsProgramFilesCommon. The
    // system-wide VST3 folder is Common Files\VST3; the second entry covers a
    // per-machine install that a user pointed at Program Files.
    add (juce::File::getSpecialLocation (juce::File::windowsProgramFilesCommon).getChildFile ("VST3"));
    add (juce::File::getSpecialLocation (juce::File::globalApplicationsDirectory).getChildFile ("VST3"));
   #elif JUCE_MAC
    add (juce::File ("/Library/Audio/Plug-Ins/VST3"));
    add (juce::File ("~/Library/Audio/Plug-Ins/VST3"));
   #else
    add (juce::File ("~/.vst3"));
    add (juce::File ("/usr/lib/vst3"));
    add (juce::File ("/usr/local/lib/vst3"));
   #endif

    // VST3_PATH is part of the plug-in spec and lets users point at a custom
    // folder without moving bundles around.
    const auto envPath = juce::SystemStats::getEnvironmentVariable ("VST3_PATH", {});
    if (envPath.isNotEmpty())
    {
        for (const auto& part : juce::StringArray::fromTokens (envPath, ";:", ""))
            if (part.trim().isNotEmpty())
                add (juce::File (part.trim()));
    }

    return folders;
}

void VstScanner::ensureFormats()
{
    if (manager.getNumFormats() > 0)
        return;

   #if defined(HYBRID_HEADLESS)
    juce::addHeadlessDefaultFormatsToManager (manager);
   #else
    // JUCE 9 replaced AudioPluginFormatManager::addDefaultFormats() with a free
    // function so the UI and headless builds can share the manager.
    juce::addDefaultFormatsToManager (manager);
   #endif
}

void VstScanner::scan()
{
    entries.clear();
    descriptions.clear();
    errorMessage.clear();

    ensureFormats();

    auto* format = findVst3Format (manager);
    if (format == nullptr)
    {
        errorMessage = "The VST3 format is not available in this build.";
        return;
    }

    const auto folders = defaultFolders();
    if (folders.isEmpty())
    {
        errorMessage = "No VST3 folder was found. Install a plug-in or set VST3_PATH.";
        return;
    }

    std::vector<juce::File> bundles;
    for (const auto& folder : folders)
        collectBundles (juce::File (folder), bundles, 0);

    int failed = 0;
    for (const auto& bundle : bundles)
    {
        juce::OwnedArray<juce::PluginDescription> types;
        format->findAllTypesForFile (types, bundle.getFullPathName());

        if (types.isEmpty())
        {
            ++failed;
            continue;
        }

        for (auto* description : types)
        {
            if (description == nullptr)
                continue;

            Entry entry;
            entry.id = description->createIdentifierString();
            entry.name = description->name;
            entry.maker = description->manufacturerName;
            entry.category = normaliseCategory (description->category);
            entry.path = description->fileOrIdentifier;
            entry.instrument = description->isInstrument;

            entries.push_back (entry);
            descriptions.push_back (*description);
        }
    }

    if (entries.empty())
    {
        errorMessage = failed > 0
                          ? "VST3 plug-ins were found but none could be loaded."
                          : "No VST3 plug-ins found in " + folders.joinIntoString (", ");
    }
}

std::unique_ptr<VstInsert> VstScanner::create (const juce::String& identifier,
                                              double sampleRate,
                                              int blockSize,
                                              juce::String& error)
{
    error.clear();

    ensureFormats();

    const juce::PluginDescription* description = nullptr;
    for (const auto& candidate : descriptions)
    {
        if (candidate.createIdentifierString() == identifier)
        {
            description = &candidate;
            break;
        }
    }

    if (description == nullptr)
    {
        error = "That plug-in is no longer in the scanned list. Rescan and try again.";
        return nullptr;
    }

    juce::String createError;
    auto instance = manager.createPluginInstance (*description,
                                                  sampleRate > 0 ? sampleRate : 48000.0,
                                                  blockSize > 0 ? blockSize : 512,
                                                  createError);

    if (instance == nullptr)
    {
        error = createError.isNotEmpty()
                  ? createError
                  : "The plug-in failed to instantiate. Is it licensed and installed for this user?";
        return nullptr;
    }

    auto insert = std::make_unique<VstInsert> (std::move (instance));
    insert->prepare (sampleRate > 0 ? sampleRate : 48000.0, blockSize > 0 ? blockSize : 512);
    return insert;
}

} // namespace hybrid
