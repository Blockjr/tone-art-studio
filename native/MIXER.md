# Native mixer and per-track VST3 hosting

Browsers cannot load VST3 binaries, so the desktop build owns the plugin path.
The browser still composes and prints the song; the native host plays those
stems and gives every track its own VST3 chain.

## What the desktop build does

- **Scans VST3** in the standard folders (plus `VST3_PATH`), on demand.
- **Plays a song** from stem files: `Studio Rig → Export stems…` writes one WAV
  per track and a `stems.json` manifest; `Load folder…` reads them back.
- **Hosts a VST3 chain per track** (`native/Core` mix graph slot order), with
  bypass, reorder, remove, up to eight slots, and a net editor window per plugin.
- **Hosts a master chain** with the same controls.
- **Runs the transport** on the audio device clock: play, stop, locate, loop,
  position and master meters, reported to the web UI.
- **Applies the channel strip** recorded in the manifest: fader in dB, pan,
  mute and solo — so solo still works while mixing through VSTs.
- **Processes live ASIO input** through the master chain when no stems are
  loaded, as before.

Files:

| file | job |
| --- | --- |
| `Core/MixGraph.*` | tracks, insert chains, gain/pan/mute/solo, master, meters (JUCE-free) |
| `Core/SongPlayer.*` | stem playback, resampling, transport, loop (JUCE-free) |
| `Source/VstInsert.*` | `AudioPluginInstance` as an `Insert`; state save/restore |
| `Source/VstScanner.*` | VST3 folders, bundle scan, instantiation |
| `Source/PluginHost.*` | catalogue, per-track/master chains, `stems.json`, transport |
| `Source/AudioEngine.*` | device callback: song mode or live input |
| `Source/MainComponent.*` | bridge commands, state/meters events, plugin editors |

Headless tests cover the graph and the player, including stem resampling, loop
wrap, fader ramps and oversized blocks:

```bash
native/Core/build-tests.sh      # 69 checks, no JUCE, no audio device
```

`PluginHost` (stems → graph → output) compiles against JUCE 9's headless
processors module, so the adapter and loader can be checked without a sound
card; `.github/workflows/native-core.yml` runs the core tests and
`native-windows.yml` builds and links the full app.

## The stem hand-off

The browser renders one track at a time with the same offline path used by Bounce
and Mixdown, but with `forStems`: post-insert, pre-fader, no sends, no master
rack and no master fader. `stems.json` then carries what the native mixer needs:

```json
{
  "format": "hstudio-stems",
  "version": 1,
  "bpm": 124,
  "sampleRate": 48000,
  "masterGainDb": -3.2,
  "length": 187.4,
  "tracks": [
    { "id": "…", "name": "Lead Vox", "file": "01-lead-vox.wav",
      "gainDb": -4.1, "pan": -0.1, "mute": false, "solo": false }
  ]
}
```

The folder is chosen with the File System Access API, so the desktop shell can
read the same path with `juce::File`. Nothing travels over the WebView bridge:
no base64 audio, no multi-megabyte JSON.

## Bridge commands

Implemented in `src/native/bridge.ts` and `MainComponent.cpp`:

| command | payload |
| --- | --- |
| `scanPlugins` | — |
| `addPlugin`, `removePlugin`, `movePlugin`, `clearPlugins` | master chain |
| `openPluginEditor` | `index` |
| `addTrackPlugin` | `trackId`, `identifier` |
| `removeTrackPlugin` | `trackId`, `slot` |
| `moveTrackPlugin` | `trackId`, `from`, `to` |
| `setTrackPluginBypass` | `trackId`, `slot`, `bypassed` |
| `openTrackPluginEditor` | `trackId`, `slot` |
| `chooseStemsFolder` / `loadStems` / `unloadStems` | folder picker or `path` |
| `songPlay` | `playing` |
| `songLocate` | `seconds` |
| `songLoop` | `enabled` |
| `setTrackMix` | `trackId`, `gainDb`, `pan`, `mute`, `solo` |

`hybridState` pushes `song: { loaded, playing, position, length, loop,
masterChain, tracks: [{ id, name, gainDb, pan, mute, solo, chain }] }`;
`hybridMeters` adds the transport position and master peaks at 15 Hz.

## Real-time rules

- No allocation, locks, file I/O or JSON on the audio thread. Stems are loaded
  on the message thread and swapped in while the transport is stopped.
- Plugins are prepared with the device sample rate and maximum block size; the
  player splits a larger driver block instead of dropping it.
- Stems are resampled with a cubic interpolator when their rate differs from the
  device rate; all tracks read from one transport position.
- Latency is reported per chain but not compensated across tracks yet.
- A misbehaving plugin takes the audio thread with it; crash-isolated hosting is
  a later hardening step.

## Current status

| Stage | Status |
| --- | --- |
| Mix graph with per-track chains | Done, tested |
| VST3 adapter and per-track host | Done |
| Stem printing + manifest (browser) | Done |
| Native stem playback and transport | Done |
| Bridge commands and Studio Rig UI | Done |
| Plugin editor windows per track | Done |
| Chain layouts saved in the project | Not started |
| Native clip/instrument playback (no print step) | Not started |
| Windows build and real-plugin smoke test | CI build only; no plugin in the repo |

## Next steps

1. Persist chain layouts (identifier, bypass, base64 state) in the `.hstudio`
   document and restore them when the project opens.
2. Replace the print step with native track sources — port the clip and
   instrument engines, then the stems become an export option rather than the
   playback path.
3. Delay-compensate tracks by the reported chain latency.
4. Add a CI smoke test with a known free VST3 that processes a sine and checks
   the output changed.
