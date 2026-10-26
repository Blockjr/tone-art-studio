import { describe, expect, it } from 'vitest';
import {
  byteColumns,
  drawWaveform,
  peakBuckets,
  peakColumns,
  sampleColumns,
  type SampleSource,
} from '../src/audio/waveform';
import { computePeaks } from '../src/audio/dsp';

function sine(freq: number, seconds: number, rate = 48000, amplitude = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amplitude;
  return out;
}

function source(channels: Float32Array[]): SampleSource {
  return {
    numberOfChannels: channels.length,
    getChannelData: (index) => channels[index] ?? new Float32Array(0),
  };
}

describe('waveform peaks', () => {
  it('keeps the very first and very last samples', () => {
    const data = new Float32Array(1000);
    data[0] = 0.9;
    data[999] = -0.8;
    const peaks = computePeaks([data], 10);

    expect(peaks.length).toBe(20);
    expect(peaks[1]).toBeCloseTo(0.9, 6);
    expect(peaks[18]).toBeCloseTo(-0.8, 6);
  });

  it('spreads buckets over the whole file without leaving empty ones', () => {
    // 1003 samples over 7 buckets: a fixed integer step would leave the tail
    // unmeasured and push a bucket past the end.
    const data = new Float32Array(1003);
    for (let i = 0; i < data.length; i++) data[i] = 0.25;
    const peaks = computePeaks([data], 7);

    expect(peaks.length).toBe(14);
    for (let bucket = 0; bucket < 7; bucket++) {
      expect(peaks[bucket * 2 + 1]).toBeCloseTo(0.25, 6);
    }
  });

  it('measures every channel, not just the left one', () => {
    const left = new Float32Array(512);
    const right = new Float32Array(512);
    right[256] = 0.95;
    const peaks = computePeaks([left, right], 8);
    expect(Math.max(...peaks)).toBeCloseTo(0.95, 6);
  });

  it('never asks for more buckets than there are samples', () => {
    const peaks = computePeaks([new Float32Array(4)], 4096);
    expect(peaks.length).toBe(8);
  });
});

describe('summary density', () => {
  it('scales with length but stays bounded', () => {
    expect(peakBuckets(0)).toBe(900);
    expect(peakBuckets(2)).toBe(900);
    expect(peakBuckets(30)).toBeGreaterThan(900);
    expect(peakBuckets(60 * 60)).toBe(8192);
  });
});

describe('column envelopes', () => {
  it('never loses a transient when squeezed into few columns', () => {
    const peaks: number[] = [];
    for (let pair = 0; pair < 1000; pair++) peaks.push(-0.01, 0.01);
    peaks[517] = 0.98; // one loud pair deep inside the file

    const columns = 24;
    const env = peakColumns(peaks, columns);
    const heights = Array.from({ length: columns }, (_, column) => env[column * 2 + 1]);

    expect(Math.max(...heights)).toBeCloseTo(0.98, 6);
    // The spike is reachable rather than skipped over by an index step.
    expect(heights.filter((value) => value > 0.9).length).toBeGreaterThan(0);
  });

  it('reads every peak pair across the columns', () => {
    const peaks: number[] = [];
    for (let pair = 0; pair < 300; pair++) peaks.push(pair % 2 === 0 ? -0.5 : 0.5);
    const env = peakColumns(peaks, 17);

    let zeroColumns = 0;
    for (let column = 0; column < 17; column++) {
      if (env[column * 2] === 0 && env[column * 2 + 1] === 0) zeroColumns++;
    }
    expect(zeroColumns).toBe(0);
  });

  it('maps a slice of the file to the full width', () => {
    const peaks = [-1, -0.5, -0.5, 0, 0, 0.5, 0.5, 1];
    const env = peakColumns(peaks, 2, 0.5, 1);
    // Envelopes always reach back to the zero line, so a pair that sits entirely
    // above or below it fills the matching half only.
    expect(env[0]).toBeCloseTo(0, 6);
    expect(env[1]).toBeCloseTo(0.5, 6);
    expect(env[2]).toBeCloseTo(0, 6);
    expect(env[3]).toBeCloseTo(1, 6);
  });

  it('handles an empty or reversed window', () => {
    const empty = peakColumns([], 8);
    expect(Array.from(empty).every((value) => value === 0)).toBe(true);

    const peaks = [-1, -0.5, 0.5, 1];
    const reversed = peakColumns(peaks, 2, 1, 0);
    const forward = peakColumns(peaks, 2, 0, 1);
    expect(Array.from(reversed)).toEqual(Array.from(forward));
  });
});

