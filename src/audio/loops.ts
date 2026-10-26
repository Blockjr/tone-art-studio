/**
 * Loop-editor analysis: tempo estimation, grid slicing and BPM tags.
 *
 * Everything here works on plain numbers (a mono sample array or a duration),
 * so it runs in a worker, in tests, and in the app without an AudioContext. The
 * UI only has to supply the region the user selected in the preview.
 */

const MIN_BPM = 60;
const MAX_BPM = 190;
const FRAME = 1024;
const HOP = 256;
/** Tempo the octave-correction prior favours: most loops sit near 120. */
const PRIOR_BPM = 122;
const PRIOR_OCTAVES = 0.55;

export interface LoopTempo {
  /** Beats per minute, or null when nothing periodic was found. */
  bpm: number | null;
  /** 0..1 — how strongly the winning period stood out from the rest. */
  confidence: number;
  /** True when the tempo came from a tag the user wrote, not analysis. */
  locked: boolean;
  source: 'tag' | 'detected' | 'none';
  /** Seconds to the first strong onset, used to align the slice grid. */
  offset: number;
}

export interface Onset {
  /** Seconds from the start of the analysed region. */
  time: number;
  /** 0..1 relative strength within the analysed region. */
  strength: number;
}

export interface SliceOptions {
  /** Tempo to slice against. Required for bar/beat grids. */
  bpm?: number | null;
  /** How many bars each slice spans on the bar grid (default 1). */
  barsPerSlice?: number;
  /** `bar` = bars, `beat` = quarters, `half` = eighth notes, `transient`. */
  grid?: 'bar' | 'beat' | 'half' | 'transient';
  /** Shortest allowed slice, in seconds. Default 0.02. */
  minSlice?: number;
  /** Onset picker sensitivity, 0..1. Default 0.35. */
  sensitivity?: number;
  /** Snap detected onsets to the beat grid when they land this close (ms). */
  snapMs?: number;
  /** Transient positions in file time, as returned by `detectOnsets`. */
  onsets?: Onset[];
  /**
   * Where the grid starts, in file seconds — normally the first detected hit.
   * Cuts land on multiples of the slice length from here, so slices line up
   * with the bar lines drawn over the waveform. Defaults to the region start.
   */
  align?: number;
}

export interface LoopSlice {
  start: number;
  end: number;
}

/** Mono view of a decoded buffer, which is all the analysis needs. */
export interface LoopSignal {
  duration: number;
  sampleRate: number;
  samples: Float32Array;
}

/** Mixes every channel to mono at the buffer's own sample rate. */
export function signalFromBuffer(buffer: AudioBuffer): LoopSignal {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const samples = new Float32Array(length);

  if (channels === 1) {
    samples.set(buffer.getChannelData(0));
  } else {
    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) samples[i] += data[i] / channels;
    }
  }

  return { duration: buffer.duration, sampleRate: buffer.sampleRate, samples };
}

/* ----------------------------------------------------------------- tempo tag */

/**
 * Reads an explicit tempo from a file name such as `break_174bpm.wav`,
 * `loop 120 BPM.wav` or `arp@128.wav` (Soundcloud-style `@` tag).
 * Only an explicit tag counts: a bare number in a name is a take number.
 */
export function parseTempoTag(name: string): number | null {
  const clean = String(name ?? '');
  const tagged = /(?:^|[^0-9a-z])(\d{2,3}(?:\.\d+)?)\s*bpm\b/i.exec(clean);
  if (tagged) {
    const bpm = Number(tagged[1]);
    if (bpm >= 40 && bpm <= 300) return bpm;
  }
  const at = /@\s?(\d{2,3}(?:\.\d+)?)/.exec(clean);
  if (at) {
    const bpm = Number(at[1]);
    if (bpm >= 40 && bpm <= 300) return bpm;
  }
  return null;
}

/* ------------------------------------------------------------ onset analysis */

/**
 * Splits a signal into a small mono envelope at a fixed hop, then reports the
 * positive energy jumps. This is the shared front end for both the tempo
 * estimate and the transient slicer: the same kick that wins the
 * autocorrelation is the one that gets a slice boundary.
 */
