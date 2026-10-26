import { MidiInput, KEYBOARD_COMMANDS, type MidiPortInfo, type MidiStatus } from '../audio/midiinput';
import type { Engine } from '../audio/engine';
import {
  MIDI_FX_SPECS,
  createMidiFx,
  defaultMidiFxParams,
  describeMidiFx,
  midiFxSpec,
} from '../core/midifx';
import type { Store } from '../core/store';
import type { MidiFxState, MidiFxType } from '../core/types';
import { el } from './controls';

/** Controls a MIDI controller's knobs can drive. */
export const MIDI_TARGETS: { key: string; label: string }[] = [
  { key: 'master', label: 'Master volume' },
  { key: 'volume', label: 'Selected track volume' },
  { key: 'pan', label: 'Selected track pan' },
  { key: 'sendA', label: 'Selected track send A' },
];

interface MidiMapEntry {
  controller: number;
  target: string;
}

const MAP_KEY = 'tas.midimap';

export interface MidiPanelOptions {
  onOpenNotes?: () => void;
  /**
   * Every note played, whether from a port or the computer keyboard, so the
   * arranger can record it. `down` is false on the matching release.
   */
  onNote?: (pitch: number, velocity: number, down: boolean) => void;
  toast?: (message: string) => void;
}

/**
 * The MIDI panel: controllers, the computer keyboard, MIDI effects and
 * controller mapping.
 *
 * Split out from the rack on purpose. A player sets a controller up once and
 * then works in the arrangement, so this is a floating panel that can be
 * opened next to whatever is being played, and detached to a second screen
 * with the window button in its header.
 */
export class MidiPanel {
  private store: Store;
  private engine: Engine;
  private options: MidiPanelOptions;
  private input: MidiInput;

  private root: HTMLElement;
  private badge!: HTMLElement;
  private statusLine!: HTMLElement;
  private activityLine!: HTMLElement;
  private portList!: HTMLElement;
  private startButton!: HTMLButtonElement;
  private fxList!: HTMLElement;
  private fxPicker!: HTMLSelectElement;
  private trackLabel!: HTMLElement;
  private learnButton!: HTMLButtonElement;
  private mapList!: HTMLElement;
  private mapTarget!: HTMLSelectElement;
  private octaveReadout!: HTMLElement;
  private velocityReadout!: HTMLElement;

  private octave = 3;
  private velocity = 0.8;
  private learning = false;
  private map: MidiMapEntry[] = [];
  private open = false;
  private unsubscribe: (() => void) | null = null;
  /**
   * What the effect list currently shows. Parameter changes must not rebuild
   * the cards: the slider being dragged would be replaced under the pointer and
   * the drag would die. Only a changed device list rebuilds.
   */
  private fxSignature = '';

  constructor(store: Store, engine: Engine, options: MidiPanelOptions = {}) {
    this.store = store;
    this.engine = engine;
    this.options = options;
    this.map = readMap();

    this.input = new MidiInput({
      onNoteOn: (pitch, velocity) => {
        void this.playNote(pitch, velocity);
        this.options.onNote?.(pitch, velocity, true);
      },
      onNoteOff: (pitch) => {
        // Live notes are one-shots with a release tail; nothing to stop, but a
        // recording still needs to know when the key came up.
        this.options.onNote?.(pitch, 0, false);
      },
      onControl: (event) => this.onControl(event.controller, event.value),
      onPorts: (ports) => this.renderPorts(ports),
      onStatus: (status) => this.renderStatus(status),
    });

    this.root = el('aside', 'agent rig-panel midi-panel');
    this.root.id = 'midi-panel';
    this.build();
  }

  // ------------------------------------------------------------------ build

