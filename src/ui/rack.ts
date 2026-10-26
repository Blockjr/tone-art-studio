import type { Engine } from '../audio/engine';
import { MIC_MODELS, MIC_PRESETS, micModelAt, micPresetParams, presetsForModel } from '../audio/mics';
import {
  MASTER_TARGETS,
  analyzeMaster,
  analyzeTrack,
  type AiAnalysis,
  type AiCorrection,
} from '../audio/mixai';
import { ASSISTANT_NAME } from '../core/assistant';
import {
  DEVICE_SPECS,
  INSTRUMENT_SPECS,
  formatParam,
  type ParamSpec,
} from '../audio/specs';
import { createDevice, createInstrument, createMicDevice } from '../core/project';
import { delayMode, reverbMode } from '../audio/fxmath';
import { applyChainTemplate, templateCategories, templatesFor } from '../audio/templates';
import type { Store } from '../core/store';
import type { DeviceState, DeviceType, InstrumentType, Track } from '../core/types';
import { createKnob, el } from './controls';
import { mountEchoPanel, mountReverbPanel } from './fxpanels';
import { mountModulePanel } from './modulepanel';
import { enableReorder } from './reorder';
import { drawMicCurve, scheduleMicCurve } from './miccurve';

interface CardOptions {
  title: string;
  subtitle: string;
  params: ParamSpec[];
  values: Record<string, number>;
  enabled: boolean;
  collapsed: boolean;
  isInstrument?: boolean;
  onChange: (key: string, value: number) => void;
  onCommit: () => void;
  onToggle?: () => void;
  onCollapse?: () => void;
  onRemove?: () => void;
  /** slot number shown on the card, and the two reorder commands */
  index?: number;
  accent?: string;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** custom card contents (mic emulator); replaces the knob grid */
  body?: (host: HTMLElement) => void;
}

const DEVICE_ORDER: DeviceType[] = [
  'console',
  'busglue',
  'fet',
  'opto',
  'tape',
  'air',
  'aimix',
  'eq3',
  'compressor',
  'limiter',
  'delay',
  'reverb',
  'drive',
  'filter',
  'chorus',
  'micemu',
];

/** Panel accents per module family, so a chain reads at a glance. */
const DEVICE_ACCENTS: Partial<Record<DeviceType, string>> = {
  console: '#7dd3fc',
  busglue: '#f59e0b',
  fet: '#fb7185',
  opto: '#a3e635',
  tape: '#c084fc',
  air: '#38bdf8',
  eq3: '#34d399',
  compressor: '#fbbf24',
  limiter: '#f87171',
  delay: '#f472b6',
  reverb: '#60a5fa',
  drive: '#fb923c',
  filter: '#22d3ee',
  chorus: '#a78bfa',
  micemu: '#e879f9',
  aimix: '#f5a524',
};

interface AiCardState {
  analysis: AiAnalysis | null;
  applied: Set<string>;
  status: string;
  busy: boolean;
  /** bumped on every new run, so a slow render cannot overwrite a newer one */
  token: number;
}

export class Rack {
  private store: Store;
  private engine: Engine;
  private container: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private options: { onOpenAi?: (scope: string) => void };
  /** analysis survives the re-render that follows every applied correction */
  private aiState = new Map<string, AiCardState>();
  private applyingAi = false;
  /** which chain the rack edits: a track id, or 'master' */
  private target: string;
  private showTemplates = false;
  private chainStatus = '';
  private stopReorder: (() => void) | null = null;

  constructor(
    store: Store,
    engine: Engine,
    container: HTMLElement,
    options: { onOpenAi?: (scope: string) => void } = {},
  ) {
    this.store = store;
    this.engine = engine;
    this.container = container;
    this.options = options;
    this.target = store.selectedTrackId;
  }

