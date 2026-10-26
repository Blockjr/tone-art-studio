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
cmake --build native/build --config Release --parallel
```

Output: `HybridVirtualAsio.dll`, copied next to `Tone Art Studio.exe` together with
`install-virtual-asio.ps1` and `ToneArtVirtualAsioTest.exe`.

This folder also configures on its own, which is how the bridge gets tested in a
minute instead of building all of JUCE to find out whether the loopback works:

```
cmake -S native/VirtualAsio -B build-asio -A x64 -DASIO_SDK_DIR=<asio sdk root>
cmake --build build-asio --config Release
build-asio/Release/ToneArtVirtualAsioTest.exe
```

The Steinberg ASIO SDK headers come from JUCE itself: JUCE 9 vendors them in
`modules/juce_audio_devices/native/asio`, JUCE 8 keeps them in the `asio`
submodule (run `git -C native/build/_deps/juce-src submodule update --init
--recursive` after the first configure). `-DASIO_SDK_DIR=<sdk root>` also works.

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

`installer/test-virtual-asio.ps1` does exactly that and then undoes it: it
registers the built DLL, asserts both keys, checks that `InprocServer32` points at
the DLL that was just built, creates the COM object once (`CoCreateInstance` on
the class id, which is what a host does when it opens the device), and
unregisters. `installer/ci-build.ps1` runs it on every Windows build, so a driver
that cannot register fails the build instead of reaching a release.

## Verify the bridge

Registration proves a DAW can *find* the device. It says nothing about whether
audio crosses it, and that is the interesting failure: a device with a broken
bridge opens perfectly, records perfectly, and produces silence.

`ToneArtVirtualAsioTest.exe` is the second application the bridge normally needs.
It loads the DLL through `DllGetClassObject` - no registration, no administrator
rights - creates the driver in its own process and then plays the studio's half of
the shared block against it: a 440 Hz master published into `toClient`, and
`toStudio` recorded and checked. It asserts the audio is bit-identical in both
directions, that both halves of every double buffer are wired up, that the
channels are not swapped, that the bus width, sample rate and block size the
driver publishes to the studio match what the host asked for, that the transport
advances by exactly one block per block, and that the counters land exactly where
they belong - one starvation on the master ring before the first block, because
the host has not played anything yet, and none afterwards. Then it does the whole
thing again at a different rate and block size, where stale ring state or an
un-republished header would show up.

Run it from the folder holding the driver, or point it at one:

```
ToneArtVirtualAsioTest.exe --pause
ToneArtVirtualAsioTest.exe C:\path\to\HybridVirtualAsio.dll
```

Exit code 0 means every check passed. It ships in
`ToneArtVirtualAsio-<version>.zip` and in `ToneArtStudioHostSetup-<version>.exe`,
whose setup offers to run it. `.github/workflows/native-asio.yml` runs it on a
Windows runner for every change in this folder - and compiles only these four
source files rather than all of JUCE - and `installer/ci-build.ps1` runs it in
the full Windows build before anything is packaged.

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
- **Status: the device, its registration and the whole bridge are tested
  automatically; not yet driven by a real ASIO host.** Every Windows build
  compiles the DLL, registers it in an elevated session, checks the keys a host
  reads, creates the COM object, unregisters, and then runs the bridge self-test
  above end to end; `native-windows.yml` and `native-asio.yml` fail outright if
  the DLL or the self-test is missing or the bridge carries nothing. Registration
  - and so installing the driver - needs admin; the self-test does not. It ships
  in `ToneArtStudioHostSetup-<version>.exe` and in
  `ToneArtVirtualAsio-<version>.zip`.

  The ring protocol itself is covered on every push by `native/tests/build-tests.sh`
  (`native-core.yml`), which needs no Windows and no audio device: sample-exact
  round trips, wraparound across the index mask, partial writes when the ring is
  full, silence-and-a-counted-underrun when it runs dry, reset discarding a
  backlog without shifting the signal, the two rings staying independent, and a
  4 000-step randomised run cross-checked against an independent reference FIFO.
  It pins the protocol version, magic value and mask, so a change to the shared
  header cannot quietly break DLLs already installed in other people's hosts.

  What neither can prove is how a particular DAW behaves once it drives the
  device: its own buffer negotiation, its own callback thread and timing, and
  whether the audio that arrives is the audio you wanted. Your first session is
  that test.
- Browsers cannot use ASIO at all. To capture browser audio, bridge it with
  VoiceMeeter or ASIO Link, or record the interface's loopback in Tone Art Studio.
