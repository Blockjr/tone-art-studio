import './styles.css';
import { blankProject, createDevice, createInstrument, createMicDevice, createTrack, demoProject } from './core/project';
import { Store } from './core/store';
import {
  loadPreferences,
  loadRecentProjects,
  normalizeProjectName,
  parseProject,
  readAutosave,
  rememberRecent,
  savePreferences,
  serializeProject,
  writeAutosave,
  type Preferences,
  type RecentProject,
} from './core/session';
import { Engine } from './audio/engine';
import { computePeaks } from './audio/dsp';
import { peakBuckets } from './audio/waveform';
import { countInLabel } from './audio/metronome';
import { downloadBlob, renderMixdown } from './audio/export';
import { exportStemsForVst } from './audio/stems';
import { clamp, dbToGain, formatBars, formatTime, gainToDb, parseBars, snapBeat, uid } from './core/time';
import {
  normalizeClip,
  quantizeAudioClip,
  setClipGain,
  setClipPitch,
  setClipStretch,
  toggleReverseClip,
} from './audio/clipedits';
import { prepareClipAudio, prepareProjectAudio } from './audio/clipsource';
import { MIC_MODELS, micPresetParams } from './audio/mics';
import { DEVICE_SPECS, INSTRUMENT_SPECS } from './audio/specs';
import type {
  AudioAsset,
  Clip,
  DeviceType,
  InstrumentType,
  Project,
  Take,
  Track,
  TrackKind,
} from './core/types';
import { planClipBounce, planTrackBounce, insertBounce, renderBounce } from './audio/bounce';
import { Timeline } from './ui/timeline';
import { PianoRoll } from './ui/piano';
import { FileExplorer } from './ui/explorer';
import { filesFromDrop, hasFileDrag } from './ui/dropfiles';
import { FILE_DRAG_MIME, isAudioName, takeDrag, type NamedFile } from './core/filebrowse';
import { ViewMenu } from './ui/view';
import {
  DEFAULT_LAYOUT,
  LAYOUT_PRESETS,
  clampLayout,
  fittedLayout,
  layoutPreset,
  type LayoutPreset,
  type LayoutState,
  type Viewport,
} from './core/layout';
import { Mixer } from './ui/mixer';
import { Rack } from './ui/rack';
import { AssistantPanel } from './ui/agent';
import { RemotePanel } from './ui/remote';
import { NativePanel } from './ui/native';
import { MidiPanel } from './ui/midi';
import { TakePanel } from './ui/comp';
import {
  InputRecorder,
  describeCapture,
  listInputDevices,
  loopSlicesFromCapture,
  takeFromRecording,
  type RecordingResult,
} from './audio/recorder';
import { clipFromTake, compOverRange, takeName, takesForTrack } from './core/takes';
import { NativeBridge, announceUiReady } from './native/bridge';
import { PreviewPanel } from './ui/preview';
import { PreviewPlayer } from './audio/preview';
import { RemoteBridge } from './remote/bridge';
import { applyRemoteCommand, buildRemoteState, type RemoteRecordHooks } from './remote/remote';
import { stretchChannelsAsync } from './audio/dsp';
import {
  decodeAudioAsset,
  encodedAssetBytes,
  encodeProjectAssets,
  formatBytes,
  type SerializedAsset,
} from './audio/assets';
import { FOLLOW_MODES, nextFollowMode, normalizeFollow, type FollowMode } from './core/playhead';
import { el } from './ui/controls';
import { FileMenu, StartScreen } from './ui/files';
import { MetronomeMenu } from './ui/metronome';
import { openProjectDocument, saveProjectDocument } from './ui/fileio';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

let preferences: Preferences = loadPreferences();

const store = new Store(demoProject());
const engine = new Engine(store, preferences.metronome, (metronome) => {
  preferences = { ...preferences, metronome };
  savePreferences(preferences);
});

/** Session identity: the project name, and whether it differs from the file. */
let projectName = store.project.name;
let dirty = false;
let applyingProject = false;

const timeline = new Timeline(
  store,
  engine,
  {
    canvas: $<HTMLCanvasElement>('timeline-canvas'),
    ruler: $<HTMLCanvasElement>('ruler-canvas'),
    headers: $('track-headers'),
    lanes: $('lanes'),
    body: $('arrange-body'),
  },
  { onEditNotes: (clipId) => piano.open(clipId) },
);
const piano = new PianoRoll(store, engine, { onBounce: (clipId) => void bounceClip(clipId) });

/**
 * Opens the note editor for the selected MIDI clip, or for the first MIDI clip
 * on the selected track when nothing is selected. The fallback matters because
 * "no clip selected" used to make the Notes button and Enter do nothing at all,
 * which reads as a missing feature rather than a missing selection.
 */
function openNotes(): boolean {
  const selected = store.selectedClip;
  if (selected?.kind === 'midi') {
    piano.open(selected.id);
    return true;
  }

  const track = store.selectedTrack;
  const fallback = track
    ? store.project.clips.find((clip) => clip.trackId === track.id && clip.kind === 'midi')
    : store.project.clips.find((clip) => clip.kind === 'midi');

  if (!fallback) {
    toast('This project has no MIDI clips yet. Double-click a MIDI track to make one.');
    return false;
  }

  store.selectClip(fallback.id);
  piano.open(fallback.id);
  return true;
}

const midiPanel = new MidiPanel(store, engine, {
  onOpenNotes: () => {
    openNotes();
  },
  toast,
});
const mixer = new Mixer(store, engine, $('mixer-strips'), {
  onOpenMasterAi: () => assistant.openMixAi('master'),
});
const rack = new Rack(store, engine, $('rack-body'), {
  onOpenAi: (scope) => assistant.openMixAi(scope),
});
const assistant = new AssistantPanel(store, {
  onExport: () => $('btn-export').click(),
  onOpenRig: () => nativePanel.toggle(),
  onOpenRemote: () => remotePanel.toggle(),
  onShowStart: () => showStartScreen(),
  onEditTarget: (targetId) => {
    if (targetId !== 'master' && targetId !== 'mix') store.selectTrack(targetId);
    assistant.close();
    if (window.innerWidth <= 860 && !$('rack').classList.contains('is-drawer')) toggleDrawer('rack');
  },
});
const bridge = new RemoteBridge();
const remotePanel = new RemotePanel(bridge);
const nativeBridge = new NativeBridge();
const nativePanel = new NativePanel(
  nativeBridge,
  preferences,
  (next) => {
    preferences = next;
    savePreferences(next);
  },
  async () => {
    const result = await exportStemsForVst(store);
    toast(`Wrote ${result.tracks} stems to “${result.folder}”`);
    return `Wrote ${result.tracks} stems to “${result.folder}”. Load that folder here to mix through VST3.`;
  },
);
const recorder = new InputRecorder();

/** Capture stops itself here so a forgotten take cannot exhaust memory. */
const MAX_RECORD_SECONDS = 300;

let recording: {
  trackId: string;
  anchor: { beat: number; ctxTime: number };
  /** the loop being recorded, frozen when the take started */
  loop: { start: number; end: number } | null;
  limitReached?: boolean;
} | null = null;

const takePanel = new TakePanel(
  store,
  preferences,
  (next) => {
    preferences = next;
    savePreferences(next);
  },
  {
    startRecording: () => void startRecording(),
    stopRecording: () => stopRecording(),
    setMonitoring: (enabled) => recorder.setMonitoring(enabled),
    listInputs: () => listInputDevices(),
    audition: (take, range) => auditionTake(take, range),
    notify: (message) => toast(message),
  },
);

const previewPlayer = new PreviewPlayer(engine);
const previewPanel = new PreviewPanel(store, previewPlayer, sendPreviewToArrangement);

timeline.mount();
mixer.mount();
rack.mount();
assistant.mount();
piano.mount();
remotePanel.mount();
nativePanel.mount();
midiPanel.mount();

// A panel window opened from the desktop shell (`?panel=midi`) shows that one
// panel on its own, which is how a panel is moved to a second screen.
const detachedPanel = new URLSearchParams(window.location.search).get('panel');
if (detachedPanel) {
  document.body.classList.add('is-detached');
  if (detachedPanel === 'midi') midiPanel.openPanel();
  else if (detachedPanel === 'rig') nativePanel.open();
}
takePanel.mount();

// The top bar scrolls sideways at narrow widths. Its scrollbar is hidden, so a
// wheel over it has to move the bar rather than do nothing.
const topbar = document.querySelector<HTMLElement>('.topbar');
topbar?.addEventListener(
  'wheel',
  (event) => {
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (topbar.scrollWidth <= topbar.clientWidth + 1) return;
    event.preventDefault();
    topbar.scrollLeft += event.deltaY;
  },
  { passive: false },
);

type FloatingPanel = 'assistant' | 'remote' | 'rig' | 'midi' | 'preview' | 'takes';

/**
 * Only one floating panel on screen at a time.
 *
 * Every panel docks into the same right-hand slot, so opening a second one
 * without closing the first stacked two panels exactly on top of each other:
 * the one underneath was unreachable, and its close button could not be found.
 * Besides, a panel covering the rack hid controls the user was reaching for.
 */
function closeFloating(except?: FloatingPanel): void {
  if (except !== 'assistant') assistant.close();
  if (except !== 'remote') remotePanel.close();
  if (except !== 'rig') nativePanel.close();
  if (except !== 'midi') midiPanel.close();
  if (except !== 'preview') previewPanel.close();
  if (except !== 'takes') takePanel.close();
}

$('btn-assistant').addEventListener('click', () => {
  closeFloating('assistant');
  assistant.toggleMix();
});
$('btn-help').addEventListener('click', () => {
  closeFloating('assistant');
  assistant.openHelp();
});
$('btn-remote').addEventListener('click', () => {
  closeFloating('remote');
  remotePanel.toggle();
});
$('btn-rig').addEventListener('click', () => {
  closeFloating('rig');
  nativePanel.toggle();
});

