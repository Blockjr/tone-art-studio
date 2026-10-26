// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/audio/engine';
import { listInputDevices, listOutputDevices, measureInputLevel } from '../src/audio/recorder';
import { emptyProject } from '../src/core/project';
import { Store } from '../src/core/store';

interface FakeTrack {
  stopped: boolean;
  stop(): void;
}

function installMediaDevices(options: {
  devices?: Partial<MediaDeviceInfo>[];
  peak?: number;
  getUserMedia?: () => Promise<unknown>;
}): { tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [];

  const mediaDevices: Record<string, unknown> = {
    enumerateDevices: async () =>
      (options.devices ?? []).map((device) => ({
        deviceId: device.deviceId ?? 'id',
        kind: device.kind ?? 'audioinput',
        label: device.label ?? '',
        groupId: '',
        toJSON: () => ({}),
      })),
    getUserMedia: async () => {
      if (options.getUserMedia) return options.getUserMedia();
      const track: FakeTrack = {
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    },
  };

  Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true });
  return { tracks };
}

/** The smallest AudioContext that can measure a level. */
class FakeAudioContext {
  static closed = 0;
  sampleRate = 48000;
  currentTime = 0;

  constructor(private readonly peak: number) {}

  createAnalyser() {
    let fftSize = 2048;
    // The level this fake device is putting out, read once: the analyser is a
    // plain object, so it does not carry the context with it.
    const level = this.peak;
    return {
      get fftSize() {
        return fftSize;
      },
      set fftSize(value: number) {
        fftSize = value;
      },
      getFloatTimeDomainData(array: Float32Array) {
        array.fill(0);
        array[0] = level;
      },
    };
  }

  createMediaStreamSource() {
    return { connect() {} };
  }

  async close(): Promise<void> {
    FakeAudioContext.closed += 1;
  }
}

function useFakeAudioContext(peak = 0.5): void {
  const PeakContext = class extends FakeAudioContext {
    constructor() {
      super(peak);
    }
  };
  (window as unknown as { AudioContext: unknown }).AudioContext = PeakContext;
}

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  FakeAudioContext.closed = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('audio devices', () => {
  it('lists the inputs and the outputs, and names the ones that have no label', async () => {
    installMediaDevices({
      devices: [
        { deviceId: 'mic-1', kind: 'audioinput', label: 'AudioBox 22VSL' },
        { deviceId: 'mic-2', kind: 'audioinput', label: '' },
        { deviceId: 'out-1', kind: 'audiooutput', label: 'AudioBox 22VSL' },
        { deviceId: 'video', kind: 'videoinput', label: 'Camera' },
      ],
    });

    expect(await listInputDevices()).toEqual([
      { id: 'mic-1', label: 'AudioBox 22VSL' },
      { id: 'mic-2', label: 'Input 2' },
    ]);
    expect(await listOutputDevices()).toEqual([{ id: 'out-1', label: 'AudioBox 22VSL' }]);
  });

  it('answers with no devices rather than throwing where there are none', async () => {
    // jsdom has no mediaDevices at all, which is also a browser without input.
    expect(await listInputDevices()).toEqual([]);
    expect(await listOutputDevices()).toEqual([]);

    installMediaDevices({});
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        enumerateDevices: async () => {
          throw new Error('denied');
        },
      },
      configurable: true,
    });
    expect(await listInputDevices()).toEqual([]);
  });

  it('reports an input that cannot be opened instead of throwing', async () => {
    const result = await measureInputLevel('mic-1', 100);
    expect(result.opened).toBe(false);
    expect(result.error).toContain('cannot open');
    expect(result.peak).toBe(0);
  });

  it('measures the level of a working interface and releases it afterwards', async () => {
    const { tracks } = installMediaDevices({});
    useFakeAudioContext(0.5);

    const result = await measureInputLevel('mic-1', 120);

    expect(result.opened).toBe(true);
    expect(result.peak).toBeCloseTo(0.5, 3);
    expect(result.clipped).toBe(false);
    // The interface is let go: the check must not hold the device open and stop
    // the take that follows from opening it.
    expect(tracks[0].stopped).toBe(true);
    expect(FakeAudioContext.closed).toBe(1);
  });

  it('warns when the input is already clipping', async () => {
    installMediaDevices({});
    useFakeAudioContext(1);

    const result = await measureInputLevel('mic-1', 120);
    expect(result.clipped).toBe(true);
    expect(result.peak).toBe(1);
  });
});

describe('the engine output device', () => {
  const engineOf = (): Engine => new Engine(new Store(emptyProject()));

  it('routes the master to the chosen interface', async () => {
    const engine = engineOf();
    const setSinkId = vi.fn(async () => {});

    // The context is built on the first play or test, which is a sound card call
    // this test does not need: only the routing is under test.
    (engine as unknown as { ensureContext: () => Promise<unknown> }).ensureContext = async () => ({ setSinkId });

    expect(await engine.setOutputDevice('out-1')).toBe(true);
    expect(setSinkId).toHaveBeenCalledWith('out-1');
    expect(engine.outputDevice).toBe('out-1');

    // The system default is a real choice, not a missing value.
    expect(await engine.setOutputDevice('')).toBe(true);
    expect(engine.outputDevice).toBe('');
  });

  it('says so when the build cannot choose an output at all', async () => {
    const engine = engineOf();
    (engine as unknown as { ensureContext: () => Promise<unknown> }).ensureContext = async () => ({});

    expect(await engine.setOutputDevice('out-1')).toBe(false);
    expect(engine.outputDevice).toBe('');
  });
});
