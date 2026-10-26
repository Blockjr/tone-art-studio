# Tone Art Studio

A studio in the browser: arrangement, console-style mixer, channel EQ and sends,
an effect rack, a piano-roll MIDI editor, MIDI-to-audio bounce, an AI Mix &
Master insert that measures and corrects a track or the whole mix, audio import
with embedded project files, and a Windows desktop host with ASIO, a virtual
ASIO driver and VST3 hosting.

```
npm install
npm run dev      # http://localhost:3000
npm test         # 252 tests
npm run build    # production bundle in dist/
```

[FEATURES.md](FEATURES.md) is the feature ledger: every capability that was
asked for, whether it is built, and the gaps still open against an
industry-standard DAW.

## AI Mix & Master

Add **AI Mix & Master** from the Device Rack. It is an insert like any other, so
it can sit on a track or on any track while set to *Master the mix*:

1. **Mix this track** measures the track on its own, **Master the mix** measures
the full render, and each one reports integrated loudness (BS.1770 gated),
inter-sample true peak, crest factor, phase correlation and a four-band balance.
2. It then proposes concrete corrections and explains each with the measurement
that caused it: input trim, high-pass, tone shelves, a compressor, pan or send
changes, and for the master a tonal balance, glue compressor, limiter ceiling
and master-fader trim.
3. **Apply** one correction or **Apply all**. Everything lands in the normal
channel strip and insert chain as a single undo step (`Ctrl+Z` undoes the whole
batch), so nothing is hidden inside the device.

The **Intensity** slider scales how far it moves things (20%–100%), and the
master targets are Streaming (-14 LUFS), Club / DJ (-9 LUFS) and Speech
(-16 LUFS). Analysis is entirely local DSP: no network, no API key, no model
download. `src/audio/mixai.ts` holds the measurement and planning, `tests/mixai.test.ts`
checks it against synthetic tones and mixes.

The insert is built into the app rather than shipped as a separate VST3 binary.
Offering it to other hosts would mean porting the same analysis to C++ inside
`native/` and compiling that target on Windows; that binary is not included.

## Sage AI and in-app help

The studio assistant is named **Sage**. The same engine lives in the rack and in
the **Sage AI** panel, so you never have to open a device to ask a question
about the mix:

| where | how |
| --- | --- |
| top bar | **Sage AI** opens Mix & Master; the **?** button opens Help |
| keyboard | `Shift+M` opens Sage, `?` or `F1` opens Help, `Esc` closes |
| Device Rack | the Sage AI Mix & Master card's **Open in Sage** button |
| Console | clicking the master insert chain opens the panel scoped to the whole mix |

**Mix & Master** has one dropdown: a single track, or **Whole mix (all tracks +
master)**. The whole-mix pass renders every track in context as well as the full
mix, so it can hear shared low end, a low-mid pile-up across parts, a nearly
mono stereo field and a mix that is already louder than the target. Then it
plans the per-track moves and the master chain together. **Scan every track**
remains available for a quick per-channel list.

Every correction writes the ordinary channel-strip or master parameters. Apply
one or Apply all is one undo step; **Undo AI change** or `Ctrl+Z` takes the last
pass back, and every applied value can then be dragged in the rack or console
like any manual setting — nothing Sage does is fixed in place.

**Help** is a searchable guide library plus live **session checks**. The checks
read the actual project — silent tracks, a master that clips, tracks left muted,
missing sends, an unbalanced mix — and each one offers a one-click **Fix** that
is itself a normal undoable edit. Guides cover Sage, the AI insert, LUFS and true
peak, phase, VST3 and ASIO, export, saves, the tablet remote and shortcuts; many
of them carry an action button that jumps straight to the screen they describe.
`src/help/topics.ts` holds the guides, `src/help/diagnose.ts` the checks, and
`src/ui/agent.ts` the panel.

## MIDI editing and bounce

Select a MIDI clip and press **Notes**, press `Enter`, or double-click the clip:
the piano roll opens over the arrangement. With nothing selected, **Notes** opens
the first MIDI clip on the selected track instead of doing nothing, so the editor
is always one click away. Click empty grid to draw a note, drag
to move it in time and pitch, drag the right edge to stretch it, `Delete` to
remove it, arrows to nudge by the grid or by a semitone. Quantize, ±12 transpose
and the velocity slider apply to the selection, or to every note when nothing is
selected. Each gesture is one undo step, and the arrangement and editor share the
same history.

