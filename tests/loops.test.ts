import { describe, expect, it } from 'vitest';
import {
  analyseLoop,
  barSeconds,
  detectOnsets,
  estimateLoopTempo,
  loopBars,
  parseTempoTag,
  signalFromBuffer,
  sliceBuffer,
  sliceRegion,
  snapRegionToBars,
} from '../src/audio/loops';

const RATE = 44100;

/** A kick-and-hat pattern, the shape the detector is tuned for. */
function clickTrack(bpm: number, seconds: number, sampleRate = RATE): Float32Array {
  const samples = new Float32Array(Math.ceil(seconds * sampleRate));
  const beat = 60 / bpm;

  for (let b = 0; b * beat < seconds; b++) {
    const at = Math.round(b * beat * sampleRate);
    const kick = b % 4 === 0 ? 1 : 0.55;
    const decay = Math.exp(-1 / (0.05 * sampleRate));

    for (let i = 0; i < 0.08 * sampleRate && at + i < samples.length; i++) {
      const envelope = Math.exp(-i / (0.02 * sampleRate));
      samples[at + i] += Math.sin((2 * Math.PI * 70 * i) / sampleRate) * envelope * kick;
      if (i < 20) samples[at + i] += (Math.random() * 2 - 1) * 0.25;
    }

    // An eighth-note hat, quiet enough to test the log-compressed envelope.
    const offbeat = Math.round((b + 0.5) * beat * sampleRate);
    for (let i = 0; i < 0.01 * sampleRate && offbeat + i < samples.length; i++) {
      const envelope = Math.exp(-i / (0.002 * sampleRate)) * decay;
      samples[offbeat + i] += (Math.random() * 2 - 1) * 0.18 * envelope;
    }
  }

  return samples;
}

function signal(samples: Float32Array, sampleRate = RATE) {
  return { samples, sampleRate, duration: samples.length / sampleRate };
}

/** Minimal AudioBuffer stand-in for the analysis and slicing helpers. */
function fakeBuffer(channels: Float32Array[], sampleRate = RATE): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    duration: channels[0].length / sampleRate,
    getChannelData: (channel: number) => channels[channel],
  } as unknown as AudioBuffer;
}

function fakeContext(): BaseAudioContext {
  return {
    createBuffer: (channelCount: number, length: number, sampleRate: number) => {
      const data = Array.from({ length: channelCount }, () => new Float32Array(length));
      return {
        numberOfChannels: channelCount,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (channel: number) => data[channel],
        copyToChannel: (source: Float32Array, channel: number) => data[channel].set(source),
      } as unknown as AudioBuffer;
    },
  } as unknown as BaseAudioContext;
}

describe('BPM tags', () => {
  it('reads an explicit tempo from a file name', () => {
    expect(parseTempoTag('break_174bpm.wav')).toBe(174);
    expect(parseTempoTag('Loop 120 BPM.wav')).toBe(120);
    expect(parseTempoTag('arp@128.wav')).toBe(128);
    expect(parseTempoTag('120bpm-chords.aiff')).toBe(120);
  });

  it('does not mistake a take number for a tempo', () => {
    expect(parseTempoTag('take 12.wav')).toBeNull();
    expect(parseTempoTag('vox_999bpm.wav')).toBeNull();
    expect(parseTempoTag('')).toBeNull();
  });

  it('lets the tag win over the detector', () => {
    const buffer = fakeBuffer([clickTrack(100, 8)]);
    const result = analyseLoop(signalFromBuffer(buffer), { name: '120bpm-loop.wav' });

    expect(result.bpm).toBe(120);
    expect(result.locked).toBe(true);
    expect(result.source).toBe('tag');
    expect(result.confidence).toBe(1);
  });
});

