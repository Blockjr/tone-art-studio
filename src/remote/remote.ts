import type { Engine } from '../audio/engine';
import type { Store } from '../core/store';
import { clamp } from '../core/time';

export interface RemoteTrackState {
  id: string;
  name: string;
  kind: 'audio' | 'midi';
  /** only audio tracks can be armed and recorded */
  armed: boolean;
  color: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  gain: number;
  sends: number[];
  preSends: boolean[];
  peak: number;
}

export interface RemoteReturnState {
  id: string;
  name: string;
  label: string;
  color: string;
  volume: number;
  pan: number;
  mute: boolean;
  peak: number;
}

export interface RemoteClipState {
  id: string;
  trackId: string;
  name: string;
  /** arrangement start and length in beats */
  start: number;
  length: number;
}

export interface RemoteState {
  type: 'state';
  projectName: string;
  playing: boolean;
  /** capture is running and a take is being written */
  recording: boolean;
  /** input/transport setup is still running, before the take begins */
  recordingStarting: boolean;
  /** the track whose take is open, for highlighting it on the tablet */
  recordingTrackId: string | null;
  countingIn: boolean;
  countInRemaining: number;
  position: number;
  bpm: number;
  beatsPerBar: number;
  length: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  selectedTrackId: string;
  masterVolume: number;
  masterPeak: number;
  masterChain: string[];
  tracks: RemoteTrackState[];
  returns: RemoteReturnState[];
  /** the arrangement, capped so a huge session still fits one websocket frame */
  clips: RemoteClipState[];
}

export type RemoteCommand =
  | { type: 'command'; kind: 'transport'; action: 'play' | 'stop' | 'toggle' }
  | { type: 'command'; kind: 'seek'; beat: number }
  | { type: 'command'; kind: 'volume'; trackId: string; value: number }
  | { type: 'command'; kind: 'pan'; trackId: string; value: number }
  | { type: 'command'; kind: 'gain'; trackId: string; value: number }
  | { type: 'command'; kind: 'send'; trackId: string; index: number; value: number }
  | { type: 'command'; kind: 'sendMode'; trackId: string; index: number; pre: boolean }
  | { type: 'command'; kind: 'mute' | 'solo'; trackId: string }
  | { type: 'command'; kind: 'returnLevel'; returnId: string; value: number }
  | { type: 'command'; kind: 'returnPan'; returnId: string; value: number }
  | { type: 'command'; kind: 'returnMute'; returnId: string }
  | { type: 'command'; kind: 'master'; value: number }
  | { type: 'command'; kind: 'tempo'; value: number }
  | { type: 'command'; kind: 'loop'; value: boolean }
  | { type: 'command'; kind: 'select'; trackId: string }
  | { type: 'command'; kind: 'arm'; trackId: string; armed: boolean }
  | { type: 'command'; kind: 'record'; action: 'start' | 'stop' | 'toggle' };

/**
 * Recording lives in the app shell rather than the audio engine, so the remote
 * receives callbacks instead of reaching into UI state it should not own.
 */
export interface RemoteRecordHooks {
  start?: () => void;
  stop?: () => void;
  isRecording?: () => boolean;
  isStarting?: () => boolean;
  recordingTrackId?: () => string | null;
}

export function buildRemoteState(store: Store, engine: Engine, hooks: RemoteRecordHooks = {}): RemoteState {
  const isRecording = Boolean(hooks.isRecording?.());
  const isCountingIn = Boolean(engine.isCountingIn);
  const countIn = isCountingIn ? engine.countInState : null;
  const project = store.project;
  return {
    type: 'state',
    projectName: project.name,
    playing: engine.isPlaying,
    recording: isRecording,
    recordingStarting: Boolean(hooks.isStarting?.()),
    recordingTrackId: isRecording ? (hooks.recordingTrackId?.() ?? null) : null,
    countingIn: isCountingIn,
    countInRemaining: isCountingIn && countIn ? countIn.remaining : 0,
    position: Number(engine.positionBeat.toFixed(3)),
    bpm: project.bpm,
    beatsPerBar: project.beatsPerBar,
    length: project.length,
    loop: project.loop.enabled,
    loopStart: project.loop.start,
    loopEnd: project.loop.end,
    selectedTrackId: store.selectedTrackId,
    masterVolume: project.master.volume,
    masterPeak: Number(engine.masterPeak().toFixed(3)),
    masterChain: project.master.devices.filter((d) => d.enabled).map((d) => d.type),
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      armed: track.armed,
      color: track.color,
      volume: track.volume,
      pan: track.pan,
      mute: track.mute,
      solo: track.solo,
      gain: track.gain,
      sends: [...track.sends],
      preSends: [...track.preSends],
      peak: Number(engine.trackPeak(track.id).toFixed(3)),
    })),
    clips: project.clips.slice(0, 240).map((clip) => ({
      id: clip.id,
      trackId: clip.trackId,
      name: clip.name.slice(0, 80),
      start: clip.start,
      length: clip.length,
    })),
    returns: project.returns.map((bus, index) => ({
      id: bus.id,
      name: bus.name,
      label: bus.label,
      color: bus.color,
      volume: bus.volume,
      pan: bus.pan,
      mute: bus.mute,
      peak: Number(engine.returnPeak(index).toFixed(3)),
    })),
  };
}

