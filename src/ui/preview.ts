import type { PreviewPlayer, PreviewSnapshot } from '../audio/preview';
import type { Store } from '../core/store';
import { encodeWav, downloadBlob } from '../audio/export';
import {
  analyseLoop,
  barSeconds,
  detectOnsets,
  loopBars,
  signalFromBuffer,
  sliceBuffer,
  sliceRegion,
  snapRegionToBars,
  type LoopSlice,
  type LoopTempo,
  type Onset,
} from '../audio/loops';
import { drawWaveform } from '../audio/waveform';
import { isAudioName } from '../core/filebrowse';
import { filesFromDrop } from './dropfiles';
import { el } from './controls';

export interface PreviewSend {
  /**
   * `bpm` is the tempo the buffer is currently stretched to. `slices` are
   * regions of the raw buffer to place one after another, or undefined for the
   * whole file.
   */
  (buffer: AudioBuffer, name: string, bpm: number, slices?: LoopSlice[]): void;
}

type SliceMode = '1' | '2' | '4' | 'beat' | 'eighth' | 'transient';

const SLICE_MODE_LABEL: Record<SliceMode, string> = {
  '1': '1 bar',
  '2': '2 bars',
  '4': '4 bars',
  beat: '1 beat',
  eighth: '1/8',
  transient: 'Transients',
};

const MIN_REGION = 0.02;

/**
 * Docked audio preview: waveform, its own transport and metronome, a BPM
 * detector, pitch-preserving tempo change and an independent pitch control.
 *
 * It doubles as the loop editor. Loading a file analyses it (or trusts a BPM
 * tag in the name), the waveform shows the bar/beat grid, dragging selects a
 * loop region, and the slicer cuts that region on a bar/beat grid or on its
 * transients. Slices can be exported as WAVs with a manifest, or dropped
 * straight onto the arrangement at the project tempo.
 */
export class PreviewPanel {
  private store: Store;
  private player: PreviewPlayer;
  private onSend: PreviewSend;
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private wave: HTMLCanvasElement;
  private waveCtx: CanvasRenderingContext2D;

  private nameLabel: HTMLElement;
  private status: HTMLElement;
  private playButton: HTMLButtonElement;
  private rawButton: HTMLButtonElement;
  private loopButton: HTMLButtonElement;
  private metroButton: HTMLButtonElement;
  private bpmInput: HTMLInputElement;
  private detectButton: HTMLButtonElement;
  private pitchLabel: HTMLButtonElement;
  private tempoLabel: HTMLElement;
  private progress: HTMLElement;

  private loopBadge: HTMLElement;
  private regionLabel: HTMLElement;
  private sliceModeSelect: HTMLSelectElement;
  private snapButton: HTMLButtonElement;
  private sliceButton: HTMLButtonElement;
  private sendSlicesButton: HTMLButtonElement;
  private exportButton: HTMLButtonElement;

  private detectedBpm = 0;
  private forceTempo: 'project' | 'raw' | 'manual' = 'raw';
  private raf = 0;
  private drawDirty = true;
  private resizeObserver: ResizeObserver | null = null;

  /** Analysis of the loaded file: tempo, confidence and the first onset. */
  private tempo: LoopTempo | null = null;
  private onsets: Onset[] = [];
  /** Loop region and slices, in file seconds (before tempo processing). */
  private region: LoopSlice | null = null;
  private slices: LoopSlice[] = [];

  private drag: { x: number; start: number; moved: boolean } | null = null;