$('btn-midi').addEventListener('click', () => {
  closeFloating('midi');
  midiPanel.toggle();
});

$('btn-preview').addEventListener('click', () => {
  closeFloating('preview');

  if (!previewPanel.element.classList.contains('is-open') && previewPanel.loadSelectedClip()) {
    previewPanel.open();
    return;
  }

  previewPanel.toggle();
});

const autoFadeToggle = $<HTMLInputElement>('chk-auto-fade');
autoFadeToggle.checked = store.autoFade;
autoFadeToggle.addEventListener('change', () => {
  store.autoFade = autoFadeToggle.checked;
  store.emit('view');
});

// -------------------------------------------------------------- audio clip bar

const clipBar = $('clip-bar');
const clipName = $('clip-name');
const clipGain = $<HTMLInputElement>('clip-gain');
const clipGainLabel = $('clip-gain-db');
const clipPitch = $<HTMLInputElement>('clip-pitch');
const clipPitchLabel = $('clip-pitch-st');
const clipStretch = $<HTMLInputElement>('clip-stretch');
const reverseButton = $<HTMLButtonElement>('btn-reverse-clip');
const quantizeButton = $<HTMLButtonElement>('btn-quantize');

function selectedAudioClip(): Clip | null {
  const clip = store.selectedClip;
  return clip && clip.kind === 'audio' ? clip : null;
}

/** Re-renders the audio warps and restarts a rolling transport on the spot. */
async function reflowClipAudio(clip?: Clip | null | undefined): Promise<void> {
  if (clip && clip.kind === 'audio') await prepareClipAudio(store, clip);
  if (engine.isPlaying) engine.seek(engine.positionBeat);
}

function refreshClipBar(): void {
  const clip = selectedAudioClip();
  clipBar.hidden = !clip;
  if (!clip) return;

  clipName.textContent = clip.name;
  clipName.title = clip.name;
  const db = clamp(gainToDb(clip.gain), -24, 12);
  if (document.activeElement !== clipGain) clipGain.value = db.toFixed(1);
  clipGainLabel.textContent = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  const semitones = clip.warp?.semitones ?? 0;
  if (document.activeElement !== clipPitch) clipPitch.value = String(semitones);
  clipPitchLabel.textContent = `${semitones >= 0 ? '+' : ''}${semitones} st`;
  clipStretch.checked = clip.warp?.stretch === true;
  reverseButton.classList.toggle('is-on', clip.reverse === true);
  reverseButton.textContent = clip.reverse ? 'Reversed' : 'Reverse';
  quantizeButton.disabled = !(store.snap > 0);
  quantizeButton.title = store.snap > 0
    ? 'Slice at transients, then pull the slices onto the grid (time-stretched)'
    : 'Set Snap to a grid value first';
}

store.subscribe((reason) => {
  if (reason === 'selection' || reason === 'structure') refreshClipBar();
});
refreshClipBar();

clipGain.addEventListener('input', () => {
  const db = Number(clipGain.value);
  clipGainLabel.textContent = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
});
clipGain.addEventListener('change', () => {
  const clip = selectedAudioClip();
  if (!clip) return;
  const db = Number(clipGain.value);
  setClipGain(store, clip.id, dbToGain(db));
  void reflowClipAudio(clip);
  toast(`Clip gain ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`);
});

clipPitch.addEventListener('input', () => {
  const semitones = Number(clipPitch.value);
  clipPitchLabel.textContent = `${semitones >= 0 ? '+' : ''}${semitones} st`;
});
clipPitch.addEventListener('change', () => {
  const clip = selectedAudioClip();
  if (!clip) return;
  const semitones = Number(clipPitch.value);
  setClipPitch(store, clip.id, semitones);
  void reflowClipAudio(store.selectedClip);
  toast(`Clip pitch ${semitones >= 0 ? '+' : ''}${semitones} semitones · length kept`);
});

clipStretch.addEventListener('change', () => {
  const clip = selectedAudioClip();
  if (!clip) return;
  setClipStretch(store, clip.id, clipStretch.checked);
  void reflowClipAudio(store.selectedClip);
  toast(
    clipStretch.checked
      ? 'Stretch on — drag the clip edge to time-stretch it'
      : 'Stretch off — the clip is trimmed to its natural length again',
  );
});

$('btn-normalize').addEventListener('click', () => {
  const clip = selectedAudioClip();
  if (!clip) return;
  const gain = normalizeClip(store, clip.id);
  if (gain === null) {
    toast('This clip is silent — nothing to normalize');
    return;
  }
  void reflowClipAudio(store.selectedClip);
  toast(`Normalized to −1 dBFS · clip gain ${gainToDb(gain).toFixed(1)} dB`);
});

reverseButton.addEventListener('click', () => {
  const clip = selectedAudioClip();
  if (!clip) return;
  const reversed = toggleReverseClip(store, clip.id);
  if (reversed === null) return;
  void reflowClipAudio(store.selectedClip);
  toast(reversed ? 'Clip reversed — Ctrl+Z brings the original back' : 'Clip plays forwards again');
});

quantizeButton.addEventListener('click', () => {
  const clip = selectedAudioClip();
  if (!clip) return;
  const snap = store.snap;
  quantizeButton.disabled = true;
  quantizeButton.textContent = 'Slicing…';
  void (async () => {
    try {
      const count = await quantizeAudioClip(store, clip.id, snap);
      toast(
        count
          ? `Sliced into ${count} parts and quantized — Ctrl+Z restores the whole clip`
          : 'No transients to slice, or Snap is off',
      );
      if (count) void prepareProjectAudio(store);
    } finally {
      quantizeButton.textContent = 'Slice to grid';
      quantizeButton.disabled = !(store.snap > 0);
    }
  })();
});

// The tablet arms tracks and starts/stops takes through the same functions the
// transport uses, so count-in, loop takes, takes/comping and error handling all
// stay on one path.
const remoteRecordHooks: RemoteRecordHooks = {
  start: () => void startRecording(),
  stop: () => stopRecording(),
  isRecording: () => recording !== null,
  isStarting: () => recordingStarting,
  recordingTrackId: () => recording?.trackId ?? null,
};

bridge.onCommand((command) => applyRemoteCommand(store, engine, command, remoteRecordHooks));
window.setInterval(() => {
  if (bridge.currentStatus === 'online') bridge.send(buildRemoteState(store, engine, remoteRecordHooks));
}, 100);

// ---------------------------------------------------------------- helpers

// Development-only handle for the browser console and end-to-end checks.
if (import.meta.env.DEV) {
  (window as unknown as { __studio: unknown }).__studio = { store, engine, timeline };
}

let toastTimer = 0;
function toast(message: string): void {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('is-visible'), 2200);
}

function beatNow(): number {
  return engine.positionBeat;
}

/**
 * Places a preview file on an audio track, stretched to the project tempo.
 *
 * With `slices` the loop editor's cut points are used instead of the whole
 * file: the buffer is stretched once (so slices stay in time with each other)
 * and each slice becomes a clip laid end to end from the playhead.
 */
async function sendPreviewToArrangement(
  buffer: AudioBuffer,
  name: string,
  sourceBpm: number,
  slices?: { start: number; end: number }[],
): Promise<void> {
  const projectBpm = store.project.bpm;
  let finalBuffer = buffer;

  if (sourceBpm > 0 && Math.abs(sourceBpm - projectBpm) / projectBpm > 0.005) {
    const ctx = await engine.ensureContext();
    const channels: Float32Array[] = [];

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      channels.push(Float32Array.from(buffer.getChannelData(channel)));
    }

    const stretched = await stretchChannelsAsync(channels, { tempoRate: projectBpm / sourceBpm });

    if (stretched && stretched.length > 0) {
      const rendered = ctx.createBuffer(stretched.length, stretched[0].length, ctx.sampleRate);

      for (let channel = 0; channel < stretched.length; channel++) {
        rendered.copyToChannel(stretched[channel] as Float32Array<ArrayBuffer>, channel);
      }

      finalBuffer = rendered;
    }
  }

  const asset: AudioAsset = {
    id: uid('asset'),
    name,
    buffer: finalBuffer,
    duration: finalBuffer.duration,
    peaks: peaksFor(finalBuffer),
  };
  store.assets.set(asset.id, asset);

  let track = store.project.tracks.find((t) => t.kind === 'audio');
  if (!track) track = addTrack('audio');

  const target = track;
  const secondsPerBeat = 60 / projectBpm;
  // Stretching keeps every slice's proportion of the file, so one scale maps
  // file seconds to arrangement seconds.
  const scale = buffer.duration > 0 ? finalBuffer.duration / buffer.duration : 1;
  const parts = slices && slices.length > 0 ? slices : [{ start: 0, end: buffer.duration }];
  const multiple = parts.length > 1;

  const clips: Clip[] = [];
  let beat = Math.max(0, Math.round(beatNow()));

  for (const [index, part] of parts.entries()) {
    const length = Math.max(0.125, ((part.end - part.start) * scale) / secondsPerBeat);
    clips.push({
      id: uid('clip'),
      trackId: target.id,
      name: multiple ? `${name} ${String(index + 1).padStart(2, '0')}` : name,
      kind: 'audio',
      start: beat,
      length,
      color: target.color,
      notes: [],
      assetId: asset.id,
      offset: Math.max(0, part.start * scale),
      gain: 1,
    });
    beat += length;
  }

  store.edit('structure', (project) => {
    if (!project.tracks.some((t) => t.id === target.id)) project.tracks.push(target);
    project.clips.push(...clips);
    const end = Math.max(...clips.map((clip) => clip.start + clip.length));
    project.length = Math.max(project.length, end);
  });
  store.selectClip(clips[0].id);
  toast(
    multiple
      ? `Added ${clips.length} slices from ${name} at ${projectBpm} BPM`
      : `Added ${name} at ${projectBpm} BPM`,
  );
}

