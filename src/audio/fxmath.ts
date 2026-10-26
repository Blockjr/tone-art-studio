/**
 * The numbers behind the echo and reverb devices.
 *
 * Kept apart from the Web Audio wiring so the delay times, decay gains and
 * mode constants can be tested, plotted and reasoned about without an audio
 * context. The shapes here follow the classic hardware: tape heads and BBD
 * stages for the delay, an allpass-diffused feedback delay network for the
 * reverb.
 */

export type DelayModeId = 'tape' | 'bbd' | 'digital' | 'pingpong';

export interface DelayMode {
  id: DelayModeId;
  name: string;
  /** longest delay this technology can produce, in seconds */
  maxTime: number;
  /** feedback bandwidth ceiling: tape loses top on every pass, BBD more */
  toneCap: number;
  /** slow speed wander (wow) and fast grain (flutter), in Hz */
  wowRate: number;
  flutterRate: number;
  /** modulation depth at amount 1, in seconds */
  wowDepth: number;
  flutterDepth: number;
  /** how hard the feedback path saturates */
  driveScale: number;
  /** right-channel time offset as a fraction of the delay time */
  spread: number;
  /** headroom lost to the storage medium, as a linear trim */
  trim: number;
}

export const DELAY_MODES: DelayMode[] = [
  {
    id: 'tape',
    name: 'Tape',
    maxTime: 1.2,
    toneCap: 8000,
    wowRate: 0.7,
    flutterRate: 7.3,
    wowDepth: 0.0011,
    flutterDepth: 0.00016,
    driveScale: 0.7,
    spread: 0.012,
    trim: 0.9,
  },
  {
    id: 'bbd',
    name: 'BBD',
    maxTime: 0.75,
    toneCap: 3800,
    wowRate: 1.6,
    flutterRate: 11,
    wowDepth: 0.0007,
    flutterDepth: 0.00008,
    driveScale: 0.45,
    spread: 0.006,
    trim: 0.82,
  },
  {
    id: 'digital',
    name: 'Digital',
    maxTime: 2,
    toneCap: 20000,
    wowRate: 0.13,
    flutterRate: 3.1,
    wowDepth: 0.00018,
    flutterDepth: 0.00004,
    driveScale: 0.18,
    spread: 0,
    trim: 1,
  },
  {
    id: 'pingpong',
    name: 'Ping-Pong',
    maxTime: 2,
    toneCap: 16000,
    wowRate: 0.11,
    flutterRate: 2.7,
    wowDepth: 0.00012,
    flutterDepth: 0.00003,
    driveScale: 0.12,
    spread: 0,
    trim: 1,
  },
];

export function delayMode(index: number): DelayMode {
  return DELAY_MODES[Math.min(DELAY_MODES.length - 1, Math.max(0, Math.round(index ?? 0)))];
}

export interface NoteDivision {
  id: string;
  label: string;
  /** length in beats */
  beats: number;
}

/** Straight, dotted and triplet divisions, ordered shortest first. */
export const NOTE_DIVISIONS: NoteDivision[] = [
  { id: '1/16', label: '1/16', beats: 0.25 },
  { id: '1/8T', label: '1/8T', beats: 1 / 3 },
  { id: '1/8', label: '1/8', beats: 0.5 },
  { id: '1/8D', label: '1/8.', beats: 0.75 },
  { id: '1/4', label: '1/4', beats: 1 },
];

export function noteDivision(index: number): NoteDivision {
  return NOTE_DIVISIONS[Math.min(NOTE_DIVISIONS.length - 1, Math.max(0, Math.round(index ?? 2)))];
}

/** Seconds for one division at a tempo, clamped to a sane 20 ms – 2 s. */
export function syncedTime(division: number, bpm: number): number {
  const beat = 60 / Math.max(20, Math.min(300, bpm || 120));
  const seconds = noteDivision(division).beats * beat;
  return Math.max(0.02, Math.min(2, seconds));
}

/**
 * The delay time the engine should use. In sync mode the note division wins;
 * otherwise the millisecond knob does, bounded by what the mode can store.
 */
