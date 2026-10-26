import { describe, expect, it } from 'vitest';
import {
  beatsToSeconds,
  formatBars,
  formatTime,
  midiToFreq,
  noteName,
  parseBars,
  secondsToBeats,
  snapBeat,
} from '../src/core/time';
import { createDevice, demoProject } from '../src/core/project';
import { Store } from '../src/core/store';
import { encodeWav, renderMixdown } from '../src/audio/export';
import { DEVICE_SPECS } from '../src/audio/specs';

describe('time helpers', () => {
  it('converts beats and seconds at tempo', () => {
    expect(beatsToSeconds(4, 120)).toBeCloseTo(2);
    expect(secondsToBeats(2, 120)).toBeCloseTo(4);
    expect(beatsToSeconds(32, 124)).toBeCloseTo(15.4839, 3);
  });

  it('formats bar/beat/sixteenth positions', () => {
    expect(formatBars(0)).toBe('1.1.1');
    expect(formatBars(4)).toBe('2.1.1');
    expect(formatBars(5.5)).toBe('2.2.3');
  });

  it('formats mm:ss.mmm', () => {
    expect(formatTime(0)).toBe('00:00.000');
    expect(formatTime(65.25)).toBe('01:05.250');
  });

  it('reads typed bar locations and rejects nonsense', () => {
    expect(parseBars('1.1.1')).toBe(0);
    expect(parseBars('2.3.1')).toBe(6);
    expect(parseBars('2.3.4')).toBe(6.75);
    expect(parseBars('5')).toBe(16);
    expect(parseBars(' 2:1 ')).toBe(4);
    expect(parseBars('0.1.1')).toBeNull();
    expect(parseBars('1.5.1')).toBeNull();
    expect(parseBars('1.1.17')).toBeNull();
    expect(parseBars('abc')).toBeNull();
    expect(parseBars('1.2.3.4')).toBeNull();
  });

  it('snaps to the grid and leaves it alone when off', () => {
    expect(snapBeat(1.13, 0.25)).toBeCloseTo(1.25);
    expect(snapBeat(1.13, 0)).toBeCloseTo(1.13);
  });

  it('maps midi to frequency and names', () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(60)).toBeCloseTo(261.63, 1);
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
  });
});

describe('demo project', () => {
  it('has tracks, clips and devices wired together', () => {
    const project = demoProject();
    expect(project.tracks).toHaveLength(4);
    expect(project.clips).toHaveLength(4);
    for (const clip of project.clips) {
      expect(project.tracks.some((t) => t.id === clip.trackId)).toBe(true);
      expect(clip.notes.length).toBeGreaterThan(0);
      for (const note of clip.notes) {
        expect(note.start).toBeGreaterThanOrEqual(0);
        expect(note.start + note.duration).toBeLessThanOrEqual(clip.length + 0.001);
        expect(note.velocity).toBeGreaterThan(0);
        expect(note.velocity).toBeLessThanOrEqual(1);
      }
    }
    expect(project.master.devices.map((d) => d.type)).toEqual(['eq3', 'compressor', 'limiter']);
  });

  it('ships four aux returns and a full send matrix', () => {
    const project = demoProject();

    expect(project.returns.map((bus) => bus.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(project.returns.map((bus) => bus.name)).toEqual(['Reverb', 'Delay', 'Chorus', 'Room']);

    for (const bus of project.returns) {
      expect(bus.devices.length).toBeGreaterThan(0);
      expect(bus.volume).toBeGreaterThan(0);
      expect(bus.id).toMatch(/^return-/);
      // returns are fed 100% wet
      expect(bus.devices[0].params.mix).toBe(1);
    }

    for (const track of project.tracks) {
      expect(track.sends).toHaveLength(4);
      expect(track.preSends).toHaveLength(4);
      for (const level of track.sends) expect(level).toBeGreaterThanOrEqual(0);
      for (const level of track.sends) expect(level).toBeLessThanOrEqual(1);
    }

    expect(project.tracks.some((track) => track.preSends.some(Boolean))).toBe(true);
  });

  it('creates devices with every parameter defaulted', () => {
    const device = createDevice('delay');
    const spec = DEVICE_SPECS.delay;
    for (const param of spec.params) {
      expect(device.params[param.key]).toBe(param.default);
    }
  });
});

describe('store history', () => {
  it('undoes and redoes structural edits', () => {
    const store = new Store(demoProject());
    const track = store.project.tracks[0];
    store.edit('structure', () => {
      track.name = 'Renamed';
    });
    expect(store.project.tracks[0].name).toBe('Renamed');
    store.undo();
    expect(store.project.tracks[0].name).toBe('Drums');
    store.redo();
    expect(store.project.tracks[0].name).toBe('Renamed');
  });

  it('reorders tracks as one undo step, keeping clips attached and clamping', () => {
    const store = new Store(demoProject());
    const ids = store.project.tracks.map((t) => t.id);
    const clipFor = (trackId: string) => store.project.clips.find((c) => c.trackId === trackId);

    store.moveTrack(ids[3], 0);
    expect(store.project.tracks.map((t) => t.id)).toEqual([ids[3], ids[0], ids[1], ids[2]]);
    // Clips belong to tracks, not to a row, so the arrangement follows the move.
    expect(clipFor(ids[3])?.name).toBe('Arp 16ths');

    store.undo();
    expect(store.project.tracks.map((t) => t.id)).toEqual(ids);

    store.moveTrack(ids[0], 99);
    expect(store.project.tracks.map((t) => t.id)).toEqual([ids[1], ids[2], ids[3], ids[0]]);

    // A drop onto the same slot is a no-op: undo must still step over the move.
    store.moveTrack(ids[0], 3);
    store.undo();
    expect(store.project.tracks.map((t) => t.id)).toEqual(ids);
  });

  it('coalesces a gesture into one undo step', () => {
    const store = new Store(demoProject());
    const track = store.project.tracks[1];
    store.beginGesture();
    store.touch('params', () => {
      track.volume = 0.5;
    });
    store.touch('params', () => {
      track.volume = 0.3;
    });
    store.endGesture();
    expect(store.project.tracks[1].volume).toBeCloseTo(0.3);
    store.undo();
    expect(store.project.tracks[1].volume).toBeCloseTo(0.78);
  });
});

describe('wav encoder', () => {
  const fakeBuffer = (samples: Float32Array) =>
    ({
      numberOfChannels: 1,
      length: samples.length,
      sampleRate: 44100,
      getChannelData: () => samples,
    }) as unknown as AudioBuffer;

  it('writes a valid 16-bit PCM header and samples', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWav(fakeBuffer(samples), 16);
    expect(blob.type).toBe('audio/wav');
    const view = new DataView(await blob.arrayBuffer());

    const text = (offset: number, length: number): string => {
      let out = '';
      for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
      return out;
    };

    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(view.getInt16(48, true)).toBe(Math.round(-0.5 * 0x7fff));
    expect(view.getInt16(50, true)).toBe(0x7fff);
    expect(view.getInt16(52, true)).toBe(-0x7fff);
    expect(view.byteLength).toBe(44 + samples.length * 2);
  });

  it('writes 24-bit PCM at 3 bytes per sample', async () => {
    const samples = new Float32Array([0, 0.5]);
    const blob = encodeWav(fakeBuffer(samples), 24);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.byteLength).toBe(44 + 6);
  });
});

