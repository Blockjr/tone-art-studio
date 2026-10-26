/**
 * Waveform drawing shared by the arrangement, the preview player, the take
 * list and the mixer scopes.
 *
 * Summary peaks are min/max pairs over 0..1. Every pair that falls inside a
 * pixel column is folded in, so a single-sample transient still stands at full
 * height when a four-bar loop is squeezed into a handful of pixels. Once the
 * zoom goes past the resolution of the summary — or the summary is missing —
 * the same columns are measured from the samples themselves, which is what
 * makes a zoomed-in waveform the real shape rather than a staircase.
 */

export interface SampleSource {
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

const MIN_BUCKETS = 900;
const MAX_BUCKETS = 8192;
/** Samples a single redraw may read before it settles for the summary peaks. */
const SAMPLE_BUDGET = 400_000;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Pairs to keep for a source of this length: about one pair per pixel at
 * normal zoom, capped so a long file does not bloat the saved project.
 */
export function peakBuckets(seconds: number, pairsPerSecond = 90): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return MIN_BUCKETS;
  return clamp(Math.round(seconds * pairsPerSecond), MIN_BUCKETS, MAX_BUCKETS);
}

/**
 * Min/max per column across the `from`..`to` slice of the peaks, both 0..1.
 * Columns narrower than one pair repeat that pair instead of reading nothing,
 * and pairs of a reversed clip are handled by the caller.
 */
export function peakColumns(peaks: number[], columns: number, from = 0, to = 1): Float32Array {
  const count = Math.max(1, Math.floor(columns));
  const out = new Float32Array(count * 2);
  const pairs = Math.floor(peaks.length / 2);
  if (pairs === 0) return out;

  const lo = clamp(Math.min(from, to), 0, 1);
  const hi = clamp(Math.max(from, to), 0, 1);
  const span = hi - lo;

  for (let column = 0; column < count; column++) {
    const start = lo + (span * column) / count;
    const end = lo + (span * (column + 1)) / count;

    let first = clamp(Math.floor(start * pairs), 0, pairs - 1);
    let last = clamp(Math.ceil(end * pairs) - 1, first, pairs - 1);
    if (last < first) last = first;

    let min = 0;
    let max = 0;
    for (let index = first; index <= last; index++) {
      const low = peaks[index * 2] ?? 0;
      const high = peaks[index * 2 + 1] ?? 0;
      if (low < min) min = low;
      if (high > max) max = high;
    }

    out[column * 2] = clamp(min, -1, 1);
    out[column * 2 + 1] = clamp(max, -1, 1);
  }

  return out;
}

/** Min/max per column measured from the samples, for sample-accurate zoom. */
export function sampleColumns(
  source: SampleSource,
  columns: number,
  fromSample: number,
  toSample: number,
): Float32Array {
  const count = Math.max(1, Math.floor(columns));
  const out = new Float32Array(count * 2);

  const channels = Math.max(1, Math.min(8, source.numberOfChannels || 1));
  const data: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel++) data.push(source.getChannelData(channel));
  const total = data[0]?.length ?? 0;
  if (total === 0) return out;

  const lo = clamp(Math.min(fromSample, toSample), 0, total);
  const hi = clamp(Math.max(fromSample, toSample), 0, total);
  const span = hi - lo;

  for (let column = 0; column < count; column++) {
    const start = Math.floor(lo + (span * column) / count);
    const end = Math.max(start + 1, Math.floor(lo + (span * (column + 1)) / count));

    let min = 0;
    let max = 0;
    for (const channel of data) {
      for (let i = start; i < end && i < total; i++) {
        const value = channel[i] ?? 0;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }

    out[column * 2] = clamp(min, -1, 1);
    out[column * 2 + 1] = clamp(max, -1, 1);
  }

  return out;
}

/** Min/max per column from a byte time-domain buffer (128 is silence). */
export function byteColumns(bytes: ArrayLike<number>, columns: number): Float32Array {
  const count = Math.max(1, Math.floor(columns));
  const out = new Float32Array(count * 2);
  const length = bytes.length;
  if (length === 0) return out;

  for (let column = 0; column < count; column++) {
    const start = Math.floor((column * length) / count);
    const end = Math.max(start + 1, Math.min(length, Math.floor(((column + 1) * length) / count)));

    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      const value = ((bytes[i] ?? 128) - 128) / 128;
      if (value < min) min = value;
      if (value > max) max = value;
    }

    out[column * 2] = clamp(min, -1, 1);
    out[column * 2 + 1] = clamp(max, -1, 1);
  }

  return out;
}

