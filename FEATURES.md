# Feature ledger

This file is the durable record of what has been asked for and where it stands.
It is updated as capabilities land, so a later session starts from the same list
instead of guessing.

**End goal:** record, mix, master and edit in one studio, with the audio and MIDI
editing depth expected of an industry-standard DAW.

Status key: **Done** ships and is verified in this build · **Partial** works with limits stated · **Planned** requested, not built yet.

## Transport, playhead and locators

| Requested | Status | Notes |
| --- | --- | --- |
| Locate by clicking the ruler or arrangement | **Done** | Snaps to the current grid; while playing it keeps rolling from the new spot. |
| Drag the playhead / visual scrub | **Done** | Dragging the upper ruler auditions the position and resumes playback where released. This is visual scrubbing, not tape-style audio scrub. |
| Playhead follow modes | **Done** | Page, Scroll, Center and Off, selected in the toolbar or cycled with F; remembered per browser. |
| Return to project start / end | **Done** | Home and End, plus the transport rewind button. |
| Return to last playback start | **Done** | Shift+R or the ↩ transport button. |
| Go to loop start / end | **Done** | Shift+Home and Shift+End. |
| Nudge by grid or bar | **Done** | Left/Right use the Snap grid (a sixteenth when Off); Shift+Left/Right jump a bar. |
| Type a location | **Done** | Click the bar.beat.sixteenth readout and type a position. |
| Named markers / locators | **Done** | M adds at the playhead; double-click the marker band to add or rename; drag to move; Alt+click to delete. They are saved with the project and drawn through the arrangement. |
| Previous / next marker | **Done** | Comma and period jump between locators. |
| Loop range in the ruler | **Done** | Drag the lower strip or its braces; the loop survives save and reload. |
| Loop from a selected clip | **Done** | Shift+L sets the loop to the clip exactly. |
| Loop start / end at the playhead | **Done** | [ and ] set the braces and enable the loop. |
| Play from selection | **Done** | Shift+Space starts at the selected clip; a Shift+dragged ruler range plays with Space. |
| Metronome click on/off | **Done** | K toggles it; count-in clicks still sound when the playback click is off. |
| Click level, accent and sound | **Done** | Settings caret or right-click on the metronome: volume, accent beat one, and Classic / Click / Wood voices. |
| Click subdivisions | **Done** | Quarter, eighth or sixteenth clicks, with the downbeat accented. |
| Count-in / pre-roll | **Done** | 1, 2 or 4 bars before playback; Shift+K toggles it, the readout counts down, Stop cancels it. It follows the project meter; count-in on a recording take waits on capture. |
| Tap tempo | **Done** | T or TAP; 40–260 BPM, following the usual two-second tap window. |
| Punch in / out | **Done** | IN and OUT in the transport, using the loop braces as the punch points the way Ableton does: IN drops everything before the loop start, OUT everything after the loop end, either works without the loop running, and both are saved with the project. Audio takes are trimmed in the recorder; MIDI notes outside the range are never captured and a note held past punch-out ends on it. |
| Loop recording and takes | **Done** | With the loop on, Record starts at the loop start and every lap becomes its own take, aligned to the loop; the last complete lap is placed in the arrangement and a lap cut short becomes a partial take. All laps stay in the Takes panel for comping, and one undo step removes the pass. Capture stops at five minutes. |
| Marker-based loop range | **Done** | L loops the drawn range when there is one, otherwise between the markers either side of the playhead (or the last pair); pressing it again on that exact marker loop turns the loop off. Shift+L still loops a clip. |
| Selection-range playback | **Done** | Shift+drag the ruler draws a range; Space plays it once and parks on its end, and L loops it. Drawn in blue across ruler and lanes, cleared by a plain locate. |
| Tape-style audio scrub | **Done** | Dragging the playhead plays throttled, self-fading grains of the audio clips beneath it through their channel strips; grain pitch tilts slightly with drag speed. MIDI/instruments are not scrubbed. |

## Metronome and click track

