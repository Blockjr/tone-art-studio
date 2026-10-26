// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/core/session';
import { NativePanel } from '../src/ui/native';
import {
  NativeBridge,
  createJuceTarget,
  describeChain,
  describeDevice,
  describeLoopback,
  filterPlugins,
  groupDevices,
  isNativeHost,
  latencyMilliseconds,
  sortPlugins,
  type NativeChainEntry,
  type NativeDevice,
  type NativePlugin,
  type NativeState,
  type NativeTarget,
} from '../src/native/bridge';

class FakeTarget implements NativeTarget {
  available = true;
  sent: { eventId: string; payload: unknown }[] = [];
  private listeners = new Map<string, ((payload: unknown) => void)[]>();

  send(eventId: string, payload: unknown): void {
    this.sent.push({ eventId, payload });
  }

  listen(eventId: string, callback: (payload: unknown) => void): void {
    const list = this.listeners.get(eventId) ?? [];
    list.push(callback);
    this.listeners.set(eventId, list);
  }

  emit(eventId: string, payload: unknown): void {
    for (const callback of this.listeners.get(eventId) ?? []) callback(payload);
  }
}

const device = (overrides: Partial<NativeDevice> = {}): NativeDevice => ({
  type: 'ASIO',
  name: 'Focusrite USB ASIO',
  isAsio: true,
  isVirtual: false,
  selected: false,
  ...overrides,
});

const plugin = (name: string, manufacturer = 'Acme'): NativePlugin => ({
  name,
  manufacturer,
  category: 'Fx',
  identifier: `${manufacturer}-${name}`,
  file: `${name}.vst3`,
});

const state = (overrides: Partial<NativeState> = {}): NativeState => ({
  available: true,
  device: {
    open: true,
    name: 'Focusrite USB ASIO',
    type: 'ASIO',
    sampleRate: 48000,
    bufferSize: 256,
    latencySamples: 512,
    isAsio: true,
    isVirtual: false,
    error: '',
  },
  loopback: { enabled: false, attached: true, driverOnline: false },
  deviceTypes: ['ASIO', 'Windows Audio'],
  devices: [device()],
  plugins: [plugin('Pro-C 2', 'FabFilter')],
  chain: [],
  pluginCount: 1,
  lastError: '',
  ...overrides,
});

describe('native host detection', () => {
  it('reports the browser as non-native', () => {
    expect(isNativeHost({} as Window)).toBe(false);
    expect(createJuceTarget({} as Window)).toBeNull();
  });

  it('detects the JUCE host through its init data or backend', () => {
    const withData = { __JUCE__: { initialisationData: { hybridNative: [true] } } } as unknown as Window;
    expect(isNativeHost(withData)).toBe(true);

    const withBackend = {
      __JUCE__: {
        backend: {
          emitEvent: () => {},
          addEventListener: () => {},
        },
      },
    } as unknown as Window;

    expect(isNativeHost(withBackend)).toBe(true);
    expect(createJuceTarget(withBackend)).not.toBeNull();
  });
});

describe('native bridge', () => {
  it('subscribes, requests a snapshot and forwards state to listeners', () => {
    const target = new FakeTarget();
    const bridge = new NativeBridge(target);
    const listener = vi.fn();

    bridge.connect();
    bridge.onState(listener);

    expect(target.sent[0]).toEqual({ eventId: 'hybridCommand', payload: { type: 'listDevices' } });

    target.emit('hybridState', state());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.state?.device.name).toBe('Focusrite USB ASIO');
  });

  it('sends every command as a hybridCommand payload', () => {
    const target = new FakeTarget();
    const bridge = new NativeBridge(target);
    bridge.connect();
    target.sent.length = 0;

    bridge.openDevice('ASIO', 'Tone Art Virtual ASIO');
    bridge.scanPlugins();
    bridge.addPlugin('FabFilter-Pro-C 2');
    bridge.removePlugin(1);
    bridge.movePlugin(0, 2);
    bridge.openPluginEditor(0);
    bridge.clearPlugins();
    bridge.setLoopback(true);

    expect(target.sent.map((entry) => (entry.payload as { type: string }).type)).toEqual([
      'openDevice',
      'scanPlugins',
      'addPlugin',
      'removePlugin',
      'movePlugin',
      'openPluginEditor',
      'clearPlugins',
      'setLoopback',
    ]);

    expect(target.sent[0].payload).toMatchObject({
      type: 'openDevice',
      deviceType: 'ASIO',
      deviceName: 'Tone Art Virtual ASIO',
    });
  });

  it('keeps loopback telemetry fresh from the meter stream', () => {
    const target = new FakeTarget();
    const bridge = new NativeBridge(target);
    const meters = vi.fn();
    bridge.connect();
    bridge.onMeters(meters);

    target.emit('hybridState', state());
    target.emit('hybridMeters', {
      left: 0.4,
      right: 0.3,
      loopback: { enabled: true, attached: true, driverOnline: true, inputOverruns: 2 },
    });

    expect(meters).toHaveBeenCalledTimes(1);
    expect(bridge.state?.loopback.driverOnline).toBe(true);
    expect(bridge.state?.loopback.inputOverruns).toBe(2);
  });

  it('is inert without a target', () => {
    const bridge = new NativeBridge(null);
    expect(bridge.available).toBe(false);
    expect(() => {
      bridge.connect();
      bridge.scanPlugins();
    }).not.toThrow();
  });
});