export interface WaveformPaint {
  x: number;
  y: number;
  width: number;
  height: number;
  peaks: number[];
  /** decoded audio for this asset, when it is still in memory */
  source?: SampleSource | null;
  /** progress window into the source, 0..1, in playback direction */
  from?: number;
  to?: number;
  /** draw the window right to left, for reversed clips */
  reversed?: boolean;
  color?: string;
  edge?: string;
  /** 1 fills the box; lower leaves a margin */
  scale?: number;
  /** samples one redraw may read before falling back to the peaks */
  sampleBudget?: number;
}

export interface WaveformDrawn {
  columns: number;
  /** true when the columns came from the samples rather than the summary */
  sampled: boolean;
}

/**
 * Draws a waveform into a box, one envelope column per pixel: a filled body
 * with a bright edge, the shape every editor shows. Returns how it was drawn.
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  paint: WaveformPaint,
): WaveformDrawn | null {
  const width = paint.width;
  const height = paint.height;
  if (!(width >= 1) || !(height >= 1)) return null;

  const columns = Math.max(1, Math.round(width));
  const from = paint.from ?? 0;
  const to = paint.to ?? 1;
  const pairs = Math.floor(paint.peaks.length / 2);

  let env: Float32Array | null = null;
  let sampled = false;

  const source = paint.source ?? null;
  if (source && source.numberOfChannels > 0) {
    const total = source.getChannelData(0).length;
    const spanSamples = Math.abs(to - from) * total;
    const perColumn = spanSamples / columns;
    const perPair = pairs > 0 ? total / pairs : 0;

    // The summary can only resolve what one pair covers; below that the samples
    // are both more truthful and cheaper to read.
    const summaryTooCoarse = perPair === 0 || perColumn < perPair;
    const budget = paint.sampleBudget ?? SAMPLE_BUDGET;
    if (summaryTooCoarse && columns * perColumn <= budget) {
      env = sampleColumns(source, columns, from * total, to * total);
      sampled = true;
    }
  }

  if (!env) env = peakColumns(paint.peaks, columns, from, to);

  if (paint.reversed) {
    const flipped = new Float32Array(env.length);
    for (let column = 0; column < columns; column++) {
      const mirror = columns - 1 - column;
      flipped[column * 2] = env[mirror * 2] ?? 0;
      flipped[column * 2 + 1] = env[mirror * 2 + 1] ?? 0;
    }
    env = flipped;
  }

  const mid = paint.y + height / 2;
  const amplitude = (height / 2) * (paint.scale ?? 1);
  const color = paint.color ?? ctx.strokeStyle?.toString() ?? '#4d8dff';
  const edge = paint.edge ?? color;
  const columnWidth = width / columns;

  const top = new Float32Array(columns);
  const bottom = new Float32Array(columns);
  for (let column = 0; column < columns; column++) {
    const min = clamp(env[column * 2] ?? 0, -1, 1);
    const max = clamp(env[column * 2 + 1] ?? 0, -1, 1);
    const up = mid - max * amplitude;
    const down = mid - min * amplitude;
    // A signal that is there but tiny still has to be visible; anything below a
    // pixel reads as silence otherwise.
    top[column] = max > 0 ? Math.min(up, mid - 0.75) : Math.min(up, mid);
    bottom[column] = min < 0 ? Math.max(down, mid + 0.75) : Math.max(down, mid);
  }

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(paint.x, top[0] ?? mid);
  for (let column = 1; column < columns; column++) {
    ctx.lineTo(paint.x + column * columnWidth, top[column] ?? mid);
  }
  for (let column = columns - 1; column >= 0; column--) {
    ctx.lineTo(paint.x + column * columnWidth, bottom[column] ?? mid);
  }
  ctx.closePath();

  ctx.globalAlpha = 0.72;
  ctx.fillStyle = color;
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();

  return { columns, sampled };
}