Researched against the current Ableton Live 12, Logic Pro and Pro Tools
documentation, then checked in this build. The transport exposes the controls
that matter for keeping time without turning the top bar into a second mixer.

| Feature | Status | Notes |
| --- | --- | --- |
| Click on/off during playback | **Done** | K, the transport button, or the settings checkbox. |
| Click level | **Done** | 0–100% in the settings panel; the click rides the master input so it sits with the mix. |
| Accent beat one | **Done** | On by default; switching it off gives every click the same pitch and level. |
| Click sound | **Done** | Classic sine, bright Click and dry Wood, matching the three choices in Ableton's metronome. |
| Subdivision | **Done** | Quarter, eighth and sixteenth notes; subdivisions are quieter than the main beats. |
| Count-in length | **Done** | 1, 2 or 4 bars, using the project's beats-per-bar. |
| Count-in independent of click | **Done** | Count-in is audible with the playback click off, and can be enabled without enabling the click. |
| Count-in visual | **Done** | The position readout and count-in button show the remaining count; the button pulses. |
| Tap tempo | **Done** | T / TAP; tempo 40–260 BPM. |
| Settings persistence | **Done** | Click sound, level, accent, subdivision, count-in and count-in length are saved per browser. |
| Count-in for recording / punch | **Done** | Capture starts with the count-in and the pre-roll is trimmed at the first beat, so the take lands on the grid; loop recording counts in once, before the first lap, and MIDI notes played during the count-in are heard but not recorded. |
| Click output routing | **Planned** | The click currently shares the master input; a separate cue output would need a dedicated monitor bus. |

## Recording

| Requested | Status | Notes |
| --- | --- | --- |
| Record audio from an input | **Done** | Arm an audio track and press Record (R). Capture uses the transport's AudioContext, input monitoring is optional, and each pass becomes a take aligned to the transport anchor. |
| Converter capture quality | **Done** | Input is captured on the audio thread through an AudioWorklet (ScriptProcessor fallback), at the interface's own rate, as 32-bit float, with echo cancellation, noise suppression, auto gain and voice isolation disabled and no gain stage, limiter or dither before the take. The Takes panel reports the live format and flags full-scale input. Converter noise floor and headroom remain the hardware's. In the Windows build, recording still arrives through WebView2's shared-mode capture rather than straight from the ASIO driver; capturing ASIO input at the device rate is the remaining step for studio-grade conversion. |
| Import audio recordings | **Done** | Import Audio in the browser; WAV/MP3 decode, waveform peaks, embedded in the project file. |
| Take management | **Done** | Every pass is kept with its waveform; takes are listed per track, auditioned over a range, and saved with the project, including their audio. |
| Comping | **Partial** | Shift-drag the ruler and click Use range on a take: the comp replaces that span, splits or trims the clips it crosses, fades each edge and is one undo step. Take lanes in the arrangement and automatic crossfade matching between comps are not built. |
| Punch in / out recording | **Done** | Uses the loop braces as punch points (see Transport). A take that falls entirely outside the braces is dropped rather than placed, and a pass recorded in the braces keeps only that span. |
| Record with latency compensation | **Partial** | Takes align to the transport anchor (capture pre-roll is trimmed), but device round-trip latency is not measured and compensated. |
| MIDI recording from a keyboard | **Done** | Arm a MIDI track and press Record: notes from a Web MIDI port or the computer keyboard land at their transport positions in one undoable pass. With the loop on every lap adds to the same clip (overdub); recording over a clip that covers the pass start overdubs into it and grows it instead of stacking a second clip. Nothing is captured during the count-in, punch in/out trims the pass, and a pass with no notes says so rather than creating an empty clip. The armed track that is selected is the one recorded, because that is the track the notes are played through. |

## MIDI editing

