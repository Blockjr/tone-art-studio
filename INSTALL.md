# Installing Tone Art Studio

Tone Art Studio ships in two forms:

| Form | What it is | Who it is for |
| --- | --- | --- |
| **Windows desktop app** | A native window (JUCE + WebView2) with ASIO, a virtual ASIO driver and VST3 hosting, packaged as `ToneArtStudioSetup-0.1.0.exe` | Anyone who wants to record, monitor and host plugins |
| **Web build** | The same interface served as a web page, no install | Quick listening, editing and the tablet remote |

## Already-built installer

The current build is published from the Windows CI run. The public copy needs
no GitHub account:

| What | Where |
| --- | --- |
| Setup program (7.3 MB, no login) | <https://site-f5f03b496a2a42d89332792b1c0dd1e5.freebuff.page/download/ToneArtStudioSetup-0.1.0.exe> |
| Checksum file | <https://site-f5f03b496a2a42d89332792b1c0dd1e5.freebuff.page/download/SHA256.txt> |
| Repository copy | [`installer-dist/ToneArtStudioSetup-0.1.0.exe`](installer-dist/ToneArtStudioSetup-0.1.0.exe) |
| Release asset (sign in first — this repository is private) | <https://github.com/Blockjr/tone-art-studio/releases/download/v0.1.0/ToneArtStudioSetup-0.1.0.exe> |
| Build log | <https://github.com/Blockjr/tone-art-studio/actions/runs/40225917749> |

## Download zips (no login needed)

Each part is a separate zip, and `ToneArtStudio-ALL.zip` holds all four.

| What | Where |
| --- | --- |
| **Download page** (kit + source, no login) | <https://site-f5f03b496a2a42d89332792b1c0dd1e5.freebuff.page/download/> |
| **Desktop kit** — installer, tablet remote, setup script | <https://site-f5f03b496a2a42d89332792b1c0dd1e5.freebuff.page/download/ToneArtStudio-2-Desktop-and-Remote-Kit.zip> |
| **Source code** zip | <https://site-f5f03b496a2a42d89332792b1c0dd1e5.freebuff.page/download/ToneArtStudio-3-Source-Code.zip> |
| Release asset (public repository) | <https://github.com/Blockjr/tone-art-studio/releases/download/v0.1.0/ToneArtStudioSetup-0.1.0.exe> |
| Raw copy in the repository | <https://raw.githubusercontent.com/Blockjr/tone-art-studio/main/installer-dist/ToneArtStudioSetup-0.1.0.exe> |

The repository is public, so every one of those links works without signing in.
The zips are also in `deliverables/`, with their SHA-256 values in
`deliverables/README.txt`.

### The desktop kit — app **and** tablet remote, one download

Unzip `ToneArtStudio-2-Desktop-and-Remote-Kit.zip`, then double-click **`Tone Art Studio Desktop Setup.cmd`**. It installs
the app if it is not installed yet and puts **two icons on the Desktop**:

| Icon | What it does |
| --- | --- |
| **Tone Art Studio** | the app |
| **Tone Art Remote** | starts the tablet bridge, prints the address for the tablet and opens the controller |

The remote icon needs Node.js; the setup script installs it through `winget`
when it is missing (or opens nodejs.org if `winget` is unavailable). Details are
in `README.txt` inside the zip. The source of the kit is `remote-kit/` in this
repository.

