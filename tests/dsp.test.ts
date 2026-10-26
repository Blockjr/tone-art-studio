import { describe, expect, it } from 'vitest';
import { computePeaks, detectOnsets, detectTempo, processChannels, resampleLinear, timeStretch } from '../src/audio/dsp';
import { AUTO_FADE_SECONDS, fadeEnvelope, resolveFades } from '../src/audio/fades';

const SR = 44100;

function sine(frequency: number, seconds: number, sampleRate = SR): Float32Array {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return data;
}

/** Frequency estimate from mean zero-crossing distance. */
function estimateFrequency(data: Float32Array, sampleRate = SR): number {
  let crossings = 0;
  let first = -1;
  let last = -1;

  for (let i = 1; i < data.length; i++) {
    if (data[i - 1] <= 0 && data[i] > 0) {
      crossings++;
      if (first < 0) first = i;
      last = i;
    }
  }

  if (crossings < 2 || last <= first) return 0;
  const period = (last - first) / (crossings - 1);
  return sampleRate / period;
}

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

describe('time-stretch and pitch', () => {
  it('resamples to a shorter, higher signal', () => {
    const tone = sine(220, 0.5);
    const up = resampleLinear(tone, 2);

    expect(up.length).toBeCloseTo(tone.length / 2, -1);
    expect(estimateFrequency(up)).toBeGreaterThan(400);
  });

  it('halves the duration at double rate without moving the pitch', () => {
    const tone = sine(220, 1);
    const fast = timeStretch(tone, 2);

    expect(fast.length).toBeCloseTo(tone.length / 2, -2);
    expect(estimateFrequency(fast)).toBeGreaterThan(210);
    expect(estimateFrequency(fast)).toBeLessThan(230);
    expect(rms(fast)).toBeGreaterThan(0.4);
  });

  it('doubles the duration at half rate without moving the pitch', () => {
    const tone = sine(220, 1);
    const slow = timeStretch(tone, 0.5);

    expect(slow.length).toBeCloseTo(tone.length * 2, -2);
    expect(estimateFrequency(slow)).toBeGreaterThan(210);
    expect(estimateFrequency(slow)).toBeLessThan(230);
  });

  it('shifts pitch an octave up while keeping the duration', () => {
    const tone = sine(220, 1);
    const [shifted] = processChannels([tone], { tempoRate: 1, pitchRatio: 2 });

    expect(shifted.length).toBeCloseTo(tone.length, -2);
    expect(estimateFrequency(shifted)).toBeGreaterThan(425);
    expect(estimateFrequency(shifted)).toBeLessThan(455);
  });

  it('shifts pitch an octave down while keeping the duration', () => {
    const tone = sine(440, 1);
    const [shifted] = processChannels([tone], { tempoRate: 1, pitchRatio: 0.5 });

    expect(shifted.length).toBeCloseTo(tone.length, -2);
    expect(estimateFrequency(shifted)).toBeGreaterThan(205);
    expect(estimateFrequency(shifted)).toBeLessThan(235);
  });

  it('changes tempo without changing pitch', () => {
    const tone = sine(330, 1);
    const [faster] = processChannels([tone], { tempoRate: 1.5, pitchRatio: 1 });

    expect(faster.length).toBeCloseTo(tone.length / 1.5, -2);
    expect(estimateFrequency(faster)).toBeGreaterThan(315);
    expect(estimateFrequency(faster)).toBeLessThan(345);
  });

  it('leaves the signal alone at neutral settings', () => {
    const tone = sine(220, 0.2);
    const [same] = processChannels([tone]);
    expect(same.length).toBe(tone.length);
    expect(same[100]).toBeCloseTo(tone[100], 5);
  });
});