| Requested | Status | Notes |
| --- | --- | --- |
| Piano-roll note editor | **Done** | Double-click a MIDI clip, press Enter, or use **Notes**. Draw, drag to move, drag the right edge to stretch, Delete, arrow-key nudges, note audition on the instrument. |
| Quantize, transpose, velocity | **Done** | Quantize snaps start and length to the chosen grid; ±12 transposes; velocity slider applies to selection or all notes. |
| Undoable editing gestures | **Done** | Each gesture is one undo step; the arrangement and the note editor share the same history. |
| Four built-in instruments | **Done** | Drums, Poly Synth, Electric Piano, Bass, each with editable parameters and MIDI preview keys in the rack. |
| MIDI import / export (.mid) | **Planned** | Needed to move parts between DAWs. |
| Drum map and per-note articulations | **Planned** | Useful for realistic drums and orchestral libraries. |
| Note nudge/groove templates | **Planned** | Quantize exists; swing and extract-groove do not. |

## Audio editing

| Requested | Status | Notes |
| --- | --- | --- |
| Split, duplicate, delete | **Done** | Toolbar buttons and `S` / `D` / `Delete`; MIDI notes are split with the clip. |
| Trim, move, snap, zoom | **Done** | Drag edges or body, snap values from 1/32 to bar, zoom with `+` / `−` / Ctrl+scroll. |
| Fades and declicking | **Done** | Draggable fade handles on audio clips plus automatic short crossfades at clip boundaries. |
| Waveform display | **Done** | Peaks computed on import and after every bounce. |
| Loop editor: BPM detection, slicing, drop and export | **Done** | The Audio Preview doubles as a loop editor. It analyses tempo (an explicit `120bpm`/`@128` tag wins), draws the bar/beat grid, and lets you drag a region that loops. **Snap to bars** fits the region to the grid; the slicer cuts it into 1/2/4-bar, beat, 1/8 or transient slices. **Slices → arrangement** lays them out at the project tempo in one undo step, and **Export** writes a 24-bit WAV or a folder of slices with `loop.json`. Audio dropped on the panel opens there. |
| Clip gain, reverse, normalize | **Done** | Gold gain line on every audio clip (±24/+12 dB, double-click for unity), clip-bar slider, Normalize to −1 dBFS (N) and non-destructive Reverse (R); all one undo step. |
| Time-stretch and pitch shift on the timeline | **Done** | Stretch fills the clip's timeline length with pitch-preserving WSOLA, so dragging an edge warps it; pitch shifts ±12 semitones at constant length. Rendered into cached buffers before playback and included in the mixdown. |
| Comping and takes | **Planned** | No take lanes yet. |
| Audio quantize / groove | **Partial** | Slice to grid detects transients, cuts the clip and pulls each cut to the Snap grid, time-stretching each slice to fit. There is no groove template or manual warp-marker editing. |
| Automation lanes | **Planned** | Fader, pan, send and plugin parameters are static; no envelopes. |
| Markers and arrangement regions | **Done** | Loop braces are real, draggable locators and drive follow/loop playback; named markers, a marker band and previous/next navigation are built. Marker-to-marker loop ranges remain planned. |

## MIDI to audio

| Requested | Status | Notes |
| --- | --- | --- |
| Convert MIDI to audio | **Done** | **Bounce** in the arrangement toolbar, or **Print to audio** in the piano roll. Renders offline through the instrument, channel EQ, inserts, pan, fader and sends, and inserts a new audio track directly below with a unity fader and neutral EQ so nothing is applied twice. The MIDI is kept, so the print is non-destructive and one `Ctrl+Z` removes it. |
| Bounce whole tracks and audio clips | **Done** | With no clip selected, Bounce prints every clip on the selected track as one file; with an audio clip selected it prints that clip through its inserts. |
| Stem export and batch bounce | **Done** | Studio Rig → **Export stems…** prints one dry, pre-fader 24-bit stem per track plus a `stems.json` manifest into a folder you choose; the native VST3 mixer loads that folder. Writing a folder needs the File System Access API (Chrome, Edge or the desktop build). |
| Stem separation (vocals/drums/bass out of a mixed song) | **Not planned** | That needs a hosted model such as Demucs, so it would only work online and would send your audio to a server. Stems are printed per track instead, which keeps everything on your machine and works offline. |
| Freeze/commit insert chains in place | **Partial** | Bouncing a track freezes its sound to audio; there is no one-click bypass/freeze toggle. |