describe('offline mixdown', () => {
  const param = (value = 0) => ({
    value,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime() {},
  });

  const node = () => ({
    connect: (dest: unknown) => dest ?? node(),
    disconnect() {},
    start() {},
    stop() {},
    gain: param(1),
    frequency: param(440),
    Q: param(1),
    detune: param(0),
    delayTime: param(0),
    pan: param(0),
    threshold: param(-24),
    knee: param(30),
    ratio: param(12),
    attack: param(0.003),
    release: param(0.25),
    type: 'sine',
    curve: null,
    oversample: 'none',
    fftSize: 1024,
    smoothingTimeConstant: 0.5,
    buffer: null,
    setPeriodicWave() {},
  });

  it('renders the demo arrangement through the master chain', async () => {
    const renderedFrames = 1000;
    const renderedSamples = new Float32Array(renderedFrames).fill(0.25);

    class FakeOfflineAudioContext {
      destination = node();
      sampleRate: number;
      currentTime = 0;
      constructor(_channels: number, _frames: number, sampleRate: number) {
        this.sampleRate = sampleRate;
      }
      createGain = () => node();
      createBiquadFilter = () => node();
      createDynamicsCompressor = () => node();
      createWaveShaper = () => node();
      createOscillator = () => node();
      createBufferSource = () => node();
      createAnalyser = () => node();
      createPeriodicWave = () => ({});
      createStereoPanner = () => node();
      createChannelSplitter = () => node();
      createChannelMerger = () => node();
      createDelay = () => node();
      createConvolver = () => node();
      createBuffer = (_channels: number, length: number) => ({
        length,
        numberOfChannels: 1,
        sampleRate: this.sampleRate,
        getChannelData: () => new Float32Array(length),
      });
      async startRendering() {
        return {
          numberOfChannels: 2,
          length: renderedFrames,
          sampleRate: this.sampleRate,
          getChannelData: () => renderedSamples,
        };
      }
    }

    const scope = globalThis as unknown as { OfflineAudioContext?: unknown };
    const original = scope.OfflineAudioContext;
    scope.OfflineAudioContext = FakeOfflineAudioContext;

    try {
      const store = new Store(demoProject());
      const blob = await renderMixdown(store, { bitDepth: 16, sampleRate: 8000 });
      expect(blob.size).toBe(44 + renderedFrames * 2 * 2);
      const view = new DataView(await blob.arrayBuffer());
      expect(view.getUint32(24, true)).toBe(8000);
      expect(view.getUint16(34, true)).toBe(16);
      expect(view.getUint32(40, true)).toBe(renderedFrames * 2 * 2);
    } finally {
      scope.OfflineAudioContext = original;
    }
  });
});
