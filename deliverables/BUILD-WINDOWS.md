# Building Tone Art Studio as a Windows program

This is the complete source: unzip it and build. The version comes from
`package.json`, so the file names below carry whatever version you are on.

## What you get

`dist-installer\ToneArtStudioSetup-<version>.exe` — a normal installed Windows
program: Start menu entry, desktop shortcut, uninstaller, and its own embedded
browser engine so it does not depend on what is installed on the PC.

`dist-native\ToneArtStudioHostSetup-<version>.exe` — the native engine, which is
the ASIO and VST3 build: the JUCE host, the Tone Art Gate VST3 and the Tone Art
Virtual ASIO driver registered at install time. See [DOWNLOAD.md](../DOWNLOAD.md)
for which of the two to hand someone.

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

## Which of the two programs you want

Audio in the plain app goes through Windows' normal audio path (the Chromium
engine inside the app), not ASIO, and it does not host VST3 plugins — the Studio
Rig panel says so rather than offering buttons that do nothing. That is why the
native engine exists: JUCE opening an ASIO device, the VST3 scanner and host, and
the virtual driver. Both are built by the same command and both are published;
install the native engine when you want the ASIO DAW, and the plain app when you
want the interface and the tablet remote.
