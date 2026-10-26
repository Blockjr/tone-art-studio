/**
 * Frequency and transfer responses for the module displays.
 *
 * These are the same shapes the filters and the compressor actually apply, so a
 * curve on a faceplate is a measurement of the setting rather than decoration.
 * Everything works on plain numbers and is sample-rate aware.
 */

export interface BiquadShape {
  type: 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'lowshelf' | 'highshelf';
  /** corner or centre frequency in Hz */
  freq: number;
  /** for Web Audio filters this is in dB for low/high-pass */
  q: number;
  /** only used by peaking and shelf filters */
  gain?: number;
}

interface Coefficients {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

const shelf = 0.7071067811865476;

/** RBJ cookbook coefficients, matching the biquads Web Audio builds. */
function coefficients(shape: BiquadShape, sampleRate: number): Coefficients {
  const rate = Math.max(8000, sampleRate);
  const f = Math.min(rate * 0.49, Math.max(10, shape.freq));
  const w0 = (2 * Math.PI * f) / rate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const gain = shape.gain ?? 0;
  const A = Math.pow(10, gain / 40);
  const linearQ = shape.type === 'lowpass' || shape.type === 'highpass' ? Math.pow(10, shape.q / 20) : shape.q;
  const alpha = sin / (2 * Math.max(0.0001, linearQ));
  const shelfAlpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / shelf - 1) + 2);
  const shelfRoot = 2 * Math.sqrt(A) * shelfAlpha;
  const shelfPlus = A + 1;
  const shelfMinus = A - 1;

  switch (shape.type) {
    case 'lowpass':
      return {
        b0: (1 - cos) / 2,
        b1: 1 - cos,
        b2: (1 - cos) / 2,
        a0: 1 + alpha,
        a1: -2 * cos,
        a2: 1 - alpha,
      };
    case 'highpass':
      return {
        b0: (1 + cos) / 2,
        b1: -(1 + cos),
        b2: (1 + cos) / 2,
        a0: 1 + alpha,
        a1: -2 * cos,
        a2: 1 - alpha,
      };
    case 'bandpass':
      return { b0: alpha, b1: 0, b2: -alpha, a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha };
    case 'notch':
      return { b0: 1, b1: -2 * cos, b2: 1, a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha };
    case 'peaking':
      return {
        b0: 1 + alpha * A,
        b1: -2 * cos,
        b2: 1 - alpha * A,
        a0: 1 + alpha / A,
        a1: -2 * cos,
        a2: 1 - alpha / A,
      };
    case 'lowshelf':
      return {
        b0: A * (shelfPlus - shelfMinus * cos + shelfRoot),
        b1: 2 * A * (shelfMinus - shelfPlus * cos),
        b2: A * (shelfPlus - shelfMinus * cos - shelfRoot),
        a0: shelfPlus + shelfMinus * cos + shelfRoot,
        a1: -2 * (shelfMinus + shelfPlus * cos),
        a2: shelfPlus + shelfMinus * cos - shelfRoot,
      };
    case 'highshelf':
      return {
        b0: A * (shelfPlus + shelfMinus * cos + shelfRoot),
        b1: -2 * A * (shelfMinus + shelfPlus * cos),
        b2: A * (shelfPlus + shelfMinus * cos - shelfRoot),
        a0: shelfPlus - shelfMinus * cos + shelfRoot,
        a1: 2 * (shelfMinus - shelfPlus * cos),
        a2: shelfPlus - shelfMinus * cos - shelfRoot,
      };
    default:
      return { b0: 1, b1: 0, b2: 0, a0: 1, a1: 0, a2: 0 };
  }
}

/** Magnitude response in dB at one frequency, for a single biquad. */
export function biquadGainDb(shape: BiquadShape, sampleRate: number, frequency: number): number {
  const c = coefficients(shape, sampleRate);
  const w = (2 * Math.PI * Math.min(sampleRate * 0.499, Math.max(1, frequency))) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const numeratorRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const numeratorIm = -(c.b1 * sin1 + c.b2 * sin2);
  const denominatorRe = c.a0 + c.a1 * cos1 + c.a2 * cos2;
  const denominatorIm = -(c.a1 * sin1 + c.a2 * sin2);
  const numerator = Math.hypot(numeratorRe, numeratorIm);
  const denominator = Math.hypot(denominatorRe, denominatorIm);
  return 20 * Math.log10(Math.max(1e-9, numerator / Math.max(1e-9, denominator)));
}

export interface EqBand {
  shape: BiquadShape;
  /** used for direct manipulation: where the handle sits */
  label?: string;
}

/** Summed response of filters in series, in dB. */
export function chainGainDb(bands: EqBand[], sampleRate: number, frequency: number): number {
  let total = 0;
  for (const band of bands) total += biquadGainDb(band.shape, sampleRate, frequency);
  return total;
}

export const EQ_FREQUENCIES = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

/** Log-spaced sample points for drawing a response from 20 Hz to 20 kHz. */
export function responsePoints(bands: EqBand[], sampleRate: number, count = 180): { freq: number; db: number }[] {
  const low = Math.log(20);
  const high = Math.log(20000);
  const points: { freq: number; db: number }[] = [];
  for (let index = 0; index < count; index++) {
    const freq = Math.exp(low + ((high - low) * index) / (count - 1));
    points.push({ freq, db: chainGainDb(bands, sampleRate, freq) });
  }
  return points;
}

export interface CompressorShape {
  threshold: number;
  ratio: number;
  knee: number;
  /** optional ceiling for a limiter-style display */
  ceiling?: number;
}

/** Output level in dB for a given input level, with a soft knee. */
export function compressorGainDb(inputDb: number, shape: CompressorShape): number {
  const ratio = Math.max(1, shape.ratio);
  const knee = Math.max(0, shape.knee);
  const over = inputDb - shape.threshold;
  if (knee > 0 && Math.abs(over) <= knee / 2) {
    const x = over + knee / 2;
    return inputDb + (1 / ratio - 1) * (x * x) / (2 * knee);
  }
  if (over <= 0) return inputDb;
  return shape.threshold + over / ratio;
}

export interface FilterDesign {
  type: 'lowpass' | 'highpass' | 'bandpass' | 'notch';
  freq: number;
  q: number;
}

export function filterBands(design: FilterDesign): EqBand[] {
  return [{ shape: { type: design.type, freq: design.freq, q: design.q } }];
}

/** A rough harmonic curve for the drive display: more drive, more bend. */
export function driveCurve(amount: number, count = 120): { x: number; y: number }[] {
  const k = 0.2 + Math.max(0, Math.min(1, amount)) * 8;
  const norm = Math.tanh(k);
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < count; index++) {
    const x = (index / (count - 1)) * 2 - 1;
    points.push({ x, y: Math.tanh(x * k) / norm });
  }
  return points;
}

/** One-pole low-pass coefficient, used to draw a tone shelf's slope. */
export function toneGainDb(frequency: number, cutoff: number): number {
  const ratio = frequency / Math.max(10, cutoff);
  return -10 * Math.log10(1 + ratio * ratio);
}

/** Air shelf response: low/mid presence plus a high shelf, in dB. */
export function airGainDb(frequency: number, mid: number, high: number): number {
  const midShape: BiquadShape = { type: 'peaking', freq: 3800, q: 0.8, gain: (mid / 100) * 12 };
  const highShape: BiquadShape = { type: 'highshelf', freq: 12000, q: 0.707, gain: (high / 100) * 12 };
  return biquadGainDb(midShape, 48000, frequency) + biquadGainDb(highShape, 48000, frequency);
}
