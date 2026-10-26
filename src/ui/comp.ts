import type { Preferences } from '../core/session';
import type { Store } from '../core/store';
import type { Take } from '../core/types';
import { clipFromTake, compOverRange, takeEnd, takeOverlap, takesForTrack } from '../core/takes';
import { formatBars } from '../core/time';
import type { InputDevice } from '../audio/recorder';
import { drawWaveform } from '../audio/waveform';
import { el } from './controls';

const CAPTURE_IDLE = 'Converter idle · 32-bit float capture, browser processing off';

export interface TakePanelActions {
  startRecording: () => void;
  stopRecording: () => void;
  setMonitoring: (enabled: boolean) => void;
  listInputs: () => Promise<InputDevice[]>;
  audition: (take: Take, range: { start: number; end: number }) => void;
  notify: (message: string) => void;
}

/**
 * Recording, takes and comping.
 *
 * Recording captures onto the armed audio track. Each pass becomes a take that
 * stays out of the arrangement; a comp is written by choosing a take (or a take
 * plus the shift-dragged range on the ruler) and replacing that part of the
 * timeline with an ordinary clip that reads the take's audio. Everything is one
 * undo step, and the take is never modified.
 */
export class TakePanel {
  private store: Store;
  private actions: TakePanelActions;
  private preferences: Preferences;
  private onPreferences: (preferences: Preferences) => void;
  private root: HTMLElement;
  private badge: HTMLElement;
  private status: HTMLElement;
  private inputSelect: HTMLSelectElement;
  private capture: HTMLElement;
  private monitor: HTMLInputElement;
  private recordButton: HTMLButtonElement;
  private trackSelect: HTMLSelectElement;
  private rangeLine: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private devices: InputDevice[] = [];
  private recording = false;
  private inputsLoaded = false;

  constructor(
    store: Store,
    preferences: Preferences,
    onPreferences: (preferences: Preferences) => void,
    actions: TakePanelActions,
  ) {
    this.store = store;
    this.preferences = preferences;
    this.onPreferences = onPreferences;
    this.actions = actions;

    this.root = el('aside', 'agent rig-panel take-panel');

    const head = el('header', 'agent-head');
    const dot = el('span', 'agent-dot');
    dot.style.background = 'var(--red, #f43f5e)';
    dot.style.boxShadow = '0 0 10px rgba(244, 63, 94, 0.8)';
    const title = el('div', 'agent-title');
    title.append(el('strong', '', 'Takes'), el('span', '', 'record · takes · comp'));
    this.badge = el('span', 'rig-badge', 'idle');
    const close = el('button', 'tbtn tbtn-sm', '✕');
    close.addEventListener('click', () => this.close());
    head.append(dot, title, this.badge, close);

    const body = el('div', 'agent-body');

    this.status = el('div', 'agent-status', 'Arm an audio track, then record a pass.');

    // Input section ---------------------------------------------------------
    this.inputSelect = el('select', 'rig-select');
    this.inputSelect.title = 'Input device used for recording';
    this.inputSelect.addEventListener('change', () => {
      this.preferences = { ...this.preferences, recordDeviceId: this.inputSelect.value };
      this.onPreferences(this.preferences);
    });

    const inputRow = el('div', 'rig-row');
    const refresh = el('button', 'tbtn tbtn-sm', 'Refresh');
    refresh.addEventListener('click', () => void this.loadInputs(true));
    inputRow.append(this.inputSelect, refresh);

    this.capture = el('div', 'capture-format', CAPTURE_IDLE);
    this.capture.title =
      'The record path keeps the interface\u2019s own samples: 32-bit float, its own rate, no browser processing.';

    const monitorLabel = el('label', 'rig-pref');
    this.monitor = el('input') as HTMLInputElement;
    this.monitor.type = 'checkbox';
    this.monitor.checked = Boolean(preferences.monitorInput);
    this.monitor.addEventListener('change', () => {
      this.preferences = { ...this.preferences, monitorInput: this.monitor.checked };
      this.onPreferences(this.preferences);
      this.actions.setMonitoring(this.monitor.checked);
    });
    monitorLabel.append(this.monitor, el('span', '', 'Monitor input (use headphones)'));

    this.recordButton = el('button', 'agent-run', '● Record');
    this.recordButton.addEventListener('click', () => {
      if (this.recording) this.actions.stopRecording();
      else this.actions.startRecording();
    });

    // Comp section ----------------------------------------------------------
    this.trackSelect = el('select', 'rig-select');
    this.trackSelect.addEventListener('change', () => {
      this.store.selectTrack(this.trackSelect.value);
      this.renderTakes();
    });

    this.rangeLine = el('div', 'agent-status', 'No range: “Use take” replaces the take’s own span.');
    const rangeRow = el('div', 'rig-row');
    const clearRange = el('button', 'tbtn tbtn-sm', 'Clear range');
    clearRange.addEventListener('click', () => this.store.clearRange());
    rangeRow.append(this.rangeLine, clearRange);

    this.list = el('div', 'take-list');
    this.empty = el('div', 'agent-status', 'No takes for this track yet.');

    body.append(
      el('p', 'agent-intro', 'Record passes onto the armed audio track, then comp them together. With the loop on, every lap becomes its own take. Shift-drag the arrangement ruler to choose a range; the range limits what a comp replaces.'),
      this.status,
      el('div', 'section-title', 'Input'),
      inputRow,
      this.capture,
      monitorLabel,
      this.recordButton,
      el('div', 'section-title', 'Comp track'),
      this.trackSelect,
      rangeRow,
      this.list,
      this.empty,
    );

    this.root.append(head, body);

    this.store.subscribe((reason) => {
      if (reason === 'structure' || reason === 'selection') this.refresh();
    });
  }

