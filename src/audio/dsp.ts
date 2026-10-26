/**
 * Offline DSP for the audio preview: pitch-preserving time-stretch (WSOLA),
 * resampling pitch shift, waveform peaks and tempo detection.
 *
 * Everything here works on plain Float32Arrays so it runs in the browser and in
 * tests without a Web Audio context. Processing is chunked through
 * `stretchChannelsAsync` so a long file never blocks the UI.
 */

export interface StretchOptions {
  /** playback speed: 2 = twice as fast, half the duration, same pitch */
  tempoRate?: number;
  /** pitch ratio: 2 = one octave up, same duration */
  pitchRatio?: number;
}

const FRAME = 2048;
/** 87.5% overlap: more sum of similar grains, fewer granular artefacts. */
const SYNTH_HOP = 256;
const SEARCH = 96;
/** 2-sample search resolution: the correlation is cheap, so quality wins. */
const SEARCH_STEP = 2;
const OVERLAP = FRAME - SYNTH_HOP;

function hann(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
  return window;
}

const HANN = hann(FRAME);

/**
 * Catmull-Rom resample. ratio > 1 makes the signal shorter and higher.
 * Cubic interpolation keeps pitch-shifted material cleaner than linear
 * interpolation, which folds high frequencies into audible aliasing.
 */
export function resampleLinear(input: Float32Array, ratio: number): Float32Array {
  if (!Number.isFinite(ratio) || ratio <= 0) return input.slice();
  if (Math.abs(ratio - 1) < 1e-4) return input.slice();

  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  const last = input.length - 1;

  for (let i = 0; i < length; i++) {
    const position = Math.min(last, i * ratio);
    const index = Math.floor(position);
    const fraction = position - index;
    const p0 = input[Math.max(0, index - 1)] ?? 0;
    const p1 = input[index] ?? 0;
    const p2 = input[Math.min(last, index + 1)] ?? p1;
    const p3 = input[Math.min(last, index + 2)] ?? p2;
    // Catmull-Rom (cubic Hermite with a 0.5 tension).
    const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    const c = -0.5 * p0 + 0.5 * p2;
    output[i] = ((a * fraction + b) * fraction + c) * fraction + p1;
  }

  return output;
}

function bestOffset(
  input: Float32Array,
  nominal: number,
  reference: number,
  overlay: number,
): number {
  let best = 0;
  let bestScore = -Infinity;

  for (let offset = -SEARCH; offset <= SEARCH; offset += SEARCH_STEP) {
    const start = nominal + offset;

    if (start < 0 || start + overlay >= input.length || reference + overlay >= input.length) continue;

    let correlation = 0;
    let energy = 0;

    for (let i = 0; i < overlay; i += SEARCH_STEP) {
      const candidate = input[start + i];
      correlation += candidate * input[reference + i];
      energy += candidate * candidate;
    }

    const score = correlation / (Math.sqrt(energy) + 1e-9);

    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }

  return best;
}

function stretchChannelSync(input: Float32Array, rate: number): Float32Array {
  if (!Number.isFinite(rate) || rate <= 0) return input.slice();
  if (Math.abs(rate - 1) < 1e-3) return input.slice();

  const outputLength = Math.max(1, Math.round(input.length / rate));
  const output = new Float32Array(outputLength + FRAME);
  const weight = new Float32Array(outputLength + FRAME);

  let previousStart = 0;
  let hasPrevious = false;
  let inPosition = 0;

  for (let outPosition = 0; outPosition < outputLength; outPosition += SYNTH_HOP) {
    const nominal = Math.round(inPosition);
    let start = nominal;

    if (hasPrevious) {
      const reference = Math.min(input.length - OVERLAP - 1, previousStart + SYNTH_HOP);
      if (reference >= 0) start = nominal + bestOffset(input, nominal, reference, OVERLAP);
    }

    start = Math.max(0, Math.min(input.length - 1, start));

    for (let i = 0; i < FRAME; i++) {
      const source = start + i;
      if (source >= input.length) break;
      output[outPosition + i] += input[source] * HANN[i];
      weight[outPosition + i] += HANN[i];
    }

    previousStart = start;
    hasPrevious = true;
    inPosition += SYNTH_HOP * rate;
  }

  const result = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const normaliser = weight[i];
    result[i] = normaliser > 1e-4 ? output[i] / normaliser : output[i];
  }

  return result;
}

