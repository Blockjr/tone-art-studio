/**
 * Client for the JUCE native host (Tone Art Studio desktop build).
 *
 * Inside the desktop app the web UI runs in a WebView2 that exposes
 * `window.__JUCE__`. Native events arrive through `backend.addEventListener`
 * and commands go out through `backend.emitEvent`. In a plain browser none of
 * that exists, the bridge reports `available === false`, and the Studio Rig
 * panel explains what the browser build cannot do.
 */

export interface NativeAudioStatus {
  open: boolean;
  name: string;
  type: string;
  sampleRate: number;
  bufferSize: number;
  latencySamples: number;
  isAsio: boolean;
  isVirtual: boolean;
  error: string;
}

export interface NativeDevice {
  type: string;
  name: string;
  isAsio: boolean;
  isVirtual: boolean;
  selected: boolean;
}

export interface NativePlugin {
  name: string;
  manufacturer: string;
  category: string;
  version?: string;
  identifier: string;
  file: string;
}

export interface NativeChainEntry {
  index: number;
  slot?: number;
  name: string;
  bypassed: boolean;
  hasEditor: boolean;
  latencySamples?: number;
  vst3?: boolean;
}

export interface NativeSongTrack {
  id: string;
  name: string;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  peakLeft: number;
  peakRight: number;
  chain: NativeChainEntry[];
}

export interface NativeSong {
  loaded: boolean;
  playing: boolean;
  position: number;
  length: number;
  loop: boolean;
  latencySamples: number;
  masterPeakLeft: number;
  masterPeakRight: number;
  masterChain: NativeChainEntry[];
  tracks: NativeSongTrack[];
}

export interface NativeSongTransport {
  loaded: boolean;
  playing: boolean;
  position: number;
  length: number;
  loop: boolean;
  left: number;
  right: number;
}

export interface NativeLoopbackStatus {
  enabled: boolean;
  attached: boolean;
  driverOnline: boolean;
  sampleRate?: number;
  blockSize?: number;
  inputOverruns?: number;
  inputUnderruns?: number;
  outputOverruns?: number;
  outputUnderruns?: number;
  queuedFromDrivers?: number;
}

export interface NativeState {
  available: boolean;
  platform?: string;
  device: NativeAudioStatus;
  loopback: NativeLoopbackStatus;
  deviceTypes: string[];
  devices: NativeDevice[];
  plugins: NativePlugin[];
  chain: NativeChainEntry[];
  song?: NativeSong;
  pluginCount: number;
  lastError: string;
  uiSource?: string;
}

export interface NativeMeters {
  left: number;
  right: number;
  loopback?: NativeLoopbackStatus;
  song?: NativeSongTransport;
}

export interface NativeTarget {
  available: boolean;
  send(eventId: string, payload: unknown): void;
  listen(eventId: string, callback: (payload: unknown) => void): void;
}

export type NativeCommand =
  | { type: 'openDevice'; deviceType: string; deviceName: string }
  | { type: 'listDevices' }
  | { type: 'scanPlugins' }
  | { type: 'addPlugin'; identifier: string }
  | { type: 'removePlugin'; index: number }
  | { type: 'movePlugin'; from: number; to: number }
  | { type: 'openPluginEditor'; index: number }
  | { type: 'clearPlugins' }
  | { type: 'setLoopback'; enabled: boolean }
  | { type: 'setGain'; value: number }
  | { type: 'testTone'; on: boolean; frequency: number }
  | { type: 'addTrackPlugin'; trackId: string; identifier: string }
  | { type: 'removeTrackPlugin'; trackId: string; slot: number }
  | { type: 'moveTrackPlugin'; trackId: string; from: number; to: number }
  | { type: 'setTrackPluginBypass'; trackId: string; slot: number; bypassed: boolean }
  | { type: 'openTrackPluginEditor'; trackId: string; slot: number }
  | { type: 'chooseStemsFolder' }
  | { type: 'loadStems'; path: string }
  | { type: 'unloadStems' }
  | { type: 'songPlay'; playing: boolean }
  | { type: 'songLocate'; seconds: number }
  | { type: 'songLoop'; enabled: boolean }
  | {
      type: 'setTrackMix';
      trackId: string;
      gainDb: number;
      pan: number;
      mute: boolean;
      solo: boolean;
    };

