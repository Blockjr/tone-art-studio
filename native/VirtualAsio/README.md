# Tone Art Virtual ASIO

A 2-in / 2-out virtual ASIO device for Windows. It lets ASIO applications and
Tone Art Studio pass audio to each other without an audio interface.

```
 other ASIO app output ──► toStudio ring ──► Tone Art Studio (loopback input)
 Tone Art Studio master  ──► toClient ring ──► other ASIO app input
```

Both directions are lock-free single-producer/single-consumer rings in one
shared mapping (`Local\HybridStudioVirtualAsio`, 32 768 stereo frames each), with
the driver calling `bufferSwitchTimeInfo` on its own steady clock at the block
size the host asked for.

## Why this needs no kernel driver

ASIO drivers on Windows are **in-process COM servers**, not WDM/PortCls kernel
drivers. Nothing here is signed, nothing touches the driver store, and no reboot
is needed. (A system-wide *audio endpoint* — the thing browsers and media players
pick in the Windows sound settings — is a different beast: that is a kernel-mode
driver and deliberately out of scope.)

## Build

```
cmake -S native -B native/build -G "Visual Studio 17 2022" -A x64 -DHYBRID_BUILD_VIRTUAL_ASIO=ON
git -C native/build/_deps/juce-src submodule update --init --recursive   # ASIO SDK headers
cmake --build native/build --config Release --parallel
```

Output: `HybridVirtualAsio.dll`, copied next to `Tone Art Studio.exe` together with
`install-virtual-asio.ps1`.

The DLL uses the static CRT on purpose: a device DLL must not depend on the Visual
C++ redistributable being present in every host process.

## Install

```powershell
powershell -ExecutionPolicy Bypass -File .\install-virtual-asio.ps1
# remove
powershell -ExecutionPolicy Bypass -File .\install-virtual-asio.ps1 -Uninstall
```

UAC prompts once. The script calls `regsvr32`, which invokes `DllRegisterServer`:

- `HKLM\SOFTWARE\Classes\CLSID\{6E1B7A52-2C4E-4B0E-9F1B-7A3C5D8E9F21}\InprocServer32`
  → the DLL, threading model `Both`
- `HKLM\SOFTWARE\ASIO\Tone Art Virtual ASIO` → `CLSID` and `Description`

ASIO hosts enumerate the second key. Restart any host after installing.

## Use

1. Start Tone Art Studio and open **Studio Rig**.
2. Open any audio device (real ASIO hardware, or another virtual driver).
3. Press **Enable virtual loopback** — the panel turns green when streaming.
4. In the other ASIO application choose **Tone Art Virtual ASIO**:
   - what it *plays* arrives in Tone Art Studio's master,
   - what it *records* is Tone Art Studio's master output.

## Limits

- 64-bit only. A 32-bit ASIO host needs a separate 32-bit build.
- Float32 stereo only; no MIDI, no clock sync, no per-channel routing matrix.
- ~2 blocks of latency in each direction, plus the ring depth.
- Sample rates 44.1–192 kHz; the rate is fixed while a host is running.
- **Status: experimental.** The driver could not be compiled or run in the Linux
  environment this project was built in; it needs a Windows build and a real
  ASIO host to verify. Keep it off in shipping builds until you have tested it
  with your hosts.
- Browsers cannot use ASIO at all. To capture browser audio, bridge it with
  VoiceMeeter or ASIO Link, or record the interface's loopback in Tone Art Studio.
