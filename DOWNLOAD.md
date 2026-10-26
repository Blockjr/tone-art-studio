# Download Tone Art Studio 0.1.0

Everything is attached to the [v0.1.0 release](https://github.com/Blockjr/tone-art-studio/releases/tag/v0.1.0).
The installer in every archive is the same file, `ToneArtStudioSetup-0.1.0.exe`,
7,654,197 bytes, built from the current source tree on a Windows runner.

| # | File | Size | What it is |
|---|------|------|------------|
| 1 | [ToneArtStudio-1-App-Installer.zip](https://github.com/Blockjr/tone-art-studio/releases/download/v0.1.0/ToneArtStudio-1-App-Installer.zip) | 7.1 MB | the Windows installer on its own, with notes |
| 2 | [ToneArtStudio-2-Desktop-and-Remote-Kit.zip](https://github.com/Blockjr/tone-art-studio/releases/download/v0.1.0/ToneArtStudio-2-Desktop-and-Remote-Kit.zip) | 7.3 MB | installer + tablet remote + a script that puts **both icons on your Desktop** |
| 3 | [ToneArtStudio-3-Source-Code.zip](https://github.com/Blockjr/tone-art-studio/releases/download/v0.1.0/ToneArtStudio-3-Source-Code.zip) | 8.3 MB | the finished code (`npm ci && npm run build` runs from a clean extract) |
| 4 | [ToneArtStudio-4-Web-Build.zip](https://github.com/Blockjr/tone-art-studio/releases/download/v0.1.0/ToneArtStudio-4-Web-Build.zip) | 350 KB | the compiled browser build |
| - | [ToneArtStudio-ALL.zip](https://github.com/Blockjr/tone-art-studio/releases/download/v0.1.0/ToneArtStudio-ALL.zip) | 23 MB | all four above in one download |
| - | [ToneArtStudioSetup-0.1.0.exe](https://github.com/Blockjr/tone-art-studio/releases/download/v0.1.0/ToneArtStudioSetup-0.1.0.exe) | 7.6 MB | just the installer |

## Install it

1. Download zip 2 (or 1, or just the `.exe`).
2. Extract it, then double-click **Tone Art Studio Desktop Setup.cmd** (kit) or
   **ToneArtStudioSetup-0.1.0.exe** (installer).
3. If Windows says "Windows protected your PC", click **More info -> Run anyway**.
   The setup is not code-signed, so SmartScreen always says that for it.
4. Leave the audio-driver task ticked; it registers the Tone Art Virtual ASIO driver.
5. Start **Tone Art Studio** from the Start menu or the Desktop icon.

The app runs locally. No account, no sign-in, no internet connection needed.

## Checksums (SHA-256)

```
e90add87c863240c06c37b7464c314c0f939c97c810f2cb9185aa7a0e3d7bc36  ToneArtStudio-1-App-Installer.zip
5cfacd8beab34c51d2bb0c1cd7832bf65cb224caa63f573682cd08fe4718ad73  ToneArtStudio-2-Desktop-and-Remote-Kit.zip
b526dc24ac1407127527eae698130d95e7919dedd5a04b77be310c6593d08b38  ToneArtStudio-3-Source-Code.zip
69257eac79b957f4c6b3f7e057f7ac4f3300b856c66c87c091de32d2b6709808  ToneArtStudio-4-Web-Build.zip
12cbfc4df77f49df079c5654361adb4bc319d46f082322107d9788167b03d827  ToneArtStudio-ALL.zip
0a1b070784a144ea9de76cbfed56967e8573c041a5b1db2c411c2fb9f834defb  ToneArtStudioSetup-0.1.0.exe
```

Verify on Windows with `certutil -hashfile <file> SHA256`.

## If the window is blank

The desktop host loads the bundled interface from the `ui` folder next to
`Tone Art Studio.exe`, and falls back to the hosted build if that folder is
missing. A blank window therefore means the web view itself failed: install the
[WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
(Microsoft's evergreen installer) and start the app again. The app writes
`webview.log` in `%LOCALAPPDATA%\Tone Art Studio` if it cannot start its UI.