type JuceWindow = Window & {
  __JUCE__?: {
    backend?: {
      emitEvent?: (eventId: string, payload: unknown) => void;
      addEventListener?: (eventId: string, callback: (payload: unknown) => void) => unknown;
    };
    initialisationData?: Record<string, unknown>;
  };
};

function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** True when this page is running inside the JUCE desktop host. */
export function isNativeHost(scope: JuceWindow = window as JuceWindow): boolean {
  const flag = firstValue(scope.__JUCE__?.initialisationData?.hybridNative);
  if (flag === true) return true;

  return typeof scope.__JUCE__?.backend?.emitEvent === 'function';
}

/** Adapts the JUCE WebView bridge to the small interface the panel needs. */
export function createJuceTarget(scope: JuceWindow = window as JuceWindow): NativeTarget | null {
  const backend = scope.__JUCE__?.backend;

  if (typeof backend?.emitEvent !== 'function' || typeof backend.addEventListener !== 'function') {
    return null;
  }

  return {
    available: true,
    send: (eventId, payload) => backend.emitEvent?.(eventId, payload),
    listen: (eventId, callback) => {
      backend.addEventListener?.(eventId, callback);
    },
  };
}

// ---------------------------------------------------------------- formatting

/** Round-trip latency in milliseconds from the host's sample counts. */
export function latencyMilliseconds(
  status: Pick<NativeAudioStatus, 'latencySamples' | 'bufferSize' | 'sampleRate'>,
): number {
  if (!status.sampleRate || status.sampleRate <= 0) return 0;
  const samples = status.latencySamples > 0 ? status.latencySamples : status.bufferSize;
  return (samples / status.sampleRate) * 1000;
}

export function describeDevice(status: NativeAudioStatus | undefined): string {
  if (!status || !status.open) return status?.error || 'No audio device open';
  const latency = latencyMilliseconds(status);
  return `${status.name} · ${Math.round(status.sampleRate)} Hz · ${status.bufferSize} smp · ${latency.toFixed(1)} ms`;
}

export interface DeviceGroups {
  asio: NativeDevice[];
  virtual: NativeDevice[];
  other: NativeDevice[];
}

/** Splits the device list so virtual ASIO drivers are always easy to find. */
export function groupDevices(devices: NativeDevice[]): DeviceGroups {
  const groups: DeviceGroups = { asio: [], virtual: [], other: [] };

  for (const device of devices) {
    if (device.isVirtual) groups.virtual.push(device);
    else if (device.isAsio) groups.asio.push(device);
    else groups.other.push(device);
  }

  return groups;
}

export function describeLoopback(status: NativeLoopbackStatus | undefined): string {
  if (!status) return 'Virtual ASIO driver: unknown';
  if (!status.attached) return 'Virtual ASIO driver: not installed, or no host has opened it';
  if (!status.driverOnline) return 'Virtual ASIO driver: ready, waiting for a host to start it';

  const stats = [
    status.inputOverruns ? `${status.inputOverruns} input overruns` : '',
    status.inputUnderruns ? `${status.inputUnderruns} input underruns` : '',
  ].filter(Boolean);

  return `Virtual ASIO driver: streaming${stats.length ? ` (${stats.join(', ')})` : ''}`;
}

/** Case-insensitive name/manufacturer search used by the plugin browser. */
export function filterPlugins(plugins: NativePlugin[], query: string): NativePlugin[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return plugins;

  return plugins.filter(
    (plugin) =>
      plugin.name.toLowerCase().includes(needle) || plugin.manufacturer.toLowerCase().includes(needle),
  );
}

export function sortPlugins(plugins: NativePlugin[]): NativePlugin[] {
  return [...plugins].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.manufacturer.localeCompare(b.manufacturer);
  });
}

export function describeChain(chain: NativeChainEntry[]): string {
  if (chain.length === 0) return 'No VST3 plugins in the master chain';
  return `${chain.length} plugin${chain.length === 1 ? '' : 's'}: ${chain.map((entry) => entry.name).join(' → ')}`;
}

// ------------------------------------------------------------------- bridge