`ToneArtStudioSetup-0.1.0.exe` — 7,633,647 bytes,
SHA-256 `fa386df3c5158ef5f376211e019c22081bc3fb756db310f4dee8708c375b95bf`.
It contains `Tone Art Studio.exe`, the `ui` folder the window renders, the
`HybridVirtualAsio.dll` driver with its registration script, the `Tone Art Gate`
VST3 and `README.md`. Download it, then continue at
[1.4 Install it](#14-install-it).

The `.exe` can only be compiled **on Windows**: it needs the MSVC toolchain and Inno Setup. Everything needed to produce it is in this folder — one PowerShell command runs the whole chain and prints the path of the finished installer.

---

## Part 1 — Build the Windows installer

### 1.0 The one-double-click route (recommended)

Right-click **`installer\ONE-CLICK-BUILD.cmd`** in a freshly extracted copy of the
kit and choose **Run as administrator** (or just double-click it and accept the
prompt). It checks each prerequisite, installs whatever is missing through
`winget`, then runs the full build and opens the folder with the finished
setup program. Progress is mirrored into `installer\build-log.txt`.

The first run is long — the Visual Studio C++ tools alone are several GB — so
run it when you can leave the PC alone for half an hour. Sections 1.1–1.2 below
are the manual equivalent, for when you would rather install the tools
yourself or `winget` is not available.

### 1.1 Install the toolchain (once, ~20 minutes)

| Tool | Version | Where | Notes |
| --- | --- | --- | --- |
| Node.js | 20 or newer | <https://nodejs.org> | Builds the web UI that the desktop app displays |
| Visual Studio 2022 | Community is fine | <https://visualstudio.microsoft.com/vs/community/> | In the installer tick the workload **Desktop development with C++**. This provides the MSVC compiler and Windows SDK |
| CMake | 3.25 or newer | <https://cmake.org/download/> | During setup choose **Add CMake to the system PATH** |
| Inno Setup | 6.3 or newer | <https://jrsoftware.org/isdl.php> | Compiles the setup executable |
| Git for Windows | any current | <https://git-scm.com/download/win> | CMake uses it to fetch JUCE and the ASIO SDK |

Verify each one in a **new** PowerShell window (`node -v`, `cmake --version`, `git --version`). If a command is not found, the installer was added to `PATH` in a window that was already open — open a fresh one.

### 1.2 Build

Unzip this kit anywhere (for example `C:\dev\tone-art-studio`), then open PowerShell **in that folder** — the one containing `package.json`, `src\`, `native\` and `installer\` — and run:

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1
```

The script prints a cyan `==` heading as it moves through four steps:

1. **Building the web UI** — `npm ci` then `npm run build`. This is the interface the desktop window loads.
2. **Configuring the native host** — CMake fetches JUCE 9.0.4 (about 150 MB, first run only).
3. **Fetching the Steinberg ASIO SDK** — a git submodule inside JUCE, then CMake is configured a second time so the ASIO headers are picked up.
4. **Compiling (Release)** and **Compiling the installer** — MSVC builds the app, the virtual ASIO driver and the bundled VST3, then Inno Setup compresses everything.

**Timing:** expect 10–20 minutes the first time (mostly the JUCE download and the first C++ compile). Later rebuilds take a couple of minutes.

**Result:**

```
dist-installer\ToneArtStudioSetup-0.1.0.exe
```

The script prints the exact path and the file size when it finishes.

### 1.3 Build options

| Command | Effect |
| --- | --- |
| `... -File installer\build-installer.ps1` | Full chain: web UI + native code + installer |
| `... -File installer\build-installer.ps1 -SkipUi` | Reuses the committed `dist\` folder, so Node is not needed |
| `... -File installer\build-installer.ps1 -SkipNative` | Reuses `native\build\`, only recompresses the installer |
| `... -File installer\build-installer.ps1 -SkipUi -SkipNative -OpenOutput` | Fastest repack, then opens the output folder |

### 1.4 Install it

1. Double-click `dist-installer\ToneArtStudioSetup-0.1.0.exe`.
2. Windows SmartScreen shows **“Windows protected your PC”** because the setup is unsigned. Click **More info → Run anyway**. Signing the executable with a code-signing certificate is the only way to remove that prompt.
3. Accept the UAC prompt. Administrator rights are required because the virtual ASIO driver registers itself machine-wide.
4. The wizard shows the Tone Art Studio artwork. Choose whether you want a **desktop shortcut** (off by default) and whether to **register the Tone Art Virtual ASIO driver** (on by default — say yes unless you use another virtual driver).
5. If the Microsoft Edge **WebView2 runtime** is missing, the installer detects it and offers to open Microsoft's download page. Install the runtime from there, then run the installer again. Windows 11 and up-to-date Windows 10 already have it.
6. The installer finishes, registers the driver and launches the app.

**Where things land**

| Path | Contents |
| --- | --- |
| `C:\Program Files\Tone Art Studio\` | `Tone Art Studio.exe`, `HybridVirtualAsio.dll`, the driver registration script, `README.md` |
| `C:\Program Files\Tone Art Studio\ui\` | The web UI build the app renders |
| `C:\Program Files\Common Files\VST3\Tone Art Gate.vst3` | The bundled VST3, so other DAWs can load it |
| Start Menu → Tone Art Studio | App shortcut and uninstaller |

**First run:** pick a project name, tempo and length on the start screen, or **Load demo session** to hear the app working straight away. Choose your ASIO device in the app's device panel; on a machine without an audio interface, **Tone Art Virtual ASIO** appears in the list once registered.

### 1.5 Portable use (no installer)

The compiled folder runs on its own — useful for a USB stick or a machine where you cannot install software.

```
native\build\HybridStudio_artefacts\Release\
    Tone Art Studio.exe
    ui\...                      (must sit next to the exe)
    HybridVirtualAsio.dll
    install-virtual-asio.ps1
```

Copy that whole folder, then run `Tone Art Studio.exe`. The `ui` folder is required; the driver and the VST3 are optional. To register the driver from a portable copy, run:

```powershell
powershell -ExecutionPolicy Bypass -File install-virtual-asio.ps1
```

Add `-Uninstall` to reverse it.

### 1.6 Uninstall

**Settings → Apps → Installed apps → Tone Art Studio → Uninstall**, or the Start Menu entry.

The uninstaller removes the application folder, the `ui` folder, the Start Menu entries and de-registers the virtual ASIO driver. **Your `.hstudio` projects, your audio, and third-party VST3 plugins are never touched.** The bundled `Tone Art Gate.vst3` in `Common Files\VST3` is left in place, because other DAWs may be using it — delete that folder by hand if you want it gone.

---

## Part 2 — Run the web build

This is the fastest way to see the app; it needs no compiler and no installer.

```bash
npm ci          # install exact dependencies from package-lock.json
npm run dev     # http://localhost:3000
```

For a production bundle:

```bash
npm run build   # writes dist/
```

`dist/` **must be served over HTTP** — opening `dist/index.html` from disk leaves you with a blank page, because ES modules and the AudioWorklet are blocked on `file://`. Serve it with any static server:

```bash
npx serve dist                 # or
python -m http.server 8080 -d dist
```

Use a Chromium-based browser (Chrome, Edge, Brave) or Firefox for the best audio-device support. Microphone input requires `https://` or `localhost`.

**Tablet remote** (optional) — drive the studio from a phone or tablet on the same network:

```bash
REMOTE_PORT=9000 npm run remote     # PowerShell: $env:REMOTE_PORT=9000; npm run remote
```

The server prints a URL and a QR code; open it on the tablet. Add `--https` if you need microphone access on the tablet (see `README.md`).

---

## Part 3 — Check the build

```bash
npm run typecheck   # tsc --noEmit
npm test            # 369 tests across 29 files
npm run build       # tsc --noEmit && vite build
```

All three pass on a clean checkout. The suite includes a 38-test app-shell pass that boots the DAW in a simulated browser and exercises transport, mixer, rack, autosave and track reordering.

---

## Part 4 — Folder map

```
package.json              version (0.1.0) — the installer name follows it
index.html                web entry point
src/                      UI and audio sources
  core/                   project model, session, undo, time
  audio/                  engine, devices, DSP, export, mix AI
  ui/                     arrangement, mixer, rack, editors, panels
  native/                 bridge to the desktop host
  help/                   guides and session checks
public/                   logo, favicons, fonts, capture worklet
assets/brand/             logo artwork and the .ico used by the installer
native/                   JUCE desktop host, virtual ASIO driver, VST3 target
installer/                Inno Setup script + build-installer.ps1
dist/                     prebuilt web UI (shipped inside the installer)
tests/                    Vitest suites
```

Regenerating the artwork (optional, needs Python + Pillow):

```bash
python3 assets/brand/generate-icons.py
```

That rewrites `public/logo.svg`, the favicon PNGs, `assets/brand/tone-art.ico` (7 resolutions, 16–256 px) and the Inno Setup wizard bitmaps from one source of truth. `tests/installer.test.ts` checks every path and pixel size the installer expects.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm was not found on PATH` | Install Node.js 20+ and open a new PowerShell window |
| `cmake was not found on PATH` | Install CMake and tick **Add to PATH**, or add it manually and reopen the terminal |
| `Inno Setup 6 was not found` | Install Inno Setup 6.3+. The script looks in `Program Files (x86)\Inno Setup 6`, `Program Files\Inno Setup 6` and `%LOCALAPPDATA%\Programs\Inno Setup 6` |
| `Tone Art Studio.exe was not produced` | The native build failed — scroll up for the MSVC error. Almost always a missing **Desktop development with C++** workload, or CMake configured for a different architecture (it must be `-A x64`) |
| CMake fails while fetching JUCE | No network access or a proxy blocking GitHub. Run once with network available; JUCE is then cached in `native\build\_deps` |
| The ASIO submodule step warns “JUCE sources not found” | The first CMake configure did not complete. Run the script again |
| Build succeeds but the app window is blank | The `ui` folder is missing next to the exe, or WebView2 is not installed |
| No audio devices listed | Install or update the audio driver, or register Tone Art Virtual ASIO (Part 1.5), then reopen the app |
| Virtual ASIO does not appear in another app | Registration needs admin. Run `install-virtual-asio.ps1` from an elevated PowerShell, then restart the other application |
| SmartScreen warns on every launch | Expected for an unsigned build. Code-sign `ToneArtStudioSetup-*.exe` to remove it |
| Blank page when opening `dist/index.html` | Serve it over HTTP instead (Part 2) |