  private build(): void {
    const head = el('header', 'agent-head');
    const dot = el('span', 'agent-dot');
    dot.style.background = 'var(--blue, #5aa9e6)';
    const title = el('div', 'agent-title');
    title.append(el('strong', '', 'MIDI'), el('span', '', 'controllers · keyboard · effects'));
    this.badge = el('span', 'rig-badge', 'offline');

    const detach = el('button', 'tbtn tbtn-sm', '⧉');
    detach.title = 'Open this panel in its own window, for a second screen';
    detach.addEventListener('click', () => this.detach());

    const close = el('button', 'tbtn tbtn-sm', '✕');
    close.addEventListener('click', () => this.close());
    head.append(dot, title, this.badge, detach, close);

    const body = el('div', 'agent-body');

    this.statusLine = el('div', 'agent-status', 'MIDI is not started.');
    this.activityLine = el('div', 'agent-status midi-activity', '');
    this.startButton = el('button', 'agent-run', 'Enable MIDI inputs');
    this.startButton.addEventListener('click', () => void this.toggleInputs());

    this.portList = el('div', 'rig-list');

    // Computer keyboard ------------------------------------------------------
    this.octaveReadout = el('span', 'midi-readout', '');
    this.velocityReadout = el('span', 'midi-readout', '');
    const octaveDown = el('button', 'tbtn tbtn-sm', '−');
    octaveDown.title = 'Octave down (Z)';
    octaveDown.addEventListener('click', () => this.shiftOctave(-1));
    const octaveUp = el('button', 'tbtn tbtn-sm', '+');
    octaveUp.title = 'Octave up (X)';
    octaveUp.addEventListener('click', () => this.shiftOctave(1));
    const velocityDown = el('button', 'tbtn tbtn-sm', '−');
    velocityDown.title = 'Softer (C)';
    velocityDown.addEventListener('click', () => this.shiftVelocity(-0.1));
    const velocityUp = el('button', 'tbtn tbtn-sm', '+');
    velocityUp.title = 'Harder (V)';
    velocityUp.addEventListener('click', () => this.shiftVelocity(0.1));

    const octaveRow = el('div', 'rig-row');
    octaveRow.append(el('span', 'midi-key', 'Octave'), octaveDown, this.octaveReadout, octaveUp);
    const velocityRow = el('div', 'rig-row');
    velocityRow.append(el('span', 'midi-key', 'Velocity'), velocityDown, this.velocityReadout, velocityUp);

    const notes = el('button', 'agent-run', 'Open the piano roll');
    notes.addEventListener('click', () => this.options.onOpenNotes?.());
    notes.title = 'Edit the notes of the selected MIDI clip';

    // MIDI effects -----------------------------------------------------------
    this.trackLabel = el('div', 'agent-status', '');
    this.fxPicker = el('select', 'rig-select') as HTMLSelectElement;
    this.fxPicker.title = 'Add a MIDI effect in front of the instrument';
    for (const spec of MIDI_FX_SPECS) {
      const option = el('option', '', spec.name);
      option.value = spec.type;
      this.fxPicker.appendChild(option);
    }
    const addFx = el('button', 'agent-run rig-grow', 'Add MIDI effect');
    addFx.addEventListener('click', () => this.addFx(this.fxPicker.value as MidiFxType));

    const pickerRow = el('div', 'rig-row');
    pickerRow.append(this.fxPicker, addFx);

    this.fxList = el('div', 'rig-list midi-fx-list');

    // Controller mapping -----------------------------------------------------
    this.mapTarget = el('select', 'rig-select') as HTMLSelectElement;
    for (const target of MIDI_TARGETS) {
      const option = el('option', '', target.label);
      option.value = target.key;
      this.mapTarget.appendChild(option);
    }
    this.learnButton = el('button', 'agent-run', 'Learn');
    this.learnButton.title = 'Move a knob or fader on the controller to bind it to the chosen control';
    this.learnButton.addEventListener('click', () => {
      this.learning = !this.learning;
      this.renderMapping();
    });
    const learnRow = el('div', 'rig-row');
    learnRow.append(this.learnButton);
    this.mapList = el('div', 'rig-list');

    body.append(
      el('p', 'agent-intro',
        'Play the selected MIDI track from a controller or the computer keyboard. MIDI effects run before the instrument, so they shape what you play and what plays back.'),
      this.statusLine,
      this.startButton,
      this.activityLine,
      el('div', 'section-title', 'Inputs'),
      this.portList,
      el('div', 'section-title', 'Computer keyboard'),
      octaveRow,
      velocityRow,
      el('p', 'agent-suggestion-detail',
        `A–L are the white keys, W E T Y U the black keys. ${KEYBOARD_COMMANDS.z} is Z, ${KEYBOARD_COMMANDS.x} is X, ${KEYBOARD_COMMANDS.c} is C, ${KEYBOARD_COMMANDS.v} is V.`),
      notes,
      el('div', 'section-title', 'MIDI effects'),
      this.trackLabel,
      pickerRow,
      this.fxList,
      el('div', 'section-title', 'Controller mapping'),
      this.mapTarget,
      learnRow,
      this.mapList,
    );

    this.root.append(head, body);
    this.renderReadouts();
    this.renderMapping();
  }

