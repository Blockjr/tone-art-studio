import type { MidiFxState, MidiFxType, Note } from './types';
import { uid } from './time';

/**
 * MIDI effects: they transform notes *before* the instrument, the way Ableton's
 * MIDI effect devices sit in front of a synth's device chain.
 *
 * Everything here is pure: notes go in, notes come out, no audio graph and no
 * DOM. That keeps the behaviour testable (tests/midifx.test.ts) and means the
 * same transform runs for live keyboard input and for clip playback.
 *
 * Parameter ranges and behaviour follow Ableton Live 12's MIDI effect
 * reference where it documents them (Chord shifts are ±36 semitones, Velocity
 * output is 1..127 with Clip/Gate/Fixed modes, Pitch has Block/Fold/Limit).
 */

export interface MidiFxParam {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  step: number;
  /** suffix drawn next to the value, e.g. " st" or " %" */
  unit?: string;
  /** labelled positions for a parameter that behaves like a chooser */
  choices?: string[];
}

export interface MidiFxSpec {
  type: MidiFxType;
  name: string;
  blurb: string;
  params: MidiFxParam[];
}

/** The scales the Scale device can remap into, as semitone offsets. */
export const SCALES: { name: string; steps: number[] }[] = [
  { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Harmonic Minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'Melodic Minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  { name: 'Major Pentatonic', steps: [0, 2, 4, 7, 9] },
  { name: 'Minor Pentatonic', steps: [0, 3, 5, 7, 10] },
  { name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  { name: 'Whole Tone', steps: [0, 2, 4, 6, 8, 10] },
];

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const ARP_STYLES = ['Up', 'Down', 'Up Down', 'Down Up', 'Play Order', 'Random'];

export const MIDI_FX_SPECS: MidiFxSpec[] = [
  {
    type: 'chord',
    name: 'Chord',
    blurb: 'Adds up to six pitches to every note you play.',
    params: [
      { key: 'shift1', label: 'Shift 1', min: -36, max: 36, default: 0, step: 1, unit: ' st' },
      { key: 'shift2', label: 'Shift 2', min: -36, max: 36, default: 0, step: 1, unit: ' st' },
      { key: 'shift3', label: 'Shift 3', min: -36, max: 36, default: 0, step: 1, unit: ' st' },
      { key: 'shift4', label: 'Shift 4', min: -36, max: 36, default: 0, step: 1, unit: ' st' },
      { key: 'shift5', label: 'Shift 5', min: -36, max: 36, default: 0, step: 1, unit: ' st' },
      { key: 'shift6', label: 'Shift 6', min: -36, max: 36, default: 0, step: 1, unit: ' st' },
      { key: 'velocity', label: 'Velocity', min: 1, max: 200, default: 100, step: 1, unit: '%' },
      { key: 'chance', label: 'Chance', min: 0, max: 100, default: 100, step: 1, unit: '%' },
      { key: 'strum', label: 'Strum', min: 0, max: 400, default: 0, step: 1, unit: ' ms' },
    ],
  },
  {
    type: 'scale',
    name: 'Scale',
    blurb: 'Remaps notes into a scale, so wrong notes come out right.',
    params: [
      { key: 'base', label: 'Base', min: 0, max: 11, default: 0, step: 1, choices: NOTE_NAMES },
      {
        key: 'scale',
        label: 'Scale',
        min: 0,
        max: SCALES.length - 1,
        default: 0,
        step: 1,
        choices: SCALES.map((scale) => scale.name),
      },
      { key: 'transpose', label: 'Transpose', min: -36, max: 36, default: 0, step: 1, unit: ' st' },
      { key: 'fold', label: 'Fold', min: 0, max: 1, default: 1, step: 1, choices: ['Off', 'On'] },
      { key: 'lowest', label: 'Lowest', min: 0, max: 127, default: 0, step: 1 },
      { key: 'range', label: 'Range', min: 1, max: 128, default: 128, step: 1 },
    ],
  },
  {
    type: 'arp',
    name: 'Arpeggiator',
    blurb: 'Turns a held chord into a repeating pattern.',
    params: [
      { key: 'style', label: 'Style', min: 0, max: ARP_STYLES.length - 1, default: 0, step: 1, choices: ARP_STYLES },
      { key: 'rate', label: 'Rate', min: 0.125, max: 4, default: 0.25, step: 0.125, unit: ' beats' },
      { key: 'gate', label: 'Gate', min: 5, max: 200, default: 75, step: 1, unit: '%' },
      { key: 'octaves', label: 'Octaves', min: 1, max: 4, default: 1, step: 1 },
      { key: 'repeats', label: 'Repeats', min: 0, max: 32, default: 0, step: 1 },
      { key: 'groove', label: 'Groove', min: 0, max: 100, default: 0, step: 1, unit: '%' },
    ],
  },
  {
    type: 'velocity',
    name: 'Velocity',
    blurb: 'Shapes how hard the notes hit, without touching their pitch.',
    params: [
      { key: 'lowest', label: 'Lowest', min: 1, max: 127, default: 1, step: 1 },
      { key: 'range', label: 'Range', min: 1, max: 127, default: 127, step: 1 },
      { key: 'outLow', label: 'Out Low', min: 1, max: 127, default: 1, step: 1 },
      { key: 'outHi', label: 'Out Hi', min: 1, max: 127, default: 127, step: 1 },
      {
        key: 'mode',
        label: 'Mode',
        min: 0,
        max: 2,
        default: 0,
        step: 1,
        choices: ['Clip', 'Gate', 'Fixed'],
      },
      { key: 'random', label: 'Random', min: 0, max: 127, default: 0, step: 1 },
      { key: 'drive', label: 'Drive', min: -100, max: 100, default: 0, step: 1, unit: '%' },
    ],
  },
  {
    type: 'pitch',
    name: 'Pitch',
    blurb: 'Transposes and keeps notes inside a range.',
    params: [
      { key: 'semitones', label: 'Pitch', min: -128, max: 128, default: 0, step: 1, unit: ' st' },
      { key: 'mode', label: 'Mode', min: 0, max: 2, default: 0, step: 1, choices: ['Block', 'Fold', 'Limit'] },
      { key: 'lowest', label: 'Lowest', min: 0, max: 127, default: 0, step: 1 },
      { key: 'range', label: 'Range', min: 1, max: 128, default: 128, step: 1 },
    ],
  },
  {
    type: 'notelength',
    name: 'Note Length',
    blurb: 'Makes every note longer or shorter.',
    params: [
      { key: 'length', label: 'Length', min: 0.05, max: 8, default: 1, step: 0.05, unit: '×' },
      { key: 'gate', label: 'Gate', min: 5, max: 200, default: 100, step: 1, unit: '%' },
    ],
  },
];

export function midiFxSpec(type: MidiFxType): MidiFxSpec {
  const spec = MIDI_FX_SPECS.find((entry) => entry.type === type);
  if (!spec) throw new Error(`unknown MIDI effect: ${type}`);
  return spec;
}

export function defaultMidiFxParams(type: MidiFxType): Record<string, number> {
  const params: Record<string, number> = {};
  for (const param of midiFxSpec(type).params) params[param.key] = param.default;
  return params;
}

export function createMidiFx(type: MidiFxType): MidiFxState {
  return {
    id: uid('mfx'),
    type,
    enabled: true,
    params: defaultMidiFxParams(type),
  };
}

/** Reads a parameter, falling back to its default when the state predates it. */
function param(state: MidiFxState, key: string): number {
  const value = state.params[key];
  if (Number.isFinite(value)) return value;
  return midiFxSpec(state.type).params.find((entry) => entry.key === key)?.default ?? 0;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const clampPitch = (pitch: number): number => clamp(Math.round(pitch), 0, 127);

/** A note in flight, without the identity a stored note carries. */
export interface MidiNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

export interface MidiFxOptions {
  /** needed so strum, gate and arpeggiator times line up with the tempo */
  secondsPerBeat: number;
}

// ------------------------------------------------------------------- devices

/** Chord: the original note plus up to six shifts. */
function chord(notes: MidiNote[], state: MidiFxState, options: MidiFxOptions): MidiNote[] {
  const shifts: number[] = [];
  for (let index = 1; index <= 6; index++) {
    const shift = Math.round(param(state, `shift${index}`));
    // Ableton disables a shift that duplicates another; a zero shift means off.
    if (shift !== 0 && !shifts.includes(shift)) shifts.push(shift);
  }

  const velocityScale = param(state, 'velocity') / 100;
  const chance = param(state, 'chance');
  const strum = (param(state, 'strum') / 1000) / Math.max(0.001, options.secondsPerBeat);
  const out: MidiNote[] = [];

  for (const note of notes) {
    // Shift 0 is the input note itself and always plays.
    const pitches = [note.pitch, ...shifts.map((shift) => clampPitch(note.pitch + shift))];

    pitches.forEach((pitch, index) => {
      // The root is never subject to Chance; the generated notes are.
      if (index > 0 && chance < 100 && Math.random() * 100 >= chance) return;

      out.push({
        pitch,
        start: note.start + index * strum,
        duration: note.duration,
        velocity: clamp(note.velocity * velocityScale, 0.01, 1),
      });
    });
  }

  return out;
}

/** Snaps a pitch into the chosen scale, in the scale's octave. */
export function scalePitch(pitch: number, base: number, steps: number[], fold: boolean): number {
  const relative = pitch - base;
  const octave = Math.floor(relative / 12);
  const within = ((relative % 12) + 12) % 12;

  // Distance to every scale degree, in semitones, in this octave. A tie goes
  // to the higher degree, so C# in C major becomes D rather than C: an
  // out-of-scale note moves up onto the next degree, never backwards.
  let best = steps[0];
  let bestDistance = Infinity;
  for (const step of steps) {
    const distance = Math.abs(step - within);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = step;
    }
  }

  // A note exactly on a degree stays where it is.
  const snapped = base + octave * 12 + best;

  if (!fold) return snapped;

  // Fold keeps the correction inside six semitones of the original.
  let result = snapped;
  while (result - pitch > 6) result -= 12;
  while (pitch - result > 6) result += 12;
  return result;
}

function scale(notes: MidiNote[], state: MidiFxState): MidiNote[] {
  const base = Math.round(param(state, 'base')) % 12;
  const steps = SCALES[clamp(Math.round(param(state, 'scale')), 0, SCALES.length - 1)].steps;
  const transpose = Math.round(param(state, 'transpose'));
  const fold = param(state, 'fold') >= 1;
  const lowest = Math.round(param(state, 'lowest'));
  const range = Math.round(param(state, 'range'));

  const out: MidiNote[] = [];
  for (const note of notes) {
    const shifted = note.pitch - base;
    // Notes above the range are transformed, then put back in octaves that fit.
    let pitch = scalePitch(shifted, 0, steps, fold) + base + transpose;
    while (pitch < lowest) pitch += 12;
    while (pitch >= lowest + range) pitch -= 12;
    if (pitch < lowest || pitch >= lowest + range) continue;
    out.push({ ...note, pitch: clampPitch(pitch) });
  }
  return out;
}

/** Arpeggiator: spreads a chord into a pattern over the length of the notes. */
function arp(notes: MidiNote[], state: MidiFxState): MidiNote[] {
  if (notes.length === 0) return [];

  const style = clamp(Math.round(param(state, 'style')), 0, ARP_STYLES.length - 1);
  const rate = Math.max(0.0625, param(state, 'rate'));
  const gate = param(state, 'gate') / 100;
  const octaves = Math.max(1, Math.min(4, Math.round(param(state, 'octaves'))));
  const repeats = Math.max(0, Math.round(param(state, 'repeats')));
  const groove = param(state, 'groove') / 100;

  // The pattern runs from the earliest start to the end of the longest note.
  const start = Math.min(...notes.map((note) => note.start));
  const end = Math.max(...notes.map((note) => note.start + note.duration));
  const span = Math.max(rate, end - start);

  const unique: { pitch: number; velocity: number }[] = [];
  for (const note of [...notes].sort((a, b) => a.pitch - b.pitch)) {
    if (unique.some((entry) => entry.pitch === note.pitch)) continue;
    unique.push({ pitch: note.pitch, velocity: note.velocity });
  }

  const order: { pitch: number; velocity: number }[] = [];
  for (let octave = 0; octave < octaves; octave++) {
    for (const entry of unique) order.push({ pitch: entry.pitch + octave * 12, velocity: entry.velocity });
  }

  let sequence: { pitch: number; velocity: number }[];
  switch (style) {
    case 1:
      sequence = [...order].reverse();
      break;
    case 2:
      sequence = [...order, ...[...order].reverse().slice(1, -1)];
      break;
    case 3:
      sequence = [...[...order].reverse(), ...[...order].slice(1, -1)];
      break;
    case 5:
      sequence = [...order].sort(() => Math.random() - 0.5);
      break;
    default:
      sequence = order;
  }
  if (sequence.length === 0) return [];

  const totalSteps = repeats > 0 ? repeats : Math.ceil(span / rate);
  const out: MidiNote[] = [];

  for (let step = 0; step < totalSteps; step++) {
    const entry = sequence[step % sequence.length];
    const position = start + step * rate;
    if (position >= end + rate - 1e-9) break;

    // Groove delays every second step, the way a swung 16th feels.
    const swing = step % 2 === 1 ? rate * 0.5 * groove : 0;
    const duration = Math.min(rate * gate, end - position);
    if (duration <= 0.001) continue;

    out.push({
      pitch: clampPitch(entry.pitch),
      start: position + swing,
      duration,
      velocity: entry.velocity,
    });
  }

  return out;
}

/** Velocity: remaps the note's velocity into an output range. */
function velocity(notes: MidiNote[], state: MidiFxState): MidiNote[] {
  const lowest = Math.round(param(state, 'lowest'));
  const range = Math.max(1, Math.round(param(state, 'range')));
  const outLow = Math.round(param(state, 'outLow'));
  const outHi = Math.round(param(state, 'outHi'));
  const mode = Math.round(param(state, 'mode'));
  const random = Math.round(param(state, 'random'));
  const drive = param(state, 'drive') / 100;

  const out: MidiNote[] = [];
  for (const note of notes) {
    const input = clamp(Math.round(note.velocity * 127), 1, 127);

    // Outside the input window: Clip clamps it in, Gate drops the note.
    if (input < lowest || input >= lowest + range) {
      if (mode === 1) continue;
    }

    const position = clamp((input - lowest) / range, 0, 1);
    let value = outLow + position * (outHi - outLow);

    // Drive pushes the result toward whichever end it is already nearer.
    if (drive > 0) value += (drive * (value >= (outLow + outHi) / 2 ? outHi - value : outLow - value));
    else if (drive < 0) value += (-drive * ((outLow + outHi) / 2 - value));

    if (random > 0) value += (Math.random() * 2 - 1) * random;

    const fixed = mode === 2;
    const finalValue = fixed ? outHi : value;
    out.push({ ...note, velocity: clamp(finalValue, 1, 127) / 127 });
  }
  return out;
}

/** Pitch: transposes, then decides what to do with notes that leave the range. */
function pitch(notes: MidiNote[], state: MidiFxState): MidiNote[] {
  const semitones = Math.round(param(state, 'semitones'));
  const mode = Math.round(param(state, 'mode'));
  const lowest = Math.round(param(state, 'lowest'));
  const range = Math.max(1, Math.round(param(state, 'range')));
  const highest = lowest + range - 1;

  const out: MidiNote[] = [];
  for (const note of notes) {
    let value = note.pitch + semitones;

    if (value < lowest || value > highest) {
      // Block drops the note, Fold moves it back in octaves, Limit clamps it.
      if (mode === 0) continue;
      if (mode === 1) {
        while (value < lowest) value += 12;
        while (value > highest) value -= 12;
        if (value < lowest || value > highest) continue;
      } else {
        value = clamp(value, lowest, highest);
      }
    }

    out.push({ ...note, pitch: clampPitch(value) });
  }
  return out;
}

/** Note Length: multiplies note length, with a gate for finer control. */
function notelength(notes: MidiNote[], state: MidiFxState): MidiNote[] {
  const length = Math.max(0.05, param(state, 'length'));
  const gate = param(state, 'gate') / 100;
  return notes.map((note) => ({
    ...note,
    duration: Math.max(0.01, note.duration * length * gate),
  }));
}

/**
 * Runs one device. This is the single entry point every caller uses, so a new
 * device only has to be added to the switch and the spec list.
 */
export function applyMidiFxDevice(
  state: MidiFxState,
  notes: readonly MidiNote[],
  options: MidiFxOptions = { secondsPerBeat: 0.5 },
): MidiNote[] {
  if (!state.enabled || notes.length === 0) return [...notes];

  switch (state.type) {
    case 'chord':
      return chord([...notes], state, options);
    case 'scale':
      return scale([...notes], state);
    case 'arp':
      return arp([...notes], state);
    case 'velocity':
      return velocity([...notes], state);
    case 'pitch':
      return pitch([...notes], state);
    case 'notelength':
      return notelength([...notes], state);
    default:
      return [...notes];
  }
}

/** Runs a whole chain, left to right, the way a device chain is ordered. */
export function applyMidiFx(
  chain: readonly MidiFxState[] | undefined,
  notes: readonly MidiNote[],
  options: MidiFxOptions = { secondsPerBeat: 0.5 },
): MidiNote[] {
  if (!chain || chain.length === 0) return [...notes];

  let current = [...notes];
  for (const device of chain) {
    current = applyMidiFxDevice(device, current, options);
    if (current.length === 0) break;
  }
  return current;
}

/** Applies a chain to stored notes and returns real notes with fresh ids. */
export function transformNotes(
  chain: readonly MidiFxState[] | undefined,
  notes: readonly Note[],
  options: MidiFxOptions = { secondsPerBeat: 0.5 },
): Note[] {
  const played = applyMidiFx(
    chain,
    notes.map((note) => ({
      pitch: note.pitch,
      start: note.start,
      duration: note.duration,
      velocity: note.velocity,
    })),
    options,
  );

  return played.map((note) => ({
    id: uid('n'),
    pitch: clampPitch(note.pitch),
    start: Math.max(0, note.start),
    duration: Math.max(0.01, note.duration),
    velocity: clamp(note.velocity, 0.01, 1),
  }));
}

/** Human-readable summary for a device's title bar. */
export function describeMidiFx(state: MidiFxState): string {
  const spec = midiFxSpec(state.type);
  switch (state.type) {
    case 'chord': {
      const shifts = spec.params
        .filter((entry) => entry.key.startsWith('shift'))
        .map((entry) => Math.round(param(state, entry.key)))
        .filter((shift) => shift !== 0);
      return shifts.length === 0 ? 'no shifts' : shifts.map((shift) => `${shift > 0 ? '+' : ''}${shift}`).join(' ');
    }
    case 'scale':
      return `${NOTE_NAMES[Math.round(param(state, 'base')) % 12]} ${SCALES[Math.round(param(state, 'scale'))].name}`;
    case 'arp':
      return `${ARP_STYLES[Math.round(param(state, 'style'))]} · ${param(state, 'rate')} beats`;
    case 'velocity':
      return `${Math.round(param(state, 'outLow'))}–${Math.round(param(state, 'outHi'))}`;
    case 'pitch': {
      const semitones = Math.round(param(state, 'semitones'));
      return `${semitones > 0 ? '+' : ''}${semitones} st`;
    }
    case 'notelength':
      return `${param(state, 'length')}×`;
    default:
      return '';
  }
}