export function detectOnsets(signal: LoopSignal, sensitivity = 0.35): Onset[] {
  const mono = signal.samples;
  if (mono.length < FRAME * 4) return [];

  const frames = Math.max(1, Math.floor((mono.length - FRAME) / HOP) + 1);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      const v = mono[base + i];
      sum += v * v;
    }
    energy[f] = Math.sqrt(sum / FRAME);
  }

  // Log compression keeps quiet hats visible next to a loud kick. Frame zero
  // rises from silence, so a loop that starts on a downbeat still reports it.
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const previous = f === 0 ? 0 : Math.log1p(energy[f - 1] * 20);
    const rise = Math.log1p(energy[f] * 20) - previous;
    flux[f] = rise > 0 ? rise : 0;
  }

  let peak = 0;
  for (let f = 0; f < frames; f++) peak = Math.max(peak, flux[f]);
  if (peak <= 0) return [];

  // Adaptive threshold: local mean over a ~0.4 s window plus a fraction of the
  // global peak. A fixed threshold either drowns in noise or misses soft loops.
  const win = Math.max(3, Math.round((signal.sampleRate / HOP) * 0.4));
  const threshold = Math.min(0.92, Math.max(0.04, sensitivity));

  const onsets: Onset[] = [];
  let lastFrame = -Infinity;
  const minGap = Math.max(2, Math.round((signal.sampleRate / HOP) * 0.05));
  for (let f = 0; f < frames - 1; f++) {
    const v = flux[f];
    if (v < peak * threshold) continue;
    if (v < (f === 0 ? 0 : flux[f - 1]) || v < flux[f + 1]) continue;
    if (f - lastFrame < minGap) continue;

    let local = 0;
    let count = 0;
    for (let k = Math.max(0, f - win); k <= Math.min(frames - 1, f + win); k++) {
      local += flux[k];
      count++;
    }
    const mean = count ? local / count : 0;
    if (v < mean * 1.6) continue;

    onsets.push({
      time: (f * HOP) / signal.sampleRate,
      strength: Math.min(1, v / peak),
    });
    lastFrame = f;
  }
  return onsets;
}

/* ----------------------------------------------------------- tempo estimation */

function autocorrelationAt(flux: Float32Array, lag: number): number {
  if (lag < 1 || lag >= flux.length) return 0;
  let sum = 0;
  const n = flux.length - lag;
  for (let i = 0; i < n; i++) sum += flux[i] * flux[i + lag];
  return n > 0 ? sum / n : 0;
}

function tempoPrior(bpm: number): number {
  const octaves = Math.log2(bpm / PRIOR_BPM);
  return Math.exp(-(octaves * octaves) / (2 * PRIOR_OCTAVES * PRIOR_OCTAVES));
}

/**
 * Estimates tempo by autocorrelating the onset envelope over the range a loop
 * library actually uses (60–190 BPM). Returns the confidence so the UI can say
 * "detected" or stay quiet instead of showing a wrong number.
 */
