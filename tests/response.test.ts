import { describe, expect, it } from 'vitest';
import {
  airGainDb,
  biquadGainDb,
  chainGainDb,
  compressorGainDb,
  driveCurve,
  filterBands,
  responsePoints,
} from '../src/audio/response';

describe('biquad responses', () => {
  it('puts a flat low-pass corner at −3 dB', () => {
    const db = biquadGainDb({ type: 'lowpass', freq: 1000, q: -3.01 }, 48000, 1000);
    expect(db).toBeCloseTo(-3.01, 0);
    expect(biquadGainDb({ type: 'lowpass', freq: 1000, q: -3.01 }, 48000, 100)).toBeGreaterThan(-0.2);
    expect(biquadGainDb({ type: 'lowpass', freq: 1000, q: -3.01 }, 48000, 10000)).toBeLessThan(-30);
  });

  it('peak and shelf filters hit their advertised gain', () => {
    expect(biquadGainDb({ type: 'peaking', freq: 1200, q: 1, gain: 6 }, 48000, 1200)).toBeCloseTo(6, 1);
    expect(biquadGainDb({ type: 'lowshelf', freq: 200, q: 0.707, gain: -9 }, 48000, 20)).toBeCloseTo(-9, 0);
    expect(biquadGainDb({ type: 'highshelf', freq: 8000, q: 0.707, gain: 4 }, 48000, 19000)).toBeCloseTo(4, 0);
    // Unity shelves are exactly transparent at every frequency.
    expect(biquadGainDb({ type: 'lowshelf', freq: 200, q: 0.707, gain: 0 }, 48000, 1000)).toBeCloseTo(0, 3);
  });

  it('sums a chain of bands into one curve', () => {
    const bands = [
      { shape: { type: 'lowshelf' as const, freq: 220, q: 0.707, gain: 6 } },
      { shape: { type: 'peaking' as const, freq: 1200, q: 1, gain: -6 } },
      { shape: { type: 'highshelf' as const, freq: 3800, q: 0.707, gain: 3 } },
    ];
    expect(chainGainDb(bands, 48000, 40)).toBeGreaterThan(3);
    expect(chainGainDb(bands, 48000, 1200)).toBeLessThan(0);
    expect(chainGainDb(bands, 48000, 18000)).toBeGreaterThan(1);
    expect(responsePoints(bands, 48000, 64)).toHaveLength(64);
    const points = responsePoints(bands, 48000, 8);
    expect(points[0].freq).toBeCloseTo(20, 0);
    expect(points.at(-1)!.freq).toBeCloseTo(20000, 0);
  });

  it('builds the filter response from the mode and resonance', () => {
    const low = filterBands({ type: 'lowpass', freq: 500, q: 0 });
    const high = filterBands({ type: 'highpass', freq: 5000, q: 0 });
    expect(chainGainDb(low, 48000, 100)).toBeGreaterThan(0);
    expect(chainGainDb(high, 48000, 100)).toBeLessThan(-50);
  });
});

describe('compressor gain computer', () => {
  it('passes anything below the threshold', () => {
    expect(compressorGainDb(-40, { threshold: -20, ratio: 4, knee: 0 })).toBeCloseTo(-40, 5);
    // Below the knee half-width, even a soft knee stays transparent.
    expect(compressorGainDb(-30, { threshold: -20, ratio: 4, knee: 6 })).toBeCloseTo(-30, 6);
  });

  it('compresses above the threshold by the ratio', () => {
    expect(compressorGainDb(-10, { threshold: -20, ratio: 4, knee: 0 })).toBeCloseTo(-17.5, 4);
    expect(compressorGainDb(0, { threshold: -20, ratio: 10, knee: 0 })).toBeCloseTo(-18, 4);
  });

  it('rounds the transition with a soft knee and stays monotonic', () => {
    const hard = compressorGainDb(-20, { threshold: -20, ratio: 4, knee: 0 });
    const soft = compressorGainDb(-20, { threshold: -20, ratio: 4, knee: 12 });
    expect(soft).toBeLessThan(hard);
    let previous = -Infinity;
    for (let db = -60; db <= 6; db += 0.5) {
      const out = compressorGainDb(db, { threshold: -20, ratio: 4, knee: 12 });
      expect(out).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = out;
    }
  });
});

describe('display curves', () => {
  it('bends the transfer curve with drive but stays symmetric and bounded', () => {
    const clean = driveCurve(0);
    expect(clean[0].y).toBeCloseTo(-1, 6);
    expect(clean.at(-1)!.y).toBeCloseTo(1, 6);
    const driven = driveCurve(0.8);
    // Odd point count puts one sample exactly at zero crossing.
    const centred = driveCurve(0.8, 121);
    expect(centred[60].y).toBeCloseTo(0, 6);
    // The shape is odd-symmetric: x and −x bend by the same amount.
    for (const index of [10, 30, 48, 50]) {
      expect(driven[index].y).toBeCloseTo(-driven[driven.length - 1 - index].y, 6);
    }
    expect(driven[Math.floor(driven.length * 0.7)].y).toBeGreaterThan(clean[Math.floor(clean.length * 0.7)].y);
  });

  it('draws an air shelf that lifts the top end', () => {
    expect(airGainDb(16000, 25, 35)).toBeGreaterThan(3);
    expect(airGainDb(1000, 25, 35)).toBeLessThan(1);
  });
});
