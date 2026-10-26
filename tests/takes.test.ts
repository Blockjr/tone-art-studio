// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/core/session';
import { Store } from '../src/core/store';
import { TakePanel } from '../src/ui/comp';
import {
  describeCapture,
  loopSlicesFromCapture,
  mergeChunks,
  scanPeak,
  takeFromRecording,
  type CaptureFormat,
  type RecordingResult,
} from '../src/audio/recorder';
import {
  clipFromTake,
  compOverRange,
  normalizeTakes,
  takeOverlap,
  takesForTrack,
} from '../src/core/takes';
import { createTrack, demoProject } from '../src/core/project';
import { parseProject, serializeProject } from '../src/core/session';
import { projectAssetIds } from '../src/audio/assets';
import type { Clip, Take, Track } from '../src/core/types';

const track = (id: string): Track => ({
  id,
  name: id,
  kind: 'audio',
  color: '#fff',
  volume: 0.8,
  gain: 0,
  eq: { hp: 30, low: 0, mid: 0, midFreq: 1000, high: 0 },
  eqOn: true,
  pan: 0,
  mute: false,
  solo: false,
  armed: false,
  sends: [0, 0, 0, 0],
  preSends: [false, false, false, false],
  instrument: null,
  devices: [],
});

const take = (overrides: Partial<Take> = {}): Take => ({
  id: 'take-1',
  trackId: 'a',
  assetId: 'asset-1',
  name: 'Take 1',
  start: 8,
  length: 8,
  offset: 0,
  gain: 1,
  pass: 1,
  createdAt: 0,
  ...overrides,
});

const clip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  trackId: 'a',
  name: 'Clip',
  kind: 'audio',
  start: 0,
  length: 16,
  color: '#fff',
  notes: [],
  assetId: 'asset-1',
  offset: 0,
  gain: 1,
  ...overrides,
});

describe('take model', () => {
  it('repairs malformed takes and keeps them with their tracks', () => {
    const takes = normalizeTakes(
      [
        { id: 'one', trackId: 'a', assetId: 'asset', start: 4, length: 8, pass: 2 },
        { id: 'one', trackId: 'a', assetId: 'asset', start: 12, length: 4 },
        { trackId: 'missing', assetId: 'asset', start: 0, length: 4 },
        { trackId: 'a', start: 0, length: 4 },
        { trackId: 'a', assetId: 'asset', start: -1, length: 4 },
        { trackId: 'a', assetId: 'asset', start: 0, length: 0 },
        null,
      ],
      [track('a')],
    );

    expect(takes).toHaveLength(2);
    expect(new Set(takes.map((entry) => entry.id)).size).toBe(2);
    expect(takes[0].pass).toBe(2);
    expect(takes[1].start).toBe(12);
    expect(takes[1].length).toBe(4);
    expect(takes[0].gain).toBe(1);
  });

  it('orders takes by pass and finds the selected overlap', () => {
    const project = { takes: [take({ id: 'b', pass: 2 }), take({ id: 'a', pass: 1 })] };
    expect(takesForTrack(project, 'a').map((entry) => entry.id)).toEqual(['a', 'b']);

    expect(takeOverlap(take(), null)).toEqual({ start: 8, end: 16 });
    expect(takeOverlap(take(), { start: 12, end: 20 })).toEqual({ start: 12, end: 16 });
    expect(takeOverlap(take(), { start: 20, end: 24 })).toBeNull();
  });

  it('builds a clip that reads the take at the right offset', () => {
    const source = take({ start: 8, offset: 1.5 });
    const built = clipFromTake(source, track('a'), 120, { start: 10, end: 12 });

    expect(built.trackId).toBe('a');
    expect(built.start).toBe(10);
    expect(built.length).toBe(2);
    expect(built.assetId).toBe('asset-1');
    expect(built.offset).toBeCloseTo(1.5 + 2 * 0.5);
    expect(built.fadeIn).toBeGreaterThan(0);
    expect(built.fadeOut).toBeGreaterThan(0);
  });
});