/** Pitch-preserving time-stretch of one channel. rate > 1 is faster and shorter. */
export function timeStretch(input: Float32Array, rate: number): Float32Array {
  return stretchChannelSync(input, Math.max(0.25, Math.min(4, rate)));
}

/** Applies the pitch/tempo plan: resample for pitch, then stretch for tempo. */
export function processChannels(
  channels: Float32Array[],
  options: StretchOptions = {},
): Float32Array[] {
  const tempoRate = Math.max(0.25, Math.min(4, options.tempoRate ?? 1));
  const pitchRatio = Math.max(0.25, Math.min(4, options.pitchRatio ?? 1));

  let working = channels;

  if (Math.abs(pitchRatio - 1) > 1e-4) {
    working = working.map((channel) => resampleLinear(channel, pitchRatio));
  }

  const stretch = tempoRate / pitchRatio;

  if (Math.abs(stretch - 1) > 1e-3) {
    working = working.map((channel) => timeStretch(channel, stretch));
  }

  return working;
}

export interface StretchJobOptions extends StretchOptions {
  onProgress?: (progress: number) => void;
  shouldCancel?: () => boolean;
  /** Yield to the event loop every this many milliseconds. */
  budgetMs?: number;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Chunked version used by the preview panel: same maths, but it hands the event
 * loop back regularly so meters and the UI keep running on low CPU.
 */
export async function stretchChannelsAsync(
  channels: Float32Array[],
  options: StretchJobOptions = {},
): Promise<Float32Array[] | null> {
  const tempoRate = Math.max(0.25, Math.min(4, options.tempoRate ?? 1));
  const pitchRatio = Math.max(0.25, Math.min(4, options.pitchRatio ?? 1));

  if (Math.abs(tempoRate - 1) < 1e-3 && Math.abs(pitchRatio - 1) < 1e-4) {
    options.onProgress?.(1);
    return channels;
  }

  const budget = options.budgetMs ?? 24;
  let working = channels;

  if (Math.abs(pitchRatio - 1) > 1e-4) {
    working = working.map((channel) => resampleLinear(channel, pitchRatio));
  }

  const stretch = tempoRate / pitchRatio;
  const output: Float32Array[] = [];

  for (let channel = 0; channel < working.length; channel++) {
    const input = working[channel];
    const outputLength = Math.max(1, Math.round(input.length / stretch));
    const result = new Float32Array(outputLength + FRAME);
    const weight = new Float32Array(outputLength + FRAME);
    // The budget is per slice of work, so reset the clock after every yield;
    // otherwise a long file yields once per frame and crawls at timer speed.
    let started = performance.now();

    let previousStart = 0;
    let hasPrevious = false;
    let inPosition = 0;
    let outPosition = 0;

    while (outPosition < outputLength) {
      const nominal = Math.round(inPosition);
      let start = nominal;

      if (hasPrevious) {
        const reference = Math.min(input.length - OVERLAP - 1, previousStart + SYNTH_HOP);
        if (reference >= 0) start = nominal + bestOffset(input, nominal, reference, OVERLAP);
      }

      start = Math.max(0, Math.min(input.length - 1, start));

      for (let i = 0; i < FRAME; i++) {
        const source = start + i;
        if (source >= input.length) break;
        result[outPosition + i] += input[source] * HANN[i];
        weight[outPosition + i] += HANN[i];
      }

      previousStart = start;
      hasPrevious = true;
      inPosition += SYNTH_HOP * stretch;
      outPosition += SYNTH_HOP;

      if (performance.now() - started > budget) {
        options.onProgress?.((channel + outPosition / outputLength) / working.length);
        await nextFrame();
        started = performance.now();

        if (options.shouldCancel?.()) return null;
      }
    }

    const trimmed = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      trimmed[i] = weight[i] > 1e-4 ? result[i] / weight[i] : result[i];
    }

    output.push(trimmed);
    options.onProgress?.((channel + 1) / working.length);
  }

  return output;
}

export interface OnsetOptions {
  /** 0..1 of the loudest flux peak; lower catches more hits */
  threshold?: number;
  /** minimum spacing between detected onsets, in seconds */
  minGap?: number;
}

/**
 * Onset times (seconds) from a spectral-flux style energy rise. It is tuned for
 * slicing drums and rhythmic material, and it is deterministic, so the same
 * audio always yields the same slice points.
 */