describe('sample-accurate columns', () => {
  it('finds a spike in the column that contains it', () => {
    const data = new Float32Array(1000);
    data[500] = 0.75;
    const env = sampleColumns(source([data]), 10, 0, 1000);
    expect(env[5 * 2 + 1]).toBeCloseTo(0.75, 6);
    expect(env[0]).toBe(0);
  });

  it('shows the real shape of a sine instead of bucketed steps', () => {
    const data = sine(100, 0.05);
    const env = sampleColumns(source([data]), 64, 0, data.length);
    const heights = Array.from({ length: 64 }, (_, column) => env[column * 2 + 1]);
    expect(Math.max(...heights)).toBeGreaterThan(0.99);
    // A sampled envelope of a 100 Hz tone keeps its cycle peaks.
    expect(heights.filter((value) => value > 0.9).length).toBeGreaterThan(2);
  });

  it('folds stereo channels together and clamps to the buffer', () => {
    const left = new Float32Array(64);
    const right = new Float32Array(64);
    right[32] = -0.6;
    const env = sampleColumns(source([left, right]), 4, -100, 10_000);
    expect(env[2 * 2]).toBeCloseTo(-0.6, 6);
  });
});

describe('drawing', () => {
  function recorder(): { ctx: CanvasRenderingContext2D; calls: string[] } {
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      beginPath: () => calls.push('beginPath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      closePath: () => calls.push('closePath'),
      fill: () => calls.push('fill'),
      stroke: () => calls.push('stroke'),
      globalAlpha: 1,
      lineWidth: 1,
      lineJoin: 'round',
      fillStyle: '#4d8dff',
      strokeStyle: '#4d8dff',
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }

  it('draws a filled body with a stroked edge', () => {
    const { ctx, calls } = recorder();
    const peaks = computePeaks([sine(220, 0.5)], 900);
    const result = drawWaveform(ctx, { x: 0, y: 0, width: 200, height: 40, peaks });

    expect(result).toEqual({ columns: 200, sampled: false });
    expect(calls).toContain('fill');
    expect(calls.filter((call) => call === 'lineTo').length).toBeGreaterThan(200);
  });

  it('switches to the samples once a pixel is finer than a peak pair', () => {
    const data = sine(100, 1);
    const peaks = computePeaks([data], 900);
    const { ctx } = recorder();

    const wide = drawWaveform(ctx, { x: 0, y: 0, width: 200, height: 40, peaks, source: source([data]) });
    expect(wide?.sampled).toBe(false);

    const zoomed = drawWaveform(ctx, {
      x: 0,
      y: 0,
      width: 2000,
      height: 40,
      peaks,
      source: source([data]),
    });
    expect(zoomed?.sampled).toBe(true);
  });

  it('ignores a box with no size and draws a flat line for silence', () => {
    const { ctx, calls } = recorder();
    expect(drawWaveform(ctx, { x: 0, y: 0, width: 0, height: 40, peaks: [0, 0] })).toBeNull();

    drawWaveform(ctx, { x: 0, y: 0, width: 30, height: 40, peaks: [0, 0] });
    expect(calls).toContain('fill');
  });
});

describe('scope columns', () => {
  it('centres silence at zero and folds every byte into its column', () => {
    const bytes = new Uint8Array(100).fill(128);
    expect(Array.from(byteColumns(bytes, 10)).every((value) => value === 0)).toBe(true);

    bytes[50] = 255;
    bytes[51] = 0;
    const env = byteColumns(bytes, 10);
    expect(env[5 * 2 + 1]).toBeCloseTo(127 / 128, 6);
    expect(env[5 * 2]).toBeCloseTo(-128 / 128, 6);
  });

  it('survives an empty buffer', () => {
    expect(Array.from(byteColumns(new Uint8Array(0), 4)).every((value) => value === 0)).toBe(true);
  });
});
