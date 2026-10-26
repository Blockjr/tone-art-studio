export type TrackKind = 'midi' | 'audio';

export type InstrumentType = 'drums' | 'polysynth' | 'epiano' | 'bass';

export type DeviceType =
  | 'eq3'
  | 'compressor'
  | 'limiter'
  | 'delay'
  | 'reverb'
  | 'drive'
  | 'filter'
  | 'chorus'
  | 'micemu'
  /** console-style channel strip: filters, EQ, compressor and drive */
  | 'console'
  /** VCA bus compressor for group and master glue */
  | 'busglue'
  /** fast FET peak compressor */
  | 'fet'
  /** slow opto leveler */
  | 'opto'
  /** tape saturation and tone */
  | 'tape'
  /** high-frequency air and presence */
  | 'air'
  /** the AI Mix & Master insert: analysis and correction, no audio path of its own */
  | 'aimix';

/**
 * MIDI effects sit in front of the instrument and transform notes before they
 * are played, the way Ableton's MIDI effect devices do.
 */
export type MidiFxType = 'chord' | 'scale' | 'arp' | 'velocity' | 'pitch' | 'notelength';

export interface MidiFxState {
  id: string;
  type: MidiFxType;
  enabled: boolean;
  params: Record<string, number>;
}

export interface DeviceState {
  id: string;
  type: DeviceType;
  enabled: boolean;
  collapsed: boolean;
  params: Record<string, number>;
}

export interface InstrumentState {
  type: InstrumentType;
  params: Record<string, number>;
}

export interface Note {
  id: string;
  /** MIDI note number */
  pitch: number;
  /** clip-local start in beats */
  start: number;
  /** length in beats */
  duration: number;
  /** 0..1 */
  velocity: number;
}

export interface AudioAsset {
  id: string;
  name: string;
  buffer: AudioBuffer;
  duration: number;
  /** min/max pairs for waveform drawing, 0..1 */
  peaks: number[];
}

/**
 * Non-destructive audio warp. `stretch` fills the clip's current timeline
 * length with the whole source, so dragging an edge time-stretches it;
 * `semitones` shifts pitch while keeping that length.
 */
export interface ClipWarp {
  stretch: boolean;
  semitones: number;
}

export interface Clip {
  id: string;
  trackId: string;
  name: string;
  kind: TrackKind;
  /** arrangement start in beats */
  start: number;
  /** length in beats */
  length: number;
  color: string;
  notes: Note[];
  /** audio clips only */
  assetId?: string;
  offset: number;
  gain: number;
  /** audio clips only: time-stretch to the clip length and/or shift pitch */
  warp?: ClipWarp;
  /** audio clips only: play the source backwards, still non-destructive */
  reverse?: boolean;
  /** fade-in length in seconds; 0 disables it, undefined uses the auto declick */
  fadeIn?: number;
  /** fade-out length in seconds; 0 disables it, undefined uses the auto declick */
  fadeOut?: number;
}

/**
 * An aux return: a real mixer channel fed by the track sends. It has its own
 * fader, pan, mute/solo and effect chain, and it sums into the master bus.
 */
export interface ReturnState {
  id: string;
  name: string;
  /** mixer label, A–D */
  label: string;
  color: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** stays audible when another channel is soloed, like a real FX return */
  soloSafe: boolean;
  devices: DeviceState[];
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  color: string;
  /** 0..1.5 linear fader */
  volume: number;
  /** input trim in dB, -24..24 */
  gain: number;
  /** channel EQ */
  eq: { hp: number; low: number; mid: number; midFreq: number; high: number };
  /** false = EQ out (channel is flat) */
  eqOn: boolean;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  armed: boolean;
  /** aux sends A–D (reverb, delay, chorus, room), 0..1 */
  sends: [number, number, number, number];
  /** true = pre-fader send for A–D */
  preSends: [boolean, boolean, boolean, boolean];
  instrument: InstrumentState | null;
  devices: DeviceState[];
  /** MIDI effects in front of the instrument; absent means none */
  midiFx?: MidiFxState[];
}

/** One recorded pass. Lives beside the arrangement and is used for comping. */
export interface Take {
  id: string;
  trackId: string;
  assetId: string;
  name: string;
  /** arrangement start in beats */
  start: number;
  /** recorded length in beats */
  length: number;
  /** seconds into the asset where the take begins */
  offset: number;
  gain: number;
  /** 1-based number within the track, used for the label and ordering */
  pass: number;
  createdAt: number;
}

export interface Marker {
  id: string;
  name: string;
  /** arrangement position in beats */
  beat: number;
  color: string;
}

export interface Project {
  name: string;
  bpm: number;
  beatsPerBar: number;
  tracks: Track[];
  clips: Clip[];
  /** recorded passes kept for comping; comps themselves are ordinary clips */
  takes: Take[];
  /** named arrangement locators, sorted by position */
  markers: Marker[];
  master: { volume: number; devices: DeviceState[] };
  returns: ReturnState[];
  loop: { enabled: boolean; start: number; end: number };
  /**
   * Punch in/out. The loop braces double as the punch points, the way Ableton
   * does it: `in` stops capture before the loop start, `out` stops it after the
   * loop end, and either can be used without the other.
   */
  punch?: { in: boolean; out: boolean };
  /** arrangement length in beats */
  length: number;
}