export function applyRemoteCommand(
  store: Store,
  engine: Engine,
  command: RemoteCommand,
  hooks: RemoteRecordHooks = {},
): void {
  switch (command.kind) {
    case 'transport':
      if (command.action === 'toggle') engine.togglePlay();
      else if (command.action === 'play') void engine.play();
      else engine.stop();
      return;
    case 'seek':
      engine.seek(command.beat);
      return;
    case 'volume': {
      const track = store.trackById(command.trackId);
      if (track) {
        store.touch('params', () => {
          track.volume = clamp(command.value, 0, 1.4);
        });
      }
      return;
    }
    case 'pan': {
      const track = store.trackById(command.trackId);
      if (track) {
        store.touch('params', () => {
          track.pan = clamp(command.value, -1, 1);
        });
      }
      return;
    }
    case 'gain': {
      const track = store.trackById(command.trackId);
      if (track) {
        store.touch('params', () => {
          track.gain = clamp(command.value, -24, 24);
        });
      }
      return;
    }
    case 'send': {
      const track = store.trackById(command.trackId);
      if (track) {
        store.touch('params', () => {
          track.sends[command.index] = clamp(command.value, 0, 1);
        });
      }
      return;
    }
    case 'sendMode': {
      const track = store.trackById(command.trackId);
      if (track) {
        store.edit('structure', () => {
          track.preSends[command.index] = command.pre;
        });
      }
      return;
    }
    case 'returnLevel': {
      const bus = store.project.returns.find((r) => r.id === command.returnId);
      if (bus) {
        store.touch('params', () => {
          bus.volume = clamp(command.value, 0, 1.4);
        });
      }
      return;
    }
    case 'returnPan': {
      const bus = store.project.returns.find((r) => r.id === command.returnId);
      if (bus) {
        store.touch('params', () => {
          bus.pan = clamp(command.value, -1, 1);
        });
      }
      return;
    }
    case 'returnMute': {
      const bus = store.project.returns.find((r) => r.id === command.returnId);
      if (bus) {
        store.edit('structure', () => {
          bus.mute = !bus.mute;
        });
      }
      return;
    }
    case 'mute':
    case 'solo': {
      const track = store.trackById(command.trackId);
      if (!track) return;
      store.edit('structure', () => {
        if (command.kind === 'mute') track.mute = !track.mute;
        else track.solo = !track.solo;
      });
      return;
    }
    case 'master':
      store.touch('params', () => {
        store.project.master.volume = clamp(command.value, 0, 1.4);
      });
      return;
    case 'tempo':
      store.edit('structure', (project) => {
        project.bpm = Math.round(clamp(command.value, 40, 260));
      });
      return;
    case 'loop':
      store.edit('structure', (project) => {
        project.loop.enabled = command.value;
      });
      return;
    case 'select':
      store.selectTrack(command.trackId);
      return;
    case 'arm': {
      const track = store.trackById(command.trackId);
      // MIDI recording is not built, so only audio tracks take an arm.
      if (!track || track.kind !== 'audio') return;
      if (track.armed !== command.armed) {
        store.edit('structure', () => {
          track.armed = command.armed;
        });
      }
      // Arming is also how the performer says which track Record should take.
      if (command.armed) store.selectTrack(track.id);
      return;
    }
    case 'record':
      if (command.action === 'stop') {
        hooks.stop?.();
        return;
      }
      if (hooks.isRecording?.()) {
        if (command.action === 'toggle') hooks.stop?.();
        return;
      }
      // The shell ignores a second start, but do not even ask while it is
      // still opening the input or waiting for the count-in to finish.
      if (hooks.isStarting?.()) return;
      hooks.start?.();
      return;
    default:
      return;
  }
}