## Mixing

| Requested | Status | Notes |
| --- | --- | --- |
| Console-style mixer | **Done** | Channel strips with trim, 3-band EQ, pan, fader, mute/solo, four sends with pre/post, insert list, meters, scopes. |
| Aux sends and returns | **Done** | Reverb, Delay, Chorus and Room returns are full channels with their own faders and inserts. |
| Insert effects | **Done** | EQ three, compressor, limiter, Echo, Reverb, drive, filter, chorus, a mic-emulation module, and six console/rack modules: Console Strip (HPF, 3-band EQ, compressor, drive), Bus Glue, FET Comp, Opto Leveler, Tape and Air. |
| Echo | **Done** | Four storage types in one engine: tape (bandwidth loss and wow/flutter), BBD (dark, modulated), digital (clean, up to 2 s) and ping-pong (cross-fed sides). Feedback filters and saturation sit inside the loop so repeats degrade the way hardware does; tempo sync with straight, dotted and triplet divisions; loop latency is compensated so repeats stay on the grid. Freeze closes the input and holds the current repeats at near-unity feedback, and Duck sidechains the wet signal to the dry input at audio rate with an adjustable release. |
| Reverb | **Done** | Plate, hall and room from two decorrelated banks of damped comb filters into allpass diffusion, plus a separate early-reflection field. Decay is a real RT60 in seconds, damping shortens the highs inside every loop, and pre-delay, low cut, diffusion, early level, modulation and width are independent. |
| Per-track effect chains | **Done** | The rack is one chain per track plus the master: a tab for every track, numbered slots in signal order, move up/down, bypass, collapse, remove. Selecting a track anywhere brings its chain up. |
| Mix and master chain templates | **Done** | Track templates (Vocal, Drums, Bass, Keys & Guitar, Bus) and master templates (streaming, club, warm analog, clean) load a gain-staged chain in one undo step; every value stays editable. |
| Track reordering | **Done** | Drag in the arrangement or the console; both stay in step. |
| Per-track VST3 inserts (desktop) | **Partial** | Studio Rig prints one dry stem per track plus a `stems.json`, and the native host rebuilds the channel strips, runs a VST3 chain on every track before its fader and a master chain, with editors, bypass, reorder, mute/solo and a native transport. Stems are a print, so browser edits need a re-export, and chain layouts are not saved in the project yet. The same build produces the bundled **Tone Art Gate** VST3 (tempo-synced gate, host-synced rate, automatable), installed to the standard VST3 folder. See `native/MIXER.md`. |
| Group/VCA buses | **Planned** | |
| Sidechain compression | **Planned** | |
| Parameter automation | **Planned** | See audio editing. |

## Mastering

| Requested | Status | Notes |
| --- | --- | --- |
| Master chain and limiter | **Done** | EQ, glue compressor, limiter with ceiling, master fader, safety clipper. Master chain templates (streaming, club, warm, clean) load a whole bus chain ending in a limiter. |
| Loudness measurement and targets | **Done** | ITU-R BS.1770-4 integrated LUFS, 4× oversampled true peak, crest, phase, four bands. Targets: streaming −14, club −9, speech −16 LUFS. |
| AI Mix & Master (Sage) | **Done** | Insert and Sage AI panel; measures one track or the whole mix (every track plus the master), explains and applies corrections as one undo step. |
| Whole-mix AI pass | **Done** | Renders all tracks in context as well as the mix, so cross-track low end, mid-range build-up and stereo width are judged together with the master bus. |
| AI edits stay editable | **Done** | Corrections write normal strip/master parameters; each pass is one undoable step with an explicit Undo AI change, and every applied value can be dragged afterwards. |
| Dither on export | **Planned** | Export is 16/24-bit WAV without noise shaping. |
| Per-song loudness report on export | **Partial** | The assistant reports the numbers; the export dialog does not. |