/**
 * Summary peaks for one buffer, dense enough to stay sharp in the arrangement
 * at normal zoom but capped so hour-long material does not bloat a project.
 * Every channel is measured, so a stereo file whose interest sits on the right
 * side still draws correctly.
 */
function peaksFor(buffer: AudioBuffer): number[] {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channels.push(buffer.getChannelData(channel));
  }
  return computePeaks(channels, peakBuckets(buffer.duration));
}

// ---------------------------------------------------------------- recording

let auditionSource: AudioBufferSourceNode | null = null;
let recordWatch: number | null = null;
let recordingStarting = false;

function syncRecordButton(): void {
  const button = $('btn-record');
  button.classList.toggle('is-on', recording !== null);
  button.setAttribute('aria-pressed', recording ? 'true' : 'false');
  button.title = recording
    ? 'Stop recording (R)'
    : store.project.loop.enabled
      ? 'Record onto the armed audio track — one take per loop lap (R)'
      : 'Record onto the armed audio track (R)';
}

function waitForAnchor(timeoutMs: number): Promise<{ beat: number; ctxTime: number } | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const timer = window.setInterval(() => {
      const anchor = engine.transportAnchor;
      if (anchor) {
        window.clearInterval(timer);
        resolve(anchor);
      } else if (!engine.isPlaying && !engine.isCountingIn) {
        window.clearInterval(timer);
        resolve(null);
      } else if (performance.now() - started >= timeoutMs) {
        window.clearInterval(timer);
        resolve(null);
      }
    }, 30);
  });
}

async function startRecording(): Promise<void> {
  if (recording) {
    stopRecording();
    return;
  }
  if (recordingStarting) return;
  recordingStarting = true;

  try {
  const armed = store.project.tracks.filter((track) => track.kind === 'audio' && track.armed);
  const track = armed.find((candidate) => candidate.id === store.selectedTrackId) ?? armed[0];

  if (!track) {
    toast('Arm an audio track to record');
    closeFloating('takes');
    takePanel.open();
    return;
  }

  let captureLabel = '';
  try {
    const ctx = await engine.ensureContext();
    await recorder.start(ctx, { deviceId: preferences.recordDeviceId, monitor: preferences.monitorInput });
    const format = recorder.format;
    if (format) {
      captureLabel = describeCapture(format);
      takePanel.setCapture(captureLabel);
    }
  } catch (error) {
    console.error(error);
    takePanel.setCapture(null);
    toast(error instanceof Error ? error.message : 'The audio input could not be opened');
    return;
  }

  const loop = store.project.loop;
  const loopRecord = loop.enabled && loop.end - loop.start >= 0.05;
  const startBeat = loopRecord ? loop.start : engine.positionBeat;

  // Loop recording always takes off from the loop start, even when the
  // playhead is parked somewhere else.
  if (loopRecord && (engine.isPlaying || engine.isCountingIn)) engine.pause();

  // Capture is already running: the pre-roll before the first beat is trimmed
  // at stop, so the take lands sample-aligned on the grid.
  try {
    await engine.play(startBeat, { countIn: engine.countIn });
  } catch (error) {
    console.error(error);
    recorder.cancel();
    takePanel.setCapture(null);
    toast('The transport could not start recording');
    return;
  }

  const anchor = await waitForAnchor(20000);

  if (!anchor || !recorder.isCapturing) {
    const cancelled = !engine.isPlaying && !engine.isCountingIn;
    recorder.cancel();
    takePanel.setCapture(null);
    engine.pause();
    toast(cancelled ? 'Recording cancelled' : 'Recording could not start');
    return;
  }

  recording = {
    trackId: track.id,
    anchor,
    loop: loopRecord ? { start: loop.start, end: loop.end } : null,
  };
  syncRecordButton();
  takePanel.setRecording(true, loopRecord);

  // A remote stop or any other transport stop ends the take too. Loop
  // recording rolls until the user stops, so capture also has a hard limit.
  let clippedWarned = false;
  recordWatch = window.setInterval(() => {
    if (!recording) return;
    if (!clippedWarned && recorder.isClipped) {
      clippedWarned = true;
      takePanel.setCapture(`${captureLabel} — input clipped at the interface`, true);
      toast('Input clipping — pull the gain back at the interface');
    }
    if (!engine.isPlaying && !engine.isCountingIn) {
      stopRecording();
      return;
    }
    if (recorder.elapsedSeconds >= MAX_RECORD_SECONDS) {
      recording.limitReached = true;
      stopRecording();
    }
  }, 250);
  } finally {
    recordingStarting = false;
  }
}

/**
 * Turns one loop pass into a take per lap. Each lap shares the loop start, so
 * comping between them stays on the grid; the last complete lap goes into the
 * arrangement and every take stays available in the Takes panel.
 */
function commitLoopTakes(
  session: { trackId: string; anchor: { beat: number; ctxTime: number }; loop: { start: number; end: number } },
  result: RecordingResult,
  track: Track,
  ctx: AudioContext,
): string {
  const slices = loopSlicesFromCapture(result, session.anchor, session.loop, store.project.bpm);
  if (slices.length === 0) return '';

  const firstPass =
    takesForTrack(store.project, track.id).reduce((highest, take) => Math.max(highest, take.pass), 0) + 1;
  const entries = slices.map((slice, index) => {
    const pass = firstPass + index;
    const buffer = ctx.createBuffer(slice.channels.length, slice.channels[0].length, result.sampleRate);
    for (let channel = 0; channel < slice.channels.length; channel++) {
      buffer.copyToChannel(slice.channels[channel] as Float32Array<ArrayBuffer>, channel);
    }

    const asset: AudioAsset = {
      id: uid('asset'),
      name: `${track.name} take ${pass}`,
      buffer,
      duration: buffer.duration,
      peaks: peaksFor(buffer),
    };
    const take: Take = {
      id: uid('take'),
      trackId: track.id,
      assetId: asset.id,
      name: takeName(track, pass) + (slice.complete ? '' : ' · partial'),
      start: slice.startBeat,
      length: slice.lengthBeats,
      offset: 0,
      gain: 1,
      pass,
      createdAt: Date.now() + index,
    };
    return { take, asset, complete: slice.complete };
  });

  const primary = [...entries].reverse().find((entry) => entry.complete) ?? entries[entries.length - 1];
  const clip = clipFromTake(primary.take, track, store.project.bpm, {
    start: primary.take.start,
    end: primary.take.start + primary.take.length,
  });
  clip.name = primary.take.name;

  for (const entry of entries) store.assets.set(entry.asset.id, entry.asset);

  store.edit('structure', (project) => {
    for (const entry of entries) project.takes.push(entry.take);
    project.clips = compOverRange(
      project.clips,
      track.id,
      primary.take.start,
      primary.take.start + primary.take.length,
      clip,
      project.bpm,
    );
    project.length = Math.max(project.length, primary.take.start + primary.take.length);
  });
  store.selectClip(clip.id);

  const first = entries[0].take;
  const last = entries[entries.length - 1].take;
  return entries.length === 1
    ? `Recorded ${first.name} (${first.length.toFixed(1)} beats)`
    : `Recorded ${entries.length} loop takes (${first.name} – ${last.name})`;
}

function stopRecording(): void {
  if (!recording) return;

  const session = recording;
  recording = null;

  if (recordWatch !== null) {
    window.clearInterval(recordWatch);
    recordWatch = null;
  }

  syncRecordButton();
  takePanel.setRecording(false);
  takePanel.setCapture(null);

  const result = recorder.stop();
  engine.pause();

  if (!result) {
    toast('Nothing was recorded');
    return;
  }

  if (session.loop) {
    const track = store.trackById(session.trackId);
    const ctx = engine.context;
    const summary = track && ctx ? commitLoopTakes({ ...session, loop: session.loop }, result, track, ctx) : '';

    if (!summary) {
      toast('The loop pass was too short to keep');
      return;
    }

    toast(session.limitReached ? `${summary} · stopped at the 5 minute cap` : summary);
    takePanel.open();
    takePanel.refresh();
    return;
  }

  const trimmed = takeFromRecording(result, session.anchor, store.project.bpm);
  if (!trimmed) {
    toast('The take was too short to keep');
    return;
  }

  const track = store.trackById(session.trackId);
  const ctx = engine.context;
  if (!track || !ctx) return;

  const buffer = ctx.createBuffer(trimmed.channels.length, trimmed.channels[0].length, result.sampleRate);
  for (let channel = 0; channel < trimmed.channels.length; channel++) {
    buffer.copyToChannel(trimmed.channels[channel] as Float32Array<ArrayBuffer>, channel);
  }

  const pass = takesForTrack(store.project, track.id).reduce((highest, take) => Math.max(highest, take.pass), 0) + 1;
  const asset: AudioAsset = {
    id: uid('asset'),
    name: `${track.name} take ${pass}`,
    buffer,
    duration: buffer.duration,
    peaks: peaksFor(buffer),
  };
  const take: Take = {
    id: uid('take'),
    trackId: track.id,
    assetId: asset.id,
    name: takeName(track, pass),
    start: trimmed.startBeat,
    length: trimmed.lengthBeats,
    offset: 0,
    gain: 1,
    pass,
    createdAt: Date.now(),
  };
  const clip = clipFromTake(take, track, store.project.bpm, { start: take.start, end: take.start + take.length });
  clip.name = take.name;

  store.assets.set(asset.id, asset);
  store.edit('structure', (project) => {
    project.takes.push(take);
    project.clips = compOverRange(project.clips, take.trackId, take.start, take.start + take.length, clip, project.bpm);
    project.length = Math.max(project.length, take.start + take.length);
  });
  store.selectClip(clip.id);

  toast(`Recorded ${take.name} (${take.length.toFixed(1)} beats)`);
  takePanel.open();
  takePanel.refresh();
}