  // ------------------------------------------------------------------ state

  mount(): void {
    document.body.appendChild(this.root);
    if (!this.unsubscribe) this.unsubscribe = this.store.subscribe((reason) => {
      if (reason === 'params' && this.fxSignature === this.currentFxSignature()) return;
      this.renderFx();
    });
  }

  /** True while the panel is on screen; the keyboard only plays notes then. */
  get visible(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open = !this.open;
    this.root.classList.toggle('is-open', this.open);
    if (this.open) this.renderFx();
  }

  openPanel(): void {
    this.open = true;
    this.root.classList.add('is-open');
    this.renderFx();
  }

  close(): void {
    this.open = false;
    this.root.classList.remove('is-open');
    this.input.releaseAll();
  }

  /** Called by the window-level keyboard handler. True means the key was a note. */
  handleKey(key: string, down: boolean, repeat: boolean): boolean {
    // Octave and velocity keys only act on the way down, never repeat.
    if (down && !repeat) {
      const lower = key.toLowerCase();
      if (lower === 'z') {
        this.shiftOctave(-1);
        return true;
      }
      if (lower === 'x') {
        this.shiftOctave(1);
        return true;
      }
      if (lower === 'c') {
        this.shiftVelocity(-0.1);
        return true;
      }
      if (lower === 'v') {
        this.shiftVelocity(0.1);
        return true;
      }
    }

    return this.input.handleKey(key, {
      down,
      repeat,
      octave: this.octave,
      velocity: this.velocity,
    });
  }

  private targetTrackId(): string {
    const selected = this.store.selectedTrack;
    if (selected && selected.kind === 'midi') return selected.id;
    return this.store.project.tracks.find((track) => track.kind === 'midi')?.id ?? '';
  }

  private playNote(pitch: number, velocity: number): void {
    const trackId = this.targetTrackId();
    if (!trackId) return;
    void this.engine.liveNote(trackId, pitch, velocity);
  }

  private shiftOctave(delta: number): void {
    this.octave = Math.max(0, Math.min(8, this.octave + delta));
    this.renderReadouts();
  }

  private shiftVelocity(delta: number): void {
    this.velocity = Math.max(0.05, Math.min(1, Math.round((this.velocity + delta) * 10) / 10));
    this.renderReadouts();
  }

  private renderReadouts(): void {
    this.octaveReadout.textContent = `C${this.octave}`;
    this.velocityReadout.textContent = String(Math.round(this.velocity * 127));
  }

  private async toggleInputs(): Promise<void> {
    const status = this.input.state;
    if (status.state === 'ready') {
      this.input.stop();
      this.startButton.textContent = 'Enable MIDI inputs';
      return;
    }
    this.startButton.textContent = 'Looking for devices…';
    const result = await this.input.start();
    this.startButton.textContent = result.state === 'ready' ? 'Stop MIDI inputs' : 'Try again';
    this.renderStatus(result);
  }

  private renderStatus(status: MidiStatus): void {
    this.statusLine.textContent = status.message;
    this.badge.textContent = status.state === 'ready' ? 'live' : status.state;
    this.badge.classList.toggle('is-live', status.state === 'ready');
    if (status.activity) this.activityLine.textContent = status.activity;
    this.startButton.textContent = status.state === 'ready' ? 'Stop MIDI inputs' : 'Enable MIDI inputs';
  }

