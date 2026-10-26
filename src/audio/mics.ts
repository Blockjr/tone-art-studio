import { clamp } from '../core/time';

/**
 * Microphone emulation.
 *
 * Each model is a measured-style coloration curve (high-pass, low shelf, low-mid
 * bell, presence bell, air shelf and top-end roll-off) plus the amount of
 * transformer/valve saturation the circuit adds. The same filter description is
 * used by the Web Audio device (`createDevice('micemu')`), by the offline render
 * and by the response plot, so the curve you see is the curve you hear.
 *
 * These are archetypes, not clones: a real measurement of a specific serial
 * number is not available here, so the names describe the design (capsule size,
 * magnet, circuit) rather than claiming to be an exact emulation.
 */

export type MicFamily = 'Condenser' | 'Dynamic' | 'Ribbon' | 'Stage' | 'Utility';

export interface MicFilter {
  type: 'highpass' | 'lowpass' | 'lowshelf' | 'highshelf' | 'peaking';
  freq: number;
  gain: number;
  q: number;
}

export interface MicModel {
  id: string;
  name: string;
  family: MicFamily;
  tagline: string;
  /** high-pass corner (proximity rumble / handling noise) */
  hp: number;
  low: { freq: number; gain: number };
  mud: { freq: number; gain: number; q: number };
  presence: { freq: number; gain: number; q: number };
  air: { freq: number; gain: number };
  /** top-end roll-off in Hz, 0 = open */
  top: number;
  /** saturation baked into the circuit, 0..1 */
  drive: number;
  /** where this mic usually shines */
  best: string;
}

export interface MicPreset {
  id: string;
  modelId: string;
  name: string;
  /** what the preset is for */
  use: string;
  params: {
    proximity: number;
    presence: number;
    air: number;
    drive: number;
    output: number;
  };
}

export const MIC_MODELS: MicModel[] = [
  {
    id: 'condenser',
    name: 'Studio Condenser',
    family: 'Condenser',
    tagline: 'Large diaphragm, open top, low noise floor',
    best: 'Lead vocals, voiceover',
    hp: 35,
    low: { freq: 160, gain: 1.4 },
    mud: { freq: 320, gain: -1.1, q: 0.8 },
    presence: { freq: 3200, gain: 2.6, q: 1.1 },
    air: { freq: 11000, gain: 2.2 },
    top: 0,
    drive: 0.1,
  },
  {
    id: 'broadcast',
    name: 'Broadcast Dynamic',
    family: 'Dynamic',
    tagline: 'Mid-forward, tight bottom, built for close speech',
    best: 'Podcast, broadcast, rap',
    hp: 70,
    low: { freq: 150, gain: 1 },
    mud: { freq: 350, gain: 1.8, q: 0.9 },
    presence: { freq: 2600, gain: 3.4, q: 1.2 },
    air: { freq: 9000, gain: -1.8 },
    top: 15000,
    drive: 0.26,
  },
  {
    id: 'ribbon',
    name: 'Vintage Ribbon',
    family: 'Ribbon',
    tagline: 'Dark, smooth top, fat proximity',
    best: 'Crooners, horns, guitar cabs',
    hp: 45,
    low: { freq: 130, gain: 2.6 },
    mud: { freq: 420, gain: 1.4, q: 0.7 },
    presence: { freq: 3000, gain: -2.4, q: 0.9 },
    air: { freq: 10000, gain: -4.5 },
    top: 9000,
    drive: 0.22,
  },
  {
    id: 'pencil',
    name: 'Pencil Condenser',
    family: 'Condenser',
    tagline: 'Small diaphragm, fast detail, honest low end',
    best: 'Acoustic, overheads, strings',
    hp: 60,
    low: { freq: 200, gain: -1 },
    mud: { freq: 450, gain: -1.6, q: 1 },
    presence: { freq: 4200, gain: 3, q: 1.3 },
    air: { freq: 12000, gain: 3.4 },
    top: 20000,
    drive: 0.08,
  },
  {
    id: 'handheld',
    name: 'Stage Handheld',
    family: 'Stage',
    tagline: 'Presence peak, rolled sub, high SPL',
    best: 'Live vocals, loud sources',
    hp: 100,
    low: { freq: 180, gain: 2.2 },
    mud: { freq: 500, gain: 2.4, q: 0.9 },
    presence: { freq: 3400, gain: 4.2, q: 1.1 },
    air: { freq: 10000, gain: -0.6 },
    top: 16000,
    drive: 0.32,
  },
  {
    id: 'consumer',
    name: 'Phone / USB Mic',
    family: 'Utility',
    tagline: 'Small capsule, thin bottom, limited top',
    best: 'Demos, calls, reference takes',
    hp: 120,
    low: { freq: 220, gain: -3 },
    mud: { freq: 600, gain: -2.4, q: 0.9 },
    presence: { freq: 2800, gain: 1, q: 1 },
    air: { freq: 9000, gain: -3 },
    top: 14000,
    drive: 0.18,
  },
  {
    id: 'custom',
    name: 'Flat / Custom',
    family: 'Utility',
    tagline: 'No coloration — start from your own mic',
    best: 'Any source, neutral reference',
    hp: 20,
    low: { freq: 160, gain: 0 },
    mud: { freq: 400, gain: 0, q: 0.8 },
    presence: { freq: 3200, gain: 0, q: 1.1 },
    air: { freq: 11000, gain: 0 },
    top: 0,
    drive: 0,
  },
];