function auditionTake(take: Take, range: { start: number; end: number }): void {
  const ctx = engine.context;
  const asset = store.assetById(take.assetId);

  if (!ctx || !asset) {
    toast('That take has no audio loaded');
    return;
  }

  auditionSource?.stop();
  auditionSource = null;

  const secondsPerBeat = 60 / store.project.bpm;
  const offset = Math.max(0, take.offset + (range.start - take.start) * secondsPerBeat);
  const duration = Math.max(0.05, Math.min(asset.duration - offset, (range.end - range.start) * secondsPerBeat));
  if (duration <= 0) return;

  const source = ctx.createBufferSource();
  source.buffer = asset.buffer;
  const gain = ctx.createGain();
  gain.gain.value = 1;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start(0, offset, duration);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
    if (auditionSource === source) auditionSource = null;
  };
  auditionSource = source;
}

// ---------------------------------------------------------------- transport

const btnPlay = $('btn-play');
const btnLoop = $('btn-loop');
const btnMetro = $('btn-metro');
const btnCountIn = $('btn-countin');
const tempoInput = $<HTMLInputElement>('tempo-input');
const metronomeMenu = new MetronomeMenu({
  get: () => engine.metronomeSettings,
  update: (patch) => engine.setMetronomeSettings(patch),
  test: (level) => void engine.previewClick(level),
});

function refreshTransport(): void {
  const counting = engine.countInState;
  btnPlay.classList.toggle('is-on', engine.isPlaying || engine.isCountingIn);
  btnPlay.textContent = engine.isPlaying || engine.isCountingIn ? '❚❚' : '▶';
  btnLoop.classList.toggle('is-on', store.project.loop.enabled);
  btnLoop.title = `Loop ${store.project.loop.enabled ? 'on' : 'off'} · ${formatBars(
    store.project.loop.start,
    store.project.beatsPerBar,
  )} – ${formatBars(store.project.loop.end, store.project.beatsPerBar)} (L)`;
  btnMetro.classList.toggle('is-on', engine.metronome);
  btnMetro.title = `Metronome ${engine.metronome ? 'on' : 'off'} (K) · settings ▾`;
  btnCountIn.classList.toggle('is-on', engine.countIn);
  btnCountIn.classList.toggle('is-counting', counting.active);
  btnCountIn.title = `${countInLabel(engine.metronomeSettings)} (Shift+K)`;
  if (!counting.active) btnCountIn.textContent = '◷';
  if (metronomeMenu.isOpen) metronomeMenu.refresh();
  $('btn-undo').toggleAttribute('disabled', !store.canUndo());
  $('btn-redo').toggleAttribute('disabled', !store.canRedo());
  if (document.activeElement !== tempoInput) tempoInput.value = String(store.project.bpm);
  $('song-meta').textContent = `${store.project.tracks.length} tracks · ${store.project.clips.length} clips · ${store.project.bpm} BPM`;
  $('rack-track-name').textContent = rack.targetName();
  syncRecordButton();
}

btnPlay.addEventListener('click', () => {
  if (recording) {
    stopRecording();
    return;
  }
  engine.togglePlay();
});

$('btn-record').addEventListener('click', () => {
  if (recording) stopRecording();
  else void startRecording();
});

syncRecordButton();

$('btn-takes').addEventListener('click', () => {
  closeFloating('takes');
  takePanel.toggle();
});

$('btn-stop').addEventListener('click', () => {
  if (recording) stopRecording();
  engine.stop();
});
$('btn-rewind').addEventListener('click', () => timeline.seek(0));
$('btn-last').addEventListener('click', () => timeline.returnToLastStart());

const posReadout = $('pos');
/** Click the transport readout to type a bar.beat.sixteenth location. */
function editPosition(): void {
  const rect = posReadout.getBoundingClientRect();
  const input = document.createElement('input');
  input.className = 'position-input';
  input.value = formatBars(engine.positionBeat, store.project.beatsPerBar);
  input.maxLength = 12;
  input.setAttribute('aria-label', 'Playhead position');
  input.style.left = `${Math.max(6, rect.left)}px`;
  input.style.top = `${Math.max(6, rect.top)}px`;
  input.style.width = `${Math.max(112, rect.width)}px`;
  document.body.append(input);

  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    if (commit) {
      const beat = parseBars(input.value, store.project.beatsPerBar);
      if (beat === null) {
        toast('Type a location like 5.2.1');
      } else {
        timeline.seek(Math.min(store.project.length, beat));
      }
    }
    input.remove();
  };

  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', (event) => event.stopPropagation());
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

posReadout.addEventListener('click', editPosition);
posReadout.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.stopPropagation();
    editPosition();
  }
});

btnLoop.addEventListener('click', () => {
  store.edit('structure', (project) => {
    project.loop.enabled = !project.loop.enabled;
  });
});

btnMetro.addEventListener('click', () => {
  engine.setMetronome(!engine.metronome);
  refreshTransport();
});

btnCountIn.addEventListener('click', () => {
  engine.setCountIn(!engine.countIn);
  refreshTransport();
  toast(countInLabel(engine.metronomeSettings));
});

tempoInput.addEventListener('change', () => {
  const value = clamp(Number(tempoInput.value) || store.project.bpm, 40, 260);
  store.edit('structure', (project) => {
    project.bpm = Math.round(value);
  });
});

let taps: number[] = [];
function tapTempo(): void {
  const now = performance.now();
  taps = [...taps.filter((t) => now - t < 2500), now];
  if (taps.length < 2) {
    toast('Tap again to set tempo');
    return;
  }
  const intervals = taps.slice(1).map((t, i) => t - taps[i]);
  const average = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const bpm = clamp(Math.round(60000 / average), 40, 260);
  store.edit('structure', (project) => {
    project.bpm = bpm;
  });
  toast(`Tempo ${bpm} BPM`);
}
$('btn-tap').addEventListener('click', tapTempo);

// ---------------------------------------------------------------- editing

$('snap-select').addEventListener('change', (event) => {
  const value = Number((event.target as HTMLSelectElement).value);
  store.snap = value;
  store.emit('view');
});

const followSelect = $<HTMLSelectElement>('follow-select');

function applyFollow(mode: FollowMode, announce = false): void {
  preferences = { ...preferences, follow: mode };
  savePreferences(preferences);
  followSelect.value = mode;
  timeline.setFollowMode(mode);
  if (announce) {
    const label = FOLLOW_MODES.find((entry) => entry.id === mode)?.label ?? mode;
    toast(`Follow: ${label}`);
  }
}

followSelect.value = preferences.follow;
timeline.setFollowMode(preferences.follow);
followSelect.addEventListener('change', () => {
  applyFollow(normalizeFollow(followSelect.value), true);
});

$('btn-zoom-in').addEventListener('click', () => timeline.zoomBy(1.25));
$('btn-zoom-out').addEventListener('click', () => timeline.zoomBy(1 / 1.25));
$('btn-notes').addEventListener('click', () => {
  openNotes();
});
$('btn-bounce').addEventListener('click', () => void bounceClip());
$('btn-split').addEventListener('click', () => timeline.splitSelected());
$('btn-duplicate').addEventListener('click', () => timeline.duplicateSelected());
$('btn-delete-clip').addEventListener('click', () => timeline.deleteSelected());
$('btn-undo').addEventListener('click', () => store.undo());
$('btn-redo').addEventListener('click', () => store.redo());

// ---------------------------------------------------------------- bounce

/**
 * Prints the selected clip, or the selected track when no clip is selected,
 * through its instrument, EQ, inserts, pan and sends into a new audio track.
 */
async function bounceClip(clipId?: string): Promise<void> {
  const clip = clipId
    ? store.project.clips.find((c) => c.id === clipId)
    : store.selectedClip;
  const trackId = clip?.trackId ?? store.selectedTrackId;
  const plan = clip
    ? planClipBounce(store.project, clip.id)
    : planTrackBounce(store.project, trackId);

  if (!plan) {
    toast('Select a MIDI or audio clip to bounce');
    return;
  }

  const button = $<HTMLButtonElement>('btn-bounce');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Bouncing…';

  try {
    const buffer = await renderBounce(store, plan, 48000);
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 32) {
        const value = Math.abs(data[index]);
        if (value > peak) peak = value;
      }
    }
    if (peak < 1e-4) {
      toast(`${plan.trackName} bounced silent — check the clip has notes or audio`);
      return;
    }
    insertBounce(store, plan, buffer, trackId);
    const bars = (plan.endBeat - plan.startBeat) / store.project.beatsPerBar;
    toast(`Bounced ${plan.trackName} to audio (${bars.toFixed(1)} bars) — source kept`);
  } catch (error) {
    console.error(error);
    toast(error instanceof Error ? error.message : 'Bounce failed');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------------------------------------------------------------- session & files

let recents: RecentProject[] = loadRecentProjects();
let startScreen: StartScreen | null = null;
let autosaveTimer = 0;

function updateProjectTitle(): void {
  const nameButton = $('project-name');
  nameButton.textContent = projectName;
  nameButton.title = 'Click to rename the project';
  $('project-dirty').classList.toggle('is-on', dirty);
  document.title = `${dirty ? '• ' : ''}${projectName} — Tone Art Studio`;
}

function setDirty(next: boolean): void {
  if (dirty === next) return;
  dirty = next;
  updateProjectTitle();
}

function scheduleAutosave(): void {
  if (!preferences.autosave) return;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    store.project.name = projectName;
    writeAutosave(store.project);
  }, 2500);
}