describe('comp slicing', () => {
  const replacement = clip({ id: 'new', start: 4, length: 4 });

  it('trims clips that cross the comp edges', () => {
    const result = compOverRange([clip({ start: 0, length: 16 })], 'a', 4, 8, replacement, 120);
    const ids = result.map((entry) => entry.id);

    expect(result).toHaveLength(3);
    expect(ids).toContain('new');
    const before = result.find((entry) => entry.start === 0)!;
    const after = result.find((entry) => entry.start === 8)!;
    expect(before.length).toBe(4);
    expect(after.length).toBe(8);
    expect(after.offset).toBeCloseTo(8 * 0.5);
  });

  it('replaces fully covered clips and leaves other tracks alone', () => {
    const other = clip({ id: 'other', trackId: 'b', start: 0, length: 16 });
    const result = compOverRange(
      [clip({ id: 'covered', start: 4, length: 4 }), other],
      'a',
      4,
      8,
      replacement,
      120,
    );

    expect(result.map((entry) => entry.id)).toEqual(['other', 'new']);
  });

  it('splits one clip into the material before and after a comp', () => {
    const result = compOverRange([clip({ start: 0, length: 16 })], 'a', 6, 10, { ...replacement, start: 6, length: 4 }, 120);
    expect(result).toHaveLength(3);
    expect(result.filter((entry) => entry.id !== 'new')).toHaveLength(2);
    expect(result[0].start).toBe(0);
    expect(result[0].length).toBe(6);
    expect(result[2].start).toBe(10);
    expect(result[2].length).toBe(6);
  });

  it('keeps comps ordered on the track', () => {
    const result = compOverRange([clip({ start: 12, length: 4 })], 'a', 4, 8, replacement, 120);
    expect(result.map((entry) => entry.start)).toEqual([4, 12]);
  });
});

describe('recording alignment', () => {
  it('merges captured blocks into channels', () => {
    const merged = mergeChunks([
      [new Float32Array([1, 2]), new Float32Array([3, 4])],
      [new Float32Array([5]), new Float32Array([6])],
    ]);

    expect(merged).toHaveLength(2);
    expect([...merged[0]]).toEqual([1, 2, 5]);
    expect([...merged[1]]).toEqual([3, 4, 6]);
  });

  it('trims pre-roll back to the transport start beat', () => {
    const frames = 48000;
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = i;
    const result: RecordingResult = {
      channels: [samples],
      sampleRate: 48000,
      frames,
      startTime: 10,
      endTime: 10.5,
    };

    const trimmed = takeFromRecording(result, { ctxTime: 10.1, beat: 8 }, 120);
    expect(trimmed).not.toBeNull();
    expect(trimmed!.startBeat).toBeCloseTo(8);
    expect(trimmed!.lengthBeats).toBeCloseTo(0.8);
    expect(trimmed!.channels[0][0]).toBe(4800);
    expect(trimmed!.channels[0]).toHaveLength(19200);
  });

  it('starts late when capture began after the transport', () => {
    const result: RecordingResult = {
      channels: [new Float32Array(48000)],
      sampleRate: 48000,
      frames: 48000,
      startTime: 10.2,
      endTime: 10.5,
    };

    const trimmed = takeFromRecording(result, { ctxTime: 10.1, beat: 8 }, 120);
    expect(trimmed!.startBeat).toBeCloseTo(8.2);
    expect(trimmed!.lengthBeats).toBeCloseTo(0.6);
  });

  it('cuts a loop pass into one take per lap plus a final partial', () => {
    const sampleRate = 48000;
    const lapFrames = 96000; // 4 beats at 120 BPM
    const frames = lapFrames * 2 + 24000;
    const samples = new Float32Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = i;

    const result: RecordingResult = {
      channels: [samples],
      sampleRate,
      frames,
      startTime: 10,
      endTime: 10 + frames / sampleRate,
    };

    const slices = loopSlicesFromCapture(result, { ctxTime: 10, beat: 8 }, { start: 8, end: 12 }, 120);

    expect(slices).toHaveLength(3);
    expect(slices.map((slice) => slice.lengthBeats)).toEqual([4, 4, 1]);
    expect(slices.map((slice) => slice.complete)).toEqual([true, true, false]);
    expect(slices.every((slice) => slice.startBeat === 8)).toBe(true);
    expect(slices[0].channels[0]).toHaveLength(lapFrames);
    expect(slices[0].channels[0][0]).toBe(0);
    expect(slices[1].channels[0][0]).toBe(lapFrames);
    expect(slices[2].channels[0][0]).toBe(lapFrames * 2);
  });

  it('pads a late capture so every lap starts on the loop', () => {
    const sampleRate = 48000;
    const lapFrames = 96000;
    const samples = new Float32Array(lapFrames);
    for (let i = 0; i < lapFrames; i++) samples[i] = i + 1;

    const result: RecordingResult = {
      channels: [samples],
      sampleRate,
      frames: lapFrames,
      startTime: 10.1,
      endTime: 10.1 + lapFrames / sampleRate,
    };

    const slices = loopSlicesFromCapture(result, { ctxTime: 10, beat: 8 }, { start: 8, end: 12 }, 120);

    expect(slices).toHaveLength(1);
    expect(slices[0].complete).toBe(true);
    expect(slices[0].channels[0]).toHaveLength(lapFrames);
    expect(slices[0].channels[0][0]).toBe(0);
    expect(slices[0].channels[0][4799]).toBe(0);
    expect(slices[0].channels[0][4800]).toBe(1);
  });

  it('drops a final lap too short to be worth a take', () => {
    const sampleRate = 48000;
    const lapFrames = 96000;
    const frames = lapFrames + 1000;
    const result: RecordingResult = {
      channels: [new Float32Array(frames)],
      sampleRate,
      frames,
      startTime: 4,
      endTime: 4 + frames / sampleRate,
    };

    const slices = loopSlicesFromCapture(result, { ctxTime: 4, beat: 4 }, { start: 4, end: 8 }, 120);
    expect(slices).toHaveLength(1);
    expect(slices[0].complete).toBe(true);
  });

  it('rejects a capture with no usable audio', () => {
    const result: RecordingResult = {
      channels: [new Float32Array(0)],
      sampleRate: 48000,
      frames: 0,
      startTime: 1,
      endTime: 1,
    };
    expect(takeFromRecording(result, { ctxTime: 1, beat: 0 }, 120)).toBeNull();
  });
});