  private renderPorts(ports: MidiPortInfo[]): void {
    this.portList.replaceChildren();

    const inputs = ports.filter((port) => port.direction === 'input');
    if (inputs.length === 0) {
      this.portList.append(
        el('div', 'agent-suggestion-detail',
          'No MIDI inputs yet. Plug a controller in, then press Enable MIDI inputs — the computer keyboard works meanwhile.'),
      );
      return;
    }

    for (const port of inputs) {
      const row = el('div', 'rig-list-item midi-port');
      const name = el('div', 'midi-port-name');
      name.append(el('strong', '', port.name));
      if (port.manufacturer) name.append(el('span', '', port.manufacturer));
      if (!port.connected) name.append(el('span', 'midi-port-off', 'unplugged'));

      const trackLabel = el('label', 'rig-pref midi-switch');
      const track = el('input') as HTMLInputElement;
      track.type = 'checkbox';
      track.checked = port.track;
      track.addEventListener('change', () => this.input.setPortMode(port.id, 'track', track.checked));
      trackLabel.append(track, el('span', '', 'Track'));

      const remoteLabel = el('label', 'rig-pref midi-switch');
      const remote = el('input') as HTMLInputElement;
      remote.type = 'checkbox';
      remote.checked = port.remote;
      remote.addEventListener('change', () => this.input.setPortMode(port.id, 'remote', remote.checked));
      remoteLabel.append(remote, el('span', '', 'Remote'));

      row.append(name, trackLabel, remoteLabel);
      this.portList.append(row);
    }
  }

  // ------------------------------------------------------------- MIDI effects

  private fxChain(): MidiFxState[] | undefined {
    return this.store.selectedTrack?.midiFx;
  }

  private addFx(type: MidiFxType): void {
    const track = this.store.selectedTrack;
    if (!track) return;
    if (track.kind !== 'midi') {
      this.options.toast?.('MIDI effects belong on a MIDI track.');
      return;
    }
    this.store.edit('structure', (project) => {
      const entry = project.tracks.find((candidate) => candidate.id === track.id);
      if (!entry) return;
      entry.midiFx = [...(entry.midiFx ?? []), createMidiFx(type)];
    });
    this.options.toast?.(`Added ${midiFxSpec(type).name}`);
  }

  /** Identity of the rendered chain: the track plus its devices, not values. */
  private currentFxSignature(): string {
    const track = this.store.selectedTrack;
    const chain = track?.midiFx ?? [];
    return `${track?.id ?? ''}:${chain.map((entry) => `${entry.id}/${entry.type}/${entry.enabled ? 1 : 0}`).join(',')}`;
  }

  private renderFx(): void {
    this.fxSignature = this.currentFxSignature();
    const track = this.store.selectedTrack;
    this.trackLabel.textContent = track
      ? `${track.name}${track.kind === 'midi' ? '' : ' (not a MIDI track)'}`
      : 'Select a MIDI track';

    this.fxList.replaceChildren();
    const chain = this.fxChain() ?? [];

    if (chain.length === 0) {
      this.fxList.append(
        el('div', 'agent-suggestion-detail',
          'No MIDI effects on this track. Add Chord to play chords from one key, Scale to stay in key, or Arpeggiator to turn a held note into a pattern.'),
      );
    }

    for (const state of chain) {
      this.fxList.append(this.fxRow(state));
    }
  }

  private fxRow(state: MidiFxState): HTMLElement {
    const spec = midiFxSpec(state.type);
    const card = el('div', `midi-fx midi-fx-${state.type}`);
    card.classList.toggle('is-off', !state.enabled);

    const head = el('div', 'midi-fx-head');
    const power = el('button', 'midi-fx-power', state.enabled ? '●' : '○');
    power.title = state.enabled ? 'Bypass this effect' : 'Enable this effect';
    power.addEventListener('click', () => {
      this.store.edit('params', () => {
        state.enabled = !state.enabled;
      });
    });

    const name = el('div', 'midi-fx-name');
    name.append(el('strong', '', spec.name), el('span', '', describeMidiFx(state)));

    const remove = el('button', 'tbtn tbtn-sm midi-fx-remove', '✕');
    remove.title = `Remove ${spec.name}`;
    remove.addEventListener('click', () => {
      this.store.edit('structure', (project) => {
        const track = project.tracks.find((candidate) => candidate.id === this.store.selectedTrackId);
        if (!track?.midiFx) return;
        track.midiFx = track.midiFx.filter((entry) => entry.id !== state.id);
      });
    });

    head.append(power, name, remove);

    const grid = el('div', 'midi-fx-params');
    for (const param of spec.params) {
      const wrap = el('label', 'midi-fx-param');
      const value = state.params[param.key] ?? param.default;

      const top = el('div', 'midi-fx-param-top');
      const text = el('span', 'midi-fx-value', formatValue(param, value));
      top.append(el('span', '', param.label), text);

      const slider = el('input', 'midi-fx-slider') as HTMLInputElement;
      slider.type = 'range';
      slider.min = String(param.min);
      slider.max = String(param.max);
      slider.step = String(param.step);
      slider.value = String(value);
      slider.setAttribute('aria-label', `${spec.name} ${param.label}`);
      slider.addEventListener('input', () => {
        const next = Number(slider.value);
        text.textContent = formatValue(param, next);
        const summary = name.lastElementChild;
        if (summary) summary.textContent = describeMidiFx({ ...state, params: { ...state.params, [param.key]: next } });
        this.store.edit('params', () => {
          state.params = { ...state.params, [param.key]: next };
        });
      });
      wrap.append(top, slider);
      grid.append(wrap);
    }

    const reset = el('button', 'tbtn tbtn-sm midi-fx-reset', 'Reset');
    reset.title = 'Back to the default settings';
    reset.addEventListener('click', () => {
      this.store.edit('params', () => {
        state.params = defaultMidiFxParams(state.type);
      });
      this.renderFx();
    });
    head.append(reset);

    card.append(head, grid);
    return card;
  }