/** Replaces the session with a project, decoding any embedded audio first. */
async function applyProject(project: Project, name: string, assets: SerializedAsset[] = []): Promise<void> {
  applyingProject = true;
  engine.stop();
  store.assets.clear();

  if (assets.length > 0) {
    try {
      const ctx = await engine.ensureContext();
      for (const asset of assets) {
        store.assets.set(asset.id, decodeAudioAsset(asset, ctx));
      }
    } catch {
      toast('The audio embedded in this project could not be decoded');
    }
  }

  store.load(project);
  projectName = normalizeProjectName(name);
  store.project.name = projectName;
  dirty = false;
  updateProjectTitle();
  refreshTransport();
  applyingProject = false;
  scheduleAutosave();

  const missing = [...project.clips, ...project.takes]
    .filter((entry) => entry.assetId && !store.assets.has(entry.assetId)).length;
  if (missing > 0) {
    toast(
      `${missing} audio clip${missing === 1 ? ' needs' : 's need'} re-importing — browser snapshots keep the mix, not the audio`,
    );
  }
}

function rememberCurrentSession(): void {
  recents = rememberRecent({
    name: projectName,
    savedAt: new Date().toISOString(),
    bpm: store.project.bpm,
    tracks: store.project.tracks.length,
    data: serializeProject(store.project),
  });
  startScreen?.setRecents(recents, readAutosave()?.name ?? null);
}

async function saveProject(options: { saveAs?: boolean } = {}): Promise<boolean> {
  const embedded = encodeProjectAssets(store.project, store.assets);
  const document = serializeProject({ ...store.project, name: projectName }, { assets: embedded });
  const saved = await saveProjectDocument(document, projectName, { saveAs: options.saveAs });
  if (!saved) return false;

  projectName = normalizeProjectName(saved.name);
  store.project.name = projectName;
  dirty = false;
  updateProjectTitle();
  rememberCurrentSession();
  scheduleAutosave();

  const size = encodedAssetBytes(embedded);
  toast(
    size > 0
      ? `Saved ${saved.fileName} · ${embedded.length} audio clip${embedded.length === 1 ? '' : 's'} embedded (${formatBytes(size)})`
      : `Saved ${saved.fileName}`,
  );
  return true;
}