  mount(): void {
    document.body.appendChild(this.root);
    void this.loadInputs();
    this.refresh();
  }

  toggle(): void {
    this.root.classList.toggle('is-open');
    if (this.root.classList.contains('is-open')) {
      void this.loadInputs();
      this.refresh();
    }
  }

  open(): void {
    this.root.classList.add('is-open');
    void this.loadInputs();
    this.refresh();
  }

  close(): void {
    this.root.classList.remove('is-open');
  }

  /**
   * Shows what the open converter is delivering, or resets to the idle note.
   * `warning` tints the line for input clipping.
   */
  setCapture(text: string | null, warning = false): void {
    this.capture.textContent = text ?? CAPTURE_IDLE;
    this.capture.classList.toggle('is-warning', Boolean(text) && warning);
  }

  setRecording(recording: boolean, loop = false): void {
    this.recording = recording;
    this.badge.textContent = recording ? (loop ? 'loop rec' : 'recording') : 'idle';
    this.badge.classList.toggle('is-live', recording);
    this.recordButton.textContent = recording ? '■ Stop recording' : '● Record';
    this.recordButton.classList.toggle('is-on', recording);
    this.status.textContent = recording
      ? loop
        ? 'Recording the loop… each lap becomes its own take. Stop with the transport or this button.'
        : 'Recording… stop with the transport stop or this button.'
      : 'Arm an audio track, then record a pass.';
    this.refresh();
  }

  refresh(): void {
    this.renderTrackOptions();
    this.renderRange();
    this.renderTakes();
  }

  private async loadInputs(force = false): Promise<void> {
    if (this.inputsLoaded && !force) return;

    try {
      this.devices = await this.actions.listInputs();
    } catch {
      this.devices = [];
    }

    this.inputsLoaded = true;
    const previous = this.preferences.recordDeviceId ?? '';
    this.inputSelect.replaceChildren();

    if (this.devices.length === 0) {
      const option = el('option');
      option.value = '';
      option.textContent = 'System default input';
      this.inputSelect.appendChild(option);
      this.inputSelect.value = '';
      return;
    }

    const fallback = el('option');
    fallback.value = '';
    fallback.textContent = 'System default input';
    this.inputSelect.appendChild(fallback);

    for (const device of this.devices) {
      const option = el('option');
      option.value = device.id;
      option.textContent = device.label;
      this.inputSelect.appendChild(option);
    }

    this.inputSelect.value = this.devices.some((device) => device.id === previous) ? previous : '';
  }

  private renderTrackOptions(): void {
    const previous = this.store.selectedTrackId;
    const tracks = this.store.project.tracks.filter((track) => track.kind === 'audio');
    this.trackSelect.replaceChildren();

    if (tracks.length === 0) {
      const option = el('option');
      option.value = '';
      option.textContent = 'No audio tracks';
      this.trackSelect.appendChild(option);
      return;
    }

    for (const track of tracks) {
      const option = el('option');
      option.value = track.id;
      option.textContent = `${track.name}${track.armed ? ' · armed' : ''}`;
      this.trackSelect.appendChild(option);
    }

    this.trackSelect.value = (tracks.find((track) => track.id === previous) ?? tracks[0]).id;
  }