export class NativeBridge {
  private target: NativeTarget | null;
  private stateListeners = new Set<(state: NativeState) => void>();
  private meterListeners = new Set<(meters: NativeMeters) => void>();
  private connected = false;
  private latestState: NativeState | null = null;

  constructor(target: NativeTarget | null = createJuceTarget()) {
    this.target = target;
  }

  get available(): boolean {
    return this.target?.available === true;
  }

  get state(): NativeState | null {
    return this.latestState;
  }

  connect(): void {
    if (!this.target || this.connected) return;
    this.connected = true;

    this.target.listen('hybridState', (payload) => {
      const state = payload as NativeState;
      if (!state || typeof state !== 'object') return;
      this.latestState = state;
      for (const listener of this.stateListeners) listener(state);
    });

    this.target.listen('hybridMeters', (payload) => {
      const meters = payload as NativeMeters;
      if (!meters || typeof meters !== 'object') return;
      if (meters.loopback && this.latestState) this.latestState.loopback = meters.loopback;
      for (const listener of this.meterListeners) listener(meters);
    });

    this.send({ type: 'listDevices' });
  }

  onState(listener: (state: NativeState) => void): () => void {
    this.stateListeners.add(listener);
    if (this.latestState) listener(this.latestState);
    return () => this.stateListeners.delete(listener);
  }

  onMeters(listener: (meters: NativeMeters) => void): () => void {
    this.meterListeners.add(listener);
    return () => this.meterListeners.delete(listener);
  }

  send(command: NativeCommand): void {
    this.target?.send('hybridCommand', command);
  }

  openDevice(deviceType: string, deviceName: string): void {
    this.send({ type: 'openDevice', deviceType, deviceName });
  }

  setLoopback(enabled: boolean): void {
    this.send({ type: 'setLoopback', enabled });
  }

  scanPlugins(): void {
    this.send({ type: 'scanPlugins' });
  }

  addPlugin(identifier: string): void {
    this.send({ type: 'addPlugin', identifier });
  }

  removePlugin(index: number): void {
    this.send({ type: 'removePlugin', index });
  }

  movePlugin(from: number, to: number): void {
    this.send({ type: 'movePlugin', from, to });
  }

  openPluginEditor(index: number): void {
    this.send({ type: 'openPluginEditor', index });
  }

  clearPlugins(): void {
    this.send({ type: 'clearPlugins' });
  }

  addTrackPlugin(trackId: string, identifier: string): void {
    this.send({ type: 'addTrackPlugin', trackId, identifier });
  }

  removeTrackPlugin(trackId: string, slot: number): void {
    this.send({ type: 'removeTrackPlugin', trackId, slot });
  }

  moveTrackPlugin(trackId: string, from: number, to: number): void {
    this.send({ type: 'moveTrackPlugin', trackId, from, to });
  }

  setTrackPluginBypass(trackId: string, slot: number, bypassed: boolean): void {
    this.send({ type: 'setTrackPluginBypass', trackId, slot, bypassed });
  }

  openTrackPluginEditor(trackId: string, slot: number): void {
    this.send({ type: 'openTrackPluginEditor', trackId, slot });
  }

  chooseStemsFolder(): void {
    this.send({ type: 'chooseStemsFolder' });
  }

  loadStems(path: string): void {
    this.send({ type: 'loadStems', path });
  }

  unloadStems(): void {
    this.send({ type: 'unloadStems' });
  }

  setSongPlaying(playing: boolean): void {
    this.send({ type: 'songPlay', playing });
  }

  locateSong(seconds: number): void {
    this.send({ type: 'songLocate', seconds });
  }

  setSongLoop(enabled: boolean): void {
    this.send({ type: 'songLoop', enabled });
  }

  setTrackMix(track: NativeSongTrack, patch: Partial<Pick<NativeSongTrack, 'gainDb' | 'pan' | 'mute' | 'solo'>>): void {
    this.send({
      type: 'setTrackMix',
      trackId: track.id,
      gainDb: patch.gainDb ?? track.gainDb,
      pan: patch.pan ?? track.pan,
      mute: patch.mute ?? track.mute,
      solo: patch.solo ?? track.solo,
    });
  }
}
