# Building Tone Art Studio 0.3.0 as a Windows program

This bundle is the complete source of the version with MIDI input, MIDI effects
and the panel/startup fixes. Nothing has to be reconstructed: unzip it and build.

## What you get

`dist-installer\ToneArtStudioSetup-0.3.0.exe` — a normal installed Windows
program: Start menu entry, desktop shortcut, uninstaller, and its own embedded
browser engine so it does not depend on what is installed on the PC.

## Option 1 — build on your own Windows PC (about 5 minutes)

Needs [Node.js 20+](https://nodejs.org). Then, in the unzipped folder:

```powershell
npm ci
npm run build
npx electron-builder --win --x64
```

The setup program appears in `dist-installer\`. For the installer that also
builds the native host, the VST3 and the virtual ASIO driver, install
[Inno Setup 6](https://jrsoftware.org/isdl.php) and run instead:

```powershell
powershell -ExecutionPolicy Bypass -File installer\ci-build.ps1
```

The first run downloads Electron and the NSIS toolchain (~200 MB); later builds
reuse the cache.

## Option 2 — let GitHub build it

Push this source to `main`, then run the **native-windows** workflow (Actions →
native-windows → Run workflow). It builds on a real Windows machine, uploads the
installer as an artifact and attaches it to the release. The run log prints a
public download link and the SHA-256 as well.

## The one thing this build does not do yet

Audio in this build goes through Windows' normal audio path (the Chromium engine
inside the app), not ASIO, and it does not host VST3 plugins. The Studio Rig
panel says so rather than offering buttons that do nothing.

A DAW that records and plays at low latency through an audio interface needs the
native engine: JUCE opening the ASIO driver, and the VST3 scanner/host. That code
already exists in `native/` and builds in CI; what is missing is running it as a
background audio process that the app talks to. That is the next piece of work,
and it needs a Windows machine to verify.