  constructor(store: Store, player: PreviewPlayer, onSend: PreviewSend) {
    this.store = store;
    this.player = player;
    this.onSend = onSend;

    this.root = document.getElementById('preview') as HTMLElement;
    if (!this.root) throw new Error('Missing #preview');

    const head = el('div', 'preview-head');
    const title = el('span', 'preview-title', 'Audio Preview');
    this.nameLabel = el('span', 'panel-hint preview-name', 'no file — open one or pick an import');
    this.loopBadge = el('span', 'preview-loop-badge', 'BPM?');
    this.loopBadge.id = 'preview-loop-badge';
    const spacer = el('div', 'spacer');

    const fileLabel = el('label', 'tbtn tbtn-sm file-btn', 'Open file');
    const fileInput = el('input') as HTMLInputElement;
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.hidden = true;
    fileInput.id = 'preview-file';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void this.loadFile(file);
      fileInput.value = '';
    });
    fileLabel.appendChild(fileInput);

    const sendButton = el('button', 'tbtn tbtn-sm tbtn-accent', 'Send to arrangement');
    sendButton.id = 'preview-send';
    sendButton.addEventListener('click', () => this.sendToArrangement());

    const closeButton = el('button', 'tbtn tbtn-sm', '▾');
    closeButton.title = 'Close preview (stops playback)';
    closeButton.addEventListener('click', () => this.close());

    head.append(title, this.nameLabel, this.loopBadge, spacer, fileLabel, sendButton, closeButton);

    this.canvas = el('canvas', 'preview-wave') as HTMLCanvasElement;
    this.canvas.id = 'preview-wave';
    this.canvas.title = 'Click to seek · drag to select a loop region · double-click to select all';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx;

    this.wave = document.createElement('canvas');
    const waveCtx = this.wave.getContext('2d');
    if (!waveCtx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.waveCtx = waveCtx;

    const controls = el('div', 'preview-controls');

    this.playButton = el('button', 'tbtn tbtn-sm tbtn-play', '▶') as HTMLButtonElement;
    this.playButton.id = 'preview-play';
    this.playButton.title = 'Play / pause the preview (independent of the transport)';
    this.playButton.addEventListener('click', () => {
      if (this.player.isPlaying) this.player.pause();
      else void this.player.play();
    });

    const stop = el('button', 'tbtn tbtn-sm', '■') as HTMLButtonElement;
    stop.id = 'preview-stop';
    stop.title = 'Stop and return to the start';
    stop.addEventListener('click', () => this.player.stop());

    this.loopButton = el('button', 'tbtn tbtn-sm tbtn-toggle is-on', '⟲') as HTMLButtonElement;
    this.loopButton.id = 'preview-loop';
    this.loopButton.title = 'Loop the preview (or just the selected region)';
    this.loopButton.addEventListener('click', () => {
      const next = !this.loopButton.classList.contains('is-on');
      this.loopButton.classList.toggle('is-on', next);
      this.player.setLoop(next);
      this.syncLoopRange();
    });

    this.metroButton = el('button', 'tbtn tbtn-sm tbtn-toggle', '⧗') as HTMLButtonElement;
    this.metroButton.id = 'preview-metro';
    this.metroButton.title = 'Preview metronome (separate from the song metronome)';
    this.metroButton.addEventListener('click', () => {
      const next = !this.metroButton.classList.contains('is-on');
      this.metroButton.classList.toggle('is-on', next);
      this.player.setMetronome(next);
    });

    const bpmWrap = el('label', 'preview-field');
    bpmWrap.append(el('span', '', 'BPM'));
    this.bpmInput = el('input', 'preview-bpm') as HTMLInputElement;
    this.bpmInput.id = 'preview-bpm';
    this.bpmInput.type = 'number';
    this.bpmInput.min = '40';
    this.bpmInput.max = '260';
    this.bpmInput.step = '1';
    this.bpmInput.value = '120';
    this.bpmInput.addEventListener('change', () => {
      this.forceTempo = 'manual';
      const value = Number(this.bpmInput.value);
      if (Number.isFinite(value) && value > 0) {
        this.tempo = { ...(this.tempo ?? { bpm: value, confidence: 1, locked: true, source: 'tag', offset: 0 }), bpm: value, locked: true, source: 'tag' };
        this.detectedBpm = value;
        this.updateLoopLabel();
      }
      void this.applyTempo(value);
    });
    bpmWrap.appendChild(this.bpmInput);

    this.detectButton = el('button', 'tbtn tbtn-sm', 'Detect') as HTMLButtonElement;
    this.detectButton.id = 'preview-detect';
    this.detectButton.title = 'Analyze the file and detect its tempo';
    this.detectButton.addEventListener('click', () => this.detect());

    const force = el('button', 'tbtn tbtn-sm', 'Force to project') as HTMLButtonElement;
    force.id = 'preview-tempo';
    force.title = 'Time-stretch the preview to the project tempo, keeping pitch';
    force.addEventListener('click', () => this.forceToProject());

    const raw = el('button', 'tbtn tbtn-sm is-on', 'Play raw') as HTMLButtonElement;
    raw.id = 'preview-raw';
    raw.title = 'Play at the original speed and pitch';
    raw.addEventListener('click', () => this.playRaw());
    this.rawButton = raw;

    const pitchDown = el('button', 'tbtn tbtn-sm', '♭') as HTMLButtonElement;
    pitchDown.id = 'preview-pitch-down';
    pitchDown.title = 'Pitch down one semitone (tempo unchanged)';
    pitchDown.addEventListener('click', () => void this.shiftPitch(-1));

    this.pitchLabel = el('button', 'tbtn tbtn-sm', '0 st') as HTMLButtonElement;
    this.pitchLabel.id = 'preview-pitch';
    this.pitchLabel.title = 'Click to reset the pitch';
    this.pitchLabel.addEventListener('click', () => void this.setPitch(0));

    const pitchUp = el('button', 'tbtn tbtn-sm', '♯') as HTMLButtonElement;
    pitchUp.id = 'preview-pitch-up';
    pitchUp.title = 'Pitch up one semitone (tempo unchanged)';
    pitchUp.addEventListener('click', () => void this.shiftPitch(1));

    const volume = el('input', 'preview-volume') as HTMLInputElement;
    volume.type = 'range';
    volume.min = '0';
    volume.max = '100';
    volume.value = '90';
    volume.title = 'Preview level';
    volume.addEventListener('input', () => this.player.setVolume(Number(volume.value) / 100));

    this.tempoLabel = el('span', 'preview-tempo-mode', 'raw');
    this.progress = el('span', 'preview-progress', '');
    this.status = el('div', 'preview-status', 'No file loaded · 0:00');

    controls.append(
      this.playButton,
      stop,
      this.loopButton,
      el('span', 'tsep'),
      this.metroButton,
      bpmWrap,
      this.detectButton,
      force,
      raw,
      el('span', 'tsep'),
      pitchDown,
      this.pitchLabel,
      pitchUp,
      el('span', 'tsep'),
      volume,
      this.tempoLabel,
      this.progress,
    );

    // Loop editor row: what the slicer will do to the selected region.
    const loopRow = el('div', 'preview-loop-actions');

    this.regionLabel = el('span', 'preview-segments', 'Region: whole file');
    this.regionLabel.id = 'preview-region';

    const modeWrap = el('label', 'preview-field');
    modeWrap.append(el('span', '', 'Slice'));
    this.sliceModeSelect = el('select', 'preview-bpm') as HTMLSelectElement;
    this.sliceModeSelect.id = 'preview-slice-mode';
    this.sliceModeSelect.title = 'How the slicer divides the selected region';
    for (const mode of Object.keys(SLICE_MODE_LABEL) as SliceMode[]) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = SLICE_MODE_LABEL[mode];
      this.sliceModeSelect.appendChild(option);
    }
    this.sliceModeSelect.value = '1';
    this.sliceModeSelect.addEventListener('change', () => {
      // A mode change invalidates the cut points but never the region.
      this.slices = [];
      this.refreshLoopInfo();
      this.drawDirty = true;
      this.draw();
    });
    modeWrap.appendChild(this.sliceModeSelect);

    this.snapButton = el('button', 'tbtn tbtn-sm', 'Snap to bars') as HTMLButtonElement;
    this.snapButton.id = 'preview-snap';
    this.snapButton.title = 'Grow the selection to whole bars of the current tempo';
    this.snapButton.addEventListener('click', () => this.snap());

    this.sliceButton = el('button', 'tbtn tbtn-sm', 'Slice') as HTMLButtonElement;
    this.sliceButton.id = 'preview-slice';
    this.sliceButton.title = 'Cut the selection into slices on the chosen grid';
    this.sliceButton.addEventListener('click', () => this.slice());

    this.sendSlicesButton = el('button', 'tbtn tbtn-sm', 'Slices → arrangement') as HTMLButtonElement;
    this.sendSlicesButton.id = 'preview-send-slices';
    this.sendSlicesButton.title = 'Place each slice on the arrangement at the project tempo';
    this.sendSlicesButton.addEventListener('click', () => this.sendSlices());

    this.exportButton = el('button', 'tbtn tbtn-sm', 'Export') as HTMLButtonElement;
    this.exportButton.id = 'preview-export';
    this.exportButton.title = 'Export the selection, or every slice, as 24-bit WAV';
    this.exportButton.addEventListener('click', () => void this.exportSelection());

    const clear = el('button', 'tbtn tbtn-sm', '⨯') as HTMLButtonElement;
    clear.id = 'preview-clear-region';
    clear.title = 'Select the whole file again';
    clear.addEventListener('click', () => this.selectAll());

    loopRow.append(
      this.regionLabel,
      el('span', 'tsep'),
      modeWrap,
      this.snapButton,
      this.sliceButton,
      this.sendSlicesButton,
      this.exportButton,
      clear,
    );

    const body = el('div', 'preview-body');
    body.append(this.canvas, controls, loopRow, this.status);
    this.root.append(head, body);
    this.bindDrop();

    this.player.onState((snapshot) => this.render(snapshot));
    this.bindCanvas();

    this.resizeObserver = new ResizeObserver(() => {
      this.drawDirty = true;
      this.resize();
    });
    this.resizeObserver.observe(this.canvas);

    this.refreshLoopInfo();
  }

  get element(): HTMLElement {
    return this.root;
  }

  toggle(): void {
    const open = this.root.classList.toggle('is-open');
    if (open) {
      this.resize();
      this.store.emit('view');
    } else {
      this.player.pause();
    }
  }

  open(): void {
    if (!this.root.classList.contains('is-open')) this.toggle();
  }

  close(): void {
    this.root.classList.remove('is-open');
    this.player.pause();
  }

  /** Loads the currently selected audio clip's asset, if there is one. */
  loadSelectedClip(): boolean {
    const clip = this.store.selectedClip;
    if (!clip?.assetId) return false;
    const asset = this.store.assetById(clip.assetId);
    if (!asset) return false;

    this.loadBuffer(asset.buffer, asset.name ?? clip.name);
    return true;
  }

  /** Drops a freshly imported asset into the preview. */
  loadBuffer(buffer: AudioBuffer, name: string): void {
    const clip = this.player.loadBuffer(buffer, name);
    this.resetForBuffer(buffer, name);
    this.detectedBpm = this.tempo?.bpm || clip.bpm;
    this.forceTempo = 'raw';
    this.rawButton.classList.add('is-on');
    this.bpmInput.value = String(Math.round(this.detectedBpm || this.store.project.bpm));
    this.player.setMetronomeBpm(this.detectedBpm || this.store.project.bpm);
    this.nameLabel.textContent = name;
    this.drawDirty = true;
    this.resize();
    this.render(this.player.state);
  }

  /** Loads a file picked anywhere in the app — the explorer auditions this way. */
  async loadFile(file: File): Promise<void> {
    try {
      this.status.textContent = `Decoding ${file.name}…`;
      const clip = await this.player.loadFile(file);
      this.resetForBuffer(clip.buffer, file.name);
      this.detectedBpm = this.tempo?.bpm || clip.bpm;
      this.forceTempo = 'raw';
      this.rawButton.classList.add('is-on');
      this.bpmInput.value = String(Math.round(this.detectedBpm || this.store.project.bpm));
      this.player.setMetronomeBpm(this.detectedBpm || this.store.project.bpm);
      this.nameLabel.textContent = file.name;
      this.drawDirty = true;
      this.resize();
      this.render(this.player.state);
    } catch (error) {
      console.error(error);
      this.status.textContent = 'Could not decode that file. Try WAV, AIFF, MP3 or FLAC.';
    }
  }

  /**
   * Analysis and region reset for a new buffer. A tempo tag in the name wins
   * over the detector, so a library that names its files `break_174bpm.wav`
   * never gets a wrong grid.
   */
  private resetForBuffer(buffer: AudioBuffer, name: string): void {
    this.region = { start: 0, end: buffer.duration };
    this.slices = [];
    this.onsets = [];
    this.tempo = null;

    try {
      const signal = signalFromBuffer(buffer);
      this.onsets = detectOnsets(signal, 0.35);
      this.tempo = analyseLoop(signal, { name });
      if (this.tempo.bpm) this.detectedBpm = this.tempo.bpm;
      else if (this.detectedBpm === 0) this.detectedBpm = this.player.current?.bpm ?? 0;
    } catch (error) {
      console.error(error);
    }

    this.syncLoopRange();
    this.refreshLoopInfo();
  }

  private detect(): void {
    const bpm = this.tempo?.bpm || this.player.current?.bpm || 0;

    if (!bpm) {
      this.status.textContent = 'No tempo found — type one or name the file with its BPM.';
      return;
    }

    this.detectedBpm = bpm;
    this.bpmInput.value = String(Math.round(bpm));
    this.player.setMetronomeBpm(bpm);
    this.forceTempo = 'manual';
    this.updateLoopLabel();
    void this.applyTempo(bpm);
  }

  private forceToProject(): void {
    this.forceTempo = 'project';
    this.bpmInput.value = String(this.store.project.bpm);
    void this.applyTempo(this.store.project.bpm);
  }

  private playRaw(): void {
    this.forceTempo = 'raw';
    this.rawButton.classList.add('is-on');
    this.bpmInput.value = String(Math.round(this.detectedBpm || this.store.project.bpm));
    void this.player.setTempoRate(1).then(() => {
      this.syncLoopRange();
      this.render(this.player.state);
    });
  }

  private async applyTempo(bpm: number): Promise<void> {
    const source = this.detectedBpm || bpm;
    const rate = Math.max(0.5, Math.min(2, bpm / source));

    this.rawButton.classList.toggle('is-on', this.forceTempo === 'raw');
    this.player.setMetronomeBpm(bpm);
    await this.player.setTempoRate(rate);
    // The region is in file time; the player loops in processed time.
    this.syncLoopRange();
    this.render(this.player.state);
  }

  private async shiftPitch(delta: number): Promise<void> {
    await this.setPitch(this.player.pitchValue + delta);
  }

  private async setPitch(semitones: number): Promise<void> {
    await this.player.setPitch(semitones);
    this.syncLoopRange();
    this.render(this.player.state);
  }

  private sendToArrangement(): void {
    const buffer = this.player.processedBuffer;
    const clip = this.player.current;

    if (!buffer || !clip) {
      this.status.textContent = 'Load a file first.';
      return;
    }

    const effectiveBpm = (this.detectedBpm || this.store.project.bpm) * this.player.tempoRateValue;
    this.onSend(buffer, clip.name, effectiveBpm);
    this.status.textContent = `Sent ${clip.name} to the arrangement at the project tempo.`;
  }

  // ------------------------------------------------------------- loop editing

  /** Region in processed seconds, which is what the player and canvas use. */
  private regionInPlayerTime(): LoopSlice | null {
    if (!this.region) return null;
    const rate = this.player.tempoRateValue || 1;
    return {
      start: this.region.start / rate,
      end: this.region.end / rate,
    };
  }

  private syncLoopRange(): void {
    const range = this.regionInPlayerTime();
    const whole = this.player.state.duration;
    const isWhole = !range || (range.start <= 0.001 && range.end >= whole - 0.001);
    this.player.setLoopRange(isWhole ? null : range);
  }

  private selectAll(): void {
    const buffer = this.player.rawBuffer;
    if (!buffer) return;
    this.region = { start: 0, end: buffer.duration };
    this.slices = [];
    this.syncLoopRange();
    this.refreshLoopInfo();
    this.drawDirty = true;
    this.draw();
  }

  private snap(): void {
    if (!this.region) return;
    const bpm = this.detectedBpm || this.tempo?.bpm || null;

    if (!bpm) {
      this.status.textContent = 'Set a BPM first: snapping needs a bar length.';
      return;
    }

    this.region = snapRegionToBars(this.region, bpm, this.tempo?.offset ?? 0);
    this.slices = [];
    this.syncLoopRange();
    this.refreshLoopInfo();
    this.drawDirty = true;
    this.draw();
  }

  private slice(): void {
    if (!this.region) {
      this.status.textContent = 'Drag across the waveform to pick a region first.';
      return;
    }

    const bpm = this.detectedBpm || this.tempo?.bpm || null;
    const mode = this.sliceModeSelect.value as SliceMode;
    const grid = mode === 'transient' ? 'transient' : mode === 'beat' ? 'beat' : mode === 'eighth' ? 'half' : 'bar';

    if (grid !== 'transient' && !bpm) {
      this.status.textContent = 'Set a BPM first, or slice on transients.';
      return;
    }

    this.slices = sliceRegion(this.region, {
      bpm,
      grid,
      barsPerSlice: mode === '2' ? 2 : mode === '4' ? 4 : 1,
      onsets: this.onsets,
      sensitivity: 0.35,
      align: this.tempo?.offset ?? this.region.start,
    });

    this.refreshLoopInfo();
    this.status.textContent = `Sliced into ${this.slices.length} ${this.slices.length === 1 ? 'piece' : 'pieces'}.`;
    this.drawDirty = true;
    this.draw();
  }

  /** Slices if the user sliced, otherwise the selected region as one piece. */
  private partsToPlace(): LoopSlice[] {
    if (this.slices.length > 0) return this.slices;
    if (this.region) return [this.region];
    return [];
  }

  private sendSlices(): void {
    const buffer = this.player.rawBuffer;
    const clip = this.player.current;
    if (!buffer || !clip) {
      this.status.textContent = 'Load a file first.';
      return;
    }

    const parts = this.partsToPlace();
    if (parts.length === 0) {
      this.status.textContent = 'Drag across the waveform to pick a region first.';
      return;
    }

    const bpm = this.detectedBpm || this.store.project.bpm;
    this.onSend(buffer, clip.name, bpm, parts);
    this.status.textContent = parts.length === 1
      ? `Placed the selected loop on the arrangement at ${this.store.project.bpm} BPM.`
      : `Placed ${parts.length} slices on the arrangement at ${this.store.project.bpm} BPM.`;
  }

  private async exportSelection(): Promise<void> {
    const buffer = this.player.rawBuffer;
    const clip = this.player.current;
    if (!buffer || !clip) {
      this.status.textContent = 'Load a file first.';
      return;
    }

    const parts = this.partsToPlace();
    if (parts.length === 0) return;

    const base = clip.name.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '-');
    const bpm = this.detectedBpm || this.tempo?.bpm || null;

    try {
      const make = (part: LoopSlice): Blob => {
        const offline = new OfflineAudioContext(buffer.numberOfChannels, 1, buffer.sampleRate);
        return encodeWav(sliceBuffer(offline, buffer, part.start, part.end), 24);
      };

      const folder = (window as unknown as {
        showDirectoryPicker?: (options?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;

      if (typeof folder === 'function' && parts.length > 1) {
        const directory = await folder({ mode: 'readwrite', id: 'hybrid-loops' });
        const write = async (name: string, data: Blob | string) => {
          const handle = await directory.getFileHandle(name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(data);
          await writable.close();
        };

        const written: { file: string; start: number; end: number }[] = [];
        for (const [index, part] of parts.entries()) {
          const file = `${base}-${String(index + 1).padStart(2, '0')}.wav`;
          await write(file, make(part));
          written.push({ file, start: part.start, end: part.end });
        }
        await write(
          'loop.json',
          JSON.stringify(
            {
              format: 'hstudio-loop-slices',
              version: 1,
              name: base,
              bpm,
              bars: bpm ? loopBars(parts[0].end - parts[0].start, bpm) : 0,
              slices: written,
            },
            null,
            2,
          ),
        );

        this.status.textContent = `Wrote ${written.length} slices and loop.json to ${directory.name}.`;
        return;
      }

      if (parts.length === 1) {
        downloadBlob(make(parts[0]), `${base}-loop.wav`);
        this.status.textContent = `Exported ${base}-loop.wav (24-bit).`;
        return;
      }

      // No folder access: hand the slices over as separate downloads.
      for (const [index, part] of parts.entries()) {
        downloadBlob(make(part), `${base}-${String(index + 1).padStart(2, '0')}.wav`);
      }
      this.status.textContent = `Downloaded ${parts.length} slices as WAV.`;
    } catch (error) {
      console.error(error);
      this.status.textContent = 'Export was cancelled.';
    }
  }

  private refreshLoopInfo(): void {
    const bpm = this.detectedBpm || this.tempo?.bpm || 0;
    const region = this.region;
    const duration = this.player.rawBuffer?.duration ?? 0;

    if (!region) {
      this.regionLabel.textContent = 'Region: whole file';
    } else {
      const bars = bpm ? loopBars(region.end - region.start, bpm) : 0;
      const sliceText = this.slices.length > 0 ? ` · ${this.slices.length} slices` : '';
      const barText = bars ? ` · ${bars} ${bars === 1 ? 'bar' : 'bars'}` : '';
      this.regionLabel.innerHTML = `Region: <b>${(region.end - region.start).toFixed(2)}s${barText}</b>${sliceText}`;
    }

    this.regionLabel.title = region
      ? `Selected ${region.start.toFixed(3)}s – ${region.end.toFixed(3)}s of ${duration.toFixed(2)}s`
      : '';

    this.snapButton.disabled = !region || !bpm;
    this.sliceButton.disabled = !region;
    this.sendSlicesButton.disabled = !region;
    this.exportButton.disabled = !region;

    this.updateLoopLabel();
  }

  private updateLoopLabel(): void {
    const bpm = this.detectedBpm || this.tempo?.bpm || 0;

    if (!bpm) {
      this.loopBadge.textContent = 'BPM?';
      this.loopBadge.classList.remove('is-locked');
      this.loopBadge.title = 'No tempo detected — type one, or name the file with its BPM';
      return;
    }

    const tag = this.tempo?.locked ? 'tag' : this.tempo ? `${Math.round((this.tempo.confidence ?? 0) * 100)}%` : 'set';
    this.loopBadge.innerHTML = `<b>${bpm.toFixed(bpm % 1 === 0 ? 0 : 1)}</b> BPM · ${tag}`;
    this.loopBadge.classList.toggle('is-locked', Boolean(this.tempo?.locked));
    this.loopBadge.title = this.tempo?.locked
      ? 'Tempo read from the file name'
      : `Detected tempo (${tag} confidence)`;
  }

  // ------------------------------------------------------------------ drag and drop

  /** Dropping an audio file anywhere on the preview opens it here. */
  private bindDrop(): void {
    const over = (event: DragEvent): boolean => {
      const types = Array.from(event.dataTransfer?.types ?? []);
      return types.includes('Files');
    };

    this.root.addEventListener('dragover', (event) => {
      if (!over(event)) return;
      event.preventDefault();
      this.root.classList.add('is-drop');
    });

    this.root.addEventListener('dragleave', (event) => {
      if (event.target !== this.root) return;
      this.root.classList.remove('is-drop');
    });

    this.root.addEventListener('drop', (event) => {
      if (!over(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.root.classList.remove('is-drop');

      const transfer = event.dataTransfer;
      if (!transfer) return;

      void filesFromDrop(transfer)
        .then((files) => {
          const audio = files.find((entry) => isAudioName(entry.file.name) || entry.file.type.startsWith('audio/'));
          if (!audio) {
            this.status.textContent = 'That drop had no audio file the preview can open.';
            return;
          }
          this.open();
          void this.loadFile(audio.file);
        })
        .catch((error) => {
          console.error(error);
          this.status.textContent = 'Could not read that drop.';
        });
    });
  }

  // ------------------------------------------------------------------ drawing

  private bindCanvas(): void {
    this.canvas.addEventListener('pointerdown', (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const duration = this.player.state.duration;
      const rate = this.player.tempoRateValue || 1;
      const seconds = (x / Math.max(1, rect.width)) * duration * rate;

      this.drag = { x, start: seconds, moved: false };
      this.canvas.setPointerCapture?.(event.pointerId);
    });

    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.drag) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));

      if (Math.abs(x - this.drag.x) < 4 && !this.drag.moved) return;
      this.drag.moved = true;

      const duration = this.player.state.duration;
      const rate = this.player.tempoRateValue || 1;
      const seconds = (x / Math.max(1, rect.width)) * duration * rate;
      const start = Math.max(0, Math.min(this.drag.start, seconds));
      const end = Math.max(this.drag.start, seconds);

      if (end - start < MIN_REGION) return;
      this.region = { start, end };
      this.slices = [];
      this.drawDirty = true;
      this.draw();
    });

    const finish = (): void => {
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;

      if (drag.moved) {
        this.syncLoopRange();
        this.refreshLoopInfo();
        this.status.textContent = 'Region selected · Snap to bars, Slice, or Slices → arrangement.';
      } else {
        const duration = this.player.state.duration;
        const rect = this.canvas.getBoundingClientRect();
        this.player.seek((drag.x / Math.max(1, rect.width)) * duration);
      }

      this.drawDirty = true;
      this.draw();
    };

    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', () => {
      this.drag = null;
    });

    this.canvas.addEventListener('dblclick', () => this.selectAll());
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight || 74);

    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.wave.width = this.canvas.width;
    this.wave.height = this.canvas.height;
    this.waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.drawWaveform(width, height);
    this.draw();
  }

  private drawWaveform(width: number, height: number): void {
    const ctx = this.waveCtx;
    const peaks = this.player.waveform;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, width, height);

    if (!peaks.length) {
      ctx.fillStyle = '#565b67';
      ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText('Open an audio file to audition it', 10, height / 2 + 3);
      return;
    }

    drawWaveform(ctx, {
      x: 0,
      y: 2,
      width,
      height: height - 4,
      peaks,
      color: '#4d8dff',
      edge: '#8cb8ff',
    });
  }

  private draw(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.wave, 0, 0, width, height);

    const duration = this.player.state.duration;
    if (duration <= 0) return;

    const rate = this.player.tempoRateValue || 1;
    const bpm = this.detectedBpm || this.tempo?.bpm || 0;
    const xOf = (fileSeconds: number): number => (fileSeconds / rate / duration) * width;

    // Bar and beat grid, anchored to the first detected hit so loops that do
    // not start exactly on a bar still line up with what you hear.
    if (bpm > 0) {
      const bar = barSeconds(bpm);
      const beat = bar / 4;
      const origin = (this.tempo?.offset ?? 0) % bar;
      const region = this.region;

      if (region) {
        const from = Math.max(0, region.start);
        const to = Math.min(duration * rate, region.end);
        ctx.fillStyle = 'rgba(77, 141, 255, 0.10)';
        const x1 = xOf(from);
        const x2 = xOf(to);
        ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height);

        // Everything outside the selection is clearly not part of the loop.
        ctx.fillStyle = 'rgba(6, 8, 12, 0.55)';
        ctx.fillRect(0, 0, x1, height);
        ctx.fillRect(x2, 0, width - x2, height);
      }

      ctx.lineWidth = 1;
      for (let t = origin; t <= duration * rate; t += beat) {
        const isBar = Math.abs(t - origin) % bar < 1e-6;
        ctx.strokeStyle = isBar ? 'rgba(126, 145, 180, 0.45)' : 'rgba(90, 104, 130, 0.20)';
        const x = Math.round(xOf(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    }

    // Slice boundaries on top of the grid, in amber so they read as edits.
    if (this.slices.length > 0) {
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const slice of this.slices.slice(1)) {
        const x = Math.round(xOf(slice.start)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    if (this.region) {
      ctx.strokeStyle = 'rgba(77, 141, 255, 0.9)';
      ctx.lineWidth = 1;
      const x1 = Math.round(xOf(this.region.start)) + 0.5;
      const x2 = Math.round(xOf(this.region.end)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x1, 1);
      ctx.lineTo(x1, height - 1);
      ctx.moveTo(x2, 1);
      ctx.lineTo(x2, height - 1);
      ctx.stroke();
    }

    const position = this.player.state.position;
    const x = duration > 0 ? (position / duration) * width : 0;

    ctx.fillStyle = '#f43f5e';
    ctx.fillRect(Math.max(0, Math.min(width - 1, x)), 0, 1.5, height);
  }

  private render(snapshot: PreviewSnapshot): void {
    this.playButton.textContent = snapshot.playing ? '❚❚' : '▶';
    this.playButton.classList.toggle('is-on', snapshot.playing);
    this.pitchLabel.textContent = `${snapshot.pitch > 0 ? '+' : ''}${snapshot.pitch} st`;
    this.tempoLabel.textContent = `${snapshot.tempoRate.toFixed(2)}×`;
    this.progress.textContent = snapshot.processing
      ? `processing ${Math.round(snapshot.progress * 100)}%`
      : '';

    const duration = snapshot.duration;
    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);
    const minutesPos = Math.floor(snapshot.position / 60);
    const secondsPos = Math.floor(snapshot.position % 60);
    const bpmText = this.detectedBpm
      ? `${this.detectedBpm.toFixed(this.detectedBpm % 1 === 0 ? 0 : 1)} BPM${
          this.tempo?.locked ? ' (tag)' : this.tempo ? ` (${Math.round((this.tempo.confidence ?? 0) * 100)}%)` : ''
        }`
      : 'BPM not detected';

    this.status.textContent = [
      this.player.current?.name ?? 'No file loaded',
      bpmText,
      `${minutesPos}:${String(secondsPos).padStart(2, '0')} / ${minutes}:${String(seconds).padStart(2, '0')}`,
      snapshot.processing ? 'stretching…' : `${snapshot.tempoRate.toFixed(2)}× tempo`,
      snapshot.pitch !== 0 ? `${snapshot.pitch > 0 ? '+' : ''}${snapshot.pitch} st pitch` : 'pitch locked',
    ].join(' · ');

    if (snapshot.playing) this.startAnimation();
    else this.stopAnimation();

    this.draw();
  }

  private startAnimation(): void {
    if (this.raf) return;

    let last = 0;
    const tick = (time: number): void => {
      if (!this.player.isPlaying) {
        this.raf = 0;
        return;
      }

      if (time - last > 33) {
        last = time;
        this.draw();
      }

      this.raf = requestAnimationFrame(tick);
    };

    this.raf = requestAnimationFrame(tick);
  }

  private stopAnimation(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.drawDirty) {
      this.drawDirty = false;
      this.draw();
    }
  }
}
