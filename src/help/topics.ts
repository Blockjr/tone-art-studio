/**
 * The in-app help library.
 *
 * Every entry has to be true of this build: the same buttons, the same
 * shortcuts, the same limits. Topics are plain data so the panel can search
 * them and tests can check that every action is a real one.
 */

export type HelpActionKind = 'ai-track' | 'ai-master' | 'export' | 'rig' | 'remote' | 'start';

export interface HelpAction {
  label: string;
  kind: HelpActionKind;
}

export interface HelpTopic {
  id: string;
  title: string;
  group: string;
  keywords: string[];
  body: string[];
  action?: HelpAction;
}

export const HELP_GROUPS = [
  'Start here',
  'Editing',
  'Mixing',
  'AI & mastering',
  'Sound & plugins',
  'Files & remote',
  'Troubleshooting',
] as const;

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'first-session',
    title: 'Start a new session',
    group: 'Start here',
    keywords: ['new', 'project', 'tempo', 'bpm', 'bars', 'start screen', 'demo'],
    body: [
      'The start screen appears on launch: name the project, set tempo and length in bars, then press Create project. It builds two audio tracks and two MIDI tracks, ready to record into.',
      'Load demo session opens a finished four-track arrangement if you would rather pull something apart than start empty. Turn off “Show this screen when Tone Art Studio starts” once you know your way around; the File menu brings it back.',
    ],
    action: { label: 'Show the start screen', kind: 'start' },
  },
  {
    id: 'assistant',
    title: 'Ask Sage and check the session',
    group: 'Start here',
    keywords: ['assistant', 'sage', 'help', 'checks', 'diagnose', 'fix', 'scan', 'ai', 'panel'],
    body: [
      'Sage is the studio assistant in the panel on the right. Open it from the Sage AI button in the top bar, with Shift+M, or by clicking the master insert chain in the console; the ? button opens this Help tab.',
      'Mix & Master covers the whole mix workflow: choose a track or Whole mix (all tracks + master), set the intensity, press Analyze, then apply one correction or all of them. Scan every track measures each channel in turn and lists what stands out.',
      'Every correction writes a normal channel or master control, so you can edit it in the rack or console afterwards. Apply one or Apply all is a single undo step; Undo AI change or Ctrl+Z takes the last pass back.',
      'Check my session reads the open project, not a generic checklist: silent tracks, stuck mutes and solos, a master without a limiter, an unused limiter. Each finding offers a Fix that is an ordinary edit — Ctrl+Z undoes it.',
    ],
    action: { label: 'Open Sage', kind: 'ai-track' },
  },
  {
    id: 'arrangement',
    title: 'Move, split and duplicate clips',
    group: 'Start here',
    keywords: ['clip', 'drag', 'split', 'duplicate', 'delete', 'loop', 'arrange'],
    body: [
      'Drag a clip to move it, drag its right edge to trim. Click to select, then press S to split at the playhead, D to duplicate and Delete to remove it.',
      'Select an audio clip to open the clip bar under the toolbar: gain, pitch, stretch, Normalize, Reverse and Slice to grid. The gold line across the waveform is clip gain — drag it, or double-click it for unity.',
      'Loop is L, and the loop braces on the ruler can be dragged. With a range drawn, L loops exactly that range; otherwise, with two or more markers, it loops between the markers either side of the playhead. Zoom with + and −, or Ctrl+scroll over the arrangement.',
    ],
  },
  {
    id: 'import-audio',
    title: 'Import a recording',
    group: 'Start here',
    keywords: ['audio', 'import', 'wav', 'recording', 'clip', 'file'],
    body: [
      'Use Import Audio in the browser panel, or drag a file from the Files view onto a lane. The file lands as an audio clip on the selected track, with waveform peaks drawn from the samples.',
      'Imported audio is embedded in the .hstudio file as 16-bit PCM, so a project reopens complete on another machine. Browser autosave snapshots deliberately keep the mix but not the audio — the app tells you when a clip needs re-importing.',
    ],
  },
  {
    id: 'recording-comping',
    title: 'Record takes and comp',
    group: 'Editing',
    keywords: ['record', 'recording', 'take', 'takes', 'comp', 'comping', 'monitor', 'microphone', 'input', 'punch'],
    body: [
      'Arm an audio track, then press Record (R) or the circle in the transport. The take starts at the playhead; with count-in enabled the transport counts you in first and the silence before the first beat is trimmed away.',
      'Open Takes to choose the input and switch on Monitor input (use headphones). Every pass is kept with its waveform and travels inside the .hstudio file; recording again on the same track adds a new take instead of overwriting the old one.',
      'With the loop on, Record becomes loop recording. The transport starts at the loop start, every lap becomes its own take, and the last complete lap is placed in the arrangement; a lap cut short at stop is kept as a partial take. Capture stops itself after five minutes so a forgotten take cannot exhaust memory.',
      'To comp, shift-drag the arrangement ruler over the phrase you want, press Listen on a take to audition it, then Use range to put that take into the arrangement. Without a range, Use take comps the whole pass. The clips underneath are split or trimmed, every comp is one undo step, and the result is an ordinary audio clip you can trim, fade and gain like any other.',
      'Punch in and out use the loop braces as their points, the way Ableton does, so there is no second pair of markers to place. IN (in the transport) stops capture before the loop start and OUT stops it after the loop end; either works alone and the loop itself does not have to be running. A pass recorded outside the range is discarded, a note held past punch-out ends exactly on punch-out, and a take that falls entirely outside the braces is dropped instead of landing on the timeline.',
    ],
  },
  {
    id: 'record-midi',
    title: 'Record MIDI from a keyboard or controller',
    group: 'Editing',
    keywords: ['midi', 'record', 'keyboard', 'controller', 'overdub', 'piano', 'keys', 'instrument', 'punch', 'arm'],
    body: [
      'Arm the MIDI track with the red dot on its head or console strip, and pick the instrument you want to hear. Notes go to the armed track that is selected — what you hear is what gets recorded — so with several armed tracks select the one you are playing into.',
      'For a hardware keyboard, open MIDI and press Enable MIDI inputs, then leave Track ticked on the port. With no controller plugged in, the computer keyboard plays while the MIDI panel is open: A–L are the white keys, W E T Y U the black ones, Z and X shift octave and C and V set velocity.',
      'Press Record (R) and play. Each note lands at the transport position where it was played, not where the last frame drew, and the pass commits when you stop: one undo step. The stop button, R and the space bar all end the pass.',
      'With the loop on, Record starts at the loop start and every lap adds to the same clip, which is how a drum pattern or a bass line gets built up a layer at a time. Recording over a clip that already covers the pass start overdubs into it and grows it rather than making a second clip on top.',
      'The count-in is heard, never recorded. With Punch In or Punch Out on, only the part of the pass between the loop braces is kept. If nothing arrived, the app says so instead of creating an empty clip — the usual cause is a closed MIDI panel with the computer keyboard, or a port that was not enabled.',
    ],
  },
  {
    id: 'file-browser',
    title: 'Browse sample folders and drag them in',
    group: 'Files & remote',
    keywords: ['browser', 'files', 'folder', 'explorer', 'samples', 'drag', 'drop', 'library', 'search'],
    body: [
      'The Browser panel has two views: Library (tracks, instruments, microphones, effects) and Files, a real explorer for sample folders. Open folder asks the system for a folder; it is remembered as a chip for the next session, and access is confirmed once more the first time you use it.',
      'Folders open as a list with breadcrumbs, Up and Refresh. Filter this folder searches the folder you are in, Audio only hides non-audio files, and every audio row shows its length and size. The ▶ button on a row auditions it in the Audio Preview panel without importing anything.',
      'Drag a row onto the arrangement to place it exactly where you let go: that lane, that beat, snapped to the grid. Double-click a row (or press Enter) inserts it at the playhead on the selected audio track. Dropping several files at once lays them out one after another from the drop point.',
      'Files and folders dragged in from the desktop behave the same: drop them on a lane to place them there, or anywhere else in the window to import at the playhead. Dropping them on the Files panel opens them as a library. Session audio at the bottom lists everything imported or recorded in the project, and those rows drag onto tracks too.',
      'Where the browser has no folder picker, Files falls back to a directory input and drag and drop, so the panel still works; only the remembered-folder chips need the File System Access API.',
    ],
  },
  {
    id: 'notes',
    title: 'Edit MIDI notes',
    group: 'Editing',
    keywords: ['midi', 'notes', 'piano roll', 'draw', 'quantize', 'velocity', 'transpose', 'clip'],
    body: [
      'Double-click a MIDI clip, select it and press Enter, or press Notes in the arrangement toolbar. The note editor opens over the arrangement with the clip’s notes as bars, coloured like the track.',
      'Click empty grid to draw a note, drag a bar to move it in time and pitch, drag its right edge to stretch it, and press Delete to remove the selected note. The arrow keys nudge by the grid, or by a semitone up and down. Clicking a key on the left auditions that pitch on the track’s instrument.',
      'Quantize snaps the selected note — or every note when nothing is selected — to the grid; −12 and +12 transpose an octave; the Vel slider sets velocity on the same selection. Every gesture is one undo step, and Ctrl+Z works in the editor exactly as it does in the arrangement.',
    ],
  },
  {
    id: 'bounce',
    title: 'Print MIDI to audio',
    group: 'Editing',
    keywords: ['bounce', 'print', 'render', 'audio', 'midi', 'freeze', 'convert', 'wav'],
    body: [
      'Select a clip and press Bounce in the arrangement toolbar, or press Print to audio inside the note editor. The clip is rendered offline through the instrument, channel EQ, inserts, pan, fader and sends, and appears as a new audio track directly below the source.',
      'With no clip selected, Bounce prints every clip on the selected track as one continuous file, which is the quickest way to freeze a finished part. With an audio clip selected it prints that clip through its inserts, so a processed sound becomes a single file.',
      'The print skips the master chain, because the audio goes back into the session and the master would otherwise be applied twice. The new track sits at unity with a flat channel for the same reason. The MIDI track is kept and untouched, so nothing is destructive: mute it, keep it, or Ctrl+Z the whole bounce.',
    ],
  },
  {
    id: 'audio-clips',
    title: 'Edit audio clips: gain, warp and slice',
    group: 'Editing',
    keywords: ['audio', 'clip', 'gain', 'normalize', 'reverse', 'stretch', 'warp', 'pitch', 'time-stretch', 'quantize', 'slice', 'transient', 'editing', 'non-destructive'],
    body: [
      'Select an audio clip to open its bar under the arrangement toolbar. Gain is also the gold line across the waveform: drag it up or down (−24 to +12 dB), double-click it to return to unity, or use the Gain slider for a precise value. Gain is a clip setting, not a rendered change.',
      'Normalize (N) measures the loudest sample in the clip and sets clip gain so it peaks at −1 dBFS. Reverse (R) plays the clip backwards. Both read the existing audio: the file, waveform and source offset stay untouched, and Ctrl+Z returns the previous state.',
      'Stretch warps the clip to its current timeline length with pitch-preserving time-stretch (the same WSOLA engine as Preview). Turn it on and drag the clip edge: the audio follows the edge instead of being trimmed. Pitch shifts −12 to +12 semitones without changing the length. A warped clip is prepared before playback and included in the WAV export.',
      'Slice to grid finds the transients, cuts the clip there and pulls each cut onto the current Snap value, time-stretching each slice so the performance still fills its slot. It is one undo step. Set Snap to a grid first; choose Off and the button is disabled because there is nowhere to move the slices.',
      'Every one of these is non-destructive and undoable, and a sliced or reversed clip can still be trimmed, faded and gain-staged afterwards like any other clip.',
    ],
  },
  {
    id: 'levels',
    title: 'Balance a mix by hand',
    group: 'Mixing',
    keywords: ['fader', 'volume', 'pan', 'trim', 'gain', 'eq', 'send', 'balance'],
    body: [
      'Each strip has trim at the top (the input gain into the channel), a three-band EQ with a sweepable mid, pan, and the fader. Sends A–D feed the reverb, delay, chorus and room returns.',
      'Trim and fader are different tools: trim sets how hard the channel hits its inserts, the fader sets how much of it reaches the mix. The AI insert only ever moves trim, so your fader balance survives.',
    ],
  },
  {
    id: 'insert-chains',
    title: 'Stack inserts and load a chain template',
    group: 'Mixing',
    keywords: ['rack', 'insert', 'effect', 'chain', 'template', 'console', 'compressor', 'fet', 'opto', 'tape', 'air', 'bus', 'signal flow', 'slots'],
    body: [
      'The device rack holds one chain per track, and every track has its own tab along the top — click a track name to see and edit that chain, or Master for the stereo sum. Opening a track anywhere in the studio brings its chain up automatically.',
      'Add a module with the menu under the last slot; up to eight slots are shown at a time and you can keep stacking. Each module card has its number in the signal path, arrows to move it earlier or later, a power switch to bypass it, a collapse arrow, and a remove button. Signal flows top to bottom into the channel fader.',
      'The modules are modelled on console and modular-rack workflows: Console Strip (filters, EQ, compressor, drive), Bus Glue (a slow VCA-style bus compressor), FET Comp (fast peak control), Opto Leveler (slow, smooth levelling), Tape (saturation and tone) and Air (high-shelf presence). The classic EQ, compressor, limiter, drive, filter and chorus devices are still there.',
      'Echo offers tape, BBD, digital and ping-pong storage. Filters and saturation are inside the feedback loop, so repeats darken pass by pass; Sync locks the time to the tempo in straight, dotted or triplet divisions, and Width spreads the two lines. Freeze holds whatever is already in the delay lines — the input closes and feedback opens to just under unity — so a chord or a word hangs and dissolves instead of repeating with new notes on top. Duck sidechains the repeats to the dry input: the wet signal steps back while the voice is loud and returns over Duck Rel, which is how a vocal keeps its intelligibility without turning the echo down. Reverb builds plate, hall or room from damped comb banks and allpass diffusion plus a separate early field. Decay is RT60 in seconds; Damping shortens the highs inside the tail; Pre Delay, Low Cut, Diffusion, Early, Mod and Width are independent. Both panels draw a live display: the echo its repeats, the reverb its decay envelope.',
      'Templates loads ready gain-staged chains for the selected track or the master, grouped by Vocal, Drums, Bass, Keys & Guitar, Bus and Mastering. Loading one replaces the current inserts in a single undo step, so Ctrl+Z brings your chain straight back, and every control it sets is a normal knob you can keep turning.',
      'The master templates always finish with a limiter. Check the loudness readout after loading one: a chain is a starting point, not a guarantee, and the mix has to be balanced before the master bus can be loud.',
    ],
  },
  {
    id: 'ai-track',
    title: 'Let AI mix one track',
    group: 'AI & mastering',
    keywords: ['ai', 'mix', 'analyze', 'suggest', 'correction', 'trim', 'eq', 'compressor'],
    body: [
      'Open Sage (Shift+M), pick a track in the scope selector and press Analyze. It renders that track alone and reports integrated loudness, true peak, crest factor, phase correlation and a four-band balance.',
      'Every correction it proposes quotes the measurement that caused it. Apply one or Apply all — the changes land in the normal channel strip as one undo step, so Ctrl+Z reverts the whole batch.',
      'The Intensity slider scales how far it moves things. At 40% it nudges; at 100% it fixes aggressively. The same engine is also available as an insert: Device Rack → Add device → AI Mix & Master.',
    ],
    action: { label: 'Analyze the selected track', kind: 'ai-track' },
  },
  {
    id: 'ai-master',
    title: 'Master the mix',
    group: 'AI & mastering',
    keywords: ['master', 'ai', 'lufs', 'limiter', 'ceiling', 'glue', 'streaming', 'club'],
    body: [
      'In Sage, set the scope to Whole mix (all tracks + master) and choose a target: Streaming (−14 LUFS), Club / DJ (−9 LUFS) or Speech (−16 LUFS). Analyze renders every track in context plus the full mix through the master chain.',
      'It compares the tracks as an ensemble, so it can spot shared low end, a low-mid pile-up across several parts, a nearly mono stereo field and a mix that is already louder than the target. Then it proposes tonal balance, glue compression, a limiter ceiling and drive, and a master-fader trim.',
      'Mastering is iterative: apply, listen, analyze again. The second pass measures what the limiter is actually doing, so the numbers converge instead of guessing.',
    ],
    action: { label: 'Analyze the master bus', kind: 'ai-master' },
  },
  {
    id: 'loudness',
    title: 'LUFS, true peak and crest',
    group: 'AI & mastering',
    keywords: ['lufs', 'loudness', 'peak', 'dbtp', 'crest', 'meter', 'reference'],
    body: [
      'LUFS is perceived loudness, gated the way broadcast standards specify. Streaming services normalise to roughly −14 LUFS, so a mix mastered to −9 gets turned down and only loses punch.',
      'True peak (dBTP) is the peak between samples, which is what converters actually clip on. Keep it at or below −1 dBTP for streaming.',
      'Crest factor is peak minus RMS: how far the transients stick out above the body. Big crest means dynamic and poky, small crest means dense and controlled. Compression lowers crest, and so does limiting.',
    ],
  },
  {
    id: 'phase',
    title: 'Phase and mono compatibility',
    group: 'AI & mastering',
    keywords: ['phase', 'mono', 'correlation', 'stereo', 'width', 'cancel'],
    body: [
      'Correlation runs from +1 (identical channels) through 0 (unrelated) to −1 (inverted). Negative values mean something cancels when a club system or phone sums to mono.',
      'The Master strip has a MONO button for checking. If a track reads negative, start by re-centring its pan and look for an inverted channel in the source.',
    ],
  },
  {
    id: 'export',
    title: 'Export a mixdown',
    group: 'Files & remote',
    keywords: ['export', 'wav', 'bounce', 'mixdown', 'render', 'master'],
    body: [
      'Export WAV mixdown renders the arrangement through the master chain and downloads a stereo WAV — peaks, limiter and master fader included.',
      'Import and export run offline, faster than real time, so a long arrangement takes seconds rather than the length of the song.',
    ],
    action: { label: 'Export a WAV now', kind: 'export' },
  },
  {
    id: 'loops',
    title: 'Loop editor, BPM and slicing',
    group: 'Files & remote',
    keywords: ['loop', 'bpm', 'tempo', 'slice', 'sample', 'editor', 'detect', 'transient', 'drag', 'export'],
    body: [
      'Open a file in the Audio Preview — Open file, an audition row, or a drop anywhere on the panel. It detects the tempo, shows the bar and beat grid, and loops the dragged selection. A file name with a BPM tag (break_174bpm.wav, arp@128.wav) is trusted over the detector and the badge marks it as a tag.',
      'Drag across the waveform to select a region, click to seek, double-click for the whole file. Snap to bars fits the selection to the grid; the slicer cuts it into 1/2/4 bars, beats, eighths or transients. Slices → arrangement lays the slices out at the project tempo in one undo step, and Export writes a 24-bit WAV or one file per slice with a loop.json manifest.',
    ],
  },
  {
    id: 'saving',
    title: 'Saving and reopening projects',
    group: 'Files & remote',
    keywords: ['save', 'open', 'hstudio', 'autosave', 'recent', 'resume', 'file'],
    body: [
      'Ctrl+S saves, Ctrl+Shift+S is Save as, Ctrl+O opens and Ctrl+N returns to the start screen. Projects are .hstudio files: JSON with a versioned envelope and embedded audio.',
      'In Chromium and the desktop build, Save writes back into the same file; elsewhere it downloads the project. Autosave keeps a snapshot every few seconds so a reload restores the session, and the last six sessions appear on the start screen.',
    ],
  },
  {
    id: 'vst3',
    title: 'VST3 plugins',
    group: 'Sound & plugins',
    keywords: ['vst', 'vst3', 'plugin', 'scan', 'desktop', 'insert'],
    body: [
      'VST3 hosting lives in the Windows desktop build. Studio Rig lists scanned plugins, loads them into the chain of the selected track or the master bus, and opens their editors in a floating window.',
      'The VST3 mixer plays printed stems: Studio Rig → Export stems… writes one dry stem per track and a stems.json into a folder, and Load folder… gives that folder to the native mixer, which plays the song through a chain on every track. Re-export after editing clips, notes or built-in effects; while stems are loaded the native Play button owns playback.',
      'The build ships one plugin of its own: Tone Art Gate, a tempo-synced gate installed to the standard VST3 folder. Scan finds it beside third-party plugins, and any other VST3 DAW can load it too.',
      'Scanning is opt-in: enable “Scan VST3 folders at startup” on the start screen or in Studio Rig. Browsers cannot load native plugins at all, so the option is disabled in the web build.',
    ],
    action: { label: 'Open Studio Rig', kind: 'rig' },
  },
  {
    id: 'asio',
    title: 'ASIO and the virtual driver',
    group: 'Sound & plugins',
    keywords: ['asio', 'driver', 'latency', 'buffer', 'loopback', 'virtual', 'device'],
    body: [
      'The desktop build hosts ASIO directly: choose the device, sample rate and buffer size in Studio Rig. Lower buffers mean lower latency and more CPU load.',
      'The installer can register Tone Art Virtual ASIO, a 2-in / 2-out loopback driver. Other ASIO applications record what Tone Art Studio plays and feed their output back in, which is how you capture another app without an audio interface.',
    ],
  },
  {
    id: 'remote',
    title: 'Control from a tablet',
    group: 'Files & remote',
    keywords: ['remote', 'tablet', 'phone', 'lan', 'transport'],
    body: [
      'Remote serves a small web page over your network. Start it from the Remote panel, then open the shown address on a phone or tablet on the same Wi-Fi — or press QR code and let the phone camera scan it, which saves typing the address and token on a touch keyboard. The code is made on your computer, never by a website, and hides itself after two minutes.',
      'No router is needed: the phone can run a hotspot the computer joins, Windows Mobile Hotspot can do the reverse, and on Android a USB cable with adb reverse works with no radio at all. The two devices only need a path to each other; there is no internet round trip.',
      'The Arrangement map is live: tap a clip to jump the playhead there and select its track. The Performance pad throws the selected channel into the reverb and delay returns — drag for the amount, double-tap to zero. Several tablets can follow the same session, and the page reconnects by itself if Wi-Fi drops.',
      'Arm an audio track with the red dot on its strip, then press Record on the tablet. The take starts on the studio computer through the normal capture path: count-in, loop recording, takes and comping behave exactly as they do locally, and Record stops and keeps the take. The pad reads ARMING while the input opens, COUNT during a count-in and REC while capture runs; if it cannot start, it says NOT STARTED instead of pretending. MIDI tracks have no arm dot on the tablet yet; arm them in the studio and a record started there captures them too.',
    ],
    action: { label: 'Open the Remote panel', kind: 'remote' },
  },
  {
    id: 'workspace',
    title: 'Fit the workspace to any screen',
    group: 'Files & remote',
    keywords: ['layout', 'screen', 'screens', 'monitor', 'monitors', 'multiple', 'resize', 'fullscreen', 'fit', 'panel', 'multi', 'display', 'zoom', 'dpi'],
    body: [
      'Drag the splitters beside the browser, beside the rack or above the console to resize the three regions. Focus a splitter and use the arrow keys for fine steps, or double-click it to restore its default size. Every layout is saved per browser and clamped to the current window, so the same session opens safely on a laptop, a tablet or a wall display.',
      'View offers Studio, Arrangement, Mix and Mastering presets, Fit to window, Reset panels and Fullscreen (Ctrl+Shift+F). Fit sizes the panels from the current window and folds the console on short screens.',
      'Below 1080 px wide the browser becomes a drawer and below 860 px the rack does; use the Browser and Rack buttons in the top bar to open them over the arrangement. Moving the window between monitors with different scaling repaints the timelines and meters at the new pixel density.',
      'Everything that can overflow scrolls: the browser, rack, help, Sage, mixer, piano roll, long menus and dialogs all take the mouse wheel or a trackpad. In the arrangement the wheel moves the track list and Shift+wheel (or a sideways trackpad swipe) moves through time; Ctrl+wheel zooms. The rail under the arrangement is the horizontal scrollbar: drag its thumb, click anywhere on it, or wheel over it. It hides when the whole project fits on screen.',
    ],
  },
  {
    id: 'click-and-countin',
    title: 'Set up the click and count-in',
    group: 'Start here',
    keywords: ['metronome', 'click', 'count-in', 'countdown', 'count in', 'accent', 'subdivision', 'tap tempo', 'tempo', 'k'],
    body: [
      'K or the metronome button toggles the click during playback. The caret beside that button opens the click settings: Classic, Click or Wood sound, volume, accent on beat one, and quarter, eighth or sixteenth subdivisions. Right-clicking the metronome button opens the same panel.',
      'Shift+K, or the count-in button, turns count-in on. Before the transport rolls, one, two or four bars of clicks play while the transport stays parked; the bar count is shown in the position readout and on the count-in button. Count-in clicks are heard even when the playback click is off, and Stop cancels a count-in cleanly.',
      'T or the TAP button sets tempo from taps; the tempo field accepts 40–260 BPM. Count-in follows the project meter and the click subdivision settings for everything that plays after it.',
    ],
  },
  {
    id: 'playhead',
    title: 'Move and follow the playhead',
    group: 'Start here',
    keywords: ['playhead', 'cursor', 'seek', 'scrub', 'follow', 'auto-scroll', 'locate', 'nudge', 'loop', 'ruler', 'transport', 'marker', 'locator', 'centre', 'center', 'last position'],
    body: [
      'Click anywhere on the ruler or the arrangement to put the playhead there; while the transport rolls it keeps rolling from the new spot. Drag across the upper ruler to scrub: short grains of the audio under the pointer play as you move, and a readout follows with the bar and time. Playback resumes where you let go.',
      'Shift+drag across the ruler draws a time range, shown in blue on the ruler and through the lanes. Space plays that range once and stops at its end; clicking without Shift clears it.',
      'Click the position readout in the top bar and type a bar.beat.sixteenth location to jump straight there.',
      'The marker band under the bar numbers holds named locators. Press M to add one at the playhead, or double-click an empty spot in that band. Double-click a marker to rename it, drag it to move it, and Alt+click it to delete it. Markers are drawn through the arrangement and saved with the project.',
      'Move between locators with , and . (comma and period). The lower strip of the ruler sets the loop: drag it to draw new braces, drag the braces, or press [ and ] to put the loop start and end at the playhead. L loops the drawn range when there is one, otherwise the markers on either side of the playhead; Shift+L loops the selected clip exactly. The loop button tooltip shows the current span.',
      'Follow in the arrangement toolbar chooses how the view moves: Page jumps a screen at the right edge, Scroll keeps moving once the playhead passes the middle, Center locks it to the centre, Off leaves the view alone. F cycles the modes and the choice is remembered.',
      'Left and Right nudge the playhead by the Snap grid (a sixteenth when Snap is Off); Shift+Left/Right jumps a bar. Home is the project start, Shift+Home the loop start, End the project end, Shift+End the loop end. Shift+R returns to where playback last started, and Shift+Space plays from the selected clip.',
      'Punch in and out take their points from the loop braces: IN captures nothing before the loop start, OUT nothing after the loop end, and either can run without the loop. They trim both audio takes and MIDI passes, so you can roll from earlier in the song and still keep only the phrase inside the braces.',
    ],
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    group: 'Start here',
    keywords: ['keys', 'shortcut', 'keyboard', 'hotkeys', 'undo', 'redo', 'help'],
    body: [
      'Space plays and pauses, or plays the drawn range once · Shift+Space plays from the selected clip · Shift+drag the ruler draws a range · Home is the project start · Shift+Home the loop start · End is the project end · Shift+R returns to the last playback start · L loops the drawn range or the markers around the playhead · Shift+L loops the selected clip · K toggles the click · Shift+K toggles the count-in · T taps tempo.',
      'Left/Right nudge the playhead by the Snap grid · Shift+Left/Right jump a bar · F cycles the follow mode · Shift+Home/End jump to the loop start/end · [ and ] set the loop edges at the playhead.',
      'M adds a marker at the playhead · double-click a marker to rename · drag a marker to move it · Alt+click deletes · , and . jump to the previous and next marker.',
      'S splits the selected clip · D duplicates it · Delete removes it · N normalizes a selected audio clip · R reverses it · + and − zoom.',
      'Ctrl+S saves · Ctrl+Shift+S saves as · Ctrl+O opens · Ctrl+N starts a new session · Ctrl+Z undoes · Ctrl+Shift+Z redoes · Ctrl+Shift+F toggles fullscreen.',
      'Enter opens the note editor for the selected MIDI clip · double-clicking a MIDI clip does the same · Esc closes an editor or panel.',
      'Shift+M opens Sage · ? opens this help tab.',
    ],
  },
  {
    id: 'no-sound',
    title: 'No sound, or nothing to hear',
    group: 'Troubleshooting',
    keywords: ['silent', 'no sound', 'mute', 'solo', 'volume', 'browser', 'audio'],
    body: [
      'Check three things in order: is a track muted or soloed, is the master fader up, and has the browser been allowed to play audio (browsers block sound until you interact with the page — pressing play counts as interacting).',
      'In the desktop build, Studio Rig shows whether the audio device actually opened; a failed ASIO open usually means the device is held by another application.',
      'Check my session below looks for stuck mutes, solos and other states that silence a mix.',
    ],
  },
  {
    id: 'clipping',
    title: 'The master is clipping',
    group: 'Troubleshooting',
    keywords: ['clip', 'red', 'distortion', 'limiter', 'ceiling', 'hot', 'over'],
    body: [
      'A red master meter means samples hit full scale. Pull the master fader down a decibel or two first, then let the limiter handle the last of the peaks with its ceiling at −1 dB.',
      'If the mix is already dense, the fix is upstream: trim the loudest tracks rather than pushing the master, so the limiter is not doing all the work.',
    ],
    action: { label: 'Analyze the master bus', kind: 'ai-master' },
  },
];

/** Case-insensitive search across title, keywords and body. */
export function searchTopics(query: string): HelpTopic[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return HELP_TOPICS;
  const words = needle.split(/\s+/).filter(Boolean);
  return HELP_TOPICS.filter((topic) => {
    const haystack = [topic.title, topic.group, ...topic.keywords, ...topic.body].join(' ').toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function groupTopics(topics: HelpTopic[]): { group: string; topics: HelpTopic[] }[] {
  const groups: { group: string; topics: HelpTopic[] }[] = [];
  for (const group of HELP_GROUPS) {
    const entries = topics.filter((topic) => topic.group === group);
    if (entries.length) groups.push({ group, topics: entries });
  }
  return groups;
}