  mount(): void {
    this.render();

    // Dragging a module by its slot number moves it in the chain. The listener
    // is on the container, so it survives the re-render every move causes.
    this.stopReorder = enableReorder({
      container: this.container,
      axis: 'y',
      handle: (target) => {
        if (target.closest('button, input, select')) return null;
        return target.closest<HTMLElement>('.device-slot');
      },
      onDrop: (id, index) => this.dropDevice(id, index),
    });

    this.unsubscribe = this.store.subscribe((reason) => {
      if (reason === 'structure' && !this.applyingAi) {
        // An external change (undo, another editor) means the applied marks no
        // longer match the session.
        for (const state of this.aiState.values()) state.applied.clear();
      }
      if (reason === 'selection' && !this.showTemplates) {
        // Selecting a track anywhere in the studio brings its own chain up;
        // the master view stays put until a track is actually selected.
        if (this.store.selectedTrackId && this.store.selectedTrackId !== this.target) {
          this.target = this.store.selectedTrackId;
        }
      }
      if (reason === 'structure' || reason === 'selection') this.render();
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.stopReorder?.();
    this.stopReorder = null;
  }

  /** What the rack is pointing at, for the panel header. */
  targetName(): string {
    if (this.target === 'master') return 'Master bus';
    const track = this.store.project.tracks.find((entry) => entry.id === this.target) ?? this.store.selectedTrack;
    return track ? track.name : '—';
  }

  private render(): void {
    this.container.innerHTML = '';
    const master = this.target === 'master';
    const track = this.store.project.tracks.find((entry) => entry.id === this.target) ?? this.store.selectedTrack;
    if (!master && !track) {
      this.container.appendChild(el('p', 'panel-hint', 'Select a track to load its device chain.'));
      return;
    }
    if (!master && track) this.target = track.id;

    const panelLabel = document.getElementById('rack-track-name');
    if (panelLabel) panelLabel.textContent = master ? 'Master bus' : track?.name ?? '—';

    const tabs = this.buildRackTabs(master);
    this.container.append(tabs);
    this.revealActiveTab(tabs);
    const devices = master ? this.store.project.master.devices : track?.devices ?? [];
    this.container.append(this.buildChainHead(master, devices.length));
    if (this.showTemplates) this.container.append(this.buildTemplatePanel(master));

    if (master) {
      this.container.append(this.buildMasterCard());
    } else if (track) {
      this.container.appendChild(this.buildTrackCard(track));

      if (track.kind === 'midi' && track.instrument) {
        this.container.appendChild(this.buildInstrumentCard(track));
      } else {
        const audioCard = el('div', 'device');
        const head = el('div', 'device-head');
        const dot = el('span', 'dot');
        head.append(dot, el('span', 'device-title', 'Audio Input'));
        const body = el('div', 'device-body');
        body.style.gridTemplateColumns = '1fr';
        body.appendChild(
          el(
            'p',
            'panel-hint',
            'Audio tracks play imported clips. Open the Files tab in the browser to pick a sample folder, then drag a file onto a lane to drop it at that beat — or use “Import Audio” to land it on this track at the playhead.',
          ),
        );
        audioCard.append(head, body);
        this.container.appendChild(audioCard);
      }
    }

    devices.forEach((device, index) => {
      this.container.appendChild(this.buildDeviceCard(master ? 'master' : 'track', track, device, index));
    });

    this.container.appendChild(this.buildEmptyPlate());
    this.container.appendChild(this.buildAddDevice(master ? 'master' : 'track', track));
  }

  /** One tab per track plus the master bus: every chain has its own home. */
  private buildRackTabs(master: boolean): HTMLElement {
    const tabs = el('div', 'rack-tabs');
    for (const track of this.store.project.tracks) {
      const active = !master && track.id === this.target;
      const button = el('button', `rack-tab${active ? ' is-on' : ''}`);
      const dot = el('span', 'dot');
      dot.style.background = track.color;
      button.append(dot, document.createTextNode(track.name));
      button.title = `${track.name} — ${track.devices.length} inserts`;
      button.addEventListener('click', () => {
        this.target = track.id;
        this.store.selectTrack(track.id);
        this.render();
      });
      tabs.append(button);
    }
    const masterTab = el('button', `rack-tab rack-tab-master${master ? ' is-on' : ''}`, 'Master');
    masterTab.title = 'Master bus chain — glue, tone, tape and limiter';
    masterTab.addEventListener('click', () => {
      this.target = 'master';
      this.render();
    });
    tabs.append(masterTab);

    // Big sessions get one scrollable row of tabs: the wheel moves it, and the
    // active chain is brought into view so switching tracks never loses the tab.
    tabs.addEventListener(
      'wheel',
      (event) => {
        if (tabs.scrollWidth <= tabs.clientWidth + 1) return;
        event.preventDefault();
        tabs.scrollLeft += event.deltaX || event.deltaY;
      },
      { passive: false },
    );
    return tabs;
  }

  /**
   * Brings the active chain's tab on screen after the row has been laid out,
   * and leaves the row alone while the tab the user just clicked is visible.
   */
  private revealActiveTab(tabs: HTMLElement): void {
    const activeTab = tabs.querySelector<HTMLElement>('.rack-tab.is-on');
    if (!activeTab || tabs.clientWidth <= 0) return;
    const left = activeTab.offsetLeft;
    const right = left + activeTab.offsetWidth;
    if (left >= tabs.scrollLeft && right <= tabs.scrollLeft + tabs.clientWidth) return;
    const centered = left - (tabs.clientWidth - activeTab.offsetWidth) / 2;
    tabs.scrollLeft = Math.max(0, centered);
  }

  private buildChainHead(master: boolean, count: number): HTMLElement {
    const wrap = el('div', 'chain-head-wrap');
    const head = el('div', 'chain-head');
    const title = el('div', 'chain-title');
    const countText = `${count} insert${count === 1 ? '' : 's'}${count >= 8 ? ' · 8 recommended max' : ''}`;
    title.append(
      el('strong', '', master ? 'Master chain' : 'Insert chain'),
      el('span', '', `${countText} · ${master ? 'stereo sum' : 'signal flows top to bottom'}`),
    );
    const actions = el('div', 'chain-actions');
    const templates = el('button', 'chain-btn', this.showTemplates ? 'Close templates' : 'Templates');
    templates.title = 'Load a gain-staged starting chain for this track or the master';
    templates.addEventListener('click', () => {
      this.showTemplates = !this.showTemplates;
      this.render();
    });
    actions.append(templates);
    head.append(title, actions);
    wrap.append(head);
    if (this.chainStatus) wrap.append(el('div', 'chain-status', this.chainStatus));
    return wrap;
  }

  private buildTemplatePanel(master: boolean): HTMLElement {
    const panel = el('div', 'chain-templates');
    const head = el('div', 'chain-templates-head');
    head.append(
      el('strong', '', master ? 'Master templates' : 'Track templates'),
      el('span', '', 'starting points · replaces these inserts in one undo step'),
    );
    panel.append(head);
    const templates = templatesFor(master ? 'master' : 'track');
    for (const category of templateCategories(templates)) {
      panel.append(el('div', 'chain-template-group', category));
      for (const template of templates.filter((entry) => entry.category === category)) {
        const card = el('button', 'chain-template');
        card.title = `${template.description}\n\n${template.chain}`;
        card.append(el('strong', '', template.name), el('span', '', template.chain));
        card.addEventListener('click', () => {
          const ok = applyChainTemplate(this.store, template, this.target);
          this.showTemplates = false;
          this.chainStatus = ok
            ? `${template.name} applied — Ctrl+Z restores the previous chain.`
            : 'Select a track first.';
          this.render();
        });
        panel.append(card);
      }
    }
    panel.append(
      el(
        'p',
        'chain-templates-note',
        'Level-match by ear and adjust in context. These chains are modelled on classic console and modular-rack workflows, not on one fixed preset.',
      ),
    );
    return panel;
  }

  private buildMasterCard(): HTMLElement {
    const card = el('div', 'rack-track');
    const dot = el('span', 'dot');
    dot.style.background = 'var(--rose)';
    const info = el('div');
    info.append(
      el('div', 'name', 'Master Bus'),
      el('div', 'sub', `${this.store.project.master.devices.length} inserts · stereo · limiter last`),
    );
    card.append(dot, info);
    return card;
  }

  private buildEmptyPlate(): HTMLElement {
    const plate = el('div', 'rack-slot-plate');
    plate.append(el('span', '', 'EMPTY SLOT'), el('small', '', 'add a module below to keep stacking'));
    return plate;
  }

  private moveDevice(source: 'track' | 'master', index: number, delta: number, deviceId: string, track?: Track): void {
    this.moveDeviceTo(source, index + delta, deviceId, track);
  }

  /**
   * Puts one insert at a chosen position in its chain.
   *
   * Both the ↑ ↓ buttons and a drag end up here, so the two ways of moving a
   * module cannot disagree; the drag adds the one thing the buttons cannot do,
   * which is to take an insert from the bottom of a long chain straight to the
   * top. The whole move is one undo step.
   */
  private moveDeviceTo(source: 'track' | 'master', index: number, deviceId: string, track?: Track): void {
    this.editChain(source, track, (list) => {
      const from = list.findIndex((entry) => entry.id === deviceId);
      if (from === -1) return;
      const to = Math.max(0, Math.min(list.length - 1, index));
      if (to === from) return;
      const [device] = list.splice(from, 1);
      list.splice(to, 0, device);
    });
  }

  /** A dropped insert: the same undoable move, with the position it was dropped on. */
  private dropDevice(deviceId: string, index: number): void {
    const master = this.target === 'master';
    const track = this.store.project.tracks.find((entry) => entry.id === this.target) ?? this.store.selectedTrack;
    this.moveDeviceTo(master ? 'master' : 'track', index, deviceId, track);
    this.chainStatus = 'Insert moved — Ctrl+Z puts the chain back as it was.';
  }

  private editChain(
    source: 'track' | 'master',
    track: Track | undefined,
    mutate: (list: DeviceState[]) => void,
  ): void {
    this.store.edit('structure', (project) => {
      const list =
        source === 'master'
          ? project.master.devices
          : project.tracks.find((entry) => entry.id === track?.id)?.devices;
      if (list) mutate(list);
    });
  }

  private buildTrackCard(track: Track): HTMLElement {
    const card = el('div', 'rack-track');
    const dot = el('span', 'dot');
    dot.style.background = track.color;
    const info = el('div');
    info.append(el('div', 'name', track.name), el('div', 'sub', `${track.kind} track · ${track.devices.length} inserts`));
    card.append(dot, info);
    return card;
  }

  private buildInstrumentCard(track: Track): HTMLElement {
    const instrument = track.instrument;
    if (!instrument) return el('div');
    const spec = INSTRUMENT_SPECS[instrument.type];

    const card = el('div', 'device is-instrument');
    const head = el('div', 'device-head');

    const select = el('select');
    select.style.cssText =
      'background:#0d1016;border:1px solid #242833;border-radius:4px;padding:2px 4px;font-size:10px;color:#ccd0da;outline:none;max-width:150px';
    for (const type of Object.keys(INSTRUMENT_SPECS) as InstrumentType[]) {
      const option = el('option', '', INSTRUMENT_SPECS[type].name);
      option.value = type;
      option.selected = type === instrument.type;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      const type = select.value as InstrumentType;
      this.store.edit('structure', () => {
        track.instrument = createInstrument(type);
      });
    });

    head.append(el('span', 'dot'), el('span', 'device-title', 'Instrument'), select);

    const body = el('div', 'device-body');
    for (const param of spec.params) {
      body.appendChild(this.buildKnob(track, param, instrument.params, undefined));
    }

    const keybed = el('div');
    keybed.style.cssText = 'display:grid;grid-template-columns:repeat(8,1fr);gap:3px;padding:0 8px 9px';
    for (let i = 0; i < 8; i++) {
      const pitch = 60 + i;
      const key = el('button', 'tiny', ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'][i]);
      key.style.height = '22px';
      key.title = 'Audition note';
      key.addEventListener('click', () => void this.engine.previewNote(track.id, pitch, 0.45));
      keybed.appendChild(key);
    }

    card.append(head, body, keybed);
    return card;
  }

  private buildDeviceCard(
    source: 'track' | 'master',
    track: Track | undefined,
    device: DeviceState,
    index: number,
  ): HTMLElement {
    const card =
      track && device.type === 'micemu'
        ? this.buildMicCard(track, device)
        : track && device.type === 'aimix'
          ? this.buildAiCard(track, device)
          : device.type === 'delay'
            ? this.buildFxCard(source, track, device, 'delay', index)
            : device.type === 'reverb'
              ? this.buildFxCard(source, track, device, 'reverb', index)
              : this.buildModuleCard(source, track, device, index);

    // Every insert is draggable by its slot number; this is what a drop reports
    // back. The track card and the instrument card deliberately have no id, so
    // a drag that starts on them does nothing instead of moving a module.
    card.dataset.dragId = device.id;
    return card;
  }

  /** Every other insert gets the same animated faceplate family. */
  private buildModuleCard(
    source: 'track' | 'master',
    track: Track | undefined,
    device: DeviceState,
    index: number,
  ): HTMLElement {
    const spec = DEVICE_SPECS[device.type];
    const accent = DEVICE_ACCENTS[device.type] ?? '#94a3b8';
    const chooser = spec.params.find((param) => param.choices);
    const chosen = chooser
      ? chooser.choices![Math.max(0, Math.min(chooser.choices!.length - 1, Math.round(device.params[chooser.key] ?? chooser.default)))]
      : spec.category;

    return this.buildCard({
      title: spec.name,
      subtitle: chosen,
      params: [],
      values: device.params,
      enabled: device.enabled,
      collapsed: device.collapsed,
      index,
      accent,
      onChange: (key, value) => {
        this.store.beginGesture();
        this.store.touch('params', () => {
          device.params[key] = value;
        });
      },
      onCommit: () => this.store.endGesture(),
      onToggle: () => {
        this.editChain(source, track, (list) => {
          const target = list.find((entry) => entry.id === device.id);
          if (target) target.enabled = !target.enabled;
        });
      },
      onCollapse: () => {
        device.collapsed = !device.collapsed;
        this.render();
      },
      onRemove: () => {
        this.editChain(source, track, (list) => {
          const found = list.findIndex((entry) => entry.id === device.id);
          if (found !== -1) list.splice(found, 1);
        });
      },
      onMoveUp: index > 0 ? () => this.moveDevice(source, index, -1, device.id, track) : undefined,
      onMoveDown:
        source === 'master'
          ? () => this.moveDevice(source, index, 1, device.id, track)
          : track && index < track.devices.length - 1
            ? () => this.moveDevice(source, index, 1, device.id, track)
            : undefined,
      body: (host) => {
        mountModulePanel(host, {
          type: device.type,
          values: device.params,
          accent,
          bpm: this.store.project.bpm,
          level: () => (source === 'master' ? this.engine.deviceLevel('master', device.id) : track ? this.engine.deviceLevel(track.id, device.id) : 0),
          onChange: (key, value) => {
            this.store.beginGesture();
            this.store.touch('params', () => {
              device.params[key] = value;
            });
          },
          onCommit: () => this.store.endGesture(),
          rerender: () => this.render(),
        });
      },
    });
  }

  /** Echo and reverb get a full faceplate: mode buttons, display and knobs. */
  private buildFxCard(
    source: 'track' | 'master',
    track: Track | undefined,
    device: DeviceState,
    type: 'delay' | 'reverb',
    index: number,
  ): HTMLElement {
    const spec = DEVICE_SPECS[type];
    const accent = DEVICE_ACCENTS[type] ?? '#f472b6';
    const mode = type === 'delay' ? delayMode(device.params.mode ?? 0).name : reverbMode(device.params.mode ?? 1).name;

    return this.buildCard({
      title: spec.name,
      subtitle: mode,
      params: [],
      values: device.params,
      enabled: device.enabled,
      collapsed: device.collapsed,
      index,
      accent,
      onChange: (key, value) => {
        this.store.beginGesture();
        this.store.touch('params', () => {
          device.params[key] = value;
        });
      },
      onCommit: () => this.store.endGesture(),
      onToggle: () => {
        this.editChain(source, track, (list) => {
          const target = list.find((entry) => entry.id === device.id);
          if (target) target.enabled = !target.enabled;
        });
      },
      onCollapse: () => {
        device.collapsed = !device.collapsed;
        this.render();
      },
      onRemove: () => {
        this.editChain(source, track, (list) => {
          const found = list.findIndex((entry) => entry.id === device.id);
          if (found !== -1) list.splice(found, 1);
        });
      },
      onMoveUp: index > 0 ? () => this.moveDevice(source, index, -1, device.id, track) : undefined,
      onMoveDown:
        source === 'master'
          ? () => this.moveDevice(source, index, 1, device.id, track)
          : track && index < track.devices.length - 1
            ? () => this.moveDevice(source, index, 1, device.id, track)
            : undefined,
      body: (host) => {
        const panel = type === 'delay' ? mountEchoPanel : mountReverbPanel;
        panel(host, {
          values: device.params,
          accent,
          bpm: this.store.project.bpm,
          onChange: (key, value) => {
            this.store.beginGesture();
            this.store.touch('params', () => {
              device.params[key] = value;
            });
          },
          onCommit: () => this.store.endGesture(),
          rerender: () => this.render(),
          level: () =>
            source === 'master'
              ? this.engine.deviceLevel('master', device.id)
              : track
                ? this.engine.deviceLevel(track.id, device.id)
                : 0,
        });
      },
    });
  }

  private buildCard(options: CardOptions): HTMLElement {
    const card = el('div', `device${options.enabled ? '' : ' is-off'}${options.index !== undefined ? ' has-slot' : ''}`);
    if (options.collapsed) card.classList.add('is-collapsed');
    if (options.isInstrument) card.classList.add('is-instrument');
    if (options.accent) card.style.setProperty('--dev-accent', options.accent);

    const head = el('div', 'device-head');
    const power = el('span', 'dot');
    if (options.index !== undefined) {
      // The slot number doubles as the grip: it is the one part of the header
      // that is not a knob, a title or a button, so it is where a drag starts.
      const slot = el('span', 'device-slot', String(options.index + 1).padStart(2, '0'));
      slot.title = 'Drag to move this module anywhere in the chain';
      head.append(power, slot);
    } else {
      head.append(power);
    }
    head.append(el('span', 'device-title', options.title), el('span', 'device-sub', options.subtitle));

    const actions = el('div', 'device-actions');
    if (options.onMoveUp) {
      const up = el('button', '', '↑');
      up.title = 'Move this module earlier in the chain';
      up.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onMoveUp?.();
      });
      actions.appendChild(up);
    }
    if (options.onMoveDown) {
      const down = el('button', '', '↓');
      down.title = 'Move this module later in the chain';
      down.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onMoveDown?.();
      });
      actions.appendChild(down);
    }
    if (options.onToggle) {
      const toggle = el('button', '', options.enabled ? '●' : '○');
      toggle.title = options.enabled ? 'Bypass this module' : 'Enable this module';
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onToggle?.();
      });
      actions.appendChild(toggle);
    }
    if (options.onCollapse) {
      const collapse = el('button', '', options.collapsed ? '▸' : '▾');
      collapse.title = 'Collapse';
      collapse.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onCollapse?.();
      });
      actions.appendChild(collapse);
    }
    if (options.onRemove) {
      const remove = el('button', '', '✕');
      remove.title = 'Remove device';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onRemove?.();
      });
      actions.appendChild(remove);
    }
    head.appendChild(actions);

    const body = el('div', 'device-body');
    if (options.body) {
      body.classList.add('is-stacked');
      options.body(body);
    } else {
      for (const param of options.params) {
        body.appendChild(
          this.buildKnobFromValues(param, options.values, options.onChange, options.onCommit, undefined, options.accent),
        );
      }
    }

    card.append(head, body);
    return card;
  }

  private aiFor(deviceId: string): AiCardState {
    let state = this.aiState.get(deviceId);
    if (!state) {
      state = { analysis: null, applied: new Set<string>(), status: '', busy: false, token: 0 };
      this.aiState.set(deviceId, state);
    }
    return state;
  }

  /**
   * The AI Mix & Master card: measure, explain, then write the corrections into
   * the channel strip and the master chain. Nothing is applied until asked.
   */
  private buildAiCard(track: Track, device: DeviceState): HTMLElement {
    const state = this.aiFor(device.id);
    const isMaster = Math.round(device.params.mode ?? 0) === 1;
    const targetIndex = Math.min(MASTER_TARGETS.length - 1, Math.max(0, Math.round(device.params.target ?? 0)));
    const target = MASTER_TARGETS[targetIndex];

    const rerender = (): void => this.render();

    const setMode = (mode: number): void => {
      if (Math.round(device.params.mode ?? 0) === mode) return;
      state.analysis = null;
      state.applied.clear();
      state.status = '';
      this.store.edit('structure', () => {
        device.params.mode = mode;
      });
    };

    const run = async (): Promise<void> => {
      if (state.busy) return;
      const mode = Math.round(device.params.mode ?? 0) === 1 ? 'master' : 'track';
      const targetForRun = MASTER_TARGETS[
        Math.min(MASTER_TARGETS.length - 1, Math.max(0, Math.round(device.params.target ?? 0)))
      ];
      const intensity = device.params.intensity ?? 0.8;

      state.busy = true;
      state.status = mode === 'master' ? 'Rendering the whole mix and every track…' : `Rendering “${track.name}”…`;
      const token = ++state.token;
      rerender();

      try {
        const analysis =
          mode === 'master'
            ? await analyzeMaster(this.store, targetForRun, intensity)
            : await analyzeTrack(this.store, track.id, intensity);
        if (token !== state.token) return;
        state.analysis = analysis;
        state.applied.clear();
        state.status = analysis.stats.silent
          ? 'No audio in this range — nothing to correct.'
          : `${analysis.summary} · ${analysis.corrections.length} correction${analysis.corrections.length === 1 ? '' : 's'}`;
      } catch (error) {
        if (token === state.token) {
          state.status = error instanceof Error ? error.message : 'Analysis failed.';
        }
      } finally {
        if (token === state.token) {
          state.busy = false;
          rerender();
        }
      }
    };

    return this.buildCard({
      title: `${ASSISTANT_NAME} · AI Mix & Master`,
      subtitle: isMaster ? `whole mix · ${target.name}` : 'track mix',
      params: [],
      values: device.params,
      enabled: device.enabled,
      collapsed: device.collapsed,
      onChange: () => {},
      onCommit: () => {},
      onToggle: () => {
        this.store.edit('structure', () => {
          device.enabled = !device.enabled;
        });
      },
      onCollapse: () => {
        device.collapsed = !device.collapsed;
        rerender();
      },
      onRemove: () => {
        this.aiState.delete(device.id);
        this.store.edit('structure', () => {
          track.devices = track.devices.filter((d) => d.id !== device.id);
        });
      },
      body: (host) => {
        const modes = el('div', 'ai-seg');
        for (const [label, mode] of [
          ['Mix this track', 0],
          ['Master the mix', 1],
        ] as [string, number][]) {
          const button = el('button', `ai-seg-btn${(mode === 1) === isMaster ? ' is-on' : ''}`, label);
          button.addEventListener('click', () => setMode(mode));
          modes.appendChild(button);
        }
        host.appendChild(modes);

        if (isMaster) {
          const targets = el('div', 'ai-chips');
          MASTER_TARGETS.forEach((entry, index) => {
            const chip = el('button', `ai-chip${index === targetIndex ? ' is-on' : ''}`, entry.name);
            chip.title = `${entry.lufs} LUFS · ${entry.ceiling} dBTP ceiling`;
            chip.addEventListener('click', () => {
              if (index === targetIndex) return;
              state.analysis = null;
              state.applied.clear();
              state.status = `Aiming for ${entry.lufs} LUFS (${entry.name.toLowerCase()}).`;
              this.store.edit('structure', () => {
                device.params.target = index;
              });
            });
            targets.appendChild(chip);
          });
          host.appendChild(targets);
        }

        const intensityRow = el('div', 'ai-row');
        const intensityLabel = el('span', 'ai-label', 'Intensity');
        const slider = el('input', 'ai-slider') as HTMLInputElement;
        slider.type = 'range';
        slider.min = '20';
        slider.max = '100';
        slider.step = '5';
        slider.value = String(Math.round((device.params.intensity ?? 0.8) * 100));
        const value = el('span', 'ai-value', `${slider.value}%`);
        slider.addEventListener('input', () => {
          value.textContent = `${slider.value}%`;
          this.store.beginGesture();
          this.store.touch('params', () => {
            device.params.intensity = Number(slider.value) / 100;
          });
        });
        slider.addEventListener('change', () => this.store.endGesture());
        intensityRow.append(intensityLabel, slider, value);
        host.appendChild(intensityRow);

        const action = el('div', 'ai-action');
        const analyze = el('button', 'ai-run', state.busy ? 'Analyzing…' : state.analysis ? 'Analyze again' : 'Analyze & suggest');
        analyze.disabled = state.busy;
        analyze.addEventListener('click', () => void run());
        action.appendChild(analyze);
        if (state.applied.size > 0) {
          const undo = el('button', 'ai-undo', 'Undo');
          undo.title = 'Undo the last AI change (one Ctrl+Z step); all values stay editable';
          undo.addEventListener('click', () => {
            this.store.undo();
            state.applied.clear();
            state.status = 'AI change undone — previous settings restored.';
            rerender();
          });
          action.appendChild(undo);
        }
        host.appendChild(action);

        const openPanel = el('button', 'ai-open', `Open in ${ASSISTANT_NAME} ↗`);
        openPanel.title = 'Same whole-mix analysis with every track listed, plus the help guides';
        openPanel.addEventListener('click', () => {
          this.options.onOpenAi?.(Math.round(device.params.mode ?? 0) === 1 ? 'master' : track.id);
        });
        host.appendChild(openPanel);

        if (state.status) host.appendChild(el('div', 'ai-status', state.status));

        const analysis = state.analysis;
        if (!analysis) return;

        const stats = el('div', 'ai-stats');
        const stat = (label: string, text: string, title: string): HTMLElement => {
          const cell = el('div', 'ai-stat');
          cell.title = title;
          cell.append(el('span', 'ai-stat-label', label), el('span', 'ai-stat-value', text));
          return cell;
        };
        stats.append(
          stat('LUFS', analysis.stats.lufs.toFixed(1), 'Integrated loudness, BS.1770 gated'),
          stat('TRUE PK', analysis.stats.truePeakDb.toFixed(1), 'Inter-sample peak, 4x oversampled'),
          stat('CREST', `${analysis.stats.crestDb.toFixed(0)} dB`, 'Peak minus RMS, how much the transients stick out'),
          stat('PHASE', analysis.stats.correlation.toFixed(2), 'Left/right correlation; negative cancels in mono'),
        );
        host.appendChild(stats);

        const band = el('div', 'ai-band');
        const bands: [string, number, string][] = [
          ['b-low', analysis.stats.bands.low, 'Low (<150 Hz)'],
          ['b-lowmid', analysis.stats.bands.lowMid, 'Low-mid (150–800 Hz)'],
          ['b-mid', analysis.stats.bands.mid, 'Mid (0.8–3 kHz)'],
          ['b-high', analysis.stats.bands.high, 'High (>3 kHz)'],
        ];
        for (const [name, pct, title] of bands) {
          const segment = el('span', name);
          segment.style.width = `${Math.max(0, Math.min(100, pct))}%`;
          segment.title = `${title} ${pct.toFixed(0)}%`;
          band.appendChild(segment);
        }
        host.appendChild(band);

        if (!analysis.corrections.length) {
          host.appendChild(el('div', 'ai-empty', 'Already balanced for this target — nothing worth changing.'));
          return;
        }

        const pending = analysis.corrections.filter((correction) => !state.applied.has(correction.id));
        const tools = el('div', 'ai-tools');
        const applyAll = el('button', 'ai-apply-all', pending.length ? `Apply all ${pending.length}` : 'All applied ✓');
        applyAll.disabled = pending.length === 0;
        applyAll.addEventListener('click', () => this.applyAiCorrections(state, pending));
        tools.appendChild(applyAll);
        host.appendChild(tools);

        for (const correction of analysis.corrections) {
          const card = el('div', 'ai-corr');
          const head = el('div', 'ai-corr-head');
          head.appendChild(el('span', `ai-area ${correction.area}`, correction.area.toUpperCase()));
          if (correction.targetName) head.appendChild(el('span', 'ai-target', correction.targetName));
          const actions = el('div', 'ai-corr-actions');
          const done = state.applied.has(correction.id);
          const apply = el('button', 'ai-apply', done ? 'Applied ✓' : 'Apply');
          apply.disabled = done;
          apply.addEventListener('click', () => this.applyAiCorrections(state, [correction]));
          actions.appendChild(apply);
          head.appendChild(actions);
          card.append(
            head,
            el('div', 'ai-corr-title', correction.title),
            el('div', 'ai-corr-detail', correction.detail),
          );
          host.appendChild(card);
        }
        host.appendChild(
          el(
            'p',
            'ai-hint',
            'Every applied value is a normal channel-strip or master control. Edit it in the rack or console; Undo or Ctrl+Z takes the last AI change back.',
          ),
        );
      },
    });
  }

  private applyAiCorrections(state: AiCardState, corrections: AiCorrection[]): void {
    if (!corrections.length) return;
    // Mark first: store.edit re-renders synchronously, and the rebuilt card
    // reads these fields to show what has already been applied.
    for (const correction of corrections) state.applied.add(correction.id);
    state.status = `${corrections.length} change${corrections.length === 1 ? '' : 's'} applied — every value stays editable, and Undo takes it back.`;
    this.applyingAi = true;
    try {
      this.store.edit('structure', (project) => {
        for (const correction of corrections) correction.apply(project);
      });
    } finally {
      this.applyingAi = false;
    }
  }

  private buildMicCard(track: Track, device: DeviceState): HTMLElement {
    const model = micModelAt(device.params.model ?? 0);
    const store = this.store;

    const presetFor = (candidate: string): boolean => {
      const current = device.params;
      const entry = MIC_PRESETS.find((preset) => preset.id === candidate);
      if (!entry) return false;
      return (
        Math.abs((current.proximity ?? 0) - entry.params.proximity) < 1e-6 &&
        Math.abs((current.presence ?? 0) - entry.params.presence) < 1e-6 &&
        Math.abs((current.air ?? 0) - entry.params.air) < 1e-6 &&
        Math.abs((current.drive ?? 0) - entry.params.drive) < 1e-6 &&
        Math.abs((current.output ?? 0) - entry.params.output) < 1e-6
      );
    };

    const active = presetsForModel(model.id).find((preset) => presetFor(preset.id));

    return this.buildCard({
      title: 'Mic Emulator',
      subtitle: model.family,
      params: [],
      values: device.params,
      enabled: device.enabled,
      collapsed: device.collapsed,
      onChange: (key, value) => {
        store.beginGesture();
        store.touch('params', () => {
          device.params[key] = value;
        });
      },
      onCommit: () => store.endGesture(),
      onToggle: () => {
        store.edit('structure', () => {
          device.enabled = !device.enabled;
        });
      },
      onCollapse: () => {
        device.collapsed = !device.collapsed;
        this.render();
      },
      onRemove: () => {
        store.edit('structure', () => {
          track.devices = track.devices.filter((d) => d.id !== device.id);
        });
      },
      body: (host) => {
        const modelRow = el('div', 'mic-model-row');
        modelRow.appendChild(el('span', 'mic-label', 'Mic'));
        const select = el('select', 'mic-select');
        MIC_MODELS.forEach((entry, index) => {
          const option = el('option', '', entry.name);
          option.value = String(index);
          option.selected = index === Math.round(device.params.model ?? 0);
          select.appendChild(option);
        });
        select.addEventListener('change', () => {
          const chosen = MIC_MODELS[Number(select.value)] ?? MIC_MODELS[0];
          const params = micPresetParams(chosen.id);
          store.beginGesture();
          store.touch('params', () => {
            Object.assign(device.params, params);
          });
          store.endGesture();
          this.render();
        });
        modelRow.appendChild(select);

        const tagline = el('div', 'mic-tagline', `${model.tagline} · best on ${model.best.toLowerCase()}`);

        const chips = el('div', 'mic-presets');
        for (const entry of presetsForModel(model.id)) {
          const chip = el('button', 'mic-chip', entry.name);
          chip.title = entry.use;
          if (active?.id === entry.id) chip.classList.add('is-on');
          chip.addEventListener('click', () => {
            const params = micPresetParams(model.id, entry.id);
            store.beginGesture();
            store.touch('params', () => {
              Object.assign(device.params, params);
            });
            store.endGesture();
            this.render();
          });
          chips.appendChild(chip);
        }

        const canvas = el('canvas', 'mic-curve');
        canvas.width = 300;
        canvas.height = 78;
        scheduleMicCurve(canvas, device.params);

        const knobs = el('div', 'mic-knobs');
        for (const spec of DEVICE_SPECS.micemu.params) {
          if (spec.key === 'model') continue;
          const knob = createKnob({
            label: spec.label,
            value: device.params[spec.key] ?? spec.default,
            min: spec.min,
            max: spec.max,
            size: 38,
            format: (value) => formatParam(spec, value),
            defaultValue: spec.default,
            onChange: (value) => {
              store.beginGesture();
              store.touch('params', () => {
                device.params[spec.key] = value;
              });
              drawMicCurve(canvas, device.params);
            },
            onCommit: () => store.endGesture(),
          });
          knobs.appendChild(knob.element);
        }

        host.append(modelRow, tagline, chips, canvas, knobs);
      },
    });
  }

  private buildKnob(
    _track: Track,
    param: ParamSpec,
    values: Record<string, number>,
    device?: DeviceState,
  ): HTMLElement {
    return this.buildKnobFromValues(
      param,
      values,
      (key, value) => {
        this.store.beginGesture();
        this.store.touch('params', () => {
          values[key] = value;
        });
      },
      () => this.store.endGesture(),
      device,
    );
  }

  private buildKnobFromValues(
    param: ParamSpec,
    values: Record<string, number>,
    onChange: (key: string, value: number) => void,
    onCommit: () => void,
    extraClass?: unknown,
    color?: string,
  ): HTMLElement {
    const knob = createKnob({
      label: param.label,
      value: values[param.key] ?? param.default,
      min: param.min,
      max: param.max,
      size: 42,
      color,
      format: (value) => formatParam(param, value),
      onChange: (value) => onChange(param.key, value),
      onCommit,
      defaultValue: param.default,
    });
    if (extraClass) knob.element.classList.add('wide');
    return knob.element;
  }

  private buildAddDevice(source: 'track' | 'master', track?: Track): HTMLElement {
    const wrap = el('div', 'add-device');
    const select = el('select');
    select.style.cssText =
      'background:#14181f;border:1px solid #242833;border-radius:5px;padding:6px;font-size:11px;color:#ccd0da;outline:none';
    const placeholder = el('option', '', 'Add module…');
    placeholder.value = '';
    select.appendChild(placeholder);
    for (const type of DEVICE_ORDER) {
      if (source === 'master' && (type === 'micemu' || type === 'aimix')) continue;
      const option = el('option', '', `${DEVICE_SPECS[type].name} · ${DEVICE_SPECS[type].category}`);
      option.value = type;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      const type = select.value as DeviceType;
      if (!type) return;
      this.editChain(source, track, (list) => {
        list.push(type === 'micemu' ? createMicDevice(MIC_MODELS[0].id) : createDevice(type));
      });
    });
    wrap.appendChild(select);
    if (source === 'track' && track && !track.devices.length) {
      const hint = el('p', 'add-device-hint', '');
      hint.append(
        document.createTextNode('Start with '),
        el('strong', '', 'Console Strip'),
        document.createTextNode(' for tone and level, then stack a compressor and Tape. Templates above load a ready chain.'),
      );
      wrap.appendChild(hint);
    }
    return wrap;
  }
}
