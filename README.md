# Tone Art Studio — native host (JUCE, ASIO, VST3)

The browser app is the UI. This folder is the desktop host that runs it in
WebView2 with a native audio path, so ASIO devices, VST3 plugins and the virtual
ASIO driver are available. The UI is unchanged: `src/native/bridge.ts` talks to
the host over JUCE's WebView bridge (`window.__JUCE__`).

```
native/
  CMakeLists.txt          app target (JUCE 9.0.4, WebView2, ASIO, VST3)
  Source/
    Main.cpp              application + main window
    MainComponent.*       WebView2 shell, command/state bridge, plugin editors
    AudioEngine.*         device management, ASIO, loopback routing, meters
    PluginHost.*          VST3 scan + ordered master chain (max 8)
    PluginWindow.*        floating plugin editor windows
    VirtualAsioPeer.*     studio side of the virtual driver's shared memory
    HybridAsioShared.h    shared-memory ring protocol
  VirtualAsio/            the virtual ASIO driver DLL (optional target)
    VirtualAsioDriver.*   IASIO implementation
    DriverModule.cpp      COM class factory + registry registration
    self-test.cpp         the bridge self-test: the driver, in one process
    install.ps1           elevated register/unregister
    README.md             driver details and limits
  tests/                  ring-protocol tests (no JUCE, no Windows, no audio device)
    asio-ring-tests.cpp   round trips, wraparound, overflow, underrun, reset
    build-tests.sh        builds and runs them, used by native-core.yml
  Plugins/ToneArtGate/    the bundled VST3 (separate target, builds on any OS)
    PluginProcessor.*     tempo-synced gate DSP + parameters
    PluginEditor.*        faceplate
```

## Requirements

- Windows 10/11 x64, Visual Studio 2022 (Desktop C++ workload, Windows SDK)
- CMake 3.25+, Git
- Node 20+ for the web UI build
- The **Steinberg ASIO SDK**, which ships as a submodule of JUCE. JUCE's CMake
  fetch does not initialise submodules, so do it explicitly:

  ```
  cmake -S native -B native/build -G "Visual Studio 17 2022" -A x64
  git -C native/build/_deps/juce-src submodule update --init --recursive
  ```

  (or download the SDK from Steinberg and pass `-DASIO_SDK_DIR=<sdk root>`)

## Build

```
npm install
npm run build                     # produces dist/, copied next to the .exe as ui/
cmake --build native/build --config Release --parallel
```

The executable appears under `native/build/HybridStudio_artefacts/Release/`.
It loads `ui/` from its own folder; set `HYBRID_UI_DIR` to point at another
build, or run `npm run dev` and the host falls back to `http://localhost:3000`.

Add the virtual driver (off by default, needs the ASIO SDK headers):

```
cmake -S native -B native/build -DHYBRID_BUILD_VIRTUAL_ASIO=ON
cmake --build native/build --config Release --parallel
```

## Bundled VST3: Tone Art Gate

`ToneArtGate` is a real VST3 built from this project (`FORMATS VST3`, no
Standalone). It is a tempo-synced volume gate: it reads the host's BPM and PPQ
position so the pattern stays locked to the bar, with rate divisions from 1/1 to
1/32, sine/square/saw/triangle shapes, depth, phase, a smoothing control for the
hard shapes, and a wet/dry mix. Every control is an automatable parameter and
the state is saved with the VST3 preset.

```
cmake --build native/build --config Release --target ToneArtGate
```

The bundle appears under
`native/build/ToneArtGate_artefacts/Release/VST3/Tone Art Gate.vst3`;
the installer copies it to `Common Files\VST3`, which is where the host's
**Scan** looks. Build without it with `-DHYBRID_BUILD_GATE_VST3=OFF`.

## The Studio Rig panel

Open **Studio Rig** in the top bar. Inside the desktop host it shows:

- **Audio device** — every output device grouped as virtual ASIO, ASIO, system,
  with an Open button. ASIO is chosen automatically when present. Virtual
  drivers (ASIO4ALL, VoiceMeeter, FL Studio ASIO, ASIO Link, this one) are
  flagged, and a virtual device with no inputs is retried output-only.
- **Virtual ASIO loopback** — arms the shared-memory bridge to
  *Tone Art Virtual ASIO* and shows sample rate, block size, queue depth
  and overrun counters.
- **VST3 chain** — scan the standard folders, filter, add up to eight plugins,
  reorder, remove, and open each plugin's own editor window.

In a plain browser the same panel explains that ASIO, the virtual driver and
VST3 need the desktop build; the web app keeps using Web Audio.

## Tests

`native/Core/build-tests.sh` checks the mixer and `native/tests/build-tests.sh`
checks the virtual ASIO driver's shared-memory ring protocol. Neither needs
Windows, JUCE or an audio device, and `.github/workflows/native-core.yml` runs
both on every change to the mixer or to `HybridAsioShared.h`.

`native/VirtualAsio/self-test.cpp` builds into `ToneArtVirtualAsioTest.exe` and
covers the part those two cannot: the driver itself, running. It creates the real
DLL in its own process - it is the ASIO host *and* the studio - and checks the
audio in both directions, the buffers, the published bus state and the counters
across two sessions. `.github/workflows/native-asio.yml` builds just this folder
with the ASIO SDK headers and runs it on Windows; no JUCE, no registration, no
elevation, no sound card.

## Bridge protocol

Host → UI: `hybridState` (devices, loopback, catalogue, chain, errors) and
`hybridMeters` (peaks + loopback telemetry, 15 Hz).

UI → host: `hybridCommand` with `openDevice`, `listDevices`, `scanPlugins`,
`addPlugin`, `removePlugin`, `movePlugin`, `clearPlugins`,
`openPluginEditor`, `setLoopback`, `setGain`, `testTone`.

## Licensing

- JUCE 9: AGPLv3, or a commercial JUCE licence for closed-source shipping.
- VST3 SDK: bundled with JUCE, MIT since 3.8 — closed-source hosting is allowed.
- ASIO SDK: bundled with JUCE, Steinberg's own terms still apply. For a
  closed-source product you need Steinberg's ASIO licence (or GPL compliance).

Not legal advice; confirm before you distribute binaries.
