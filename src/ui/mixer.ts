import type { Engine } from '../audio/engine';
import { DEVICE_SPECS } from '../audio/specs';
import { byteColumns } from '../audio/waveform';
import type { Store } from '../core/store';
import type { ReturnState, Track } from '../core/types';
import { createKnob, el } from './controls';
import { enableReorder } from './reorder';

const FADER_MAX = 1.4;
const SEND_LABELS = ['Rev', 'Dly', 'Cho', 'Room'];
const SEND_COLORS = ['#8fd6b0', '#e0b466', '#b9a4f8', '#8fc6e6'];

function gainToDb(gain: number): number {
  return gain <= 0.0005 ? -Infinity : 20 * Math.log10(gain);
}

function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '−∞';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Console-style scale marks on the fader travel. */
const FADER_TICKS: { db: number; gain: number }[] = [
  { db: 2, gain: dbToGain(2) },
  { db: 0, gain: 1 },
  { db: -6, gain: dbToGain(-6) },
  { db: -12, gain: dbToGain(-12) },
  { db: -24, gain: dbToGain(-24) },
];

export interface MixerOptions {
  /** Clicking the master insert chips opens the AI Assistant on the master bus. */
  onOpenMasterAi?: () => void;
}

export class Mixer {
  private store: Store;
  private engine: Engine;
  private container: HTMLElement;
  private meters = new Map<string, HTMLElement>();
  private returnMeters = new Map<number, HTMLElement>();
  private readouts = new Map<string, HTMLElement>();
  private peakLines = new Map<string, HTMLElement>();
  private clipLeds = new Map<string, HTMLElement>();
  private scopes = new Map<string, HTMLCanvasElement>();
  private smoothed = new Map<string, number>();
  private held = new Map<string, number>();
  private clipUntil = new Map<string, number>();
  /** Scope toggles are view state, so they survive a re-render without undo noise. */
  private waves = new Set<string>();
  private raf = 0;
  private unsubscribe: (() => void) | null = null;
  private stopReorder: (() => void) | null = null;
  private options: MixerOptions;

  constructor(store: Store, engine: Engine, container: HTMLElement, options: MixerOptions = {}) {
    this.store = store;
    this.engine = engine;
    this.container = container;
    this.options = options;
  }

  mount(): void {
    this.render();
    this.unsubscribe = this.store.subscribe((reason) => {
      if (reason === 'structure' || reason === 'selection') this.render();
      if (reason === 'transport') this.pump();
    });
    this.pump();

    // Dragging a channel cap reorders the track list; the arrangement headers
    // listen to the same store action, so both views stay in step.
    this.stopReorder = enableReorder({
      container: this.container,
      axis: 'x',
      handle: (target) => {
        if (target.closest('input, button')) return null;
        return target.closest<HTMLElement>('.strip-cap');
      },
      onDrop: (id, index) => this.store.moveTrack(id, index),
    });
  }

  dispose(): void {
    window.clearTimeout(this.raf);
    this.unsubscribe?.();
    this.stopReorder?.();
    this.stopReorder = null;
  }

  /**
   * Meters run at ~20 fps while the transport rolls and ~3 fps when parked, so
   * a stopped session barely wakes the CPU. Scopes only read the analyser when
   * their own WAVE button is on.
   */
  private pump(): void {
    this.updateMeters();
    window.clearTimeout(this.raf);
    this.raf = window.setTimeout(() => this.pump(), this.engine.isPlaying ? 50 : 340);
  }

  private render(): void {
    this.container.innerHTML = '';
    this.meters.clear();
    this.returnMeters.clear();
    this.readouts.clear();
    this.peakLines.clear();
    this.clipLeds.clear();
    this.scopes.clear();
    this.masterPeakReadout = null;

    this.store.project.tracks.forEach((track, index) => {
      this.container.appendChild(this.buildStrip(track, index));
    });

    this.store.project.returns.forEach((bus, index) => {
      this.container.appendChild(this.buildReturnStrip(bus, index));
    });

    this.container.appendChild(this.buildMasterStrip());
    this.updateMeters();
  }