const preset = (
  modelId: string,
  slug: string,
  name: string,
  use: string,
  params: MicPreset['params'],
): MicPreset => ({ id: `${modelId}-${slug}`, modelId, name, use, params });

export const MIC_PRESETS: MicPreset[] = [
  preset('condenser', 'close-voice', 'Close Voice', 'Intimate lead, 10 cm off the grille', {
    proximity: 0.45,
    presence: 1.5,
    air: 1,
    drive: 0.05,
    output: -1,
  }),
  preset('condenser', 'bright-air', 'Bright Air', 'Pop / EDM vocal with sparkle', {
    proximity: 0.2,
    presence: 2,
    air: 3.5,
    drive: 0,
    output: -2,
  }),
  preset('condenser', 'acoustic', 'Acoustic Natural', 'Guitar body, 20 cm back', {
    proximity: 0.3,
    presence: 0,
    air: 0.5,
    drive: 0,
    output: -1,
  }),

  preset('broadcast', 'tight', 'Broadcast Tight', 'Radio-ready speech, controlled low end', {
    proximity: 0.3,
    presence: 1.5,
    air: -1,
    drive: 0.15,
    output: -1,
  }),
  preset('broadcast', 'warm', 'Podcast Warm', 'Close, warm, easy on long listens', {
    proximity: 0.5,
    presence: -1,
    air: -1.5,
    drive: 0.1,
    output: 0,
  }),
  preset('broadcast', 'remote', 'Remote Guest', 'Thin source, lift clarity', {
    proximity: 0.15,
    presence: 1,
    air: -0.5,
    drive: 0.25,
    output: -2,
  }),

  preset('ribbon', 'croon', 'Vintage Croon', 'Big, dark, right up on the ribbon', {
    proximity: 0.55,
    presence: 0,
    air: 0,
    drive: 0.12,
    output: 0,
  }),
  preset('ribbon', 'dark-room', 'Dark Room', 'Room tone and bleed tamer', {
    proximity: 0.3,
    presence: -1,
    air: -2,
    drive: 0.05,
    output: 1,
  }),
  preset('ribbon', 'cab', 'Guitar Cab', 'Ribbon on a cone, mid push', {
    proximity: 0.25,
    presence: 2.5,
    air: -0.5,
    drive: 0.3,
    output: -2,
  }),

  preset('pencil', 'overheads', 'Drum Overheads', 'Cymbals without harshness', {
    proximity: 0.1,
    presence: 0,
    air: 1,
    drive: 0,
    output: -2,
  }),
  preset('pencil', 'acoustic-detail', 'Acoustic Detail', 'Fingerpicking, string noise', {
    proximity: 0.2,
    presence: 1,
    air: 2,
    drive: 0,
    output: -1,
  }),
  preset('pencil', 'strings', 'String Section', 'Distance and air, no boom', {
    proximity: 0.15,
    presence: 0.5,
    air: 1.5,
    drive: 0,
    output: -2,
  }),

  preset('handheld', 'stage', 'Stage Vocal', 'Monitors loud, held close', {
    proximity: 0.4,
    presence: 1,
    air: 0,
    drive: 0.2,
    output: -2,
  }),
  preset('handheld', 'shout', 'Live Shout', 'Loud source, tame the top', {
    proximity: 0.2,
    presence: -1.5,
    air: 0,
    drive: 0.4,
    output: -4,
  }),
  preset('handheld', 'spoken', 'Spoken Word', 'Speech at the podium', {
    proximity: 0.5,
    presence: 0,
    air: 0,
    drive: 0.1,
    output: -1,
  }),

  preset('consumer', 'call', 'Zoom Call', 'Make a laptop mic usable', {
    proximity: 0.2,
    presence: 1,
    air: 1,
    drive: 0.15,
    output: -1,
  }),
  preset('consumer', 'memo', 'Phone Memo', 'Keep the character, control the fizz', {
    proximity: 0.35,
    presence: 0,
    air: 0,
    drive: 0.3,
    output: 0,
  }),
  preset('consumer', 'cleanup', 'Clean Up', 'Thin source, add body and air', {
    proximity: -0.1,
    presence: 1.5,
    air: 1.5,
    drive: 0,
    output: -1,
  }),

  preset('custom', 'neutral', 'Neutral', 'No coloration, unity gain', {
    proximity: 0,
    presence: 0,
    air: 0,
    drive: 0,
    output: 0,
  }),
  preset('custom', 'voice-lift', 'Voice Lift', 'Gentle clarity on any mic', {
    proximity: 0.3,
    presence: 1,
    air: 1,
    drive: 0,
    output: -1,
  }),
  preset('custom', 'de-mud', 'De-Mud', 'Pull back the boxy low mids', {
    proximity: -0.3,
    presence: 1,
    air: 0,
    drive: 0,
    output: 0,
  }),
];

