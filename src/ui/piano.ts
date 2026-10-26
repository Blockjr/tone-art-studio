import type { Engine } from '../audio/engine';
import {
  addNote,
  clampPitch,
  createNote,
  moveNote,
  notesSpan,
  pitchName,
  quantizeNotes,
  removeNotes,
  resizeNote,
  setVelocity,
  transposeNotes,
} from '../core/midi';
import type { Store } from '../core/store';
import { clamp } from '../core/time';
import type { Clip, Note } from '../core/types';
import { el } from './controls';

const LOW_PITCH = 24;
const HIGH_PITCH = 96;
const ROW = 15;
const PX_PER_BEAT = 64;
const EDGE = 7;

type DragMode = 'move' | 'resize';

interface DragState {
  mode: DragMode;
  noteId: string;
  grabBeat: number;
  grabPitch: number;
  originStart: number;
  originPitch: number;
  originDuration: number;
}

export interface PianoOptions {
  /** print the edited clip to audio without leaving the window */
  onBounce?: (clipId: string) => void;
}

/**
 * The piano roll: note-level MIDI editing for one clip.
 *
 * Click empty grid to draw, drag a note to move it, drag its right edge to
 * change its length, Delete to remove. Every gesture is one undo step, so the
 * arrangement and the clip view never disagree about what happened.
 */
export class PianoRoll {
  private store: Store;
  private engine: Engine;
  private options: PianoOptions;
  private root: HTMLElement;
  private scroll!: HTMLElement;
  private grid!: HTMLElement;
  private keys!: HTMLElement;
  private title!: HTMLElement;
  private subtitle!: HTMLElement;
  private footer!: HTMLElement;
  private velocity!: HTMLInputElement;
  private gridSelect!: HTMLSelectElement;

  private clipId: string | null = null;
  private selected: string | null = null;
  private drag: DragState | null = null;
  private step = 0.25;
  private unsubscribe: (() => void) | null = null;

  constructor(store: Store, engine: Engine, options: PianoOptions = {}) {
    this.store = store;
    this.engine = engine;
    this.options = options;
    this.root = el('div', 'piano-overlay');
    this.root.setAttribute('aria-hidden', 'true');
  }

  mount(host: HTMLElement = document.body): void {
    host.appendChild(this.root);
    this.bindKeyboard();
    this.unsubscribe = this.store.subscribe((reason) => {
      if (!this.clipId) return;
      if (this.track() === undefined) {
        this.close();
        return;
      }
      if (reason === 'structure') {
        if (!this.findClip()) {
          this.close();
          return;
        }
        this.renderNotes();
        this.renderFooter();
      }
    });
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.unsubscribe?.();
    this.root.remove();
  }

  get isOpen(): boolean {
    return this.root.classList.contains('is-open');
  }

  get openClipId(): string | null {
    return this.isOpen ? this.clipId : null;
  }

  open(clipId: string): boolean {
    const clip = this.store.project.clips.find((c) => c.id === clipId);
    if (!clip || clip.kind !== 'midi') return false;
    this.clipId = clip.id;
    this.selected = null;
    this.render();
    this.root.classList.add('is-open');
    this.root.setAttribute('aria-hidden', 'false');
    this.focusPitch(clip);
    this.root.querySelector<HTMLElement>('.piano')?.focus();
    return true;
  }

  close(): void {
    if (!this.isOpen) return;
    this.drag = null;
    this.root.classList.remove('is-open');
    this.root.setAttribute('aria-hidden', 'true');
    this.clipId = null;
  }

  toggle(clipId: string): void {
    if (this.isOpen && this.clipId === clipId) this.close();
    else this.open(clipId);
  }

  // ------------------------------------------------------------------ render

  private findClip(): Clip | undefined {
    return this.store.project.clips.find((c) => c.id === this.clipId);
  }

  private track() {
    const clip = this.findClip();
    return clip ? this.store.trackById(clip.trackId) : undefined;
  }