  private keyFor(kind: 'track' | 'return' | 'master', id: string): string {
    return kind === 'master' ? 'master' : `${kind}:${id}`;
  }

  /** Console module header: channel number, scribble name, colour tab. */
  private buildCap(options: {
    index?: number;
    label?: string;
    name: string;
    color: string;
    onRename?: (name: string) => void;
    selected?: boolean;
    onSelect?: () => void;
    draggable?: boolean;
  }): HTMLElement {
    const cap = el('div', 'strip-cap');
    if (options.selected) cap.classList.add('is-selected');

    if (options.draggable) {
      const grip = el('span', 'strip-grip', '⠿');
      grip.title = 'Drag to reorder this channel';
      cap.appendChild(grip);
    }

    if (options.index !== undefined) {
      cap.appendChild(el('span', 'strip-num', String(options.index + 1).padStart(2, '0')));
    } else if (options.label) {
      cap.appendChild(el('span', 'strip-num', options.label));
    }

    const name = el('span', 'strip-name', options.name);
    name.title = options.onRename ? 'Double-click to rename' : options.name;
    if (options.onRename) {
      name.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        this.startRename(name, options.name, options.onRename!);
      });
    }
    if (options.onSelect) {
      name.addEventListener('click', options.onSelect);
      name.style.cursor = 'pointer';
    }
    cap.appendChild(name);
    cap.appendChild(el('span', 'strip-accent')).style.background = options.color;
    return cap;
  }

  private startRename(nameEl: HTMLElement, current: string, commit: (name: string) => void): void {
    const input = el('input', 'strip-rename');
    input.value = current;
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (apply: boolean): void => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (apply && next && next !== current) {
        commit(next);
      } else {
        nameEl.textContent = current;
        input.replaceWith(nameEl);
      }
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  private buildMeter(key: string, color = 'var(--rose)'): HTMLElement {
    const wrap = el('div', 'meter-wrap');
    const fill = el('div', 'meter-fill');
    fill.style.background = `linear-gradient(0deg, #1a7a58, #35c894 58%, #d9b05a 82%, ${color})`;
    const peak = el('div', 'meter-peak');
    const led = el('span', 'clip-led');
    wrap.append(fill, peak, led);
    this.meters.set(key, fill);
    this.peakLines.set(key, peak);
    this.clipLeds.set(key, led);
    return wrap;
  }

  private buildFader(
    value: number,
    key: string,
    apply: (value: number) => void,
    label: string,
  ): { wrap: HTMLElement; readout: HTMLElement } {
    const wrap = el('div', 'fader-wrap');

    const scale = el('div', 'fader-scale');
    for (const tick of FADER_TICKS) {
      const mark = el('span', 'fader-tick');
      mark.style.bottom = `${Math.min(100, (tick.gain / FADER_MAX) * 100)}%`;
      mark.dataset.db = tick.db > 0 ? `+${tick.db}` : String(tick.db);
      scale.appendChild(mark);
    }
    const inf = el('span', 'fader-tick is-inf');
    inf.style.bottom = '0%';
    inf.dataset.db = '−∞';
    scale.appendChild(inf);

    const input = el('input', 'fader-input');
    input.type = 'range';
    input.min = '0';
    input.max = String(FADER_MAX);
    input.step = '0.005';
    input.value = String(value);
    input.title = `${label} — double-click for unity`;
    input.setAttribute('aria-label', label);
    input.addEventListener('pointerdown', () => this.store.beginGesture());
    input.addEventListener('input', () => {
      this.store.touch('params', () => apply(Number(input.value)));
      this.updateReadout(key, Number(input.value));
    });
    input.addEventListener('change', () => this.store.endGesture());
    input.addEventListener('dblclick', () => {
      this.store.edit('params', () => apply(1));
      input.value = '1';
      this.updateReadout(key, 1);
    });

    wrap.append(input, scale);

    const readout = el('div', 'strip-db', `${formatDb(gainToDb(value))} dB`);
    this.readouts.set(key, readout);
    return { wrap, readout };
  }

  private updateReadout(key: string, gain: number): void {
    const node = this.readouts.get(key);
    if (node) node.textContent = `${formatDb(gainToDb(gain))} dB`;
  }

  private buildWaveButton(key: string, color: string): HTMLButtonElement {
    const button = el('button', 'strip-toggle', 'WAVE');
    button.title = 'Live waveform viewer for this channel';
    button.classList.toggle('is-on', this.waves.has(key));
    button.addEventListener('click', () => {
      if (this.waves.has(key)) {
        this.waves.delete(key);
        button.classList.remove('is-on');
      } else {
        this.waves.add(key);
        button.classList.add('is-on');
      }
      const strip = button.closest('.strip');
      strip?.classList.toggle('has-wave', this.waves.has(key));
      if (this.waves.has(key)) {
        const canvas = this.scopes.get(key);
        if (canvas) this.drawScope(key, canvas, color);
      }
    });
    return button;
  }

  private buildScope(key: string, color: string): HTMLCanvasElement {
    const canvas = el('canvas', 'strip-scope');
    canvas.width = 260;
    canvas.height = 44;
    canvas.dataset.waveKey = key;
    canvas.style.color = color;
    this.scopes.set(key, canvas);
    return canvas;
  }

  private buildSends(track: Track): HTMLElement {
    const wrap = el('div', 'strip-sends');
    SEND_LABELS.forEach((label, index) => {
      const cell = el('div', 'send-cell');

      const knob = createKnob({
        label,
        value: track.sends[index] ?? 0,
        min: 0,
        max: 1,
        size: 24,
        color: SEND_COLORS[index],
        format: (v) => `${Math.round(v * 100)}`,
        onChange: (v) => {
          this.store.beginGesture();
          this.store.touch('params', () => {
            track.sends[index] = v;
          });
        },
        onCommit: () => this.store.endGesture(),
        defaultValue: 0,
      });

      const mode = el('button', 'send-mode', track.preSends?.[index] ? 'PRE' : 'POST');
      mode.title = `Send ${'ABCD'[index]}: pre- or post-fader`;
      mode.classList.toggle('is-pre', Boolean(track.preSends?.[index]));
      mode.addEventListener('click', () => {
        this.store.edit('structure', () => {
          track.preSends[index] = !track.preSends[index];
        });
      });

      cell.append(knob.element, mode);
      wrap.appendChild(cell);
    });
    return wrap;
  }

  private buildPan(value: number, apply: (value: number) => void): HTMLElement {
    return createKnob({
      label: 'Pan',
      value,
      min: -1,
      max: 1,
      size: 28,
      color: 'var(--m-accent, #d8b06a)',
      format: (v) => (Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`),
      onChange: (v) => {
        this.store.beginGesture();
        this.store.touch('params', () => apply(v));
      },
      onCommit: () => this.store.endGesture(),
      defaultValue: 0,
    }).element;
  }

  private buildStrip(track: Track, index: number): HTMLElement {
    const key = this.keyFor('track', track.id);
    const strip = el('div', 'strip');
    strip.dataset.trackId = track.id;
    strip.dataset.dragId = track.id;
    if (track.id === this.store.selectedTrackId) strip.classList.add('is-selected');
    if (this.waves.has(key)) strip.classList.add('has-wave');

    strip.appendChild(
      this.buildCap({
        index,
        name: track.name,
        color: track.color,
        selected: track.id === this.store.selectedTrackId,
        onSelect: () => this.store.selectTrack(track.id),
        onRename: (name) => {
          this.store.edit('structure', () => {
            track.name = name;
          });
        },
        draggable: true,
      }),
    );

    const active = track.devices.filter((d) => d.enabled);
    const inserts = el('div', 'strip-inserts');
    inserts.textContent = track.instrument
      ? `${track.instrument.type.toUpperCase()} · ${active.length} INS`
      : `${active.length} INS`;
    inserts.title = track.devices.map((d) => DEVICE_SPECS[d.type].name).join(' → ') || 'No inserts';
    strip.appendChild(inserts);

    const eqBlock = el('div', 'strip-eq');
    const eqKnob = (
      label: string,
      value: number,
      min: number,
      max: number,
      apply: (value: number) => void,
      format: (value: number) => string,
      color = '#9fb6d8',
    ): HTMLElement =>
      createKnob({
        label,
        value,
        min,
        max,
        size: 26,
        color,
        format,
        onChange: (next) => {
          this.store.beginGesture();
          this.store.touch('params', () => apply(next));
        },
        onCommit: () => this.store.endGesture(),
      }).element;

    const db = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
    eqBlock.append(
      eqKnob('Trim', track.gain, -24, 24, (v) => { track.gain = v; }, db, '#e08a9a'),
      eqKnob('HP', track.eq.hp, 20, 400, (v) => { track.eq.hp = v; }, (v) => `${Math.round(v)}`, '#e0b466'),
      eqKnob('Low', track.eq.low, -18, 18, (v) => { track.eq.low = v; }, db),
      eqKnob('Mid', track.eq.mid, -18, 18, (v) => { track.eq.mid = v; }, db),
      eqKnob('Mid F', track.eq.midFreq, 250, 6000, (v) => { track.eq.midFreq = v; }, (v) => `${Math.round(v)}`),
      eqKnob('High', track.eq.high, -18, 18, (v) => { track.eq.high = v; }, db),
    );
    strip.appendChild(eqBlock);

    const toggles = el('div', 'strip-toggles');
    const eqOn = track.eqOn !== false;
    const eqButton = el('button', 'strip-toggle', 'EQ');
    eqButton.title = 'Channel EQ in / out';
    eqButton.classList.toggle('is-on', eqOn);
    eqButton.addEventListener('click', () => {
      this.store.edit('structure', () => {
        track.eqOn = !(track.eqOn !== false);
      });
    });
    toggles.append(eqButton, this.buildWaveButton(key, track.color));
    strip.appendChild(toggles);

    const panRow = el('div', 'strip-pan');
    panRow.appendChild(this.buildPan(track.pan, (v) => { track.pan = v; }));
    strip.appendChild(panRow);

    const fader = this.buildFader(track.volume, key, (v) => { track.volume = v; }, `${track.name} volume`);
    const body = el('div', 'strip-body');
    body.append(this.buildMeter(key), fader.wrap);
    strip.appendChild(body);
    strip.appendChild(fader.readout);

    const buttons = el('div', 'strip-row');
    const mute = el('button', 'tiny', 'M');
    mute.title = 'Mute';
    mute.classList.toggle('is-on', track.mute);
    mute.addEventListener('click', () => {
      this.store.edit('structure', () => {
        track.mute = !track.mute;
      });
    });
    const solo = el('button', 'tiny is-solo', 'S');
    solo.title = 'Solo';
    solo.classList.toggle('is-on', track.solo);
    solo.addEventListener('click', () => {
      this.store.edit('structure', () => {
        track.solo = !track.solo;
      });
    });
    buttons.append(mute, solo);
    strip.appendChild(buttons);

    strip.appendChild(this.buildSends(track));
    strip.appendChild(this.buildScope(key, track.color));
    return strip;
  }

  /** An aux return channel: effect, pan, fader, mute/solo and its own meter. */
  private buildReturnStrip(bus: ReturnState, index: number): HTMLElement {
    const key = this.keyFor('return', String(index));
    const strip = el('div', 'strip is-return');
    strip.dataset.returnIndex = String(index);
    if (this.waves.has(key)) strip.classList.add('has-wave');

    strip.appendChild(
      this.buildCap({
        label: bus.label,
        name: bus.name,
        color: bus.color,
      }),
    );

    const inserts = el('div', 'strip-inserts');
    const chain = bus.devices.filter((d) => d.enabled).map((d) => DEVICE_SPECS[d.type].name);
    inserts.textContent = chain.length ? `RETURN · ${chain.join(' → ')}` : 'RETURN · dry';
    strip.appendChild(inserts);

    const toggles = el('div', 'strip-toggles');
    const soloSafe = el('span', 'strip-badge', 'SFE');
    soloSafe.title = 'Solo-safe: this return stays up when another channel is soloed';
    toggles.append(soloSafe, this.buildWaveButton(key, bus.color));
    strip.appendChild(toggles);

    const panRow = el('div', 'strip-pan');
    panRow.appendChild(this.buildPan(bus.pan, (v) => { bus.pan = v; }));
    strip.appendChild(panRow);

    const fader = this.buildFader(bus.volume, key, (v) => { bus.volume = v; }, `${bus.name} return level`);
    const body = el('div', 'strip-body');
    body.append(this.buildMeter(key, bus.color), fader.wrap);
    strip.appendChild(body);
    strip.appendChild(fader.readout);

    const buttons = el('div', 'strip-row');
    const mute = el('button', 'tiny', 'M');
    mute.title = 'Mute return';
    mute.classList.toggle('is-on', bus.mute);
    mute.addEventListener('click', () => {
      this.store.edit('structure', () => {
        bus.mute = !bus.mute;
      });
    });
    const solo = el('button', 'tiny is-solo', 'S');
    solo.title = bus.soloSafe ? 'Solo return (solo-safe)' : 'Solo return';
    solo.classList.toggle('is-on', bus.solo);
    solo.addEventListener('click', () => {
      this.store.edit('structure', () => {
        bus.solo = !bus.solo;
      });
    });
    buttons.append(mute, solo);
    strip.appendChild(buttons);

    strip.appendChild(this.buildScope(key, bus.color));
    return strip;
  }

  private buildMasterStrip(): HTMLElement {
    const key = 'master';
    const strip = el('div', 'strip is-master');
    strip.appendChild(
      this.buildCap({
        label: 'Σ',
        name: 'Master',
        color: 'var(--rose)',
      }),
    );

    const count = this.store.project.master.devices.filter((d) => d.enabled).length;
    const inserts = el('div', 'strip-inserts');
    inserts.textContent = `${count} MASTER FX`;
    strip.appendChild(inserts);

    const chain = el('div', 'master-chain');
    const labels = this.store.project.master.devices
      .filter((d) => d.enabled)
      .map((d) => DEVICE_SPECS[d.type].name);
    for (const label of labels.length ? labels : ['clean bus']) {
      chain.appendChild(el('span', 'master-chip', label));
    }
    if (this.options.onOpenMasterAi) {
      chain.classList.add('is-clickable');
      chain.title = 'Open the AI Assistant for the master bus';
      chain.addEventListener('click', () => this.options.onOpenMasterAi?.());
    }
    strip.appendChild(chain);

    const toggles = el('div', 'strip-toggles');
    const mono = el('button', 'strip-toggle', 'MONO');
    mono.title = 'Sum the monitor bus to mono (listen only)';
    mono.classList.toggle('is-on', this.engine.monitor.mono);
    mono.addEventListener('click', () => {
      const next = !this.engine.monitor.mono;
      this.engine.setMonitor({ mono: next });
      mono.classList.toggle('is-on', next);
    });
    const dim = el('button', 'strip-toggle', 'DIM');
    dim.title = 'Monitor at −18 dB (listen only)';
    dim.classList.toggle('is-on', this.engine.monitor.dim);
    dim.addEventListener('click', () => {
      const next = !this.engine.monitor.dim;
      this.engine.setMonitor({ dim: next });
      dim.classList.toggle('is-on', next);
    });
    toggles.append(mono, dim, this.buildWaveButton(key, '#f43f5e'));
    strip.appendChild(toggles);

    const fader = this.buildFader(
      this.store.project.master.volume,
      key,
      (v) => {
        this.store.project.master.volume = v;
      },
      'Master volume',
    );
    const body = el('div', 'strip-body is-master');
    body.append(this.buildMeter(key), fader.wrap);
    strip.appendChild(body);
    strip.appendChild(fader.readout);

    const readout = el('div', 'strip-peak-db', '−∞');
    readout.title = 'Peak level';
    strip.appendChild(readout);
    this.masterPeakReadout = readout;

    strip.appendChild(this.buildScope(key, '#f43f5e'));
    return strip;
  }

  private masterPeakReadout: HTMLElement | null = null;

  private updateMeters(): void {
    const now = performance.now();

    for (const track of this.store.project.tracks) {
      this.updateChannel(this.keyFor('track', track.id), this.engine.trackPeak(track.id), now);
    }
    this.store.project.returns.forEach((_bus, index) => {
      this.updateChannel(this.keyFor('return', String(index)), this.engine.returnPeak(index), now);
    });
    this.updateChannel('master', this.engine.masterPeak(), now);
    this.updateScopes();
  }

  private updateChannel(key: string, peak: number, now: number): void {
    const fill = this.meters.get(key);
    if (!fill) return;

    const previous = this.smoothed.get(key) ?? 0;
    const next = peak > previous ? peak : previous * 0.84 + peak * 0.16;
    this.smoothed.set(key, next);
    fill.style.height = `${Math.min(100, next * 100).toFixed(1)}%`;

    const held = this.held.get(key) ?? 0;
    const hold = peak >= held ? peak : Math.max(peak, held - 0.004);
    this.held.set(key, hold);
    const peakLine = this.peakLines.get(key);
    if (peakLine) peakLine.style.bottom = `${Math.min(100, hold * 100).toFixed(1)}%`;

    if (peak >= 0.995) this.clipUntil.set(key, now + 1600);
    const clip = this.clipLeds.get(key);
    if (clip) clip.classList.toggle('is-on', (this.clipUntil.get(key) ?? 0) > now);

    if (key === 'master' && this.masterPeakReadout) {
      this.masterPeakReadout.textContent = peak > 0.001 ? `${formatDb(20 * Math.log10(peak))} dBFS` : '−∞';
    }
  }

  /** Redraws the scopes after the pixel density changed (new monitor). */
  refreshScopes(): void {
    this.updateScopes();
  }

  private updateScopes(): void {
    if (!this.waves.size) return;
    for (const key of this.waves) {
      const canvas = this.scopes.get(key);
      if (!canvas) continue;
      if (!this.engine.isPlaying) continue; // park the scopes with the transport
      this.drawScope(key, canvas);
    }
  }

  private drawScope(key: string, canvas: HTMLCanvasElement, colorHint?: string): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let data: Uint8Array | null = null;
    if (key === 'master') data = this.engine.masterWaveform();
    else if (key.startsWith('track:')) data = this.engine.trackWaveform(key.slice(6));
    else if (key.startsWith('return:')) data = this.engine.returnWaveform(Number(key.slice(7)));

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(80, Math.round(canvas.clientWidth || 128));
    const height = Math.max(18, Math.round(canvas.clientHeight || 26));
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(6, 6, 5, 0.75)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(216, 176, 106, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2 + 0.5);
    ctx.lineTo(width, height / 2 + 0.5);
    ctx.stroke();

    if (!data) return;
    const color = colorHint ?? canvas.style.color ?? '#d8b06a';

    // Every sample in the window is folded into its column, so the shape is the
    // signal itself instead of whichever sample happened to land on the pixel.
    const columns = Math.max(2, Math.round(width));
    const env = byteColumns(data, columns);
    const mid = height / 2;
    const amplitude = mid - 1.5;
    const columnWidth = width / columns;

    ctx.save();
    ctx.beginPath();
    for (let column = 0; column < columns; column++) {
      const y = mid - Math.max(0, env[column * 2 + 1] ?? 0) * amplitude;
      const x = column * columnWidth;
      if (column === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let column = columns - 1; column >= 0; column--) {
      const y = mid - Math.min(0, env[column * 2] ?? 0) * amplitude;
      ctx.lineTo(column * columnWidth, y);
    }
    ctx.closePath();

    ctx.globalAlpha = 0.35;
    ctx.fillStyle = color;
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    ctx.stroke();
    ctx.restore();
  }
}