export const DEFAULT_MIC_PARAMS = {
  model: 0,
  proximity: 0,
  presence: 0,
  air: 0,
  drive: 0,
  output: 0,
};

export function micModelIndex(modelId: string): number {
  const index = MIC_MODELS.findIndex((model) => model.id === modelId);
  return index < 0 ? 0 : index;
}

export function micModelAt(index: number): MicModel {
  return MIC_MODELS[clamp(Math.round(index), 0, MIC_MODELS.length - 1)] ?? MIC_MODELS[0];
}

export function presetsForModel(modelId: string): MicPreset[] {
  return MIC_PRESETS.filter((entry) => entry.modelId === modelId);
}

export function micPresetById(id: string): MicPreset | undefined {
  return MIC_PRESETS.find((entry) => entry.id === id);
}

/** Full device params for a model + preset, ready to merge into a device state. */
export function micPresetParams(modelId: string, presetId?: string): Record<string, number> {
  const model = micModelIndex(modelId);
  const entry = presetId ? micPresetById(presetId) : presetsForModel(micModelAt(model).id)[0];
  return {
    ...DEFAULT_MIC_PARAMS,
    model,
    ...(entry ? entry.params : {}),
  };
}

/**
 * Builds the filter chain for a parameter set. Proximity adds low end and a
 * little low-mid, exactly like moving in on a real capsule; presence and air are
 * user trims on top of the model's own curve.
 */
export function micChain(params: Record<string, number>, sampleRate = 48000): MicFilter[] {
  const model = micModelAt(params.model ?? 0);
  const proximity = clamp(params.proximity ?? 0, -1, 1);
  const presence = clamp(params.presence ?? 0, -6, 6);
  const air = clamp(params.air ?? 0, -6, 6);

  const chain: MicFilter[] = [
    { type: 'highpass', freq: model.hp, gain: 0, q: 0.707 },
    {
      type: 'lowshelf',
      freq: model.low.freq,
      gain: model.low.gain + proximity * 5,
      q: 0.707,
    },
    {
      type: 'peaking',
      freq: model.mud.freq,
      gain: model.mud.gain + proximity * 1.5,
      q: model.mud.q,
    },
    {
      type: 'peaking',
      freq: model.presence.freq,
      gain: model.presence.gain + presence,
      q: model.presence.q,
    },
    { type: 'highshelf', freq: model.air.freq, gain: model.air.gain + air, q: 0.707 },
  ];

  if (model.top > 0) {
    chain.push({ type: 'lowpass', freq: Math.min(model.top, sampleRate / 2 - 200), gain: 0, q: 0.707 });
  }

  return chain;
}