async function openProject(): Promise<void> {
  const opened = await openProjectDocument();
  if (!opened) return;

  try {
    const parsed = parseProject(opened.text);
    await applyProject(parsed.project, opened.name, parsed.assets);
    rememberCurrentSession();
    toast(`Opened ${opened.fileName}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'That project could not be opened.');
  }
}

function resumeAutosave(): void {
  const autosave = readAutosave();
  if (!autosave) {
    toast('No autosaved session in this browser');
    return;
  }
  try {
    const parsed = parseProject(autosave.data);
    void applyProject(parsed.project, autosave.name, parsed.assets);
    toast(`Resumed ${autosave.name}`);
  } catch {
    toast('The autosaved session could not be read');
  }
}

function openRecent(id: string): void {
  const entry = recents.find((item) => item.id === id);
  if (!entry) return;
  try {
    const parsed = parseProject(entry.data);
    void applyProject(parsed.project, entry.name, parsed.assets);
    toast(`Opened ${entry.name}`);
  } catch {
    toast('That recent project could not be read');
  }
}

function showStartScreen(): void {
  const autosave = readAutosave();
  const screen = new StartScreen({
    preferences,
    recents,
    nativeHost: nativeBridge.available,
    resumeName: autosave?.name ?? null,
    onCreate: (options) => {
      void applyProject(blankProject(options.name, options.bpm, options.bars), options.name);
      rememberCurrentSession();
      toast(`${projectName} created`);
    },
    onDemo: () => {
      void applyProject(demoProject(), 'Tone Art Demo');
      toast('Demo session loaded');
    },
    onOpen: () => {
      startScreen = null;
      void openProject();
    },
    onResume: () => {
      startScreen = null;
      resumeAutosave();
    },
    onRecent: (id) => {
      startScreen = null;
      openRecent(id);
    },
    onPreferences: (next) => {
      preferences = next;
      savePreferences(next);
    },
    onDismiss: () => {
      startScreen = null;
    },
  });
  startScreen = screen;
  screen.open();
}

const fileMenu = new FileMenu({
  onNew: () => showStartScreen(),
  onOpen: () => {
    void openProject();
  },
  onSave: () => {
    void saveProject();
  },
  onSaveAs: () => {
    void saveProject({ saveAs: true });
  },
  onExport: () => $('btn-export').click(),
  onStartScreen: () => showStartScreen(),
});
$('project-chip').before(fileMenu.element);

$('project-name').addEventListener('click', () => {
  const button = $('project-name');
  const input = el('input', 'project-rename') as HTMLInputElement;
  input.value = projectName;
  input.maxLength = 64;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Project name');
  button.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (apply: boolean): void => {
    if (done) return;
    done = true;
    const next = apply ? normalizeProjectName(input.value) : projectName;
    input.replaceWith(button);
    if (next !== projectName) {
      projectName = next;
      store.project.name = next;
      dirty = true;
      scheduleAutosave();
    }
    updateProjectTitle();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
});

$('btn-add-midi').addEventListener('click', () => addTrack('midi'));
$('btn-add-audio').addEventListener('click', () => addTrack('audio'));

function addTrack(kind: TrackKind): Track {
  const names: Record<TrackKind, string> = { midi: 'New Instrument', audio: 'New Audio' };
  const track = createTrack(kind, names[kind], store.project.tracks.length);
  if (kind === 'midi') track.instrument = createInstrument('polysynth');
  store.edit('structure', (project) => {
    project.tracks.push(track);
    project.length = Math.max(project.length, 32);
  });
  store.selectTrack(track.id);
  toast(`Added ${track.name}`);
  return track;
}

// ---------------------------------------------------------------- export

$('btn-export').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('btn-export');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Rendering…';
  try {
    await engine.ensureContext();
    const blob = await renderMixdown(store, { bitDepth: 24, sampleRate: 48000 });
    downloadBlob(blob, `${store.project.name.replace(/\s+/g, '-').toLowerCase()}-mixdown.wav`);
    toast('Mixdown rendered (24-bit / 48 kHz WAV)');
  } catch (error) {
    console.error(error);
    toast(error instanceof Error ? error.message : 'Render failed');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

// ---------------------------------------------------------------- import audio

let fileExplorer: FileExplorer | null = null;

interface PlaceOptions {
  /** arrangement beat to place the clip on; defaults to the playhead */
  beat?: number;
  /** audio track to use; a MIDI lane or nothing falls back to the usual choice */
  trackId?: string;
}

/** The track a new audio clip belongs on: the named lane, else the selection. */
function audioTrackFor(trackId?: string): Track {
  const named = trackId ? store.trackById(trackId) : undefined;
  if (named?.kind === 'audio') return named;

  const selected = store.selectedTrack;
  if (selected?.kind === 'audio') return selected;

  const existing = store.project.tracks.find((track) => track.kind === 'audio');
  return existing ?? createTrack('audio', 'Audio', store.project.tracks.length);
}

/** Puts an asset on the timeline, snap-aligned, and selects the new clip. */
function placeAsset(asset: AudioAsset, options: PlaceOptions = {}): Clip {
  const track = audioTrackFor(options.trackId);
  const beats = Math.max(0.25, (asset.duration * store.project.bpm) / 60);
  const beat = Math.max(0, snapBeat(options.beat ?? beatNow(), store.snap || 1));
  const clip: Clip = {
    id: uid('clip'),
    trackId: track.id,
    name: asset.name,
    kind: 'audio',
    start: beat,
    length: beats,
    color: track.color,
    notes: [],
    assetId: asset.id,
    offset: 0,
    gain: 1,
  };

  const isNewTrack = !store.project.tracks.some((candidate) => candidate.id === track.id);
  store.edit('structure', (project) => {
    if (isNewTrack && !project.tracks.some((candidate) => candidate.id === track.id)) project.tracks.push(track);
    project.clips.push(clip);
    project.length = Math.max(project.length, clip.start + clip.length);
  });
  store.selectClip(clip.id);
  return clip;
}

/** Decodes a file and places it. Shared by the picker, the explorer and drops. */
async function importAudioFile(file: File, options: PlaceOptions = {}): Promise<Clip> {
  const ctx = await engine.ensureContext();
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const asset: AudioAsset = {
    id: uid('asset'),
    name: file.name,
    buffer,
    duration: buffer.duration,
    peaks: peaksFor(buffer),
  };
  store.assets.set(asset.id, asset);
  return placeAsset(asset, options);
}

function insertAsset(assetId: string, options: PlaceOptions = {}): Clip | null {
  const asset = store.assetById(assetId);
  return asset ? placeAsset(asset, options) : null;
}

$<HTMLInputElement>('file-input').addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const clip = await importAudioFile(file);
    fileExplorer?.refresh();
    toast(`Imported ${clip.name}`);
  } catch (error) {
    console.error(error);
    toast('Could not decode that audio file');
  } finally {
    input.value = '';
  }
});

// ---------------------------------------------------------------- browser

function browserSection(title: string, hint?: string): HTMLElement {
  const wrap = el('div');
  const head = el('div', 'section-title');
  head.append(el('span', '', title));
  if (hint) head.append(el('span', '', hint));
  wrap.appendChild(head);
  wrap.appendChild(el('div', 'browser-list'));
  return wrap;
}

function renderBrowser(): void {
  const body = $('browser-body');
  body.innerHTML = '';

  const trackSection = browserSection('Tracks', String(store.project.tracks.length));
  const trackList = trackSection.querySelector('.browser-list') as HTMLElement;
  for (const track of store.project.tracks) {
    const item = el('button', 'browser-item');
    if (track.id === store.selectedTrackId) item.classList.add('is-selected');
    const dot = el('span', 'dot');
    dot.style.background = track.color;
    item.append(dot, el('span', 'name', track.name), el('span', 'kind', track.kind));
    item.addEventListener('click', () => store.selectTrack(track.id));
    trackList.appendChild(item);
  }
  body.appendChild(trackSection);

  const instrumentSection = browserSection('Instruments', 'click to load');
  const instrumentList = instrumentSection.querySelector('.browser-list') as HTMLElement;
  for (const type of Object.keys(INSTRUMENT_SPECS) as InstrumentType[]) {
    const spec = INSTRUMENT_SPECS[type];
    const item = el('button', 'browser-item');
    const dot = el('span', 'dot');
    dot.style.background = 'var(--amber)';
    item.append(dot, el('span', 'name', spec.name), el('span', 'kind', spec.category));
    item.addEventListener('click', () => {
      let track = store.selectedTrack;
      if (!track || track.kind !== 'midi') track = addTrack('midi');
      const target = track;
      store.edit('structure', () => {
        target.instrument = createInstrument(type);
      });
      store.selectTrack(target.id);
      toast(`${spec.name} loaded on ${target.name}`);
    });
    instrumentList.appendChild(item);
  }
  body.appendChild(instrumentSection);

  const micSection = browserSection('Microphones', 'emulate & preset');
  const micList = micSection.querySelector('.browser-list') as HTMLElement;
  for (const model of MIC_MODELS) {
    const item = el('button', 'browser-item');
    const dot = el('span', 'dot');
    dot.style.background = '#f5a524';
    item.append(dot, el('span', 'name', model.name), el('span', 'kind', model.family));
    item.title = `${model.tagline} — best on ${model.best.toLowerCase()}`;
    item.addEventListener('click', () => {
      const track = store.selectedTrack;
      if (!track) {
        toast('Select a track first');
        return;
      }
      const params = micPresetParams(model.id);
      store.edit('structure', () => {
        const existing = track.devices.find((device) => device.type === 'micemu');
        if (existing) Object.assign(existing.params, params);
        else track.devices.push(createMicDevice(model.id));
      });
      toast(`${model.name} → ${track.name}`);
    });
    micList.appendChild(item);
  }
  body.appendChild(micSection);

  const fxSection = browserSection('Effects', 'add to selected');
  const fxList = fxSection.querySelector('.browser-list') as HTMLElement;
  for (const type of Object.keys(DEVICE_SPECS) as DeviceType[]) {
    if (type === 'micemu') continue; // lives in the Microphones section
    const spec = DEVICE_SPECS[type];
    const item = el('button', 'browser-item');
    const dot = el('span', 'dot');
    dot.style.background = 'var(--blue)';
    item.append(dot, el('span', 'name', spec.name), el('span', 'kind', spec.category));
    item.addEventListener('click', () => {
      const track = store.selectedTrack;
      if (!track) {
        toast('Select a track first');
        return;
      }
      store.edit('structure', () => {
        track.devices.push(createDevice(type));
      });
      toast(`${spec.name} → ${track.name}`);
    });
    fxList.appendChild(item);
  }
  body.appendChild(fxSection);
}

// ---------------------------------------------------------------- browser views

type BrowserTab = 'library' | 'files';

function setBrowserTab(tab: BrowserTab): void {
  $('browser-body').hidden = tab !== 'library';
  $('browser-files').hidden = tab !== 'files';

  for (const button of document.querySelectorAll<HTMLButtonElement>('.browser-tab')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('is-on', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  if (tab === 'files') {
    // The explorer needs room for file names and the folder trail. Widen a
    // narrow browser once, then leave whatever width the user settles on.
    if (layout.browserWidth < 300) applyLayout({ ...layout, browserWidth: 320 }, true);
    fileExplorer?.refresh();
  }
}

fileExplorer = new FileExplorer({
  onAuditionFile: (file) => {
    previewPanel.open();
    void previewPanel.loadFile(file);
  },
  onInsertFile: (file) => {
    void insertFromExplorer(file);
  },
  onAuditionAsset: (assetId) => {
    const asset = store.assetById(assetId);
    if (!asset) return;
    previewPanel.open();
    previewPanel.loadBuffer(asset.buffer, asset.name);
  },
  onInsertAsset: (assetId) => {
    const clip = insertAsset(assetId);
    if (clip) toast(`Inserted ${clip.name} at ${formatBars(clip.start, store.project.beatsPerBar)}`);
  },
  assets: () =>
    [...store.assets.values()].map((asset) => ({ id: asset.id, name: asset.name, duration: asset.duration })),
  notify: toast,
});
fileExplorer.mount($('browser-files'));

async function insertFromExplorer(file: File): Promise<void> {
  try {
    const clip = await importAudioFile(file);
    fileExplorer?.refresh();
    toast(`Inserted ${clip.name} at ${formatBars(clip.start, store.project.beatsPerBar)}`);
  } catch (error) {
    console.error(error);
    toast(`Could not decode ${file.name}`);
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('.browser-tab')) {
  button.addEventListener('click', () => setBrowserTab((button.dataset.tab as BrowserTab) ?? 'library'));
}

// ---------------------------------------------------------------- drag and drop

const arrangeBody = $('arrange-body');
const lanesEl = $('lanes');
const dropHint = el('div', 'drop-hint');
dropHint.hidden = true;
dropHint.append(el('div', 'drop-line'), el('div', 'drop-lane'));
lanesEl.appendChild(dropHint);

function showDropHint(target: { x: number; rowTop: number; rowHeight: number }): void {
  dropHint.hidden = false;
  dropHint.style.setProperty('--drop-x', `${target.x}px`);
  dropHint.style.setProperty('--drop-y', `${target.rowTop}px`);
  dropHint.style.setProperty('--drop-h', `${target.rowHeight}px`);
}

function hideDropHint(): void {
  dropHint.hidden = true;
}

async function placeDroppedFiles(files: NamedFile[], start: number, trackId?: string): Promise<void> {
  let beat = start;
  let placed = 0;

  for (const entry of files) {
    try {
      const clip = await importAudioFile(entry.file, { beat, trackId });
      beat = clip.start + clip.length;
      placed += 1;
    } catch (error) {
      console.error(error);
    }
  }

  fileExplorer?.refresh();
  if (placed === 0) {
    toast('Those files could not be decoded');
    return;
  }

  const at = formatBars(start, store.project.beatsPerBar);
  toast(placed === 1 ? `Placed 1 file at ${at}` : `Placed ${placed} files from ${at}`);
}

/** A drop from the explorer, or from the desktop, onto the arrangement. */
async function dropFiles(
  transfer: DataTransfer,
  target: { beat: number; trackIndex: number } | null,
): Promise<void> {
  const token = transfer.getData(FILE_DRAG_MIME);
  const payload = token ? takeDrag(token) : null;
  const lane = target ? store.project.tracks[target.trackIndex] : undefined;
  const trackId = lane?.kind === 'audio' ? lane.id : undefined;
  const start = target?.beat ?? beatNow();

  if (payload?.kind === 'asset') {
    const clip = insertAsset(payload.assetId, { beat: start, trackId });
    if (clip) toast(`Placed ${clip.name} at ${formatBars(clip.start, store.project.beatsPerBar)}`);
    return;
  }

  if (payload?.kind === 'file') {
    await placeDroppedFiles([{ file: payload.file, path: payload.name }], start, trackId);
    return;
  }

  const dropped = (await filesFromDrop(transfer)).filter((entry) => isAudioName(entry.file.name));
  if (dropped.length === 0) {
    toast('Drop audio files to place them on a track');
    return;
  }
  await placeDroppedFiles(dropped, start, trackId);
}

arrangeBody.addEventListener('dragover', (event) => {
  if (!hasFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  showDropHint(timeline.dropTarget(event.clientX, event.clientY));
});

arrangeBody.addEventListener('dragleave', (event) => {
  if (event.relatedTarget instanceof Node && arrangeBody.contains(event.relatedTarget)) return;
  hideDropHint();
});

arrangeBody.addEventListener('drop', (event) => {
  if (!hasFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  hideDropHint();
  const target = timeline.dropTarget(event.clientX, event.clientY);
  if (event.dataTransfer) void dropFiles(event.dataTransfer, target);
});

// A drop anywhere else still imports, landing at the playhead, instead of the
// browser navigating away to the file.
window.addEventListener('dragover', (event) => {
  if (!hasFileDrag(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', (event) => {
  if (!hasFileDrag(event.dataTransfer)) return;
  if (event.defaultPrevented) return;
  event.preventDefault();
  hideDropHint();
  if (event.dataTransfer) void dropFiles(event.dataTransfer, null);
});

window.addEventListener('dragend', hideDropHint);

// ---------------------------------------------------------------- layout

const root = document.documentElement;
const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });
// The preferred sizes are what the user chose; `layout` is those sizes fitted
// to the current window. Keeping both means a session can move from a 4K monitor
// to a laptop and back without permanently losing the wide arrangement.
let preferredLayout: LayoutState = preferences.layout ?? DEFAULT_LAYOUT;
let layout: LayoutState = clampLayout(preferredLayout, viewport());

function persistLayout(): void {
  preferences = { ...preferences, layout: preferredLayout };
  savePreferences(preferences);
}

/** Applies a layout to the grid, the splitters and the mixer fold state. */
function applyLayout(next: LayoutState, persist = false, remember = true): void {
  layout = next;
  if (remember) preferredLayout = next;
  root.style.setProperty('--browser-w', `${layout.browserWidth}px`);
  root.style.setProperty('--rack-w', `${layout.rackWidth}px`);
  root.style.setProperty('--mixer-h', layout.mixerCollapsed ? '0px' : `${layout.mixerHeight}px`);

  $('mixer').classList.toggle('is-collapsed', layout.mixerCollapsed);
  $('split-mixer').style.display = layout.mixerCollapsed ? 'none' : '';
  $('btn-toggle-mixer').textContent = layout.mixerCollapsed ? '▴' : '▾';
  $('btn-toggle-mixer').title = layout.mixerCollapsed ? 'Show mixer' : 'Collapse mixer';

  const splitLeft = $('split-left');
  const splitRight = $('split-right');
  splitLeft.setAttribute('aria-valuenow', String(Math.round(layout.browserWidth)));
  splitRight.setAttribute('aria-valuenow', String(Math.round(layout.rackWidth)));
  $('split-mixer').setAttribute('aria-valuenow', String(Math.round(layout.mixerHeight)));

  if (persist) persistLayout();
}

// The top bar wraps to two rows on narrow windows; the floating panels start
// below whatever height it ends up with.
const topbarElement = document.querySelector<HTMLElement>('.topbar');
if (topbarElement && typeof ResizeObserver !== 'undefined') {
  const syncTopbar = (): void => {
    root.style.setProperty('--topbar-h', `${Math.round(topbarElement.getBoundingClientRect().height)}px`);
  };
  new ResizeObserver(syncTopbar).observe(topbarElement);
  window.addEventListener('resize', syncTopbar);
  syncTopbar();
}

/**
 * A splitter is a first-class control: drag it, focus it and use the arrow
 * keys, or double-click it to put that panel back to its default size.
 */
function attachSplitter(
  handle: HTMLElement,
  vertical: boolean,
  onDelta: (delta: number) => void,
  onReset: () => void,
): void {
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', vertical ? 'horizontal' : 'vertical');
  handle.setAttribute('aria-label', vertical ? 'Resize mixer' : handle.id === 'split-left' ? 'Resize browser panel' : 'Resize device rack');

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    const startX = event.clientX;
    const startY = event.clientY;
    // The pointer delta is measured from the grab point, so only its change
    // since the last move is applied. Passing the whole delta would compound
    // and fling the panel to its limit on a short drag.
    let applied = 0;
    const move = (moveEvent: PointerEvent): void => {
      const delta = vertical ? startY - moveEvent.clientY : moveEvent.clientX - startX;
      onDelta(delta - applied);
      applied = delta;
    };
    const up = (): void => {
      handle.classList.remove('is-dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      persistLayout();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });

  handle.addEventListener('dblclick', () => onReset());

  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 12;
    let handled = true;
    if (event.key === 'ArrowLeft') onDelta(-step);
    else if (event.key === 'ArrowRight') onDelta(step);
    else if (event.key === 'ArrowUp') onDelta(step);
    else if (event.key === 'ArrowDown') onDelta(-step);
    else if (event.key === 'Home') onReset();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      persistLayout();
    }
  });
}

attachSplitter(
  $('split-left'),
  false,
  (delta) => applyLayout(clampLayout({ ...layout, browserWidth: layout.browserWidth + delta }, viewport())),
  () => applyLayout(clampLayout({ ...layout, browserWidth: DEFAULT_LAYOUT.browserWidth }, viewport()), true),
);

attachSplitter(
  $('split-right'),
  false,
  (delta) => applyLayout(clampLayout({ ...layout, rackWidth: layout.rackWidth - delta }, viewport())),
  () => applyLayout(clampLayout({ ...layout, rackWidth: DEFAULT_LAYOUT.rackWidth }, viewport()), true),
);

attachSplitter(
  $('split-mixer'),
  true,
  (delta) => applyLayout(clampLayout({ ...layout, mixerHeight: layout.mixerHeight + delta }, viewport())),
  () => applyLayout(clampLayout({ ...layout, mixerHeight: DEFAULT_LAYOUT.mixerHeight }, viewport()), true),
);

$('btn-toggle-mixer').addEventListener('click', () => {
  applyLayout({ ...layout, mixerCollapsed: !layout.mixerCollapsed }, true);
});

applyLayout(layout, false, false);

// A window dragged between monitors can change pixel density without changing
// size; repaint the timelines so they stay crisp on the new display.
function watchPixelRatio(): void {
  if (typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  query.addEventListener(
    'change',
    () => {
      timeline.refresh();
      mixer.refreshScopes();
      watchPixelRatio();
    },
    { once: true },
  );
}
watchPixelRatio();

let resizeTimer = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    applyLayout(clampLayout(preferredLayout, viewport()), false, false);
    timeline.refresh();
    // Media queries hide the panels above these widths, so a drawer that was
    // open while the window grew can never leave a stranded backdrop behind.
    if (window.innerWidth > 1080) $('browser').classList.remove('is-drawer');
    if (window.innerWidth > 860) $('rack').classList.remove('is-drawer');
    syncDrawerChrome();
  }, 120);
});

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast('Fullscreen is blocked by the browser');
  }
}

function applyPreset(preset: LayoutPreset): void {
  applyLayout(layoutPreset(preset, viewport()), true);
  const label = LAYOUT_PRESETS.find((entry) => entry.id === preset)?.label ?? 'Studio';
  toast(`Workspace: ${label}`);
  timeline.refresh();
}

const viewMenu = new ViewMenu({
  onPreset: applyPreset,
  onFit: () => {
    applyLayout(fittedLayout(viewport()), true);
    toast(`Fitted to ${window.innerWidth}×${window.innerHeight}`);
    timeline.refresh();
  },
  onReset: () => {
    applyLayout(layoutPreset('default', viewport()), true);
    toast('Panels reset');
    timeline.refresh();
  },
  onFullscreen: () => void toggleFullscreen(),
});
fileMenu.element.after(viewMenu.element);

// ------------------------------------------------------- narrow-screen panels
// Below 1080px the browser is hidden and below 860px the rack is hidden so the
// arrangement keeps a usable width. These buttons open either panel as a
// drawer, so a small laptop or a tablet never loses access to it.
const browserToggle = el('button', 'tbtn tbtn-sm panel-toggle', 'Browser');
browserToggle.id = 'btn-browser-panel';
browserToggle.title = 'Open the browser as a drawer';
const rackToggle = el('button', 'tbtn tbtn-sm panel-toggle', 'Rack');
rackToggle.id = 'btn-rack-panel';
rackToggle.title = 'Open the device rack as a drawer';
viewMenu.element.after(browserToggle, rackToggle);

const drawerBackdrop = el('div', 'drawer-backdrop');
document.body.appendChild(drawerBackdrop);

for (const [id, toggle] of [
  ['browser', browserToggle],
  ['rack', rackToggle],
] as const) {
  const panel = $(id);
  const close = el('button', 'tbtn tbtn-sm drawer-close', '✕');
  close.title = 'Close panel';
  close.addEventListener('click', () => closeDrawers());
  panel.querySelector('.panel-head')?.appendChild(close);
  toggle.setAttribute('aria-controls', id);
}

function syncDrawerChrome(): void {
  const browserOpen = $('browser').classList.contains('is-drawer');
  const rackOpen = $('rack').classList.contains('is-drawer');
  browserToggle.classList.toggle('is-on', browserOpen);
  browserToggle.setAttribute('aria-expanded', String(browserOpen));
  rackToggle.classList.toggle('is-on', rackOpen);
  rackToggle.setAttribute('aria-expanded', String(rackOpen));
  drawerBackdrop.classList.toggle('is-visible', browserOpen || rackOpen);
}

function closeDrawers(): void {
  for (const id of ['browser', 'rack'] as const) $(id).classList.remove('is-drawer');
  syncDrawerChrome();
}

function toggleDrawer(id: 'browser' | 'rack'): void {
  const panel = $(id);
  const open = !panel.classList.contains('is-drawer');
  closeDrawers();
  if (!open) return;
  panel.classList.add('is-drawer');
  syncDrawerChrome();
}

for (const [id, toggle] of [
  ['browser', browserToggle],
  ['rack', rackToggle],
] as const) {
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => toggleDrawer(id));
}
drawerBackdrop.addEventListener('pointerdown', () => closeDrawers());
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape') closeDrawers();
  },
  true,
);

// ---------------------------------------------------------------- keyboard

// A key released while the MIDI panel is open has to end its note, even if the
// panel was closed in between: the note-off is not a transport shortcut.
document.addEventListener('keyup', (event) => {
  if (!midiPanel.visible) return;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (midiPanel.handleKey(event.key, false, false)) event.preventDefault();
});

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  // Typing fields keep every key. Checkboxes, sliders and buttons do not: a
  // Space after toggling Stretch should start the transport, not re-toggle it.
  const tag = target?.tagName;
  const inputType = tag === 'INPUT' ? (target as HTMLInputElement).type : '';
  const typing =
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target?.isContentEditable === true ||
    (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(inputType));
  if (typing) return;
  // Arrow keys still belong to a focused slider; every other key is global.
  if (tag === 'INPUT' && inputType === 'range' && event.key.startsWith('Arrow')) return;

  // While the MIDI panel is open its letter keys play notes, so a key press
  // does not also fire a transport shortcut.
  if (midiPanel.visible && midiPanel.handleKey(event.key, true, event.repeat)) {
    event.preventDefault();
    return;
  }

  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) store.redo();
    else store.undo();
    return;
  }

  const command = event.key.toLowerCase();
  if (mod && command === 's') {
    event.preventDefault();
    void saveProject({ saveAs: event.shiftKey });
    return;
  }
  if (mod && command === 'o') {
    event.preventDefault();
    void openProject();
    return;
  }
  if (mod && command === 'n') {
    event.preventDefault();
    showStartScreen();
    return;
  }
  if (mod && event.shiftKey && command === 'f') {
    event.preventDefault();
    void toggleFullscreen();
    return;
  }
  if (mod) return;

  // AI Assistant: Shift+M for mix & master, ? or F1 for help, Esc to dismiss.
  if (event.shiftKey && command === 'm') {
    event.preventDefault();
    remotePanel.close();
    nativePanel.close();
    assistant.openMixAi(store.selectedTrackId || 'master');
    return;
  }
  if (event.key === '?' || event.key === 'F1') {
    event.preventDefault();
    remotePanel.close();
    nativePanel.close();
    assistant.openHelp();
    return;
  }
  if (event.key === 'Escape') {
    assistant.close();
    return;
  }

  // Enter edits the selected MIDI clip's notes, like a DAW's clip editor.
  if (event.key === 'Enter' && store.selectedClip?.kind === 'midi') {
    event.preventDefault();
    piano.open(store.selectedClip.id);
    return;
  }

  // Shift+Space starts at the selected clip, the usual DAW audition gesture.
  if (event.code === 'Space' && event.shiftKey) {
    event.preventDefault();
    if (!timeline.playFromSelection()) toast('Select a clip to play from');
    return;
  }

  // Shift+R returns to where the transport last started, like a last-locate key.
  if (event.shiftKey && command === 'r') {
    event.preventDefault();
    timeline.returnToLastStart();
    return;
  }

  // R records onto the armed audio track.
  if (!event.shiftKey && command === 'r') {
    event.preventDefault();
    if (recording) stopRecording();
    else void startRecording();
    return;
  }

  switch (event.key) {
    case ' ':
      event.preventDefault();
      if (recording) {
        stopRecording();
        break;
      }
      // A drawn range plays once; with no range Space is the usual play/pause.
      if (store.range && !engine.isPlaying && !engine.isCountingIn) timeline.playRange();
      else engine.togglePlay();
      break;
    case 'Home':
      event.preventDefault();
      timeline.seek(event.shiftKey ? store.project.loop.start : 0);
      break;
    case 'End':
      event.preventDefault();
      timeline.seek(event.shiftKey ? store.project.loop.end : store.project.length);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      timeline.nudgePlayhead(-1, event.shiftKey);
      break;
    case 'ArrowRight':
      event.preventDefault();
      timeline.nudgePlayhead(1, event.shiftKey);
      break;
    case ',':
    case '<': {
      event.preventDefault();
      if (!timeline.jumpMarker(-1)) toast('No marker before the playhead');
      break;
    }
    case '.':
    case '>': {
      event.preventDefault();
      if (!timeline.jumpMarker(1)) toast('No marker after the playhead');
      break;
    }
    case '[': {
      event.preventDefault();
      timeline.setLoopEdge('start');
      toast('Loop start set to the playhead');
      break;
    }
    case ']': {
      event.preventDefault();
      timeline.setLoopEdge('end');
      toast('Loop end set to the playhead');
      break;
    }
    case 'm':
    case 'M':
      event.preventDefault();
      if (event.altKey) {
        if (timeline.deleteMarkerAtPlayhead()) toast('Marker deleted');
        else toast('No marker at the playhead');
      } else {
        const marker = timeline.addMarkerAtPlayhead();
        toast(`Marker at ${formatBars(marker.beat, store.project.beatsPerBar)}`);
      }
      break;
    case 'Delete':
    case 'Backspace':
      event.preventDefault();
      timeline.deleteSelected();
      break;
    case 'l':
    case 'L':
      if (event.shiftKey) {
        if (timeline.loopSelectedClip()) toast('Loop set to the selected clip');
        else toast('Select a clip to loop it');
      } else if (timeline.loopRange()) {
        toast(
          `Loop set to the selection · ${formatBars(store.project.loop.start, store.project.beatsPerBar)} – ${formatBars(store.project.loop.end, store.project.beatsPerBar)}`,
        );
      } else {
        const pair = timeline.toggleMarkerLoop();
        if (pair) {
          toast(
            store.project.loop.enabled
              ? `Looping between ${formatBars(pair.start, store.project.beatsPerBar)} and ${formatBars(pair.end, store.project.beatsPerBar)}`
              : 'Marker loop off',
          );
        } else {
          store.edit('structure', (project) => {
            project.loop.enabled = !project.loop.enabled;
          });
        }
      }
      break;
    case 'n':
    case 'N': {
      const clip = store.selectedClip;
      if (clip && clip.kind === 'audio') {
        event.preventDefault();
        const gain = normalizeClip(store, clip.id);
        if (gain === null) toast('This clip is silent — nothing to normalize');
        else {
          void reflowClipAudio(store.selectedClip);
          toast(`Normalized to −1 dBFS · clip gain ${gainToDb(gain).toFixed(1)} dB`);
        }
      }
      break;
    }
    case 'r':
    case 'R': {
      const clip = store.selectedClip;
      if (clip && clip.kind === 'audio') {
        event.preventDefault();
        const reversed = toggleReverseClip(store, clip.id);
        if (reversed !== null) {
          void reflowClipAudio(store.selectedClip);
          toast(reversed ? 'Clip reversed — Ctrl+Z brings the original back' : 'Clip plays forwards again');
        }
      }
      break;
    }
    case 'f':
    case 'F':
      applyFollow(nextFollowMode(timeline.follow), true);
      break;
    case 'k':
    case 'K':
      if (event.shiftKey) {
        engine.setCountIn(!engine.countIn);
        toast(countInLabel(engine.metronomeSettings));
      } else {
        engine.setMetronome(!engine.metronome);
      }
      break;
    case 't':
    case 'T':
      tapTempo();
      break;
    case 's':
    case 'S':
      timeline.splitSelected();
      break;
    case 'd':
    case 'D':
      timeline.duplicateSelected();
      break;
    case '+':
    case '=':
      timeline.zoomBy(1.25);
      break;
    case '-':
      timeline.zoomBy(1 / 1.25);
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------- frame loop

const masterMeterCanvas = $<HTMLCanvasElement>('master-meter');
const masterMeterCtx = masterMeterCanvas.getContext('2d');
if (masterMeterCtx) {
  masterMeterCanvas.width = 168;
  masterMeterCanvas.height = 20;
}

/**
 * The readout and master meter run at display rate while the transport rolls
 * and drop to ~3 Hz when idle, so a parked session costs almost no CPU.
 */
let frameRaf = 0;
let frameTimer = 0;

function scheduleFrame(): void {
  if (frameRaf || frameTimer) return;
  frameTimer = window.setTimeout(frame, engine.isPlaying || engine.isCountingIn || engine.isPreparing ? 33 : 320);
}

/** Immediate repaint after a transport or view change, then back to the slow loop. */
function wakeFrame(): void {
  if (frameRaf) {
    window.cancelAnimationFrame(frameRaf);
    frameRaf = 0;
  }
  if (frameTimer) {
    window.clearTimeout(frameTimer);
    frameTimer = 0;
  }
  frameRaf = window.requestAnimationFrame(frame);
}

function frame(): void {
  frameRaf = 0;
  frameTimer = 0;

  const project = store.project;
  const countIn = engine.countInState;
  const pos = $('pos');
  if (countIn.active) {
    pos.classList.add('is-counting');
    $('pos-bars').textContent = String(countIn.remaining);
    $('pos-time').textContent = `${countIn.bars} bar${countIn.bars === 1 ? '' : 's'} count-in`;
    btnCountIn.textContent = String(countIn.remaining);
    pos.title = `Count-in: ${countIn.remaining}`;
  } else if (engine.isPreparing) {
    // Time-stretch runs off the audio thread; say so instead of looking stuck.
    pos.classList.add('is-counting');
    $('pos-bars').textContent = 'PREP';
    $('pos-time').textContent = 'rendering warp…';
    pos.title = 'Preparing time-stretched audio';
  } else {
    const beat = engine.positionBeat;
    pos.classList.remove('is-counting');
    $('pos-bars').textContent = formatBars(beat, project.beatsPerBar);
    $('pos-time').textContent = formatTime((beat * 60) / project.bpm);
    if (btnCountIn.textContent !== '◷') btnCountIn.textContent = '◷';
    pos.title = 'Click to type a location: bar.beat.sixteenth';
  }

  const peak = engine.masterPeak();
  if (masterMeterCtx) {
    const width = masterMeterCanvas.width;
    const height = masterMeterCanvas.height;
    masterMeterCtx.clearRect(0, 0, width, height);
    const gradient = masterMeterCtx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#1c8f68');
    gradient.addColorStop(0.7, '#38d39f');
    gradient.addColorStop(0.88, '#f5a524');
    gradient.addColorStop(1, '#f43f5e');
    masterMeterCtx.fillStyle = gradient;
    masterMeterCtx.fillRect(0, 0, Math.min(width, peak * width), height);
  }
  $('master-db').textContent = peak > 0.001 ? `${(20 * Math.log10(peak)).toFixed(1)}` : '-∞';

  scheduleFrame();
}

// ---------------------------------------------------------------- boot

store.subscribe((reason) => {
  if (reason === 'structure' || reason === 'selection') {
    renderBrowser();
    fileExplorer?.refresh();
    refreshTransport();
  }
  if (reason === 'transport') {
    refreshTransport();
    wakeFrame();
  }
  if (reason === 'view') refreshTransport();

  if (!applyingProject && (reason === 'structure' || reason === 'params')) {
    setDirty(true);
    scheduleAutosave();
  }
});

// Recover the session this browser was last working on, then open with the
// start screen unless the user turned it off.
const recovered = readAutosave();
if (recovered) {
  try {
    const parsed = parseProject(recovered.data);
    void applyProject(parsed.project, recovered.name || parsed.project.name, parsed.assets);
  } catch {
    // A corrupt snapshot must never stop the studio from opening.
  }
}

renderBrowser();
refreshTransport();
updateProjectTitle();
scheduleFrame();

// The desktop host draws a diagnostic panel instead of a blank window when this
// never arrives, so it has to be the last thing the boot does.
announceUiReady();

if (preferences.scanVst3OnStart && nativeBridge.available) {
  window.setTimeout(() => {
    nativeBridge.scanPlugins();
    toast('Scanning VST3 folders…');
  }, 900);
}

if (preferences.showStartup) {
  window.setTimeout(() => {
    if (!startScreen) showStartScreen();
  }, 80);
}

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

// First gesture unlocks the audio engine.
const unlock = (): void => {
  void engine.ensureContext().then(() => refreshTransport());
  window.removeEventListener('pointerdown', unlock);
};
window.addEventListener('pointerdown', unlock, { once: true });

// The interface is fully wired by now. index.html watches for this flag and
// shows a readable banner instead of a silent dead page if it never arrives.
document.documentElement.dataset.appReady = 'true';
