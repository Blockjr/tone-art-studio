# Download Tone Art Studio

Everything is attached to the [latest release](https://github.com/Blockjr/tone-art-studio/releases/latest).
Asset names carry the version, so whatever the release page shows is the newest
build — nothing here needs to be updated when the version changes.

| File | What it is | Get it if |
|---|---|---|
| `ToneArtStudio-ALL.zip` | **everything in one download**: the app installer, the desktop-and-remote kit, the complete source of that build, the compiled interface and the engine with its ASIO driver, each as a zip inside | you want the whole project in a single file |
| `ToneArtStudioSetup-<version>.exe` | the installed desktop app. Its interface runs in its own bundled browser engine, and it carries the **tablet remote** | you want the app and the phone/tablet remote |
| `ToneArtStudioHostSetup-<version>.exe` | the native engine: the same interface drawn by a JUCE host, with real **ASIO** input and output, VST3 hosting, and the **Tone Art Virtual ASIO driver registered at install time** | you want the DAW that opens an ASIO device |
| `ToneArtVirtualAsio-<version>.zip` | the virtual ASIO driver on its own — the DLL, the registration script and a README | you only want the device, for another DAW |
| `SHA256SUMS.txt` | the SHA-256 of each file above, and of the five parts inside the bundle | to check a download before running it |

The release page shows each file's size next to it. The desktop app is the
largest of them, because it carries a browser engine, and the driver zip is the
smallest. Unpack `ToneArtStudio-ALL.zip` to get the same pieces as separate
zips, each with its own short install note.

## Which one is the DAW?

The **native engine** is the one that plays through ASIO: a real device with
ASIO input and output, VST3 hosting, the virtual driver, and the same mixer,
arrangement and editor panes. If in doubt, install that one.

The **plain app** runs its audio in the browser engine that draws the interface,
so it cannot open an ASIO device. Install it for the interface, the file
browser, the editors and the tablet remote.

They are two different programs and neither replaces the other. Installing both
is fine and is the usual setup: the native engine for the studio, the app for
everything else.

## Install it

1. Download the file you want from the release page.
2. Double-click it. Windows SmartScreen says **"Windows protected your PC"**
   because the setup is not code-signed: click **More info → Run anyway**.
   Signing the builds with a code-signing certificate is the only way to remove
   that prompt.
3. Accept the UAC prompt. Administrator rights are needed to register the
   virtual ASIO driver machine-wide.
4. Leave the **audio driver** task ticked (it is on by default). That registers
   the Tone Art Virtual ASIO device.
5. Start **Tone Art Studio** from the Start menu or the Desktop icon.

The app runs locally: no account, no sign-in, no internet connection needed.
Windows 10 or newer, 64-bit.

## Using the virtual ASIO device

Once the driver is registered, every ASIO host on the machine sees
**"Tone Art Virtual ASIO"** with two inputs and two outputs next to its real
sound card:

- in Tone Art Studio, pick it as the device and enable the loopback in the
  **Studio Rig** panel;
- in any other DAW, pick it the same way you pick a sound card.

What it does: audio the other application plays arrives on the device's inputs,
and audio the other application records from the device's outputs is fed by Tone
Art Studio's master. That is how the studio and another DAW share audio without
a cable, a mixer or a second interface.

The registration script is also shipped on its own inside
`ToneArtVirtualAsio-<version>.zip`. Run it from an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File install-virtual-asio.ps1
```

The same script with `-Uninstall` removes the device again.

## The tablet and phone remote

The desktop app carries the remote bridge and the controller page, so nothing
extra needs to be installed:

1. On the laptop, open the **Remote** panel in the top bar and press
   **Detect**. It prints the address to open, for example
   `http://192.168.1.20:8787`.
2. On the tablet or phone, on the same Wi-Fi, open that address, then use
   **Add to Home Screen** for a full-screen icon.
3. Back in the Remote panel, press **Connect**. **QR code** draws the link with
   its token, so the phone camera can read it instead of typing.

Both devices talk over your own network — no internet, no router and no account
needed, and a phone hotspot works just as well. If the tablet cannot connect,
allow the app through the Windows firewall for **Private** networks. Reaching
the studio from outside your network means forwarding a port or putting a tunnel
in front of the bridge, with `REMOTE_TOKEN` set; the [README](README.md) covers
that in detail.

## Checksums

The release publishes `SHA256SUMS.txt` next to the downloads, and the hashes are
shown on the release page itself. It covers the standalone downloads and the
five parts inside `ToneArtStudio-ALL.zip`, so a bundle can be checked without
unpacking it first. Verify on Windows with:

```
certutil -hashfile ToneArtStudioSetup-<version>.exe SHA256
```

## If the window is blank

The app draws its interface in a web view. It bundles the WebView2 bootstrapper
and installs the runtime when the PC does not have it, so a blank window is
unusual — if you see one, the app writes the reason to
`webview.log` in `%LOCALAPPDATA%\Tone Art Studio`, and the native engine writes
its own log in the same folder. Install the
[WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
by hand and start the app again if the log says the runtime is missing.

## Build it yourself

Every one of these files is produced from this repository on a Windows machine.
[INSTALL.md](INSTALL.md) has the whole chain — the web interface, the JUCE host,
the virtual ASIO driver, the VST3 and both installers — and `installer/` holds
the scripts it runs.