export function estimateLoopTempo(
  signal: LoopSignal,
  opts: { minBpm?: number; maxBpm?: number; sensitivity?: number } = {},
): LoopTempo {
  const empty: LoopTempo = {
    bpm: null,
    confidence: 0,
    locked: false,
    source: 'none',
    offset: 0,
  };
  const onsets = detectOnsets(signal, opts.sensitivity ?? 0.3);
  if (onsets.length < 4) return empty;

  const frames = Math.max(1, Math.floor((signal.samples.length - FRAME) / HOP) + 1);
  const flux = new Float32Array(frames);
  for (const onset of onsets) {
    const f = Math.min(frames - 1, Math.max(0, Math.round((onset.time * signal.sampleRate) / HOP)));
    flux[f] = onset.strength;
  }
  // Spread each onset over a short window: exact frame alignment is too brittle
  // for an integer-lag correlation.
  const spread = new Float32Array(frames);
  for (let f = 1; f < frames - 1; f++) {
    spread[f] = flux[f] + flux[f - 1] * 0.5 + flux[f + 1] * 0.5;
  }

  const minBpm = Math.max(MIN_BPM, opts.minBpm ?? 55);
  const maxBpm = Math.min(MAX_BPM, opts.maxBpm ?? 195);
  const framesPerSecond = signal.sampleRate / HOP;
  const lowest = Math.max(2, Math.floor((60 / maxBpm) * framesPerSecond));
  const highest = Math.min(frames - 2, Math.ceil((60 / minBpm) * framesPerSecond));
  if (highest <= lowest + 2) return empty;

  const raw = new Float32Array(highest + 2);
  const scores = new Float32Array(highest + 2);
  let mean = 0;
  for (let lag = lowest; lag <= highest; lag++) {
    const bpm = (60 * framesPerSecond) / lag;
    raw[lag] = autocorrelationAt(spread, lag);
    scores[lag] = raw[lag] * tempoPrior(bpm);
    mean += scores[lag];
  }
  mean /= highest - lowest + 1;

  let best = lowest;
  for (let lag = lowest; lag <= highest; lag++) if (scores[lag] > scores[best]) best = lag;

  // Octave errors are the usual failure. A 174 BPM break also correlates at
  // 87, and either reading produces the same grid, but loop libraries almost
  // always name the faster one. Prefer the faster octave unless the slower one
  // is clearly stronger; only fall back to the slower one when the faster lag
  // is out of range and the correlation there is much better.
  // The comparison uses the raw correlation, so the tempo prior cannot tip the
  // octave the other way.
  // Half a lag rarely lands on an integer frame (119 / 2 = 59.5), so both
  // neighbouring lags are tried and the stronger one wins. Rounding alone
  // lands a frame away from the peak and the octave check then fails.
  const better = (lags: number[]): number | null => {
    let winner: number | null = null;
    for (const lag of lags) {
      if (lag < lowest || lag > highest) continue;
      if (winner === null || raw[lag] > raw[winner]) winner = lag;
    }
    return winner;
  };

  const fasterLag = better([Math.floor(best / 2), Math.ceil(best / 2)]);
  const slowerLag = better([best * 2 - 1, best * 2, best * 2 + 1]);

  if (fasterLag !== null && raw[fasterLag] >= raw[best] * 0.8) {
    best = fasterLag;
  } else if (slowerLag !== null && raw[slowerLag] >= raw[best] * 1.35) {
    best = slowerLag;
  }

  // Parabolic interpolation around the winning integer lag.
  let refined = best;
  if (best > lowest && best < highest) {
    const a = scores[best - 1];
    const b = scores[best];
    const c = scores[best + 1];
    const denom = 2 * (2 * b - a - c);
    if (Math.abs(denom) > 1e-9) refined = best + (c - a) / denom;
  }

  let bpm = (60 * framesPerSecond) / refined;
  if (bpm > maxBpm) bpm /= 2;
  if (bpm < minBpm) bpm *= 2;
  bpm = Math.round(bpm * 100) / 100;
  if (!Number.isFinite(bpm) || bpm < minBpm || bpm > maxBpm) return empty;

  const confidence = mean > 0 ? Math.max(0, Math.min(1, (scores[best] / mean - 1) / 2)) : 0;
  const strongest = onsets.reduce((a, b) => (b.strength > a.strength ? b : a), onsets[0]);

  return {
    bpm,
    confidence: Math.round(confidence * 100) / 100,
    locked: false,
    source: 'detected',
    offset: strongest.time,
  };
}

/** Tag first (the user's own tempo always wins), then analysis. */
export function analyseLoop(
  signal: LoopSignal,
  opts: { name?: string; tag?: number | null; minBpm?: number; maxBpm?: number } = {},
): LoopTempo {
  const tag = opts.tag ?? parseTempoTag(opts.name ?? '');
  if (tag) {
    const onsets = detectOnsets(signal, 0.3);
    const first = onsets.length ? onsets[0].time : 0;
    return { bpm: tag, confidence: 1, locked: true, source: 'tag', offset: first };
  }
  return estimateLoopTempo(signal, { minBpm: opts.minBpm, maxBpm: opts.maxBpm });
}

/* ----------------------------------------------------------------- slicer */