export function delayTimeSeconds(
  time: number,
  sync: boolean,
  division: number,
  bpm: number,
  mode: DelayMode,
): number {
  const wanted = sync ? syncedTime(division, bpm) : time;
  return Math.max(0.02, Math.min(mode.maxTime, wanted));
}

/**
 * Sidechain ducking for the echo. The dry input feeds a rectifier and a
 * smoothing low-pass, and the resulting envelope is subtracted from the wet
 * gain at audio rate — so the repeats step back while the voice is singing
 * instead of fighting it. These helpers keep the depth and release mapping
 * testable outside the graph.
 */
export function duckDepth(amount: number): number {
  return Math.max(0, Math.min(1, amount)) * 0.85;
}

/** Wet gain for a fully-open detector at a given duck amount, 1 down to 0.15. */
export function duckGain(envelope: number, amount: number): number {
  const env = Math.max(0, Math.min(1, envelope));
  return 1 - duckDepth(amount) * env;
}

/** Release time in seconds mapped to the envelope low-pass corner, 0.3–30 Hz. */
export function duckReleaseCutoff(seconds: number): number {
  const release = Math.max(0.05, Math.min(0.8, seconds));
  return Math.max(0.3, Math.min(30, 1 / (2 * Math.PI * release)));
}

/**
 * Loop feedback while frozen. Just under unity, so the store decays over
 * minutes instead of growing: a hold that never clips or blows up. Normal
 * feedback is clamped to the device's stable range.
 */
export function freezeFeedback(frozen: boolean, feedback: number): number {
  if (frozen) return 0.9998;
  return Math.max(0, Math.min(0.985, feedback));
}

/**
 * Feedback gain for a given delay length and RT60, from g = 10^(-3D/(fs*T60)).
 * This is what makes "decay in seconds" mean the same thing at every size.
 */
export function rt60Gain(delaySeconds: number, decaySeconds: number): number {
  if (delaySeconds <= 0 || decaySeconds <= 0) return 0;
  const gain = Math.pow(10, (-3 * delaySeconds) / decaySeconds);
  return Math.max(0, Math.min(0.999, gain));
}

/** Damping amount 0..1 mapped to a loop low-pass corner, 18 kHz down to 900 Hz. */
export function dampingCutoff(amount: number): number {
  const clamped = Math.max(0, Math.min(1, amount));
  return 18000 * Math.pow(0.05, clamped);
}

/** High-frequency decay slope used by the reverb tail display, 0..1. */
export function dampingSlope(amount: number): number {
  return 1.2 + Math.max(0, Math.min(1, amount)) * 4.8;
}

export type ReverbModeId = 'plate' | 'hall' | 'room';

export interface ReverbMode {
  id: ReverbModeId;
  name: string;
  /** scales the delay lengths, so the same decay sounds bigger or tighter */
  delayScale: number;
  /** allpass diffusion coefficient before the tank */
  diffusion: number;
  /** early-reflection level relative to the user's Early knob */
  early: number;
  /** modulation depth multiplier */
  mod: number;
  /** delay-line spread around the base lengths, as a ratio */
  spread: number;
}

export const REVERB_MODES: ReverbMode[] = [
  {
    id: 'plate',
    name: 'Plate',
    delayScale: 0.55,
    diffusion: 0.76,
    early: 0.12,
    mod: 1.6,
    spread: 0.07,
  },
  {
    id: 'hall',
    name: 'Hall',
    delayScale: 1,
    diffusion: 0.64,
    early: 0.85,
    mod: 0.85,
    spread: 0.13,
  },
  {
    id: 'room',
    name: 'Room',
    delayScale: 0.42,
    diffusion: 0.56,
    early: 1,
    mod: 0.55,
    spread: 0.1,
  },
];

export function reverbMode(index: number): ReverbMode {
  return REVERB_MODES[Math.min(REVERB_MODES.length - 1, Math.max(0, Math.round(index ?? 0)))];
}

