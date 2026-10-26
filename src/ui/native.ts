import type { Preferences } from '../core/session';
import {
  describeChain,
  describeDevice,
  describeLoopback,
  filterPlugins,
  groupDevices,
  sortPlugins,
  type NativeBridge,
  type NativeChainEntry,
  type NativeMeters,
  type NativeState,
} from '../native/bridge';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
import { el } from './controls';

export class NativePanel {
  private bridge: NativeBridge;
  private root: HTMLElement;
  private badge: HTMLElement;
  private body: HTMLElement;
  private deviceStatus: HTMLElement;
  private deviceSelect: HTMLSelectElement;
  private deviceMeta: HTMLElement;
  private refreshButton: HTMLButtonElement;
  private loopbackStatus: HTMLElement;
  private loopbackButton: HTMLButtonElement;
  private loopbackStats: HTMLElement;
  private scanButton: HTMLButtonElement;
  private clearButton: HTMLButtonElement;
  private search: HTMLInputElement;
  private pluginList: HTMLElement;
  private chainList: HTMLElement;
  private chainSummary: HTMLElement;
  private errorLine: HTMLElement;
  private state: NativeState | null = null;
  private query = '';
  private preferences: Preferences;
  private onPreferences: (preferences: Preferences) => void;
  private scanOnStart: HTMLInputElement;
  private songStatus: HTMLElement;
  private songExport: HTMLButtonElement;
  private songLoad: HTMLButtonElement;
  private songUnload: HTMLButtonElement;
  private songPlay: HTMLButtonElement;
  private songPosition: HTMLElement;
  private songLoop: HTMLInputElement;
  private songTrackSelect: HTMLSelectElement;
  private songMute: HTMLButtonElement;
  private songSolo: HTMLButtonElement;
  private chainTarget: HTMLSelectElement;
  private chainTargetLabel: HTMLElement;
  private target = 'master';
  private onExportStems: (() => Promise<string>) | undefined;