**Bounce** converts MIDI to audio. The clip is rendered offline through the
instrument, channel EQ, inserts, pan, fader and sends and lands on a new audio
track below the source, at unity with a flat channel because the print already
carries the source level. The master chain is deliberately skipped, so nothing
is applied twice. With no clip selected, Bounce prints the whole selected track
as one file; with an audio clip selected it prints that clip through its inserts.
The MIDI track is kept, so the print is non-destructive and `Ctrl+Z` removes it.
`src/audio/bounce.ts` holds the plan and render, `src/core/midi.ts` the note
operations, `src/ui/piano.ts` the editor, and `tests/midi.test.ts` /
`tests/bounce.test.ts` check them.

## MIDI input, controllers and MIDI effects

**MIDI** in the top bar opens the MIDI panel. Press **Enable MIDI inputs** once:
every connected input is listed with the two switches a DAW needs — **Track**
sends notes and controllers to the selected track, **Remote** lets the same port
drive mapped controls. A newly plugged keyboard is enabled for Track straight
away, and inputs are re-read whenever the controller is plugged in or removed.

With the panel open the computer keyboard plays: `A`–`L` are the white keys from
C, `W E T Y U` the black ones, `Z`/`X` shift the octave and `C`/`V` the velocity.
While it is open those keys play instead of firing transport shortcuts, so
playing a chord never moves the playhead.

**MIDI effects** sit in front of the instrument, on the selected track, and run
for live input and for clip playback alike:

| Device | What it does |
|---|---|
| Chord | Adds up to six pitches to each note. Shifts are ±36 semitones, with velocity scaling, chance and strum |
| Scale | Remaps notes into a scale (root, 13 scales, transpose, fold, range) so wrong notes come out right |
| Arpeggiator | Turns a held chord into a pattern: six styles, rate, gate, octaves, repeats, groove |
| Velocity | Maps input velocity into an output range, with Clip/Gate/Fixed, random and drive |
| Pitch | Transposes ±128 semitones and blocks, folds or limits notes that leave the range |
| Note Length | Scales note length, with a gate |

Each device has a power button, its parameters as sliders with live values, and
Reset. Parameter ranges follow Ableton Live 12's MIDI effect reference where it
documents them (Chord ±36, Velocity 1–127 with Clip/Gate/Fixed, Pitch
Block/Fold/Limit). The transform is pure code in `src/core/midifx.ts`, checked by
`tests/midifx.test.ts`, so a device can be dropped into the chain without
changing the engine; the panel itself is `src/ui/midi.ts`, checked by
`tests/midipanel.test.ts`.

**Controller mapping:** choose a control, press **Learn**, then move a knob. CCs
bind to master volume, the selected track's volume or pan, or its send A, and the
mapping is kept in the browser's storage. Mapped messages are consumed by the
mapping and not also played as notes.

Live notes are one-shots with the instrument's release tail: a controller's
note-off does not cut a note short yet, so a held key rings out. Per-voice
note-off is the next step for the instruments.

## Workspace, multiple screens and scaling

The window is built around three resizable regions: the browser, the
arrangement and the device rack, with the console under them. Drag any splitter,
focus one and use the arrow keys, or double-click it to restore that panel's
default size. Every size is clamped against the live viewport, so a session
opened on a large monitor still fits a laptop or a tablet, and a layout saved on
one screen never pushes the arrangement off another.

**View** in the top bar is the fast path:

| Command | What it does |
| --- | --- |
| Studio / Arrangement / Mix / Mastering | One-click panel arrangements for writing, tracking, mixing or mastering. |
| Fit to window | Sizes the panels from the current window (side panels take a share of the width, the console a share of the height) and folds the console on short screens. |
| Reset panels | Back to the default Studio layout. |
| Fullscreen | Removes the browser chrome; `Ctrl+Shift+F` toggles it from anywhere. |

Layout changes are remembered per browser. When the browser hides the side
panels to protect the arrangement on a narrow window (below 1080 px for the
browser, 860 px for the rack), a **Browser** or **Rack** button appears in the
top bar and opens that panel as a full-height drawer, so no screen loses access
to it. The app also watches pixel density: dragging the window between
monitors with different scaling repaints the timelines and meters at the new
ratio, so they stay crisp. Sizes chosen on a wide monitor are remembered and
return when the window moves back to it.