describe('device and plugin helpers', () => {
  it('groups virtual ASIO drivers ahead of hardware and system devices', () => {
    const groups = groupDevices([
      device(),
      device({ name: 'Tone Art Virtual ASIO', isVirtual: true }),
      device({ name: 'VoiceMeeter Input', isVirtual: true, isAsio: false }),
      device({ type: 'Windows Audio', name: 'Speakers', isAsio: false }),
    ]);

    expect(groups.virtual.map((entry) => entry.name)).toEqual([
      'Tone Art Virtual ASIO',
      'VoiceMeeter Input',
    ]);
    expect(groups.asio.map((entry) => entry.name)).toEqual(['Focusrite USB ASIO']);
    expect(groups.other.map((entry) => entry.name)).toEqual(['Speakers']);
  });

  it('computes round-trip latency from samples', () => {
    expect(latencyMilliseconds({ latencySamples: 512, bufferSize: 256, sampleRate: 48000 })).toBeCloseTo(
      10.666,
      2,
    );
    expect(latencyMilliseconds({ latencySamples: 0, bufferSize: 128, sampleRate: 44100 })).toBeCloseTo(
      2.902,
      2,
    );
    expect(latencyMilliseconds({ latencySamples: 0, bufferSize: 0, sampleRate: 0 })).toBe(0);
  });

  it('describes device, loopback and chain states in words', () => {
    expect(describeDevice(state().device)).toContain('48000 Hz');
    expect(describeDevice(state().device)).toContain('10.7 ms');
    expect(describeDevice(undefined)).toBe('No audio device open');
    expect(describeDevice({ ...state().device, open: false, error: 'No ASIO driver' })).toBe(
      'No ASIO driver',
    );

    expect(describeLoopback(undefined)).toContain('unknown');
    expect(describeLoopback({ enabled: false, attached: false, driverOnline: false })).toContain(
      'not installed',
    );
    expect(describeLoopback({ enabled: true, attached: true, driverOnline: false })).toContain(
      'waiting',
    );
    expect(describeLoopback({ enabled: true, attached: true, driverOnline: true })).toContain(
      'streaming',
    );

    const chain: NativeChainEntry[] = [
      { index: 0, name: 'Pro-C 2', bypassed: false, hasEditor: true },
      { index: 1, name: 'Pro-L 2', bypassed: false, hasEditor: true },
    ];

    expect(describeChain([])).toBe('No VST3 plugins in the master chain');
    expect(describeChain(chain)).toBe('2 plugins: Pro-C 2 → Pro-L 2');
  });

  it('filters and sorts the scanned VST3 catalogue', () => {
    const plugins = [plugin('Pro-Q 4', 'FabFilter'), plugin('ValhallaSupermassive', 'Valhalla'), plugin('Pro-C 2', 'FabFilter')];

    expect(filterPlugins(plugins, '').length).toBe(3);
    expect(filterPlugins(plugins, 'fabf').map((entry) => entry.name)).toEqual(['Pro-Q 4', 'Pro-C 2']);
    expect(filterPlugins(plugins, 'pro-c')).toHaveLength(1);
    expect(sortPlugins(plugins).map((entry) => entry.name)).toEqual([
      'Pro-C 2',
      'Pro-Q 4',
      'ValhallaSupermassive',
    ]);
  });
});

describe('studio rig VST3 mixer', () => {
  it('shows loaded stems and addresses a plugin to the selected track', () => {
    document.body.innerHTML = '';

    const target = new FakeTarget();
    const bridge = new NativeBridge(target);
    const panel = new NativePanel(bridge, DEFAULT_PREFERENCES, () => {}, async () => 'exported');
    panel.mount();
    bridge.connect();

    target.emit(
      'hybridState',
      state({
        song: {
          loaded: true,
          playing: false,
          position: 0,
          length: 90,
          loop: false,
          latencySamples: 0,
          masterPeakLeft: 0,
          masterPeakRight: 0,
          masterChain: [],
          tracks: [
            {
              id: 'track-1',
              name: 'Lead Vox',
              gainDb: -3,
              pan: 0,
              mute: false,
              solo: false,
              peakLeft: 0,
              peakRight: 0,
              chain: [{ index: 0, slot: 0, name: 'Pro-C 2', bypassed: false, hasEditor: true }],
            },
          ],
        },
      }),
    );

    expect(document.querySelector('.rig-panel')?.textContent).toContain('Lead Vox');
    expect(document.querySelector('.rig-panel')?.textContent).toContain('1:30');

    const trackSelect = [...document.querySelectorAll<HTMLSelectElement>('.rig-panel select')].find(
      (select) => [...select.options].some((option) => option.value === 'track-1'),
    );
    expect(trackSelect).toBeTruthy();

    trackSelect!.value = 'track-1';
    trackSelect!.dispatchEvent(new Event('change'));

    expect(document.querySelector('.rig-panel')?.textContent).toContain('Lead Vox VST3 chain');

    target.sent.length = 0;
    const add = [...document.querySelectorAll<HTMLButtonElement>('.rig-panel button')].find(
      (button) => button.textContent === 'Add' && !button.disabled,
    );
    expect(add).toBeTruthy();
    add!.click();

    expect(target.sent[0]?.payload).toEqual({
      type: 'addTrackPlugin',
      trackId: 'track-1',
      identifier: 'FabFilter-Pro-C 2',
    });
  });
});