export function detectOnsets(
  channels: Float32Array[],
  sampleRate: number,
  options: OnsetOptions = {},
): number[] {
  const mono = channels[0];
  if (!mono || mono.length < 256 || sampleRate <= 0) return [];
  const hop = 256;
  const frames = Math.floor(mono.length / hop);
  const energy = new Float32Array(frames);

  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    const start = frame * hop;
    for (let i = 0; i < hop; i += 2) sum += Math.abs(mono[start + i] ?? 0);
    energy[frame] = sum;
  }

  const flux = new Float32Array(frames);
  let peak = 0;
  for (let i = 1; i < frames; i++) {
    const rise = energy[i] - energy[i - 1];
    flux[i] = rise > 0 ? rise : 0;
    if (flux[i] > peak) peak = flux[i];
  }
  if (peak <= 1e-7) return [];
  for (let i = 0; i < frames; i++) flux[i] /= peak;

  const threshold = Math.max(0.02, Math.min(0.9, options.threshold ?? 0.22));
  const minGap = Math.max(0.02, options.minGap ?? 0.07);
  const framesPerSecond = sampleRate / hop;
  const onsets: number[] = [];
  let last = -Infinity;

  for (let i = 1; i < frames - 1; i++) {
    if (flux[i] < threshold || flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    const time = i / framesPerSecond;
    if (time - last < minGap) continue;
    onsets.push(Math.round(time * 1000) / 1000);
    last = time;
  }

  return onsets;
}

/**
 * Min/max pairs for waveform drawing, clamped to -1..1.
 *
 * Buckets are spread over the whole file with fractional boundaries, so the
 * last samples are never dropped and no bucket is left empty: a transient in
 * the final millisecond still shows, and the summary is a faithful, evenly
 * weighted picture of every channel.
 */
export function computePeaks(
  channels: Float32Array[],
  buckets = 2048,
): number[] {
  const first = channels[0];
  if (!first || first.length === 0) return [];

  const count = Math.max(1, Math.min(Math.floor(buckets) || 1, first.length));
  const span = first.length / count;
  const peaks: number[] = [];

  for (let bucket = 0; bucket < count; bucket++) {
    const start = Math.floor(bucket * span);
    const end = bucket === count - 1 ? first.length : Math.ceil((bucket + 1) * span);
    let min = 0;
    let max = 0;

    for (let i = start; i < end; i++) {
      for (const channel of channels) {
        const value = channel[i] ?? 0;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }

    peaks.push(Math.max(-1, min), Math.min(1, max));
  }

  return peaks;
}

export interface TempoEstimate {
  bpm: number;
  confidence: number;
  /** onset strength envelope, for diagnostics */
  onsetCount: number;
}

/**
 * Onset-energy autocorrelation tempo estimate, folded into 70–180 BPM.
 * Good enough to seed a preview tempo and to double-check a tap tempo.
 */
export function detectTempo(channels: Float32Array[], sampleRate: number): TempoEstimate {
  const mono = channels[0];
  if (!mono || mono.length < sampleRate) return { bpm: 0, confidence: 0, onsetCount: 0 };

  const hop = 256;
  const frames = Math.floor(mono.length / hop);
  const energy = new Float32Array(frames);

  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    const start = frame * hop;
    for (let i = 0; i < hop; i += 2) sum += Math.abs(mono[start + i] ?? 0);
    energy[frame] = sum;
  }

  const onset = new Float32Array(frames);
  let maxOnset = 0;

  for (let i = 1; i < frames; i++) {
    const rise = energy[i] - energy[i - 1];
    onset[i] = rise > 0 ? rise : 0;
    if (onset[i] > maxOnset) maxOnset = onset[i];
  }

  if (maxOnset <= 1e-6) return { bpm: 0, confidence: 0, onsetCount: 0 };

  for (let i = 0; i < frames; i++) onset[i] /= maxOnset;

  const framesPerSecond = sampleRate / hop;
  const minLag = Math.max(2, Math.round(framesPerSecond * (60 / 200)));
  const maxLag = Math.round(framesPerSecond * (60 / 50));
  const scores: number[] = [];

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const terms = frames - lag;

    for (let i = 0; i < terms; i++) sum += onset[i] * onset[i + lag];

    scores.push(terms > 0 ? sum / terms : 0);
  }

  let bestIndex = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bestIndex]) bestIndex = i;

  const mean = scores.reduce((total, value) => total + value, 0) / Math.max(1, scores.length);
  const confidence = mean > 0 ? Math.min(1, (scores[bestIndex] - mean) / (mean * 3)) : 0;
  const lag = minLag + bestIndex;
  let bpm = (60 * framesPerSecond) / lag;

  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;

  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence,
    onsetCount: frames,
  };
}