describe('tempo detection', () => {
  function clickTrain(bpm: number, seconds = 8): Float32Array {
    const data = new Float32Array(Math.round(SR * seconds));
    const interval = Math.round((60 / bpm) * SR);

    for (let start = 0; start < data.length; start += interval) {
      for (let i = 0; i < 400 && start + i < data.length; i++) {
        data[start + i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * Math.exp(-i / 90);
      }
    }

    return data;
  }

  it('finds a 120 BPM pulse', () => {
    const estimate = detectTempo([clickTrain(120)], SR);
    expect(estimate.bpm).toBeGreaterThan(117);
    expect(estimate.bpm).toBeLessThan(123);
    expect(estimate.confidence).toBeGreaterThan(0);
  });

  it('finds a 90 BPM pulse', () => {
    const estimate = detectTempo([clickTrain(90)], SR);
    expect(estimate.bpm).toBeGreaterThan(87);
    expect(estimate.bpm).toBeLessThan(93);
  });

  it('returns zero for silence', () => {
    const estimate = detectTempo([new Float32Array(SR * 2)], SR);
    expect(estimate.bpm).toBe(0);
    expect(estimate.confidence).toBe(0);
  });
});

describe('onset detection for slicing', () => {
  function hits(times: number[], seconds = 4): Float32Array {
    const data = new Float32Array(Math.round(SR * seconds));
    for (const time of times) {
      const start = Math.round(time * SR);
      for (let i = 0; i < 2200 && start + i < data.length; i++) {
        data[start + i] = Math.sin((2 * Math.PI * 900 * i) / SR) * Math.exp(-i / 500);
      }
    }
    return data;
  }

  it('finds each hit of a click train close to its true time', () => {
    const found = detectOnsets([hits([0.25, 0.9, 1.55, 2.4])], SR, { threshold: 0.15, minGap: 0.05 });
    expect(found.length).toBeGreaterThanOrEqual(4);
    const wanted = [0.25, 0.9, 1.55, 2.4];
    for (const time of wanted) {
      expect(found.some((onset) => Math.abs(onset - time) < 0.03)).toBe(true);
    }
  });

  it('returns nothing for silence', () => {
    expect(detectOnsets([new Float32Array(SR)], SR)).toEqual([]);
  });
});

describe('waveform peaks', () => {
  it('produces min/max pairs inside the sample range', () => {
    const peaks = computePeaks([sine(220, 0.5)], 64);
    expect(peaks.length).toBe(128);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...peaks)).toBeGreaterThan(0.9);
  });
});

describe('clip fades', () => {
  it('applies the auto declick when a clip has no explicit fades', () => {
    expect(resolveFades({}, true, 4)).toEqual({ in: AUTO_FADE_SECONDS, out: AUTO_FADE_SECONDS });
    expect(resolveFades({}, false, 4)).toEqual({ in: 0, out: 0 });
  });

  it('honours explicit fades and clamps them to the clip', () => {
    expect(resolveFades({ fadeIn: 0.5, fadeOut: 1.5 }, true, 4)).toEqual({ in: 0.5, out: 1.5 });
    expect(resolveFades({ fadeIn: 3, fadeOut: 3 }, true, 2)).toEqual({ in: 1, out: 1 });
    expect(resolveFades({ fadeIn: 0, fadeOut: 0 }, true, 4)).toEqual({ in: 0, out: 0 });
  });

  it('builds a click-free envelope from silence back to silence', () => {
    const points = fadeEnvelope(10, 2, { in: 0.25, out: 0.5 }, 0.8);

    expect(points[0].gain).toBe(0);
    expect(points[0].time).toBe(10);
    expect(points[1]).toEqual({ time: 10.25, gain: 0.8 });
    expect(points[2].time).toBeCloseTo(11.5, 6);
    expect(points[3]).toEqual({ time: 12, gain: 0 });
  });

  it('skips zero-length fades instead of producing duplicate ramps', () => {
    const points = fadeEnvelope(0, 1, { in: 0, out: 0 }, 1);
    expect(points[0]).toEqual({ time: 0, gain: 1 });
    expect(points[points.length - 1].gain).toBe(1);
  });
});
