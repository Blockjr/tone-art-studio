import { micPresetParams } from '../audio/mics';
import { DEVICE_SPECS, INSTRUMENT_SPECS, defaultParams } from '../audio/specs';
import { uid } from './time';
import type {
  Clip,
  DeviceState,
  DeviceType,
  InstrumentState,
  InstrumentType,
  Marker,
  Note,
  Project,
  ReturnState,
  Track,
  TrackKind,
} from './types';

export const TRACK_COLORS = ['#f43f5e', '#4d8dff', '#f5a524', '#22c98a', '#a78bfa', '#38bdf8'];

export const DEFAULT_EQ: Track['eq'] = { hp: 30, low: 0, mid: 0, midFreq: 1000, high: 0 };

export function createDevice(type: DeviceType): DeviceState {
  return {
    id: uid('dev'),
    type,
    enabled: true,
    collapsed: false,
    params: defaultParams(DEVICE_SPECS[type].params),
  };
}

/** A mic emulation insert already loaded with a model's first preset (or the one named). */
/** A transparent safety limiter: ceiling −1 dBFS, no extra gain. */
function cleanLimiter(): DeviceState {
  const device = createDevice('limiter');
  device.params = { ...device.params, ceiling: -1, release: 0.15, gain: 0 };
  return device;
}

/** Slow 2:1 bus glue, leaving the transients alone. */
function busCompressor(): DeviceState {
  const device = createDevice('compressor');
  device.params = {
    ...device.params,
    threshold: -20,
    ratio: 2,
    attack: 0.03,
    release: 0.3,
    makeup: 0,
  };
  return device;
}

export function createMicDevice(modelId: string, presetId?: string): DeviceState {
  const device = createDevice('micemu');
  device.params = { ...device.params, ...micPresetParams(modelId, presetId) };
  return device;
}

export function createInstrument(type: InstrumentType): InstrumentState {
  return { type, params: defaultParams(INSTRUMENT_SPECS[type].params) };
}

export function createTrack(kind: TrackKind, name: string, index: number): Track {
  return {
    id: uid('trk'),
    name,
    kind,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    volume: 0.8,
    gain: 0,
    eq: { ...DEFAULT_EQ },
    eqOn: true,
    pan: 0,
    mute: false,
    solo: false,
    armed: false,
    sends: [0, 0, 0, 0],
    preSends: [false, false, false, false],
    instrument: kind === 'midi' ? createInstrument('polysynth') : null,
    devices: [],
  };
}

export const RETURN_COLORS = ['#4d8dff', '#f5a524', '#a78bfa', '#38bdf8'];

/** Builds one aux return with a single fixed effect and a 100% wet chain. */
export function createReturn(
  index: number,
  name: string,
  type: DeviceType,
  params: Record<string, number> = {},
): ReturnState {
  const device = createDevice(type);
  device.params = { ...device.params, ...params };
  device.collapsed = true;

  return {
    id: `return-${'abcd'[index] ?? index}`,
    name,
    label: 'ABCD'[index] ?? String(index + 1),
    color: RETURN_COLORS[index % RETURN_COLORS.length],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    soloSafe: true,
    devices: [device],
  };
}

export function defaultReturns(): ReturnState[] {
  return [
    createReturn(0, 'Reverb', 'reverb', { mode: 1, decay: 3.2, space: 1.15, preDelay: 0.025, mix: 1 }),
    createReturn(1, 'Delay', 'delay', { mode: 0, time: 0.363, feedback: 0.38, tone: 5200, mix: 1 }),
    createReturn(2, 'Chorus', 'chorus', { rate: 0.6, depth: 0.45, mix: 1, spread: 0.7 }),
    createReturn(3, 'Room', 'reverb', { mode: 2, decay: 1.1, space: 0.6, preDelay: 0.008, mix: 1 }),
  ];
}

const note = (pitch: number, start: number, duration: number, velocity: number): Note => ({
  id: uid('n'),
  pitch,
  start,
  duration,
  velocity,
});

function barClip(track: Track, name: string, notes: Note[], length = 32): Clip {
  return {
    id: uid('clip'),
    trackId: track.id,
    name,
    kind: 'midi',
    start: 0,
    length,
    color: track.color,
    notes,
    offset: 0,
    gain: 1,
  };
}

function drumNotes(): Note[] {
  const notes: Note[] = [];
  for (let bar = 0; bar < 8; bar++) {
    const b = bar * 4;
    notes.push(note(36, b, 0.5, 1));
    notes.push(note(36, b + 2.5, 0.5, 0.82));
    notes.push(note(38, b + 1, 0.5, 0.9));
    notes.push(note(38, b + 3, 0.5, 0.9));
    for (let i = 0; i < 8; i++) {
      notes.push(note(42, b + i * 0.5, 0.25, i % 2 ? 0.42 : 0.68));
    }
    if (bar === 3 || bar === 7) {
      notes.push(note(45, b + 3.5, 0.25, 0.8));
      notes.push(note(39, b + 3.75, 0.2, 0.7));
    }
  }
  return notes;
}

function bassNotes(): Note[] {
  const roots = [33, 29, 36, 31]; // A1 F1 C2 G1
  const notes: Note[] = [];
  for (let bar = 0; bar < 8; bar++) {
    const b = bar * 4;
    const root = roots[bar % roots.length];
    notes.push(note(root, b, 0.6, 0.95));
    notes.push(note(root, b + 0.75, 0.4, 0.7));
    notes.push(note(root + 12, b + 1.5, 0.4, 0.8));
    notes.push(note(root, b + 2.25, 0.5, 0.85));
    notes.push(note(root + 7, b + 3, 0.4, 0.7));
    notes.push(note(root, b + 3.5, 0.35, 0.6));
  }
  return notes;
}