function roundTo(value: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Cuts a region into loop slices. Bar and beat grids are exact (the tempo
 * decides the boundaries); the transient grid follows detected onsets and
 * snaps them to the beat when `bpm` is known.
 *
 * Slice times are absolute file seconds, so they can drive both the drawing and
 * the export without translating coordinates again.
 */
export function sliceRegion(region: LoopSlice, opts: SliceOptions = {}): LoopSlice[] {
  const start = Math.max(0, Math.min(region.start, region.end));
  const end = Math.max(start, Math.max(region.start, region.end));
  const total = end - start;
  if (total <= 0) return [{ start: roundTo(start, 6), end: roundTo(end, 6) }];

  const minSlice = Math.max(0.005, opts.minSlice ?? 0.02);
  const grid = opts.grid ?? 'bar';
  const bpm = opts.bpm && opts.bpm > 0 ? opts.bpm : null;

  const align = Number.isFinite(opts.align) ? (opts.align as number) : start;
  let cuts: number[] = [];

  if (grid === 'transient') {
    const beat = bpm ? 60 / bpm : 0;
    const snap = (opts.snapMs ?? 45) / 1000;
    cuts = (opts.onsets ?? [])
      .map((onset) => onset.time)
      .filter((t) => t > start + minSlice * 0.5 && t < end - minSlice * 0.5)
      .map((t) => {
        if (!beat) return t;
        const nearest = align + Math.round((t - align) / beat) * beat;
        return Math.abs(nearest - t) <= snap ? nearest : t;
      });
  } else if (bpm) {
    const step = 60 / bpm;
    const span = grid === 'bar'
      ? Math.max(1, opts.barsPerSlice ?? 1) * 4 * step
      : grid === 'half'
        ? step / 2
        : step;
    // First grid line at or after the region start: a selection that begins
    // mid-bar still cuts on the bar, not wherever the drag ended.
    const first = Math.ceil((start - align) / span - 1e-6);
    for (let i = first; align + i * span < end; i++) {
      const cut = align + i * span;
      if (cut > start) cuts.push(cut);
    }
  } else {
    // No tempo: even halves still make a long take editable.
    cuts = [start + total / 2];
  }

  const sorted = Array.from(new Set(cuts.map((t) => roundTo(t, 6))))
    .filter((t) => Number.isFinite(t) && t > start && t < end)
    .sort((a, b) => a - b);

  const bounds: number[] = [];
  let cursor = start;
  for (const cut of sorted) {
    if (cut - cursor < minSlice) continue;
    if (end - cut < minSlice) break;
    bounds.push(cut);
    cursor = cut;
  }

  const edges = [start, ...bounds, end];
  const slices: LoopSlice[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    slices.push({ start: roundTo(edges[i], 6), end: roundTo(edges[i + 1], 6) });
  }
  return slices;
}

/** Expands a region to whole bars of the detected tempo. */
export function snapRegionToBars(
  region: LoopSlice,
  bpm: number | null,
  offset = 0,
  beatsPerBar = 4,
): LoopSlice {
  const bar = barSeconds(bpm, beatsPerBar);
  if (!bar) return region;

  const first = offset + Math.floor((region.start - offset) / bar + 1e-6) * bar;
  const last = offset + Math.ceil((region.end - offset) / bar - 1e-6) * bar;
  return {
    start: roundTo(Math.max(0, first), 6),
    end: roundTo(Math.max(Math.max(0, first) + bar, last), 6),
  };
}

/** Copies `[start, end)` of a decoded buffer into a standalone buffer. */
export function sliceBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  start: number,
  end: number,
): AudioBuffer {
  const rate = buffer.sampleRate;
  const from = Math.max(0, Math.min(buffer.length, Math.floor(start * rate)));
  const to = Math.max(from + 1, Math.min(buffer.length, Math.ceil(end * rate)));
  const out = ctx.createBuffer(buffer.numberOfChannels, to - from, rate);

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel).subarray(from, to);
    out.copyToChannel(source as Float32Array<ArrayBuffer>, channel);
  }
  return out;
}

/** Bar length in seconds for a tempo, used by the UI's length readout. */
export function barSeconds(bpm: number | null, beatsPerBar = 4): number {
  if (!bpm || bpm <= 0) return 0;
  return (beatsPerBar * 60) / bpm;
}

/**
 * How many whole bars a region holds, rounded to the nearest 1/4 bar so a
 * slightly long render still reports "8 bars" instead of "8.03".
 */
export function loopBars(duration: number, bpm: number | null, beatsPerBar = 4): number {
  const bar = barSeconds(bpm, beatsPerBar);
  if (!bar || duration <= 0) return 0;
  return Math.max(0.25, Math.round((duration / bar) * 4) / 4);
}