## Tablet and phone remote

`npm run remote` starts a small bridge on port 8787 and prints the address to
open on a tablet or phone. The Remote panel in the top bar connects the desktop
session to the same bridge. Both directions are plain WebSocket messages, so the
remote works on a Wi-Fi network with **no internet connection at all**.

**Same Wi-Fi.** Open the printed `http://192.168.x.x:8787` address (or press
**Detect** in the Remote panel and pick the LAN address it finds). If the tablet
cannot connect, allow port 8787 through the computer's firewall, and check that
the router is not using "client isolation" on the guest network.

**Scan instead of typing.** **QR code** in the Remote panel draws the link, with
the token already in it, as a code the phone camera reads — no address to type
on a touch keyboard. The code is built on the studio computer and never by a web
service, so the token stays here, and it hides itself after two minutes or when
the panel closes. Scanning is only useful once the address is one the phone can
reach: a `localhost` link gets a warning instead of a misleading code.

**No router needed.** The two devices need a path to each other, not the internet
and not a Wi-Fi access point, so any of these work:

- **Phone hotspot.** Turn on the phone's hotspot, join it from the studio
  computer, then **Detect** and pick the address on that network. The phone is the
  access point, so no router or internet is involved.
- **Computer hotspot.** Windows Mobile Hotspot does the same the other way round;
  the phone joins the computer.
- **USB only, no radio at all (Android).** With developer mode on, run
  `adb reverse tcp:8787 tcp:8787`, then open `http://localhost:8787` on the
  phone. `localhost` counts as a secure origin, so the installable app and its
  offline shell work there too.

What cannot work is no link at all: the controller is a web page, so the phone
needs some TCP path to the bridge — a hotspot, USB or a network. On a plain
`http://` hotspot address the controller still works as a browser tab but cannot
be installed to the home screen until you terminate TLS (see below).

**From another network.** The bridge is not a cloud service; to reach it over
the internet, forward port 8787 on the router or put a tunnel in front of it
(Cloudflare Tunnel, Tailscale, ngrok and similar). Then:

```bash
REMOTE_TOKEN='a-long-random-secret' \
REMOTE_PUBLIC_URL='https://studio.example.com' \
npm run remote
```

`REMOTE_TOKEN` is required for WebSocket connections and for `/info`; open the
tablet page with `?token=…` or enter the token in the connection sheet. The
bridge refuses to start with `REMOTE_PUBLIC_URL` set but no token, so a port
cannot be exposed open by accident. Paste the public `https://` address into the
tablet's connection sheet once; it is remembered.

**HTTPS and the installable app.** Browsers only allow a service worker (and a
proper install to the home screen) on HTTPS or `localhost`. On plain `http://`
Wi-Fi the controller still works perfectly as a browser tab and reconnects on its
own; to install it, terminate TLS in front of the bridge with a trusted
certificate, or run the bridge with `REMOTE_TLS_CERT` and `REMOTE_TLS_KEY`:

```bash
REMOTE_TLS_CERT=cert.pem REMOTE_TLS_KEY=key.pem npm run remote
```

The remote registers `/service-worker.js`, which caches the controller shell, so
an installed app opens instantly on a bad network and keeps showing its last
session while it reconnects. It never loads a font, script or icon from the
internet.

Other environment variables: `REMOTE_PORT` (default 8787), `REMOTE_HOST`
(default `0.0.0.0`), and `REMOTE_ORIGIN` (comma-separated extra page origins
allowed to open the desktop socket, for a split-host setup).

The remote is a full control surface, not a status page: transport, scrub,
loop, tap tempo, faders, pans, mute/solo, sends A–D with pre-fader switches,
aux returns, master fader with peak hold and the master insert chain. Audio
tracks can be armed from the tablet and **Record** starts the same capture path
as the studio button — count-in, loop takes, takes/comping and the five-minute
safety stop all apply, and the pad shows `ARMING`, `COUNT`, `REC` or a failure
notice. It also shows a live **Arrangement** map built from the real clips — tap a clip to jump
there and select its track — and a **Performance** pad that throws the selected
channel into the reverb and delay returns with one gesture, with a glowing trail
and double-tap to zero. Every control is touch-sized, haptic where the device
supports it, works over one WebSocket connection, reconnects on its own, and can
be installed to a home screen. Multiple tablets can follow the same session at
once. `src/remote/remote.ts` defines the snapshot and commands,
`server/remote.mjs` is the bridge, and `remote/` is the controller UI.