function rhodesNotes(): Note[] {
  const chords = [
    [57, 60, 64, 67],
    [53, 57, 60, 64],
    [48, 52, 55, 59],
    [55, 59, 62, 65],
  ];
  const notes: Note[] = [];
  for (let bar = 0; bar < 8; bar++) {
    const b = bar * 4;
    const chord = chords[bar % chords.length];
    for (const pitch of chord) {
      notes.push(note(pitch, b, 1.9, 0.62));
      notes.push(note(pitch, b + 2.25, 1.6, 0.5));
    }
  }
  return notes;
}

function arpNotes(): Note[] {
  const steps = [69, 72, 76, 79, 76, 72];
  const notes: Note[] = [];
  for (let bar = 0; bar < 8; bar++) {
    const b = bar * 4;
    for (let i = 0; i < 16; i++) {
      const pitch = steps[(bar * 16 + i) % steps.length];
      notes.push(note(pitch, b + i * 0.25, 0.22, i % 4 === 0 ? 0.8 : i % 2 === 0 ? 0.62 : 0.45));
    }
  }
  return notes;
}

const marker = (name: string, beat: number, color: string): Marker => ({ id: uid('marker'), name, beat, color });

export function emptyProject(): Project {
  return {
    name: 'Untitled',
    bpm: 124,
    beatsPerBar: 4,
    tracks: [],
    clips: [],
    takes: [],
    markers: [],
    master: { volume: 0.86, devices: [createDevice('eq3'), cleanLimiter()] },
    returns: defaultReturns(),
    loop: { enabled: true, start: 0, end: 32 },
    punch: { in: false, out: false },
    length: 64,
  };
}

/**
 * A clean session for a new song: two audio and two MIDI tracks, no clips,
 * with the same transparent master chain the demo uses.
 */
export function blankProject(name: string, bpm = 120, bars = 16): Project {
  const audio1 = createTrack('audio', 'Audio 1', 0);
  const audio2 = createTrack('audio', 'Audio 2', 1);
  const midi1 = createTrack('midi', 'MIDI 1', 2);
  midi1.instrument = createInstrument('polysynth');
  const midi2 = createTrack('midi', 'MIDI 2', 3);
  midi2.instrument = createInstrument('bass');

  const loopBars = Math.max(1, Math.round(bars));
  const length = loopBars * 4;

  return {
    name,
    bpm: Math.round(bpm),
    beatsPerBar: 4,
    tracks: [audio1, audio2, midi1, midi2],
    clips: [],
    takes: [],
    markers: [],
    master: { volume: 0.86, devices: [createDevice('eq3'), busCompressor(), cleanLimiter()] },
    returns: defaultReturns(),
    loop: { enabled: true, start: 0, end: Math.min(length, 32) },
    punch: { in: false, out: false },
    length,
  };
}

export function demoProject(): Project {
  const drums = createTrack('midi', 'Drums', 0);
  drums.instrument = createInstrument('drums');
  drums.volume = 0.9;
  drums.sends = [0.05, 0, 0.1, 0.16];
  drums.devices = [createDevice('compressor')];

  const bass = createTrack('midi', 'Sub Bass', 1);
  bass.instrument = createInstrument('bass');
  bass.volume = 0.78;
  bass.devices = [createDevice('eq3'), createDevice('drive')];

  const rhodes = createTrack('midi', 'Rhodes', 2);
  rhodes.instrument = createInstrument('epiano');
  rhodes.volume = 0.7;
  rhodes.pan = -0.12;
  rhodes.sends = [0.24, 0.06, 0.18, 0.12];
  rhodes.preSends = [true, false, false, false];
  rhodes.devices = [createDevice('chorus')];

  const arp = createTrack('midi', 'Arp Lead', 3);
  arp.instrument = createInstrument('polysynth');
  arp.volume = 0.62;
  arp.pan = 0.16;
  arp.sends = [0.14, 0.22, 0.08, 0.06];
  arp.devices = [createDevice('filter'), createDevice('delay')];

  const tracks = [drums, bass, rhodes, arp];

  return {
    name: 'Tone Art Demo',
    bpm: 124,
    beatsPerBar: 4,
    tracks,
    clips: [
      barClip(drums, 'Drum Loop A', drumNotes()),
      barClip(bass, 'Sub Bass Line', bassNotes()),
      barClip(rhodes, 'Rhodes Chords', rhodesNotes()),
      barClip(arp, 'Arp 16ths', arpNotes()),
    ],
    takes: [],
    markers: [
      marker('Intro', 0, '#f5a524'),
      marker('Verse', 8, '#4d8dff'),
      marker('Chorus', 16, '#22c98a'),
      marker('Bridge', 24, '#a78bfa'),
    ],
    master: {
      // Gentle console bus: a slow 2:1 glue compressor and a −1 dBFS limiter.
      // Master fader sits below unity so the bus never runs out of headroom.
      volume: 0.86,
      devices: [createDevice('eq3'), busCompressor(), cleanLimiter()],
    },
    returns: defaultReturns().map((bus, index) => ({
      ...bus,
      volume: [0.85, 0.7, 0.5, 0.62][index] ?? bus.volume,
    })),
    loop: { enabled: true, start: 0, end: 32 },
    punch: { in: false, out: false },
    length: 32,
  };
}