  // ---------------------------------------------------------------- mapping

  private onControl(controller: number, value: number): void {
    if (this.learning) {
      const target = this.mapTarget.value;
      this.map = [...this.map.filter((entry) => entry.target !== target), { controller, target }];
      writeMap(this.map);
      this.learning = false;
      this.options.toast?.(`CC ${controller} now controls ${MIDI_TARGETS.find((entry) => entry.key === target)?.label ?? target}`);
      this.renderMapping();
      return;
    }

    const entry = this.map.find((candidate) => candidate.controller === controller);
    if (!entry) return;
    const position = value / 127;

    this.store.edit('params', (project) => {
      if (entry.target === 'master') {
        project.master.volume = Math.round(position * 150) / 100;
        return;
      }
      const track = project.tracks.find((candidate) => candidate.id === this.store.selectedTrackId);
      if (!track) return;
      if (entry.target === 'volume') track.volume = Math.round(position * 150) / 100;
      else if (entry.target === 'pan') track.pan = position * 2 - 1;
      else if (entry.target === 'sendA') track.sends = [position, track.sends[1], track.sends[2], track.sends[3]];
    });
  }

  private renderMapping(): void {
    this.learnButton.textContent = this.learning ? 'Waiting for a knob…' : 'Learn';
    this.learnButton.classList.toggle('is-on', this.learning);

    this.mapList.replaceChildren();
    if (this.map.length === 0) {
      this.mapList.append(
        el('div', 'agent-suggestion-detail',
          'No controls mapped. Choose a fader above, press Learn, then move a knob or fader on the controller.'),
      );
      return;
    }

    for (const entry of this.map) {
      const row = el('div', 'rig-list-item midi-map');
      const label = MIDI_TARGETS.find((target) => target.key === entry.target)?.label ?? entry.target;
      row.append(el('strong', '', `CC ${entry.controller}`), el('span', '', label));

      const forget = el('button', 'tbtn tbtn-sm', '✕');
      forget.title = 'Forget this mapping';
      forget.addEventListener('click', () => {
        this.map = this.map.filter((candidate) => candidate !== entry);
        writeMap(this.map);
        this.renderMapping();
      });
      row.append(forget);
      this.mapList.append(row);
    }
  }

  private detach(): void {
    const host = (window as unknown as { tas?: { openPanel?: (panel: string) => void } }).tas;
    if (host?.openPanel) {
      host.openPanel('midi');
      this.close();
      return;
    }
    this.options.toast?.('Detaching a panel needs the desktop app.');
  }
}

function formatValue(param: { choices?: string[]; unit?: string; step: number; min: number; max: number }, value: number): string {
  if (param.choices) return param.choices[Math.round(value)] ?? String(value);
  const decimals = param.step < 1 ? 2 : 0;
  return `${value.toFixed(decimals)}${param.unit ?? ''}`;
}

function readMap(): MidiMapEntry[] {
  try {
    const raw = localStorage.getItem(MAP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MidiMapEntry[];
    return Array.isArray(parsed) ? parsed.filter((entry) => Number.isFinite(entry?.controller) && typeof entry?.target === 'string') : [];
  } catch {
    return [];
  }
}

function writeMap(map: MidiMapEntry[]): void {
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify(map));
  } catch {
    // Storage can be full or blocked; the mapping then only lasts this session.
  }
}