  constructor(
    bridge: NativeBridge,
    preferences: Preferences,
    onPreferences: (preferences: Preferences) => void,
    onExportStems?: () => Promise<string>,
  ) {
    this.bridge = bridge;
    this.preferences = preferences;
    this.onPreferences = onPreferences;
    this.onExportStems = onExportStems;
    this.root = el('aside', 'agent rig-panel');

    const head = el('header', 'agent-head');
    const dot = el('span', 'agent-dot');
    dot.style.background = 'var(--amber)';
    dot.style.boxShadow = '0 0 10px rgba(240, 176, 72, 0.85)';
    const title = el('div', 'agent-title');
    title.append(el('strong', '', 'Studio Rig'), el('span', '', 'ASIO · virtual driver · VST3'));
    this.badge = el('span', 'rig-badge', 'browser');
    const close = el('button', 'tbtn tbtn-sm', '✕');
    close.addEventListener('click', () => this.close());
    head.append(dot, title, this.badge, close);

    this.body = el('div', 'agent-body');

    // Device section
    this.deviceStatus = el('div', 'agent-status', 'Reading device…');
    this.deviceSelect = el('select', 'rig-select');
    this.deviceSelect.id = 'rig-device-select';
    const openRow = el('div', 'rig-row');
    const openButton = el('button', 'agent-run rig-grow', 'Open device');
    openButton.addEventListener('click', () => this.openSelectedDevice());
    this.refreshButton = el('button', 'tbtn tbtn-sm', 'Refresh');
    this.refreshButton.addEventListener('click', () => this.bridge.send({ type: 'listDevices' }));
    openRow.append(openButton, this.refreshButton);
    this.deviceMeta = el('div', 'agent-status', '');

    // Loopback section
    this.loopbackStatus = el('div', 'agent-status', 'Virtual ASIO driver: unknown');
    this.loopbackButton = el('button', 'agent-run', 'Enable virtual loopback');
    this.loopbackButton.addEventListener('click', () => {
      const enabled = this.state?.loopback?.enabled ?? false;
      this.bridge.setLoopback(!enabled);
    });
    this.loopbackStats = el('div', 'rig-stats', '');

    // VST3 section
    this.scanButton = el('button', 'agent-run', 'Scan VST3 folders');
    this.scanButton.addEventListener('click', () => this.bridge.scanPlugins());
    this.clearButton = el('button', 'tbtn tbtn-sm', 'Clear chain');
    this.clearButton.addEventListener('click', () => this.bridge.clearPlugins());
    this.search = el('input', 'rig-search') as HTMLInputElement;
    this.search.type = 'search';
    this.search.placeholder = 'Filter plugins by name or maker';
    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.renderPlugins();
    });
    this.pluginList = el('div', 'rig-list');
    this.chainList = el('div', 'rig-list');
    this.chainSummary = el('div', 'agent-status', describeChain([]));
    this.errorLine = el('div', 'agent-status', '');

    const vstRow = el('div', 'rig-row');
    vstRow.append(this.scanButton, this.clearButton);

    const scanPref = el('label', 'rig-pref');
    this.scanOnStart = el('input') as HTMLInputElement;
    this.scanOnStart.type = 'checkbox';
    this.scanOnStart.checked = preferences.scanVst3OnStart;
    this.scanOnStart.addEventListener('change', () => {
      this.preferences = { ...this.preferences, scanVst3OnStart: this.scanOnStart.checked };
      this.onPreferences(this.preferences);
    });
    scanPref.append(this.scanOnStart, el('span', '', 'Scan VST3 folders when the app starts'));

    this.body.append(
      el('p', 'agent-intro',
        'Native audio and plugins. ASIO and VST3 only exist in the desktop build; the browser uses Web Audio and cannot load either.'),
      el('div', 'section-title', 'Audio device'),
      this.deviceStatus,
      this.deviceSelect,
      openRow,
      this.deviceMeta,
      el('div', 'section-title', 'Virtual ASIO loopback'),
      this.loopbackStatus,
      this.loopbackButton,
      this.loopbackStats,
      el('p', 'agent-suggestion-detail',
        'Install the driver once with the elevated install-virtual-asio.ps1 next to the app. Other ASIO applications then see "Tone Art Virtual ASIO", and their audio meets the studio master here.'),
    );

    // Song (VST3 mixer) section
    this.songStatus = el('div', 'agent-status', 'No stems loaded. Export stems, then load the folder here.');
    this.songExport = el('button', 'agent-run', 'Export stems…');
    this.songExport.addEventListener('click', () => void this.exportStems());
    this.songLoad = el('button', 'tbtn tbtn-sm', 'Load folder…');
    this.songLoad.addEventListener('click', () => this.bridge.chooseStemsFolder());
    this.songUnload = el('button', 'tbtn tbtn-sm', 'Unload');
    this.songUnload.addEventListener('click', () => this.bridge.unloadStems());
    const songRow = el('div', 'rig-row');
    songRow.append(this.songExport, this.songLoad, this.songUnload);

    this.songPlay = el('button', 'agent-run', 'Play');
    this.songPlay.addEventListener('click', () => {
      this.bridge.setSongPlaying(!(this.state?.song?.playing ?? false));
    });
    this.songPosition = el('div', 'agent-status', '0:00 / 0:00');
    const transport = el('div', 'rig-row');
    transport.append(this.songPlay, this.songPosition);

    const loopLabel = el('label', 'rig-pref');
    this.songLoop = el('input') as HTMLInputElement;
    this.songLoop.type = 'checkbox';
    this.songLoop.addEventListener('change', () => this.bridge.setSongLoop(this.songLoop.checked));
    loopLabel.append(this.songLoop, el('span', '', 'Loop the song'));

    this.songTrackSelect = el('select', 'rig-select');
    this.songTrackSelect.addEventListener('change', () => {
      this.target = this.songTrackSelect.value || 'master';
      this.chainTarget.value = this.target;
      if (this.state) {
        this.renderChain(this.state);
        this.renderPlugins();
      }
    });

    this.songMute = el('button', 'tbtn tbtn-sm', 'Mute');
    this.songMute.addEventListener('click', () => this.toggleTrack('mute'));
    this.songSolo = el('button', 'tbtn tbtn-sm', 'Solo');
    this.songSolo.addEventListener('click', () => this.toggleTrack('solo'));
    const mixRow = el('div', 'rig-row');
    mixRow.append(this.songMute, this.songSolo);

    this.chainTarget = el('select', 'rig-select');
    this.chainTarget.addEventListener('change', () => {
      this.target = this.chainTarget.value || 'master';
      this.songTrackSelect.value = this.target;
      if (this.state) {
        this.renderChain(this.state);
        this.renderPlugins();
      }
    });
    this.chainTargetLabel = el('div', 'section-title', 'Master VST3 chain');

    this.body.append(
      el('div', 'section-title', 'VST3 song mixer'),
      this.songStatus,
      songRow,
      transport,
      loopLabel,
      this.songTrackSelect,
      mixRow,
      el('p', 'agent-suggestion-detail',
        'Play/Stop here drives the native VST3 mixer. The browser transport still plays the browser mix, so use one at a time, and export again after editing clips or effects.'),
      this.chainTargetLabel,
      this.chainTarget,
      vstRow,
      scanPref,
      this.search,
      this.pluginList,
      this.chainSummary,
      this.chainList,
      this.errorLine,
    );

    this.root.append(head, this.body);
  }

  mount(): void {
    document.body.appendChild(this.root);
    this.badge.textContent = this.bridge.available ? 'native' : 'browser';

    if (!this.bridge.available) {
      this.renderBrowserFallback();
      return;
    }

    this.bridge.connect();
    this.bridge.onState((state) => this.render(state));
    this.bridge.onMeters((meters) => this.renderMeters(meters));
  }

  toggle(): void {
    this.root.classList.toggle('is-open');
  }

  open(): void {
    this.root.classList.add('is-open');
  }

  close(): void {
    this.root.classList.remove('is-open');
  }

  // --------------------------------------------------------------- rendering

  private renderBrowserFallback(): void {
    this.deviceStatus.textContent = 'Web Audio engine (browser build)';
    this.deviceMeta.textContent = 'ASIO, the virtual driver and VST3 hosting require the desktop build in native/.';
    this.deviceSelect.disabled = true;
    this.loopbackStatus.textContent = 'Virtual ASIO driver: desktop build only';
    this.loopbackStats.textContent =
      'ASIO cannot be installed from a browser. Build the Windows app (native-windows CI artefact), run install-virtual-asio.ps1 as administrator, then pick “Tone Art Virtual ASIO” in your host and enable loopback here.';
    this.loopbackButton.disabled = true;
    this.scanButton.disabled = true;
    this.scanOnStart.disabled = true;
    this.clearButton.disabled = true;
    this.search.disabled = true;
    this.refreshButton.disabled = true;
    this.chainSummary.textContent = 'No native plugin host in this build';
    this.songStatus.textContent = 'Export stems here, then load the folder in the desktop build to mix through VST3.';
    this.songExport.disabled = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker !== 'function';
    this.songLoad.disabled = true;
    this.songUnload.disabled = true;
    this.songPlay.disabled = true;
    this.songLoop.disabled = true;
    this.songTrackSelect.disabled = true;
    this.songMute.disabled = true;
    this.songSolo.disabled = true;
    this.chainTarget.disabled = true;
  }

  private render(state: NativeState): void {
    this.state = state;
    this.badge.textContent = 'native';
    this.badge.classList.add('is-live');

    const device = state.device;
    this.deviceStatus.textContent = describeDevice(device);

    const flags = [device?.isAsio ? 'ASIO' : '', device?.isVirtual ? 'virtual' : ''].filter(Boolean);
    this.deviceMeta.textContent = flags.length
      ? `${flags.join(' · ')} driver · ${state.loopback?.driverOnline ? 'host active' : 'host idle'}`
      : 'System audio driver';

    this.renderDeviceOptions(state);
    this.renderLoopback(state);
    this.renderSong(state);
    this.renderChain(state);
    this.renderPlugins();

    this.errorLine.textContent = state.lastError || (state.plugins.length === 0 ? 'No VST3 plugins scanned yet.' : '');
    this.errorLine.style.color = state.lastError ? 'var(--amber)' : 'var(--dim-2)';
  }

  private renderDeviceOptions(state: NativeState): void {
    const previous = this.deviceSelect.value;
    this.deviceSelect.replaceChildren();

    const groups = groupDevices(state.devices ?? []);

    const appendGroup = (label: string, devices: typeof groups.asio) => {
      if (devices.length === 0) return;
      const group = el('optgroup');
      group.label = label;

      for (const device of devices) {
        const option = el('option');
        option.value = `${device.type}|${device.name}`;
        option.textContent = device.isVirtual ? `${device.name} (virtual)` : device.name;
        if (device.selected) option.selected = true;
        group.appendChild(option);
      }

      this.deviceSelect.appendChild(group);
    };

    appendGroup('Virtual ASIO drivers', groups.virtual);
    appendGroup('ASIO interfaces', groups.asio);
    appendGroup('System audio', groups.other);

    if (previous && !this.deviceSelect.value) {
      const restored = [...this.deviceSelect.options].find((option) => option.value === previous);
      if (restored) restored.selected = true;
    }
  }

  private renderLoopback(state: NativeState): void {
    const loopback = state.loopback;
    this.loopbackStatus.textContent = describeLoopback(loopback);
    this.loopbackStatus.style.color = loopback?.attached
      ? loopback.driverOnline
        ? 'var(--green)'
        : 'var(--blue)'
      : 'var(--dim-2)';

    this.loopbackButton.textContent = loopback?.enabled
      ? 'Disable virtual loopback'
      : 'Enable virtual loopback';
    this.loopbackButton.classList.toggle('is-on', Boolean(loopback?.enabled));
    this.loopbackButton.disabled = !loopback?.attached;

    if (!loopback?.attached) {
      this.loopbackStats.textContent = '';
      return;
    }

    const parts = [
      loopback.sampleRate ? `${loopback.sampleRate} Hz` : '',
      loopback.blockSize ? `${loopback.blockSize} smp` : '',
      `${loopback.queuedFromDrivers ?? 0} frames queued`,
      `${loopback.inputOverruns ?? 0}/${loopback.outputOverruns ?? 0} overruns`,
    ].filter(Boolean);

    this.loopbackStats.textContent = parts.join(' · ');
  }

  private chainEntries(): NativeChainEntry[] {
    if (this.target === 'master') return this.state?.song?.masterChain ?? this.state?.chain ?? [];
    return this.state?.song?.tracks.find((track) => track.id === this.target)?.chain ?? [];
  }

  private renderSong(state: NativeState): void {
    const song = state.song;
    const loaded = song?.loaded === true;
    const tracks = song?.tracks ?? [];

    if (this.target !== 'master' && !tracks.some((track) => track.id === this.target)) this.target = 'master';

    this.songStatus.textContent = loaded
      ? `${tracks.length} stems · ${formatTime(song?.length ?? 0)} · VST3 on every track`
      : 'No stems loaded. Export stems, then load the folder here.';
    this.songStatus.style.color = loaded ? 'var(--green)' : 'var(--dim-2)';
    this.songUnload.disabled = !loaded;
    this.songPlay.disabled = !loaded;
    this.songPlay.textContent = song?.playing ? 'Stop' : 'Play';
    this.songLoop.checked = song?.loop ?? false;
    this.songLoop.disabled = !loaded;
    this.songPosition.textContent = `${formatTime(song?.position ?? 0)} / ${formatTime(song?.length ?? 0)}`;

    const fillTargets = (select: HTMLSelectElement) => {
      select.replaceChildren();
      const master = el('option');
      master.value = 'master';
      master.textContent = 'Master bus';
      select.appendChild(master);

      for (const track of tracks) {
        const option = el('option');
        option.value = track.id;
        option.textContent = track.name;
        select.appendChild(option);
      }

      select.value = this.target;
      if (!select.value) select.value = 'master';
    };

    fillTargets(this.songTrackSelect);
    fillTargets(this.chainTarget);

    const track = tracks.find((candidate) => candidate.id === this.target);
    this.songMute.disabled = !track;
    this.songSolo.disabled = !track;
    this.songMute.textContent = track?.mute ? 'Muted' : 'Mute';
    this.songSolo.textContent = track?.solo ? 'Soloed' : 'Solo';
    this.songMute.classList.toggle('is-on', Boolean(track?.mute));
    this.songSolo.classList.toggle('is-on', Boolean(track?.solo));
  }

  private toggleTrack(kind: 'mute' | 'solo'): void {
    const track = this.state?.song?.tracks.find((candidate) => candidate.id === this.target);
    if (!track) return;

    this.bridge.setTrackMix(track, kind === 'mute' ? { mute: !track.mute } : { solo: !track.solo });
  }

  private renderChain(state: NativeState): void {
    const entries = this.chainEntries();
    const perTrack = this.target !== 'master';
    const track = state.song?.tracks.find((candidate) => candidate.id === this.target);

    this.chainTargetLabel.textContent = perTrack && track ? `${track.name} VST3 chain` : 'Master VST3 chain';
    this.chainSummary.textContent = describeChain(entries);
    this.chainList.replaceChildren();

    entries.forEach((entry, index) => {
      const slot = entry.slot ?? entry.index ?? index;
      const row = el('div', 'rig-item');

      const label = el('div', 'rig-item-name');
      label.append(el('strong', '', `${index + 1}. ${entry.name}`));
      label.append(el('span', '', entry.bypassed ? 'bypassed' : entry.hasEditor ? 'editor available' : 'no editor'));

      const actions = el('div', 'rig-actions');

      if (entry.hasEditor) {
        const edit = el('button', 'rig-mini', 'Edit');
        edit.title = 'Open the plugin editor';
        edit.addEventListener('click', () => {
          if (perTrack) this.bridge.openTrackPluginEditor(this.target, slot);
          else this.bridge.openPluginEditor(slot);
        });
        actions.appendChild(edit);
      }

      const power = el('button', `rig-mini${entry.bypassed ? '' : ' is-on'}`, 'Power');
      power.title = entry.bypassed ? 'Enable this plugin' : 'Bypass this plugin';
      power.addEventListener('click', () => {
        if (perTrack) this.bridge.setTrackPluginBypass(this.target, slot, !entry.bypassed);
      });
      power.disabled = !perTrack;

      const up = el('button', 'rig-mini', '↑');
      up.title = 'Move earlier in the chain';
      up.disabled = index === 0;
      up.addEventListener('click', () => {
        if (perTrack) this.bridge.moveTrackPlugin(this.target, slot, slot - 1);
        else this.bridge.movePlugin(slot, slot - 1);
      });

      const down = el('button', 'rig-mini', '↓');
      down.title = 'Move later in the chain';
      down.disabled = index === entries.length - 1;
      down.addEventListener('click', () => {
        if (perTrack) this.bridge.moveTrackPlugin(this.target, slot, slot + 1);
        else this.bridge.movePlugin(slot, slot + 1);
      });

      const remove = el('button', 'rig-mini rig-mini-danger', '✕');
      remove.title = 'Remove from the chain';
      remove.addEventListener('click', () => {
        if (perTrack) this.bridge.removeTrackPlugin(this.target, slot);
        else this.bridge.removePlugin(slot);
      });

      actions.append(power, up, down, remove);
      row.append(label, actions);
      this.chainList.appendChild(row);
    });
  }

  private async exportStems(): Promise<void> {
    if (!this.onExportStems) return;

    this.songExport.disabled = true;
    this.songStatus.textContent = 'Rendering stems…';

    try {
      this.songStatus.textContent = await this.onExportStems();
      this.songStatus.style.color = 'var(--green)';
    } catch (error) {
      this.songStatus.textContent = error instanceof Error ? error.message : 'The stems could not be written.';
      this.songStatus.style.color = 'var(--amber)';
    } finally {
      this.songExport.disabled = false;
    }
  }

  private renderPlugins(): void {
    if (!this.state) return;

    this.pluginList.replaceChildren();

    const found = sortPlugins(filterPlugins(this.state.plugins ?? [], this.query));
    const limited = found.slice(0, 60);

    if (limited.length === 0) {
      this.pluginList.appendChild(
        el('div', 'agent-status', this.query ? 'No plugins match that filter.' : 'No VST3 plugins found yet.'),
      );
      return;
    }

    for (const plugin of limited) {
      const row = el('div', 'rig-item');

      const label = el('div', 'rig-item-name');
      label.append(el('strong', '', plugin.name));
      label.append(el('span', '', plugin.manufacturer || plugin.category || 'VST3'));

      const perTrack = this.target !== 'master';
      const add = el('button', 'rig-mini', 'Add');
      add.title = perTrack
        ? `Add ${plugin.name} to this track's VST3 chain`
        : `Add ${plugin.name} to the master chain`;
      add.disabled = perTrack && !this.state?.song?.tracks.some((track) => track.id === this.target);
      add.addEventListener('click', () => {
        if (perTrack) this.bridge.addTrackPlugin(this.target, plugin.identifier);
        else this.bridge.addPlugin(plugin.identifier);
      });

      row.append(label, add);
      this.pluginList.appendChild(row);
    }
  }

  private renderMeters(meters: NativeMeters): void {
    if (meters.song) {
      this.songPosition.textContent = `${formatTime(meters.song.position)} / ${formatTime(meters.song.length)}`;

      const label = meters.song.playing ? 'Stop' : 'Play';
      if (this.songPlay.textContent !== label) this.songPlay.textContent = label;
    }

    if (!meters.loopback) return;

    const previous = this.state?.loopback;
    const state = this.state;

    if (state) {
      state.loopback = meters.loopback;

      if (previous?.enabled !== meters.loopback.enabled || previous?.driverOnline !== meters.loopback.driverOnline) {
        this.renderLoopback(state);
      } else {
        this.loopbackStats.textContent = [
          meters.loopback.sampleRate ? `${meters.loopback.sampleRate} Hz` : '',
          meters.loopback.blockSize ? `${meters.loopback.blockSize} smp` : '',
          `${meters.loopback.queuedFromDrivers ?? 0} frames queued`,
          `${meters.loopback.inputOverruns ?? 0}/${meters.loopback.outputOverruns ?? 0} overruns`,
        ]
          .filter(Boolean)
          .join(' · ');
      }
    }
  }

  private openSelectedDevice(): void {
    const value = this.deviceSelect.value;
    if (!value) return;

    const separator = value.indexOf('|');
    const deviceType = value.slice(0, separator);
    const deviceName = value.slice(separator + 1);
    this.bridge.openDevice(deviceType, deviceName);
  }
}