describe('takes travel with the project', () => {
  it('includes the audio of takes that no clip currently plays', () => {
    const project = demoProject();
    project.takes = [take({ trackId: project.tracks[0].id, assetId: 'unused-take-asset' })];
    expect(projectAssetIds(project)).toContain('unused-take-asset');
  });

  it('round-trips takes through a saved project', () => {
    const project = demoProject();
    const audio = createTrack('audio', 'Vox', 4);
    project.tracks.push(audio);
    project.takes = [take({ id: 'take-a', trackId: audio.id, assetId: 'asset-a', pass: 3, start: 4, length: 6 }) ];

    const parsed = parseProject(serializeProject(project));
    expect(parsed.project.takes).toHaveLength(1);
    expect(parsed.project.takes[0]).toMatchObject({ id: 'take-a', trackId: audio.id, assetId: 'asset-a', pass: 3, start: 4, length: 6 });
  });

  it('fills takes for older project files that never had them', () => {
    const project = demoProject();
    const legacy = JSON.parse(serializeProject(project)) as { project: Record<string, unknown> };
    delete legacy.project.takes;
    const parsed = parseProject(JSON.stringify(legacy));
    expect(parsed.project.takes).toEqual([]);
  });
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const format = (overrides: Partial<CaptureFormat> = {}): CaptureFormat => ({
  sampleRate: 96000,
  deviceSampleRate: 96000,
  channels: 2,
  bitDepth: 32,
  blockSize: 128,
  engine: 'worklet',
  processing: false,
  resampled: false,
  latencySeconds: null,
  ...overrides,
});

describe('converter capture', () => {
  it('reports a transparent 32-bit float capture at the device rate', () => {
    expect(describeCapture(format())).toBe(
      '96 kHz · 2 ch · 32-bit float · audio-thread capture · no input processing',
    );
  });

  it('says so when the browser processes or resamples the input', () => {
    const line = describeCapture(
      format({ sampleRate: 48000, deviceSampleRate: 44100, resampled: true, processing: true, engine: 'compatibility' }),
    );
    expect(line).toContain('44.1 kHz in → 48 kHz');
    expect(line).toContain('compatibility capture');
    expect(line).toContain('browser processing on');
  });

  it('catches a single full-scale sample the old stride skipped', () => {
    const block = new Float32Array(64);
    block[17] = -1;
    expect(scanPeak([block])).toEqual({ peak: 1, clipped: true });

    // A 16-bit converter's loudest sample, which a literal >= 1 test misses.
    block[17] = -32767 / 32768;
    const hottest = scanPeak([block]);
    expect(hottest.peak).toBeCloseTo(0.99997, 4);
    expect(hottest.clipped).toBe(true);

    block[17] = -0.9;
    const loud = scanPeak([block]);
    expect(loud.peak).toBeCloseTo(0.9, 6);
    expect(loud.clipped).toBe(false);
  });

  it('ships the audio-thread worklet the recorder loads', () => {
    const source = readFileSync(join(ROOT, 'public/capture-worklet.js'), 'utf8');
    expect(source).toContain("registerProcessor('toneart-capture'");
    expect(source).toContain('FRAMES_PER_MESSAGE = 2048');
    // Copies, never gain stage: the take must be the converter's own samples.
    expect(source).toContain('this.buffers[channel].set(input[channel].subarray(');
    expect(source).not.toContain('GainNode');
  });
});

describe('takes panel', () => {
  it('lists takes for the comp track and comps one into the arrangement', () => {
    document.body.innerHTML = '';

    const project = demoProject();
    const audio = createTrack('audio', 'Vox', 4);
    project.tracks.push(audio);
    project.takes = [take({ id: 'take-1', trackId: audio.id, assetId: 'asset-vox', name: 'Vox · Take 1' })];

    const store = new Store(project);
    store.selectTrack(audio.id);

    const panel = new TakePanel(store, DEFAULT_PREFERENCES, () => {}, {
      startRecording: () => {},
      stopRecording: () => {},
      setMonitoring: () => {},
      listInputs: async () => [],
      audition: () => {},
      notify: () => {},
    });
    panel.mount();
    panel.refresh();

    expect(document.body.textContent).toContain('Vox · Take 1');
    expect(document.body.textContent).toContain('No range');

    const use = [...document.querySelectorAll<HTMLButtonElement>('.take-panel button')].find(
      (button) => button.textContent === 'Use take',
    );
    expect(use).toBeTruthy();
    use!.click();

    const comped = store.project.clips.filter((clip) => clip.assetId === 'asset-vox');
    expect(comped).toHaveLength(1);
    expect(comped[0].start).toBe(8);
    expect(comped[0].length).toBe(8);
    expect(store.canUndo()).toBe(true);

    // A selected range limits the comp and is labelled as such.
    store.setRange(10, 12);
    panel.refresh();
    const useRange = [...document.querySelectorAll<HTMLButtonElement>('.take-panel button')].find(
      (button) => button.textContent === 'Use range',
    );
    expect(useRange).toBeTruthy();
    useRange!.click();

    const ranged = store.project.clips.filter((clip) => clip.assetId === 'asset-vox');
    expect(ranged).toHaveLength(3);
    expect(ranged.some((clip) => clip.start === 10 && clip.length === 2)).toBe(true);
    expect(ranged.some((clip) => clip.start === 8 && clip.length === 2)).toBe(true);
    expect(ranged.some((clip) => clip.start === 12 && clip.length === 4)).toBe(true);

    document.body.innerHTML = '';
  });

  it('shows what the converter is delivering, and flags clipping', () => {
    document.body.innerHTML = '';
    const store = new Store(demoProject());
    const panel = new TakePanel(store, DEFAULT_PREFERENCES, () => {}, {
      startRecording: () => {},
      stopRecording: () => {},
      setMonitoring: () => {},
      listInputs: async () => [],
      audition: () => {},
      notify: () => {},
    });
    panel.mount();

    const readout = document.querySelector('.capture-format') as HTMLElement;
    expect(readout.textContent).toContain('32-bit float');

    panel.setCapture('48 kHz · 2 ch · 32-bit float · audio-thread capture · no input processing');
    expect(readout.textContent).toContain('audio-thread capture');
    expect(readout.classList.contains('is-warning')).toBe(false);

    panel.setCapture('48 kHz · 2 ch · 32-bit float · audio-thread capture — input clipped', true);
    expect(readout.textContent).toContain('input clipped');
    expect(readout.classList.contains('is-warning')).toBe(true);

    panel.setCapture(null);
    expect(readout.textContent).toContain('Converter idle');
    expect(readout.classList.contains('is-warning')).toBe(false);

    document.body.innerHTML = '';
  });
});