interface Complex {
  re: number;
  im: number;
}

function biquadCoefficients(
  filter: MicFilter,
  sampleRate: number,
): { b0: number; b1: number; b2: number; a1: number; a2: number } | null {
  const freq = clamp(filter.freq, 10, sampleRate / 2 - 10);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(0.05, filter.q));
  const A = Math.pow(10, filter.gain / 40);

  let b0 = 1;
  let a0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a1 = 0;
  let a2 = 0;

  switch (filter.type) {
    case 'peaking':
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const sqrtA = Math.sqrt(A);
      const shelf = 2 * sqrtA * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + shelf);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - shelf);
      a0 = A + 1 + (A - 1) * cos + shelf;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - shelf;
      break;
    }
    case 'highshelf': {
      const sqrtA = Math.sqrt(A);
      const shelf = 2 * sqrtA * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + shelf);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - shelf);
      a0 = A + 1 - (A - 1) * cos + shelf;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - shelf;
      break;
    }
    case 'highpass':
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'lowpass':
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
  }

  if (!Number.isFinite(a0) || Math.abs(a0) < 1e-12) return null;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function biquadMagnitude(
  coeffs: { b0: number; b1: number; b2: number; a1: number; a2: number },
  freq: number,
  sampleRate: number,
): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const z1: Complex = { re: Math.cos(-w), im: Math.sin(-w) };
  const z2: Complex = { re: Math.cos(-2 * w), im: Math.sin(-2 * w) };

  const numerator: Complex = {
    re: coeffs.b0 + coeffs.b1 * z1.re + coeffs.b2 * z2.re,
    im: coeffs.b1 * z1.im + coeffs.b2 * z2.im,
  };
  const denominator: Complex = {
    re: 1 + coeffs.a1 * z1.re + coeffs.a2 * z2.re,
    im: coeffs.a1 * z1.im + coeffs.a2 * z2.im,
  };
  const num = Math.hypot(numerator.re, numerator.im);
  const den = Math.hypot(denominator.re, denominator.im);
  return den < 1e-12 ? 0 : num / den;
}

/** Magnitude response of the whole emulation at one frequency, in dB. */
export function micResponseDb(
  params: Record<string, number>,
  freq: number,
  sampleRate = 48000,
): number {
  const chain = micChain(params, sampleRate);
  let magnitude = 1;
  for (const filter of chain) {
    const coeffs = biquadCoefficients(filter, sampleRate);
    if (!coeffs) continue;
    magnitude *= biquadMagnitude(coeffs, clamp(freq, 10, sampleRate / 2 - 10), sampleRate);
  }
  const output = clamp(params.output ?? 0, -18, 18);
  return 20 * Math.log10(Math.max(1e-9, magnitude)) + output;
}

export interface CurvePoint {
  freq: number;
  db: number;
}

/** Log-spaced response points for the panel plot. */
export function micCurve(
  params: Record<string, number>,
  points = 96,
  minHz = 20,
  maxHz = 20000,
  sampleRate = 48000,
): CurvePoint[] {
  const out: CurvePoint[] = [];
  const top = Math.min(maxHz, sampleRate / 2 - 10);
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const freq = minHz * Math.pow(top / minHz, t);
    out.push({ freq, db: micResponseDb(params, freq, sampleRate) });
  }
  return out;
}

/** Saturation amount for the device waveshaper: circuit drive plus user trim. */
export function micDriveAmount(params: Record<string, number>): number {
  const model = micModelAt(params.model ?? 0);
  return clamp(model.drive + clamp(params.drive ?? 0, 0, 1) * 0.6, 0, 0.95);
}

/** Short human-readable summary, used by the rack card and the toast. */
export function micSummary(params: Record<string, number>): string {
  const model = micModelAt(params.model ?? 0);
  return `${model.name} · ${model.family}`;
}