/**
 * Eight mutually incommensurate loop lengths for the feedback delay network.
 * Scaled by space and the mode at runtime; the ratios stay fixed so the tail
 * keeps its character when the space grows.
 */
export const FDN_DELAYS_MS = [31.7, 37.3, 41.9, 47.3, 53.1, 59.3, 67.1, 73.7];

/** Four allpass lengths for input diffusion, in milliseconds. */
export const DIFFUSER_MS = [4.77, 3.61, 12.73, 9.31];

/** Early reflection taps, in milliseconds and relative level. */
export const EARLY_TAPS: { time: number; gain: number; pan: number }[] = [
  { time: 7.3, gain: 0.72, pan: -0.65 },
  { time: 11.9, gain: 0.58, pan: 0.52 },
  { time: 16.1, gain: 0.5, pan: 0.78 },
  { time: 21.7, gain: 0.42, pan: -0.82 },
  { time: 27.3, gain: 0.36, pan: 0.31 },
  { time: 34.9, gain: 0.3, pan: -0.4 },
  { time: 44.3, gain: 0.24, pan: 0.66 },
  { time: 57.1, gain: 0.18, pan: -0.2 },
];

/** Formats a delay time for the module display: 342 ms, or 1.25 s. */
export function formatDelayTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  return `${seconds.toFixed(2)} s`;
}

/* ------------------------------------------------------------------ drive */

export type DriveModeId = 'warm' | 'tube' | 'fuzz' | 'fold';

export interface DriveMode {
  id: DriveModeId;
  name: string;
  /** the shape this circuit applies, before any drive amount */
  shape: (x: number, k: number) => number;
  /** extra input gain per unit of drive, on top of the shared scale */
  input: number;
  /** output trim at full drive, so the mode stays roughly level-matched */
  trim: number;
  /** how asymmetric the curve is: even harmonics live here */
  bias: number;
  /** short description for the faceplate legend */
  character: string;
}

/** Symmetric soft clip, the cleanest of the four. */
const warmShape = (x: number, k: number): number => Math.tanh(x * k);
/** Asymmetric tube stage: the negative half compresses harder than the positive. */
const tubeShape = (x: number, k: number): number => {
  const biased = x + 0.18;
  return Math.tanh(biased * k) - Math.tanh(0.18 * k);
};
/** Fuzz: a hard clip rounded at the edges, with almost no clean headroom. */
const fuzzShape = (x: number, k: number): number => Math.sign(x) * Math.min(1, 1 - Math.exp(-Math.abs(x) * k * 1.6));
/** Wavefolder: the signal reflects back instead of clipping flat. */
const foldShape = (x: number, k: number): number => Math.sin(x * k * 1.35);

export const DRIVE_MODES: DriveMode[] = [
  { id: 'warm', name: 'Warm', shape: warmShape, input: 10, trim: 0.86, bias: 0, character: 'symmetric · odd harmonics' },
  { id: 'tube', name: 'Tube', shape: tubeShape, input: 13, trim: 0.8, bias: 0.18, character: 'asymmetric · even harmonics' },
  { id: 'fuzz', name: 'Fuzz', shape: fuzzShape, input: 26, trim: 0.58, bias: 0, character: 'hard knee · square-ish' },
  { id: 'fold', name: 'Fold', shape: foldShape, input: 9, trim: 0.7, bias: 0, character: 'reflected · metallic' },
];

export function driveMode(index: number): DriveMode {
  return DRIVE_MODES[Math.min(DRIVE_MODES.length - 1, Math.max(0, Math.round(index ?? 0)))];
}

/**
 * The transfer function the drive device writes into its WaveShaper.
 * `amount` is the 0..1 Drive knob, `bias` shifts the operating point for extra
 * even harmonics. The result is normalised so full-scale in stays at full-scale
 * out, and crossfaded against a straight line so zero drive really is clean.
 * The mode's trim keeps the perceived level steady as drive rises.
 */