## Playhead and transport

The playhead is a full-width line through the arrangement, not just a marker in
the ruler. It is drawn on a half pixel with a soft halo and a rounded grab tab,
so it stays crisp at any DPI and is easy to catch. Click the ruler or any empty
lane to locate it; clicking while the transport rolls keeps rolling from the new
position. Drag the upper ruler to scrub — short, self-fading grains of the audio
clips under the pointer play through their own channel strips as you move, and a
floating readout follows with the bar and time. Playback resumes where you
release. Drag the lower ruler strip to draw new loop braces; click without
dragging still just locates. The position readout shows bars · beats · sixteenths
and minutes · seconds · milliseconds together; click it to type a location.

**Ranges and marker loops.** Shift+drag across the ruler draws a time range in
blue through the ruler and lanes; `Space` plays that range once and parks on its
end, and a plain locate clears it. `L` loops the drawn range when there is one;
otherwise, with named markers in the project, it loops between the markers
either side of the playhead (or the last pair), and pressing it again on that
exact marker loop turns it off; `Shift+L` still loops a selected clip. The loop
button's tooltip shows the current span.

The marker band holds named locators. `M` adds one at the playhead, double-click
the band to add or rename, drag a marker to move it, and `Alt+click` deletes it.
Markers are drawn through the arrangement, saved with the project, and navigated
with `,` and `.`. Dragging the lower strip still draws loop braces, while `[`
and `]` put the loop start and end exactly at the playhead.

**Scrolling.** The arrangement moves in two directions at once: the wheel over
the lanes scrolls the track list, `Shift`+wheel (or a sideways trackpad swipe)
moves through time, and `Ctrl`/`Cmd`+wheel zooms around the pointer. A **rail**
under the arrangement is the horizontal scrollbar for the timeline — drag the
thumb, click anywhere on the bar, or wheel over it. It only appears when the
project is wider than the view, and the view is clamped to the project so it
never scrolls into empty space. The browser, rack, help and Sage panels, console,
piano roll and long menus all scroll with the wheel or a trackpad, and keep the
wheel to themselves at their edges instead of scrolling the page behind them.

**Follow** in the arrangement toolbar controls the view during playback: Page
jumps at the right edge, Scroll keeps moving once the playhead passes the
middle, Center locks it to the middle (stationary cursor), and Off leaves the
view where you put it. `F` cycles the four modes and the choice is saved per
browser.

**Click and count-in.** `K` toggles the metronome during playback; the caret
beside it opens the click settings for Classic, Click or Wood sounds, level,
downbeat accent and quarter/eighth/sixteenth subdivisions. `Shift+K` toggles a
one-, two- or four-bar count-in: the transport stays parked while the clicks
count down, the position readout shows the remaining beats, and count-in clicks
are audible even when the playback click is off. `T` taps tempo. Click and
count-in choices are saved per browser.

| key | action |
| --- | --- |
| `Space` | Play / pause in place, or play the drawn range once |
| `Shift+Space` | Play from the selected clip |
| `Shift+drag` on the ruler | Draw a time range for range playback |
| `N` / `R` | Normalize / reverse the selected audio clip |
| `Left` / `Right` | Nudge by the Snap grid (a sixteenth when Snap is Off) |
| `Shift+Left` / `Shift+Right` | Nudge one bar |
| `Home` / `Shift+Home` | Project start / loop start |
| `End` / `Shift+End` | Project end / loop end |
| `Shift+R` | Return to the last playback start |
| `,` / `.` | Previous / next marker |
| `M` / `Alt+M` | Add a marker at the playhead / delete it |
| `[` / `]` | Set the loop start / end at the playhead |
| `L` / `Shift+L` | Loop the drawn range or the markers around the playhead / set the loop to the selected clip |
| `F` | Cycle the follow mode |
| `K` / `Shift+K` | Toggle the click / toggle the count-in |
| `T` | Tap tempo |