## Studio, files and help

| Requested | Status | Notes |
| --- | --- | --- |
| Project save/open with embedded audio | **Done** | `.hstudio` JSON envelope, 16-bit PCM assets, autosave snapshots, six recent sessions. |
| File browser / sample explorer | **Done** | The Browser has Library and Files views. Files opens a real folder through the File System Access API, remembers the handle as a chip for next session and re-confirms access on use. Breadcrumbs, Up, Refresh, in-folder filter, audio-only toggle, sizes and durations, and audition through the Audio Preview. Falls back to a directory input where the API is missing. Session audio lists every asset in the project. |
| Drag and drop | **Done** | Rows drag onto the arrangement and land on the lane and beat they were dropped on, snapped to the grid; several files lay out one after another. Desktop files and folders drop the same way, anywhere in the window (a drop off the timeline imports at the playhead); dropping onto the Files panel opens the folder as a library. Double-click or Enter inserts at the playhead. No file move/rename/delete — the explorer is read-only by design. |
| WAV mixdown | **Done** | Offline render through the master chain. |
| In-app help and hints | **Done** | Sage's Help tab: live session checks with one-click fixes, 24 searchable guides, shortcuts. |
| Tablet remote | **Done** | LAN controller with transport, tap tempo, record arm for audio tracks, record start/stop through the studio capture path (count-in and loop takes included), faders, pans, mute/solo, sends A–D, aux returns, master meter and peak hold, a tappable arrangement map and a performance FX pad. The Remote panel draws a QR code of the link, token included, so a phone camera opens it without typing; the code is generated locally, never by a web service, and hides after two minutes. Works over a network, a phone or computer hotspot, or USB (`adb reverse`) with no router, LAN-only or internet via a token-protected tunnel, installable with an offline shell, haptic, reconnect-safe. |
| Multi-screen and responsive workspace | **Done** | Resizable splitter panels with keyboard/double-click reset, presets, fit-to-window, fullscreen, per-screen clamping and DPI repaint. Hidden side panels open as drawers on narrow windows. |
| Scrolling everywhere it is needed | **Done** | Arrangement: wheel scrolls tracks, Shift+wheel or trackpad pans time, Ctrl+wheel zooms, and a draggable rail under the arrangement is the timeline's horizontal scrollbar (hidden when the project fits, clamped to the project). Browser, rack (sticky track tabs), help, Sage, console, piano roll (sticky key column), chain templates, rig, menus and dialogs all wheel/trackpad scroll with overscroll contained. Top bar pans with the wheel when it overflows. |
| Windows desktop build | **Done** | Two programs, both published: the installed app (`ToneArtStudioSetup-*.exe`, Electron plus Web Audio) and the native engine (`ToneArtStudioHostSetup-*.exe`, JUCE host with ASIO in/out, VST3 scanning and hosting, WebView2 shell, Inno Setup installer). A Windows build fails if the engine's installer or the driver DLL is missing, so neither can be silently dropped again. |
| Virtual ASIO driver | **Partial** | A 2-in/2-out user-mode COM driver, built as `HybridVirtualAsio.dll` on every Windows build and registered by the engine installer (or by `install-virtual-asio.ps1`), with a driver-only zip for other DAWs. Loopback through shared-memory rings into the Studio Rig panel. Limits: 64-bit hosts, stereo Float32, no MIDI or clock sync, fixed rate while a host runs. Not yet exercised against a third-party ASIO host, so it is listed as partial rather than done. |
| Browser plugin hosting | **Not planned** | Browsers cannot load native VST3; plugin hosting is desktop-only by design. |

## Known gaps against an industry-standard DAW

Largest first: automation lanes, take lanes in the arrangement, MIDI
import/export, group buses and sidechain, dither, a separate click/cue output,
latency compensation for takes, manual warp markers and groove templates for
audio quantize.
These are the items to build next; each is listed as **Planned** above.