export function driveShape(x: number, amount: number, modeIndex: number, bias = 0): number {
  const mode = driveMode(modeIndex);
  const drive = Math.max(0, Math.min(1, amount));
  const k = 1 + drive * mode.input;
  const shift = Math.max(-0.5, Math.min(0.5, bias + mode.bias * drive));
  const shaped = mode.shape(Math.max(-1.6, Math.min(1.6, x + shift)), k);
  const edge = mode.shape(Math.min(1.6, 1 + shift), k);
  const normal = Math.abs(edge) < 1e-6 ? 1 : edge;
  const bent = shaped / normal;
  const level = (1 - drive) * x + drive * bent;
  return Math.max(-1, Math.min(1, level));
}

/** Sampled transfer curve for displays and tests. */
export function driveCurvePoints(
  amount: number,
  modeIndex: number,
  bias = 0,
  count = 121,
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < count; index++) {
    const x = (index / (count - 1)) * 2 - 1;
    points.push({ x, y: driveShape(x, amount, modeIndex, bias) });
  }
  return points;
}

/** Makes up the level the clipper takes away, so Drive does not double as a fader. */
export function driveMakeup(amount: number, modeIndex: number): number {
  const mode = driveMode(modeIndex);
  return 1 / (1 + Math.max(0, Math.min(1, amount)) * (1 - mode.trim) * 1.4);
}

/* ----------------------------------------------------------------- filter */

export type FilterModeId = 'lowpass' | 'highpass' | 'bandpass' | 'notch';

export interface FilterMode {
  id: FilterModeId;
  name: string;
  label: string;
}

export const FILTER_MODES: FilterMode[] = [
  { id: 'lowpass', name: 'Low Pass', label: 'LP' },
  { id: 'highpass', name: 'High Pass', label: 'HP' },
  { id: 'bandpass', name: 'Band Pass', label: 'BP' },
  { id: 'notch', name: 'Notch', label: 'Notch' },
];

export function filterMode(index: number): FilterMode {
  return FILTER_MODES[Math.min(FILTER_MODES.length - 1, Math.max(0, Math.round(index ?? 0)))];
}

/** LFO shape at a phase in turns (0..1). */
export function lfoShape(phase: number, waveform: 'sine' | 'triangle' = 'sine'): number {
  const turn = phase - Math.floor(phase);
  if (waveform === 'triangle') return 1 - 4 * Math.abs(turn - 0.5);
  return Math.sin(turn * Math.PI * 2);
}

/** Peak modulation in cents for the filter's detune input. */
export function filterModCents(depth: number): number {
  return Math.max(0, Math.min(1, depth)) * 2400;
}

/* ----------------------------------------------------------------- chorus */

export type ChorusModeId = 'chorus' | 'ensemble' | 'vibrato';

export interface ChorusMode {
  id: ChorusModeId;
  name: string;
  voices: number;
  /** base delay multiplier: ensembles run wider, vibrato shorter */
  delayScale: number;
  /** modulation rate multiplier per voice */
  rateScale: number;
  /** modulation depth multiplier */
  depthScale: number;
  /** wet level floor, so a vibrato mode still works at low mix */
  wetFloor: number;
  character: string;
}

export const CHORUS_MODES: ChorusMode[] = [
  { id: 'chorus', name: 'Chorus', voices: 2, delayScale: 1, rateScale: 1, depthScale: 1, wetFloor: 0, character: 'two detuned taps' },
  { id: 'ensemble', name: 'Ensemble', voices: 3, delayScale: 1.35, rateScale: 0.82, depthScale: 1.25, wetFloor: 0, character: 'three-phase strings' },
  { id: 'vibrato', name: 'Vibrato', voices: 1, delayScale: 0.7, rateScale: 1.1, depthScale: 1.5, wetFloor: 0.65, character: 'pitch-only modulation' },
];

export function chorusMode(index: number): ChorusMode {
  return CHORUS_MODES[Math.min(CHORUS_MODES.length - 1, Math.max(0, Math.round(index ?? 0)))];
}

/** Voice LFO phase offset in turns, evenly spread around the stereo field. */
export function chorusPhaseOffset(voice: number, voices: number): number {
  return voices <= 1 ? 0 : voice / voices;
}