describe('tempo detection', () => {
  for (const bpm of [100, 128, 174]) {
    it(`detects ${bpm} BPM from a click pattern`, () => {
      const buffer = fakeBuffer([clickTrack(bpm, 8)]);
      const result = estimateLoopTempo(signalFromBuffer(buffer));

      expect(result.bpm).not.toBeNull();
      expect(Math.abs((result.bpm as number) - bpm)).toBeLessThan(1.5);
      expect(result.confidence).toBeGreaterThan(0.05);
      expect(result.offset).toBeGreaterThanOrEqual(0);
    });
  }

  it('reports no tempo for silence', () => {
    const result = estimateLoopTempo(signal(new Float32Array(RATE * 2)));
    expect(result.bpm).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('finds onsets where the drum hits are', () => {
    const onsets = detectOnsets(signal(clickTrack(120, 2.5)), 0.3);

    expect(onsets.length).toBeGreaterThanOrEqual(4);
    expect(onsets[0].time).toBeLessThan(0.06);
    expect(onsets[1].time).toBeGreaterThan(0.4);
    expect(onsets[1].time).toBeLessThan(0.6);
  });
});

describe('loop slicing', () => {
  it('cuts a region into one-bar slices on the tempo grid', () => {
    // 120 BPM: a bar is 2 s, so eight seconds is four bars.
    const slices = sliceRegion({ start: 0, end: 8 }, { bpm: 120, grid: 'bar' });

    expect(slices).toHaveLength(4);
    expect(slices[0]).toEqual({ start: 0, end: 2 });
    expect(slices[3]).toEqual({ start: 6, end: 8 });
  });

  it('spans several bars per slice when asked', () => {
    const slices = sliceRegion({ start: 0, end: 8 }, { bpm: 120, grid: 'bar', barsPerSlice: 2 });
    expect(slices).toHaveLength(2);
    expect(slices[1]).toEqual({ start: 4, end: 8 });
  });

  it('cuts on the grid rather than at the drag start', () => {
    const slices = sliceRegion({ start: 0.3, end: 8.3 }, { bpm: 120, grid: 'bar', align: 0 });

    expect(slices[0].start).toBeCloseTo(0.3, 6);
    expect(slices[0].end).toBeCloseTo(2, 6);
    expect(slices[1]).toEqual({ start: 2, end: 4 });
  });

  it('cuts beats and eighths', () => {
    expect(sliceRegion({ start: 0, end: 2 }, { bpm: 120, grid: 'beat' })).toHaveLength(4);
    expect(sliceRegion({ start: 0, end: 2 }, { bpm: 120, grid: 'half' })).toHaveLength(8);
  });

  it('falls back to halves without a tempo', () => {
    const slices = sliceRegion({ start: 1, end: 5 });
    expect(slices).toEqual([
      { start: 1, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it('drops cuts that would make a sliver', () => {
    // A 10 ms tail is not a slice: the cut at the bar is dropped instead.
    expect(sliceRegion({ start: 0, end: 2.01 }, { bpm: 120, grid: 'bar', minSlice: 0.05 })).toHaveLength(1);
    expect(sliceRegion({ start: 0, end: 2.06 }, { bpm: 120, grid: 'bar', minSlice: 0.05 })).toHaveLength(2);
  });

  it('snaps transients to the beat when they are close', () => {
    const onsets = [
      { time: 0.52, strength: 1 },
      { time: 1.04, strength: 0.8 },
      { time: 2.4, strength: 0.9 },
    ];
    const slices = sliceRegion(
      { start: 0, end: 4 },
      { bpm: 120, grid: 'transient', onsets, align: 0 },
    );

    const starts = slices.map((slice) => slice.start);
    expect(starts).toContain(0.5);
    expect(starts).toContain(1);
    // 2.4 is 0.1 s past the beat, outside the snap window, so it stays put.
    expect(starts).toContain(2.4);
  });

  it('expands a selection to whole bars', () => {
    const snapped = snapRegionToBars({ start: 0.4, end: 3.6 }, 120);
    expect(snapped).toEqual({ start: 0, end: 4 });
  });

  it('aligns to the first hit when one is known', () => {
    const snapped = snapRegionToBars({ start: 0.15, end: 1.9 }, 120, 0.1);
    expect(snapped.start).toBeCloseTo(0.1, 6);
    expect(snapped.end).toBeCloseTo(2.1, 6);
  });
});

describe('loop measurements', () => {
  it('converts bars and seconds both ways', () => {
    expect(barSeconds(120)).toBe(2);
    expect(loopBars(8, 120)).toBe(4);
    expect(loopBars(7.98, 120)).toBe(4);
    expect(loopBars(8, null)).toBe(0);
  });
});

describe('buffer helpers', () => {
  it('mixes channels to mono for analysis', () => {
    const left = new Float32Array([1, 1, 1, 1]);
    const right = new Float32Array([-1, -1, -1, -1]);
    const mono = signalFromBuffer(fakeBuffer([left, right], 4));

    expect(Array.from(mono.samples)).toEqual([0, 0, 0, 0]);
    expect(mono.duration).toBe(1);
  });

  it('copies a slice into a new buffer', () => {
    const data = new Float32Array(RATE * 2);
    data[0] = 0.5;
    data[RATE] = 0.25;
    data[Math.round(RATE * 1.4)] = 0.75;

    const cut = sliceBuffer(fakeContext(), fakeBuffer([data]), 1, 1.5);
    expect(cut.length).toBe(RATE * 0.5);
    expect(cut.getChannelData(0)[0]).toBeCloseTo(0.25, 6);
    expect(cut.getChannelData(0)[Math.round(RATE * 0.4)]).toBeCloseTo(0.75, 6);
  });
});