The research and status of every playhead and transport capability — including
scrub, count-in and punch — is in
[FEATURES.md](FEATURES.md#transport-playhead-and-locators) and
[FEATURES.md](FEATURES.md#metronome-and-click-track).

## Audio clip editing

Selecting an audio clip opens a clip bar under the arrangement toolbar. The gold
line across the waveform is **clip gain**: drag it anywhere between −24 and
+12 dB, double-click for unity, or type a value with the slider. Gain is a clip
setting, so it is instant, non-destructive and independent of the fader.

**Normalize** (`N`) measures the loudest sample in the clip's audible window and
sets gain so it peaks at −1 dBFS. **Reverse** (`R`) plays the clip backwards and
mirrors its waveform; reversed and stretched clips carry `⟲` and `≈` badges in
the clip header. Both leave the source, waveform and offset untouched and are
one undo step.

**Stretch** fills the clip's current timeline length with pitch-preserving
time-stretch, so dragging an edge warps the audio instead of trimming it;
**Pitch** shifts ±12 semitones at constant length. The same WSOLA engine as the
Preview panel renders these into cached buffers before playback and during
export, so the timeline and the WAV match. `src/audio/clipsource.ts` owns the
caching and `src/audio/dsp.ts` the stretch itself.

**Slice to grid** detects transients in the clip, cuts it at every detected hit
and pulls each cut onto the current Snap value, time-stretching each slice so
the performance still fills its slot. It is one undo step and is disabled when
Snap is Off. A sliced, reversed or stretched clip can still be trimmed, faded
and gain-staged afterwards.

**Quality notes.** Time-stretch uses waveform-similarity overlap-add (WSOLA)
with a Hann window and normalised overlap-add gain, which avoids the phasing of
naive granular stretching at the ±50% ratios this UI exposes. Pitch shift is a
time-stretch followed by cubic resampling, keeping length constant. Everything
is prepared off the audio thread and cached per source/settings pair; a cache
miss during playback falls back to the dry source rather than going silent, and
the next roll uses the processed buffer.

## Sample browser and drag and drop

The Browser panel has two views. **Library** holds tracks, instruments,
microphones and effects; **Files** is a file explorer for sample folders. **Open
folder** asks the system for a folder, keeps the handle and shows it as a chip
next session, re-confirming access the first time you use it. Subfolders open in
place with breadcrumbs, **Up** and **Refresh**; *Filter this folder* searches the
folder you are in, *Audio only* hides everything else, and each audio row shows
its length and size with a ▶ audition that loads it into the Audio Preview
without importing anything.

Rows are drag sources. Drop one on the arrangement and the clip lands on the lane
and beat you released it over, snapped to the current grid; a multi-file drop
lays the files out one after another from that point. Double-clicking a row (or
pressing Enter) inserts it at the playhead on the selected audio track. Files and
folders dragged in from the desktop work the same way anywhere in the window —
off the timeline they import at the playhead — and dropping them on the Files
panel opens them as a library. **Session audio** at the bottom lists every asset
in the project (imports and recorded takes) and its rows drag onto tracks too.

Folders are remembered through the File System Access API; browsers without it
fall back to a directory input plus drag and drop, so the panel always works.

## Loop editor and slicing

The Audio Preview is also the loop editor. Loading a file — from **Open file**,
from an audition row, or by dropping audio anywhere on the panel — analyses its
tempo and draws the bar and beat grid over the waveform, anchored to the first
detected hit. A name with an explicit tag (`break_174bpm.wav`, `arp@128.wav`)
beats the detector and shows as a locked tempo, which is the reliable path for a
loop library. Type a BPM to override it; the badge reports the tempo and the
detector's confidence.

Drag across the waveform to select a region (a click still seeks, double-click
selects the whole file). The selection is what loops, what the slicer cuts, and
what **Export** writes. **Snap to bars** grows it to whole bars of the current
tempo. The slicer cuts the region into **1 bar / 2 bars / 4 bars / 1 beat /
1/8** pieces on the grid, or on the region's own transients (snapped to the beat
when they land close). Slice boundaries are drawn in amber over the waveform.

**Slices → arrangement** stretches the file to the project tempo once and lays
the slices out end to end from the playhead, so a 174 BPM break lands on the
project grid as eight looping clips in one undo step. **Export** writes the
selection as a 24-bit WAV; with slices it writes one WAV per slice plus a
`loop.json` manifest into a folder you choose (Chrome/Edge), or downloads them
individually. `loop.json` records the tempo, the bar count and each slice's
range in seconds.

## Insert chains and chain templates

The device rack is one chain per track. A tab across the top of the rack switches
between every track and the **Master** bus, so each part keeps its own stack of
effects; selecting a track anywhere in the studio brings its chain up. Modules
are numbered in signal order, can be moved with the arrows, bypassed with the
power button, collapsed, or removed, and the chain flows top to bottom into the
channel fader. Reordering, bypassing and removing are all normal undoable edits.

The modules follow the shape of a console strip and a modular rack. **Console
Strip** combines a high-pass filter, low/mid/high EQ with a sweepable mid, a
soft-knee compressor and drive. **Bus Glue** is a slow VCA-style bus compressor
for groups and the master. **FET Comp** is fast peak control, **Opto Leveler** is
slow and smooth, **Tape** adds saturation and a tone control, and **Air** is a
high-shelf presence stage. The original EQ, compressor, limiter, drive, filter
and chorus devices can sit in the same chain.

**Echo** and **Reverb** are the two deep modules. Echo has four storage types:
tape (soft bandwidth loss and wow/flutter), BBD (dark and modulated), digital
(clean, up to two seconds) and ping-pong (cross-fed sides). Filters and
saturation sit inside the feedback loop, so every repeat darkens and softens
instead of only the wet output; feedback high/low cut, drive, modulation and
stereo width have their own controls, and **Sync** locks the delay to the tempo
with straight, dotted and triplet divisions. The loop's own latency is trimmed
from the stored time, so a synced eighth stays a synced eighth however many
repeats you run. **Freeze** closes the input and holds the existing repeats at
just under unity feedback, and **Duck** sidechains them to the dry signal — a
rectified, smoothed envelope at audio rate — so vocals stay in front of their
own echo; Duck Rel sets how quickly the repeats come back.

**Reverb** is algorithmic: two decorrelated banks of damped comb filters feed
allpass diffusion, with a separate early-reflection field in front. Decay is a
real RT60 in seconds, damping removes highs inside each loop so the tail gets
darker as it dies, and pre-delay, low cut, diffusion, early level, modulation and
width stay independent. **Plate** is fast and dense, **Hall** is long and open,
**Room** leans on its early reflections. Both modules draw their own live
display: the echo its repeat pattern and division, the reverb its decay envelope
and early taps.

**Templates** in the rack header loads a ready gain-staged chain for the current
track or the master. Track templates are grouped into Vocal, Drums, Bass, Keys &
Guitar and Bus; master templates cover streaming, club, warm analog and clean
loudness. Loading a template replaces the chain in one undo step, so `Ctrl+Z`
restores the previous stack, and every value it writes is an ordinary knob you
can keep turning. Master templates always end with a limiter and a ceiling at or
below 0 dBFS; check the loudness readout after loading one, because a template
is a starting point and cannot balance a mix for you.

The panel design is original work modelled on the workflow and feel of classic
console-strip and modular-rack plugins. No product names, logos or trade dress
are reproduced. `src/audio/devices.ts` holds the audio paths, `src/audio/specs.ts`
the controls, `src/audio/templates.ts` the chains, and `src/ui/rack.ts` the panel.

## Recording, takes and comping

Arm an audio track and press **Record** or `R`. If the count-in is on, the
transport counts in first (once, before the first lap of a loop pass); capture
starts before it rolls and the take is trimmed back to the first beat, so the
recording lands on the grid. **Takes** opens the
input and comp panel: pick the interface, switch on **Monitor input** (use
headphones), and see every pass with its waveform. Takes are kept beside the
arrangement, not on top of it, and their audio is embedded in the project.

The capture path is kept transparent: input runs through an AudioWorklet on the
audio thread (with a compatibility fallback for older builds), echo
cancellation, noise suppression, auto gain and voice isolation are switched
off, and the take is stored as 32-bit float at the interface's own rate — no
gain stage, limiter or dither between the converter and the clip. The Takes
panel reports what the open input is really delivering, for example
`44.1 kHz · 2 ch · 32-bit float · audio-thread capture · no input processing`,
and turns amber with a warning if any sample reaches full scale. Headroom and
noise floor belong to the interface itself; this keeps the software from
adding anything on top.

To comp, shift-drag the ruler over the phrase you want and press **Use range** on
the take that played it best; **Listen** auditions that take over the range first.
The comp becomes an ordinary audio clip, and the clips it crosses are split or
trimmed around it, so the arrangement keeps playing, bouncing and exporting
through the normal channel strip. **Use take** without a range takes the whole
pass. Every comp is one undo step, the takes stay intact, and once a comp is in
place you can still trim, fade and gain-stage it like any audio clip.

With the loop on, **Record** becomes loop recording: the transport starts at the
loop start and each lap is captured as its own take, aligned to the loop and
named in order, so a comp can pick the best lap for each phrase. The last
complete lap is placed in the arrangement as you stop; a lap cut short is kept
as a partial take rather than discarded. The whole pass is one undo step, takes
stay in the panel between sessions, and capture stops itself after five minutes
so an unattended take cannot exhaust memory.

**Punch in** and **punch out** take their points from the loop braces, the way
Ableton does: IN keeps nothing before the loop start, OUT nothing after the loop
end, either works without the loop running, and both switches are saved with the
project. Audio is trimmed inside the recorder, so the take holds exactly the
braced span; a take that falls entirely outside it is dropped instead of landing
on the timeline.

## Recording MIDI

Arm a MIDI track and press **Record**. Notes arrive from a controller (enable the
port in **MIDI → Enable MIDI inputs**) or from the computer keyboard while the
MIDI panel is open, and each note is placed at the transport position where it
was played rather than where the last frame drew. The pass commits as one clip
and one undo step.

With the loop on, every lap adds into the same clip, so a drum pattern or a bass
line is built a layer at a time. Recording over a clip that already covers the
pass start overdubs into it and grows it rather than stacking a second clip on
top. The count-in is heard but never recorded, punch in/out trims the pass, and a
pass that captured nothing says so instead of leaving an empty clip behind.

## Sessions

Projects save to `.hstudio` files (JSON envelope, imported audio embedded as
16-bit PCM) from the **File** menu or `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+O` /
`Ctrl+N`. Chromium-based browsers and the desktop build write back into the same
file through the File System Access API; other browsers download the document.
A browser snapshot (autosave) and the six most recent sessions are kept in
`localStorage`, and the start screen offers Resume, New project, Open and the
VST3 scan preference.

## Interface and type

The interface is set in Inter, and every readout — transport, faders, knobs,
peak values — in JetBrains Mono. Both are self-hosted from `public/fonts/` and
declared at the top of `src/styles.css`, so the Windows build renders identically
with no network access. The console skin lives in the same file: engraved badge
plate and panel screws on the faceplate, paper scribble strips on each channel,
recessed fader plates, and glass over the meters.

## Windows desktop build

The native host lives in `native/` and is built with CMake + JUCE 9. It adds
ASIO device selection, per-track VST3 mixing, the virtual ASIO loopback and a
WebView2 shell around the same web UI.

**Using VST3 on every track.** In Studio Rig, **Export stems…** renders one dry
stem per track (after the built-in inserts, before the fader) plus a
`stems.json` manifest into a folder you choose. **Load folder…** hands that
folder to the native mixer: it rebuilds the channel strips from the manifest and
plays the song through a VST3 chain on each track before the fader, then the
master chain. **Play/Stop**, the position readout and loop in the same panel own
playback while stems are loaded, so the plugins process the actual mixrather than just the live input. The folder is the only hand-off; nothing is uploaded.

Stems are printed from your own tracks. Tone Art Studio does not split a mixed song into
vocals, drums and bass: that needs a hosted model, so it would only work online
and would mean uploading your audio, and it is deliberately not part of the app.

**Tone Art Gate**, the bundled VST3, is built by the same CMake project
(`native/Plugins/ToneArtGate`) and installed into the standard
`Common Files\VST3` folder, so **Scan** in Studio Rig finds it next to
third-party plugins and any other DAW can load it. It is a tempo-synced gate:
the rate is 1/1 to 1/32 of a bar, it follows the host's position so the pattern
stays locked to the bar, and shape, depth, phase, smoothing and mix are all
automatable parameters. Build just the plugin with
`cmake --build native/build --config Release --target ToneArtGate`, or turn it
off with `-DHYBRID_BUILD_GATE_VST3=OFF`.

Limits worth knowing: stems are a print, so editing a clip, note or built-in
effect needs a fresh export before you hear it through the VSTs. The browser's
own transport is bypassed while stems are loaded, and VST chain layouts are
session state — they are not stored in the `.hstudio` project yet. Browsers
cannot load VST3 binaries at all, so this is desktop-only.

The mixer core (`native/Core`) is JUCE-free and tested on any machine with
`native/Core/build-tests.sh`; the VST3 adapter and scanner are in
`native/Source/VstInsert.cpp` and `VstScanner.cpp`. `native/MIXER.md` describes
the protocol and the remaining stages.

Requirements: Windows 10/11, Visual Studio 2022 (Desktop C++), CMake 3.25+,
Node.js 20+, and optionally Inno Setup 6.3+ for the installer.

```powershell
npm ci; npm run build
cmake -S native -B native/build -G "Visual Studio 17 2022" -A x64 -DHYBRID_BUILD_VIRTUAL_ASIO=ON
git -C native/build/_deps/juce-src submodule update --init --recursive
cmake -S native -B native/build -G "Visual Studio 17 2022" -A x64 -DHYBRID_BUILD_VIRTUAL_ASIO=ON
cmake --build native/build --config Release --parallel
```

The artefacts land in `native/build/HybridStudio_artefacts/Release/` with the
web UI copied to `ui/`, plus `HybridVirtualAsio.dll` and `install-virtual-asio.ps1`.

## Installer and branding

`installer/build-installer.ps1` runs the whole chain (web UI, native build,
Inno Setup) and writes the engine installer:

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1
# -> dist-native\ToneArtStudioHostSetup-<version>.exe
```

`installer/ToneArtStudio.iss` is the installer definition: machine-wide install
into Program Files (the virtual ASIO driver needs HKLM), Start Menu and optional
desktop shortcuts, optional registration of the driver, a WebView2 runtime
check, and uninstall that removes the driver again.

Two installers come out of a Windows build, and they are different programs:

| File | What it is |
| --- | --- |
| `dist-installer/ToneArtStudioSetup-<version>.exe` | The installed desktop app. Electron plus Web Audio: no ASIO, no VST3. |
| `dist-native/ToneArtStudioHostSetup-<version>.exe` | The native engine. The same interface in a JUCE host, with ASIO in and out, VST3 hosting, and the Tone Art Virtual ASIO driver registered at install time. |
| `dist-native/ToneArtVirtualAsio-<version>.zip` | Just the driver and its registration script, for another DAW. |

The app cannot open ASIO: its audio runs in Chromium's audio stack. The engine
can, and the driver is what lets another ASIO application pass audio to and from
the studio. Anything that promises ASIO inside the plain app is wrong.

Brand assets are generated by `python3 assets/brand/generate-icons.py`:

| file | used for |
| --- | --- |
| `tone-art.ico` | installer and uninstaller icon, shortcut icon |
| `tone-art-1024.png` | `ICON_BIG` in `native/CMakeLists.txt`: the executable icon (JUCE builds the .ico) |
| `tone-art-{16..1024}.png` | store pages, docs, thumbnails |
| `tone-art-logo.svg` | vector master |
| `wizard-large.bmp`, `wizard-small.bmp` | Inno Setup wizard artwork |

The same script writes the web icons into `public/` (`logo.svg`,
`favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`,
`icon-512.png`), so
the browser tab, bookmark and the WebView2 title bar all show the mark.
`tests/installer.test.ts` checks every path and pixel size the installer and the
CMake icon step depend on.

## CI

`.github/workflows/native-windows.yml` builds the UI, the JUCE host, the virtual
driver and both installers on `windows-latest`. It fails outright if
`HybridVirtualAsio.dll` was not produced, because an optional CMake target that
silently skips is how a release ends up promising a driver it does not contain.
It uploads `tone-art-studio-windows` (portable folder), `tone-art-studio-setup`
(the app) and `tone-art-host-setup` (the engine and the driver zip), then
publishes all of them to the release with a `SHA256SUMS.txt`.
`publish-setup.yml` republishes the same artefacts from the newest run when the
release step itself fails.