/** Base delay for a voice, in seconds, with a small spread between voices. */
export function chorusVoiceDelay(voice: number, base: number, modeIndex: number): number {
  const mode = chorusMode(modeIndex);
  const spread = 1 + voice * 0.13;
  return Math.max(0.002, Math.min(0.06, base * mode.delayScale * spread));
}

/** Modulation depth in seconds for a voice. */
export function chorusDepth(depth: number, modeIndex: number): number {
  return Math.max(0, Math.min(1, depth)) * 0.0085 * chorusMode(modeIndex).depthScale;
}

/** Stereo position for a voice: a two-voice mode goes hard L/R, three fans out. */
export function chorusPan(voice: number, voices: number, spread: number): number {
  if (voices <= 1) return 0;
  const width = Math.max(0, Math.min(1, spread));
  const position = voices === 2 ? (voice === 0 ? -1 : 1) : (voice / (voices - 1)) * 2 - 1;
  return position * width;
}

/* ------------------------------------------------------------- dynamics */

/** Knee knob 0..1 to the dB width Web Audio expects. */
export function kneeWidth(amount: number): number {
  return Math.max(0, Math.min(1, amount)) * 24;
}

/** The knee is stored as a 0..1 amount in the specs; the display wants dB. */
export function kneeDb(amount: number, max = 24): number {
  return Math.max(0, Math.min(1, amount)) * max;
}

export type LimiterModeId = 'modern' | 'transparent';

export interface LimiterMode {
  id: LimiterModeId;
  name: string;
  attack: number;
  ratio: number;
  knee: number;
  character: string;
}

export const LIMITER_MODES: LimiterMode[] = [
  { id: 'modern', name: 'Modern', attack: 0.0006, ratio: 20, knee: 0, character: 'fast · loud' },
  { id: 'transparent', name: 'Transparent', attack: 0.004, ratio: 8, knee: 6, character: 'soft · musical' },
];

export function limiterMode(index: number): LimiterMode {
  return LIMITER_MODES[Math.min(LIMITER_MODES.length - 1, Math.max(0, Math.round(index ?? 0)))];
}

/**
 * Program-dependent release, approximated the way a two-stage detector does:
 * a slow release that shortens while the signal is still busy. Web Audio only
 * has one release control, so the amount is folded into it.
 */
export function programRelease(base: number, amount: number): number {
  const clamped = Math.max(0, Math.min(1, amount));
  return Math.max(0.02, Math.min(1.5, base * (1.25 - clamped * 0.45)));
}

/* ------------------------------------------------------------------ tape */

/** Wow depth in seconds at amount 1: slow capstan wander. */
export function tapeWowDepth(amount: number): number {
  return Math.max(0, Math.min(1, amount)) * 0.0026;
}

/** Flutter depth in seconds at amount 1: fast scrape flutter. */
export function tapeFlutterDepth(amount: number): number {
  return Math.max(0, Math.min(1, amount)) * 0.00042;
}

/** Tape bias: a little DC offset produces the third-harmonic lift. */
export function tapeBiasShape(x: number, bias: number): number {
  const shift = Math.max(0, Math.min(1, bias)) * 0.22;
  const shaped = Math.tanh((x + shift) * 1.7) - Math.tanh(shift * 1.7);
  const edge = Math.tanh((1 + shift) * 1.7) - Math.tanh(shift * 1.7);
  return edge === 0 ? 0 : shaped / edge;
}

/* ---------------------------------------------------------------- meters */

/** Analyser byte (0..255, centred on 128) to a linear peak for the meters. */
export function analyserPeak(data: Uint8Array): number {
  let peak = 0;
  for (let index = 0; index < data.length; index++) {
    const deviation = Math.abs(data[index] - 128) / 128;
    if (deviation > peak) peak = deviation;
  }
  return peak;
}

/** Linear peak to the dB scale a faceplate meter shows, floored at −60 dB. */
export function meterDb(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0.001) return -60;
  return Math.max(-60, Math.min(6, 20 * Math.log10(peak)));
}