  private render(): void {
    const clip = this.findClip();
    if (!clip) return;
    const track = this.track();

    this.root.innerHTML = '';
    const dialog = el('div', 'piano');
    dialog.tabIndex = -1;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', `Notes for ${clip.name}`);

    // header ---------------------------------------------------------------
    const head = el('header', 'piano-head');
    const titles = el('div', 'piano-titles');
    this.title = el('strong', '', clip.name);
    this.subtitle = el('span', '', `${track?.name ?? 'Track'} · ${track?.instrument?.type ?? 'instrument'}`);
    titles.append(this.title, this.subtitle);

    const tools = el('div', 'piano-tools');
    this.gridSelect = el('select', 'piano-select') as HTMLSelectElement;
    this.gridSelect.setAttribute('aria-label', 'Grid');
    for (const [value, label] of [
      ['0.125', '1/32'],
      ['0.25', '1/16'],
      ['0.5', '1/8'],
      ['1', '1/4'],
      ['4', 'Bar'],
    ] as [string, string][]) {
      const option = el('option', '', label);
      option.value = value;
      option.selected = Number(value) === this.step;
      this.gridSelect.appendChild(option);
    }
    this.gridSelect.addEventListener('change', () => {
      this.step = Number(this.gridSelect.value) || 0.25;
      if (this.grid) this.grid.style.setProperty('--piano-step', `${this.step * PX_PER_BEAT}px`);
      this.renderFooter();
    });

    const quantize = el('button', 'tbtn tbtn-sm', 'Quantize');
    quantize.title = 'Snap the selected notes (or all of them) to the grid';
    quantize.addEventListener('click', () => this.quantize());

    const transposeDown = el('button', 'tbtn tbtn-sm', '−12');
    transposeDown.title = 'Transpose down an octave';
    transposeDown.addEventListener('click', () => this.transpose(-12));
    const transposeUp = el('button', 'tbtn tbtn-sm', '+12');
    transposeUp.title = 'Transpose up an octave';
    transposeUp.addEventListener('click', () => this.transpose(12));

    const velocityWrap = el('label', 'piano-vel');
    velocityWrap.append(el('span', '', 'Vel'));
    this.velocity = el('input', 'piano-velocity') as HTMLInputElement;
    this.velocity.type = 'range';
    this.velocity.min = '10';
    this.velocity.max = '100';
    this.velocity.step = '5';
    this.velocity.value = '75';
    this.velocity.setAttribute('aria-label', 'Note velocity');
    this.velocity.addEventListener('change', () => {
      const value = Number(this.velocity.value) / 100;
      this.edit(() => {
        setVelocity(this.notes(), value, this.selection());
      });
      this.renderNotes();
      this.renderFooter();
    });
    velocityWrap.appendChild(this.velocity);

    const remove = el('button', 'tbtn tbtn-sm', 'Delete');
    remove.title = 'Delete the selected note (Delete)';
    remove.addEventListener('click', () => this.deleteSelected());

    const bounce = el('button', 'tbtn tbtn-sm piano-bounce', 'Print to audio');
    bounce.title = 'Render this clip through the track chain into an audio clip';
    bounce.addEventListener('click', () => {
      if (this.clipId) this.options.onBounce?.(this.clipId);
    });

    const close = el('button', 'tbtn tbtn-sm', '✕');
    close.title = 'Close (Esc)';
    close.addEventListener('click', () => this.close());

    tools.append(this.gridSelect, quantize, transposeDown, transposeUp, velocityWrap, remove, bounce, close);
    head.append(titles, tools);

    // body -----------------------------------------------------------------
    const body = el('div', 'piano-body');
    this.scroll = el('div', 'piano-scroll');
    const sheet = el('div', 'piano-sheet');

    this.keys = el('div', 'piano-keys');
    const rows = HIGH_PITCH - LOW_PITCH + 1;
    for (let index = 0; index < rows; index++) {
      const pitch = HIGH_PITCH - index;
      const key = el('div', `piano-key${isBlackKey(pitch) ? ' is-black' : ''}`, pitchName(pitch));
      key.dataset.pitch = String(pitch);
      key.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        void this.engine.previewNote(clip.trackId, pitch, 0.4);
      });
      this.keys.appendChild(key);
    }

    this.grid = el('div', 'piano-grid');
    this.grid.style.width = `${Math.max(320, clip.length * PX_PER_BEAT)}px`;
    this.grid.style.height = `${rows * ROW}px`;
    this.grid.style.setProperty('--piano-step', `${this.step * PX_PER_BEAT}px`);

    for (let index = 0; index < rows; index++) {
      const pitch = HIGH_PITCH - index;
      const row = el('div', `piano-row${isBlackKey(pitch) ? ' is-black' : ''}`);
      row.style.top = `${index * ROW}px`;
      this.grid.appendChild(row);
    }

    this.grid.addEventListener('pointerdown', (event) => this.onPointerDown(event, clip));
    this.grid.addEventListener('pointermove', (event) => this.onPointerMove(event, clip));
    this.grid.addEventListener('pointerup', () => this.onPointerUp());
    this.grid.addEventListener('pointercancel', () => this.onPointerUp());
    this.grid.addEventListener('contextmenu', (event) => {
      const note = (event.target as HTMLElement).closest<HTMLElement>('.piano-note');
      if (!note) return;
      event.preventDefault();
      this.selected = note.dataset.noteId ?? null;
      this.deleteSelected();
    });

    sheet.append(this.keys, this.grid);
    this.scroll.appendChild(sheet);
    body.appendChild(this.scroll);

    this.footer = el('footer', 'piano-foot');

    dialog.append(head, body, this.footer);
    this.root.appendChild(dialog);

    this.renderNotes();
    this.renderFooter();
  }

  private renderNotes(): void {
    const clip = this.findClip();
    if (!clip || !this.grid) return;
    for (const node of Array.from(this.grid.querySelectorAll('.piano-note'))) node.remove();

    this.grid.style.width = `${Math.max(320, clip.length * PX_PER_BEAT)}px`;

    for (const note of clip.notes) {
      if (note.pitch < LOW_PITCH || note.pitch > HIGH_PITCH) continue;
      const node = el('div', `piano-note${note.id === this.selected ? ' is-selected' : ''}`);
      node.dataset.noteId = note.id;
      node.style.left = `${note.start * PX_PER_BEAT}px`;
      node.style.width = `${Math.max(6, note.duration * PX_PER_BEAT - 1)}px`;
      node.style.top = `${(HIGH_PITCH - note.pitch) * ROW + 1}px`;
      node.style.height = `${ROW - 2}px`;
      node.style.opacity = String(0.45 + note.velocity * 0.55);
      node.style.background = clip.color;
      node.style.borderColor = 'rgba(0, 0, 0, 0.45)';
      node.title = `${pitchName(note.pitch)} · ${note.duration.toFixed(2)} beats · velocity ${Math.round(note.velocity * 100)}`;
      this.grid.appendChild(node);
    }
  }

  private renderFooter(): void {
    if (!this.footer) return;
    const clip = this.findClip();
    if (!clip) {
      this.footer.textContent = '';
      return;
    }
    const selected = clip.notes.find((n) => n.id === this.selected);
    const total = clip.notes.length;
    const gridLabel = `${this.step} beat grid`;
    const left = selected
      ? `${pitchName(selected.pitch)} · start ${selected.start.toFixed(2)} · length ${selected.duration.toFixed(2)} · velocity ${Math.round(selected.velocity * 100)}`
      : `${total} note${total === 1 ? '' : 's'} · click to draw · drag to move · drag the right edge to stretch · Delete removes`;
    this.footer.textContent = `${left}  ·  ${gridLabel}`;

    if (selected) this.velocity.value = String(Math.round(selected.velocity * 100));
  }

  private notes(): Note[] {
    return this.findClip()?.notes ?? [];
  }

  private selection(): string[] | undefined {
    return this.selected ? [this.selected] : undefined;
  }

  /** Runs one undoable edit and repaints once. */
  private edit(mutate: () => void): void {
    if (!this.clipId) return;
    const clip = this.findClip();
    if (!clip) return;
    this.store.edit('structure', () => mutate());
  }

  // --------------------------------------------------------------- gestures

  private pointToBeat(event: PointerEvent, clip: Clip): number {
    const rect = this.grid.getBoundingClientRect();
    const x = event.clientX - rect.left;
    return clamp(x / PX_PER_BEAT, 0, clip.length);
  }

  private pointToPitch(event: PointerEvent): number {
    const rect = this.grid.getBoundingClientRect();
    const y = event.clientY - rect.top;
    return clampPitch(HIGH_PITCH - Math.floor(y / ROW));
  }

  private onPointerDown(event: PointerEvent, clip: Clip): void {
    if (event.button !== 0) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('.piano-note');
    const beat = this.pointToBeat(event, clip);
    const pitch = this.pointToPitch(event);

    if (target) {
      const note = clip.notes.find((n) => n.id === target.dataset.noteId);
      if (!note) return;
      this.selected = note.id;
      const rect = target.getBoundingClientRect();
      const mode: DragMode = event.clientX >= rect.right - EDGE ? 'resize' : 'move';
      this.store.beginGesture();
      this.drag = {
        mode,
        noteId: note.id,
        grabBeat: beat,
        grabPitch: pitch,
        originStart: note.start,
        originPitch: note.pitch,
        originDuration: note.duration,
      };
      this.grid.setPointerCapture(event.pointerId);
      this.renderNotes();
      this.renderFooter();
      if (mode === 'move') void this.engine.previewNote(clip.trackId, note.pitch, 0.3);
      return;
    }

    const start = Math.max(0, Math.floor(beat / this.step) * this.step);
    const note = createNote(pitch, start, this.step, Number(this.velocity.value) / 100);
    this.selected = note.id;
    // Draw and the drag that follows it are one undo step.
    this.store.beginGesture();
    this.store.touch('structure', () => addNote(clip.notes, note));
    this.drag = {
      mode: 'move',
      noteId: note.id,
      grabBeat: beat,
      grabPitch: pitch,
      originStart: note.start,
      originPitch: note.pitch,
      originDuration: note.duration,
    };
    this.grid.setPointerCapture(event.pointerId);
    this.renderNotes();
    this.renderFooter();
    void this.engine.previewNote(clip.trackId, pitch, 0.3);
  }

  private onPointerMove(event: PointerEvent, clip: Clip): void {
    const rect = this.grid.getBoundingClientRect();
    if (!this.drag) {
      const hover = (event.target as HTMLElement).closest<HTMLElement>('.piano-note');
      if (!hover) {
        this.grid.style.cursor = 'crosshair';
        return;
      }
      const box = hover.getBoundingClientRect();
      this.grid.style.cursor = event.clientX >= box.right - EDGE ? 'ew-resize' : 'grab';
      return;
    }

    const note = clip.notes.find((n) => n.id === this.drag?.noteId);
    if (!note) return;
    const beat = clamp((event.clientX - rect.left) / PX_PER_BEAT, 0, clip.length);
    const pitch = clampPitch(HIGH_PITCH - Math.floor((event.clientY - rect.top) / ROW));

    this.store.touch('params', () => {
      if (!this.drag) return;
      if (this.drag.mode === 'resize') {
        const snappedEnd = Math.max(
          note.start + this.step,
          Math.round(beat / this.step) * this.step,
        );
        resizeNote(note, snappedEnd - note.start, this.step, clip.length);
      } else {
        const delta = Math.round((beat - this.drag.grabBeat) / this.step) * this.step;
        moveNote(note, this.drag.originStart + delta, pitch, clip.length);
      }
    });
    this.renderNotes();
    this.renderFooter();
  }

  private onPointerUp(): void {
    if (!this.drag) return;
    this.drag = null;
    this.store.endGesture();
    this.store.emit('structure');
    this.renderFooter();
  }

  // ---------------------------------------------------------------- commands

  private quantize(): void {
    const probe = this.notes().map((note) => ({ ...note }));
    if (!quantizeNotes(probe, this.step, this.selection(), true)) {
      if (this.footer) this.footer.textContent = 'Already on the grid.';
      return;
    }
    this.store.edit('structure', () => {
      quantizeNotes(this.notes(), this.step, this.selection(), true);
    });
    this.renderNotes();
    this.renderFooter();
  }

  private transpose(semitones: number): void {
    const probe = this.notes().map((note) => ({ ...note }));
    if (!transposeNotes(probe, semitones, this.selection())) return;
    this.store.edit('structure', () => {
      transposeNotes(this.notes(), semitones, this.selection());
    });
    this.renderNotes();
    this.renderFooter();
    this.ensureSelectedVisible();
  }

  /** Keeps a moved or transposed note on screen instead of hiding it off-view. */
  private ensureSelectedVisible(): void {
    const note = this.notes().find((n) => n.id === this.selected);
    if (!note || !this.scroll) return;
    const top = (HIGH_PITCH - note.pitch) * ROW;
    const view = this.scroll;
    if (top < view.scrollTop + ROW) view.scrollTop = Math.max(0, top - ROW * 4);
    else if (top + ROW > view.scrollTop + view.clientHeight - ROW) {
      view.scrollTop = top + ROW * 4 - view.clientHeight;
    }
  }

  private deleteSelected(): void {
    if (!this.selected) {
      if (this.footer) this.footer.textContent = 'Select a note first.';
      return;
    }
    const id = this.selected;
    this.selected = null;
    this.edit(() => removeNotes(this.notes(), [id]));
    this.renderNotes();
    this.renderFooter();
  }

  private bindKeyboard(): void {
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
      if (!this.isOpen) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        this.deleteSelected();
        return;
      }
      if (!this.selected) return;
      const clip = this.findClip();
      if (!clip) return;
      const note = clip.notes.find((n) => n.id === this.selected);
      if (!note) return;

      const nudge = (deltaBeats: number, deltaPitch: number): void => {
        event.preventDefault();
        event.stopPropagation();
        this.store.edit('structure', () => {
          moveNote(note, note.start + deltaBeats, note.pitch + deltaPitch, clip.length);
        });
        this.renderNotes();
        this.renderFooter();
        if (deltaPitch !== 0) void this.engine.previewNote(clip.trackId, note.pitch, 0.25);
      };

      if (event.key === 'ArrowLeft') nudge(-this.step, 0);
      else if (event.key === 'ArrowRight') nudge(this.step, 0);
      else if (event.key === 'ArrowUp') nudge(0, 1);
      else if (event.key === 'ArrowDown') nudge(0, -1);
  };

  private focusPitch(clip: Clip): void {
    const span = notesSpan(clip.notes);
    const center = span ? (span.low + span.high) / 2 : 60;
    const rows = HIGH_PITCH - LOW_PITCH + 1;
    const top = (HIGH_PITCH - center) * ROW - (this.scroll.clientHeight || 400) / 2;
    this.scroll.scrollTop = clamp(top, 0, rows * ROW);
    this.scroll.scrollLeft = 0;
  }
}

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

function isBlackKey(pitch: number): boolean {
  return BLACK_KEYS.has(((pitch % 12) + 12) % 12);
}