  private renderRange(): void {
    const range = this.store.range;
    const bars = this.store.project.beatsPerBar;

    this.rangeLine.textContent = range
      ? `Range ${formatBars(range.start, bars)} – ${formatBars(range.end, bars)} · Shift-drag the ruler to change it.`
      : 'No range: “Use take” replaces the take’s own span. Shift-drag the ruler to comp just a phrase.';
  }

  private renderTakes(): void {
    const project = this.store.project;
    const track = this.store.trackById(this.trackSelect.value);

    if (!track || track.kind !== 'audio') {
      this.list.replaceChildren();
      this.empty.hidden = false;
      this.empty.textContent = 'Add an audio track to record takes.';
      return;
    }

    if (this.trackSelect.value !== track.id) this.trackSelect.value = track.id;

    const takes = takesForTrack(project, track.id);
    this.list.replaceChildren();
    this.empty.hidden = takes.length > 0;
    this.empty.textContent =
      track.kind === 'audio' ? 'No takes for this track yet.' : 'Takes belong to audio tracks. Arm an audio track to record.';

    const range = this.store.range;

    for (const take of takes) {
      const overlap = takeOverlap(take, range);
      const hasRange = Boolean(range && overlap);
      const item = el('div', 'take-item');

      const line = el('div', 'rig-item');
      const label = el('div', 'rig-item-name');
      label.append(el('strong', '', take.name));
      label.append(
        el(
          'span',
          '',
          `${formatBars(take.start, project.beatsPerBar)} · ${take.length.toFixed(1)} beats${hasRange ? ' · in range' : ''}`,
        ),
      );

      const actions = el('div', 'rig-actions');

      const listen = el('button', 'rig-mini', 'Listen');
      listen.title = 'Audition this take over the selected range';
      listen.addEventListener('click', () => {
        const part = overlap ?? { start: take.start, end: takeEnd(take) };
        this.actions.audition(take, part);
      });

      const use = el('button', 'rig-mini', hasRange ? 'Use range' : 'Use take');
      use.title = hasRange ? 'Comp this range from this take' : 'Comp the whole take into the arrangement';
      use.addEventListener('click', () => this.useTake(take, overlap));

      actions.append(listen, use);
      line.append(label, actions);
      item.append(line, this.waveform(take, hasRange ? overlap : null));
      this.list.appendChild(item);
    }
  }

  private waveform(take: Take, highlight: { start: number; end: number } | null): HTMLCanvasElement {
    const canvas = el('canvas', 'take-wave') as HTMLCanvasElement;
    // The canvas is stretched by its stylesheet, so it is painted once the row
    // is laid out: columns then line up with real pixels and stay sharp.
    requestAnimationFrame(() => this.paintTake(canvas, take, highlight));
    return canvas;
  }

  private paintTake(
    canvas: HTMLCanvasElement,
    take: Take,
    highlight: { start: number; end: number } | null,
  ): void {
    const asset = this.store.assetById(take.assetId);
    const peaks = asset?.peaks ?? [];
    const width = Math.max(80, Math.round(canvas.clientWidth || 420));
    const height = 40;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.fillRect(0, 0, width, height);

    if (highlight) {
      const from = Math.max(0, (highlight.start - take.start) / take.length);
      const to = Math.min(1, (highlight.end - take.start) / take.length);
      ctx.fillStyle = 'rgba(240, 176, 72, 0.16)';
      ctx.fillRect(from * width, 0, Math.max(2, (to - from) * width), height);
    }

    if (peaks.length === 0 && !asset?.buffer) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2 + 0.5);
      ctx.lineTo(width, height / 2 + 0.5);
      ctx.stroke();
      return;
    }

    drawWaveform(ctx, {
      x: 0,
      y: 3,
      width,
      height: height - 6,
      peaks,
      source: asset?.buffer ?? null,
      color: '#4d8dff',
      edge: '#8cb8ff',
    });
  }

  private useTake(take: Take, overlap: { start: number; end: number } | null): void {
    const track = this.store.trackById(take.trackId);
    if (!track) return;

    const range = overlap ?? { start: take.start, end: takeEnd(take) };
    const project = this.store.project;
    const clip = clipFromTake(take, track, project.bpm, range);

    this.store.edit('structure', (draft) => {
      draft.clips = compOverRange(draft.clips, take.trackId, range.start, range.end, clip, draft.bpm);
      draft.length = Math.max(draft.length, range.end);
    });
    this.store.selectClip(clip.id);
    this.actions.notify(`Comp from ${take.name} (${range.start.toFixed(2)}–${range.end.toFixed(2)})`);
    this.refresh();
  }
}
