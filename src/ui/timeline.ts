import type { Engine } from '../audio/engine';
import { prepareClipAudio } from '../audio/clipsource';
import { resolveFades } from '../audio/fades';
import { drawWaveform } from '../audio/waveform';
import { canDropClipOn, trackIndexAtY } from '../core/dragdrop';
import type { Store } from '../core/store';
import {
  createMarker,
  followScroll,
  markerNear,
  nextMarker,
  playheadStep,
  previousMarker,
  sortMarkers,
  type FollowMode,
} from '../core/playhead';
import { clamp, dbToGain, formatBars, formatTime, gainToDb, snapBeat, uid } from '../core/time';
import type { Clip, Marker, Track } from '../core/types';
import { el } from './controls';
import { enableReorder } from './reorder';
import { scrollBeatFromRail, scrollRailMetrics } from './scrollrail';

const TRACK_H = 84;
/** Ruler bands: bar numbers on top, named markers, then the loop strip. */
const RULER_H = 48;
const BAR_BAND_H = 20;
const MARKER_BAND_H = 14;
const LOOP_BAND_H = 12;



interface DragState {
  mode:
    | 'move'
    | 'trim-left'
    | 'trim-right'
    | 'fade-in'
    | 'fade-out'
    | 'loop-start'
    | 'loop-end'
    | 'loop-range'
    | 'playhead'
    | 'range'
    | 'gain'
    | 'marker';
  clipId?: string;
  markerId?: string;
  startX: number;
  startY?: number;
  origStart: number;
  origLength: number;
  origGain?: number;
  loopOrig?: number;
  /** loop-range / playhead drags */
  anchor?: number;
  moved?: boolean;
  gesture?: boolean;
  wasPlaying?: boolean;
}

export interface TimelineElements {
  canvas: HTMLCanvasElement;
  ruler: HTMLCanvasElement;
  headers: HTMLElement;
  lanes: HTMLElement;
  body: HTMLElement;
}

export interface TimelineOptions {
  /** double-clicking a MIDI clip opens the note editor */
  onEditNotes?: (clipId: string) => void;
}

export class Timeline {
  private store: Store;
  private engine: Engine;
  private els: TimelineElements;
  private options: TimelineOptions;
  private ctx: CanvasRenderingContext2D;
  private rulerCtx: CanvasRenderingContext2D;
  private scrollX = 0;
  private rail: HTMLElement | null = null;
  private railThumb: HTMLElement | null = null;
  private drag: DragState | null = null;
  private raf = 0;
  private followMode: FollowMode = 'page';
  private headerSignature = '';
  private markerEditor: HTMLInputElement | null = null;
  private tip: HTMLElement | null = null;
  /** last scrub sample, for grain velocity and throttling */
  private scrub = { time: 0, x: 0, beat: 0 };
  private disposers: Array<() => void> = [];

  constructor(store: Store, engine: Engine, elements: TimelineElements, options: TimelineOptions = {}) {
    this.store = store;
    this.engine = engine;
    this.els = elements;
    this.options = options;
    const ctx = elements.canvas.getContext('2d');
    const rulerCtx = elements.ruler.getContext('2d');
    if (!ctx || !rulerCtx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx;
    this.rulerCtx = rulerCtx;
  }

  mount(): void {
    this.tip = document.createElement('div');
    this.tip.className = 'timeline-tip';
    this.tip.hidden = true;
    document.body.append(this.tip);

    this.bindCanvas();
    this.bindRuler();
    this.bindHeaders();
    this.bindRail();

    // Dragging a header reorders the track list; the mixer strip order is read
    // from the same array, so a drop in either view shows up in both.
    this.disposers.push(
      enableReorder({
        container: this.els.headers,
        axis: 'y',
        handle: (target) => {
          if (target.closest('button, input')) return null;
          return target.closest<HTMLElement>('.track-head');
        },
        onDrop: (id, index) => this.store.moveTrack(id, index),
      }),
    );

    const resize = new ResizeObserver(() => this.resize());
    resize.observe(this.els.lanes);
    resize.observe(this.els.ruler);
    this.disposers.push(() => resize.disconnect());

    const unsubscribe = this.store.subscribe((reason) => {
      if (reason === 'structure' || reason === 'selection') this.renderHeaders();
      if (reason === 'selection' || reason === 'structure') this.ensureVisible();
      this.wake();
    });
    this.disposers.push(unsubscribe);

    this.resize();
    this.renderHeaders();
    this.wake();
  }

  /**
   * Repaint on demand; while the transport rolls, follow the playhead at display
   * rate. A stopped project does no animation work at all.
   */
  private wake(): void {
    this.draw();

    if (this.engine.isPlaying && !this.raf) {
      this.raf = requestAnimationFrame(this.animate);
    }
  }

  private animate = (): void => {
    this.raf = 0;

    if (!this.engine.isPlaying) return;

    this.followPlayhead();
    this.draw();
    this.raf = requestAnimationFrame(this.animate);
  };

  /** Repaints after the window changed screens or the panels were resized. */
  refresh(): void {
    this.resize();
    this.wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.markerEditor?.remove();
    this.markerEditor = null;
    this.tip?.remove();
    this.tip = null;
    this.disposers.forEach((fn) => fn());
    this.disposers = [];
  }

  /** How the arrangement scrolls to keep the playhead in view. */
  setFollowMode(mode: FollowMode): void {
    this.followMode = mode;
    this.wake();
  }

  get follow(): FollowMode {
    return this.followMode;
  }

  /** Public locate used by the keyboard: keeps the target on screen. */
  seek(beat: number): void {
    const target = clamp(beat, 0, this.store.project.length);
    if (this.engine.isPlaying) this.engine.seek(target);
    else this.engine.locate(target);
    this.ensurePlayheadVisible();
    this.wake();
  }

  /** Arrow-key playhead move: grid step, or a whole bar with Shift. */
  nudgePlayhead(direction: 1 | -1, bar = false): void {
    const step = playheadStep(this.store.snap, this.store.project.beatsPerBar, bar);
    this.seek(this.engine.positionBeat + direction * step);
  }

  /** Shift+R: back to where the transport last started rolling. */
  returnToLastStart(): void {
    this.seek(this.engine.lastPlayStart);
  }

  /** `[` / `]`: put the loop brace at the playhead. */
  setLoopEdge(edge: 'start' | 'end'): void {
    const project = this.store.project;
    const beat = clamp(this.engine.positionBeat, 0, project.length);
    this.store.edit('structure', (next) => {
      next.loop.enabled = true;
      if (edge === 'start') next.loop.start = Math.max(0, Math.min(beat, next.loop.end - 0.25));
      else next.loop.end = Math.min(next.length, Math.max(beat, next.loop.start + 0.25));
    });

    if (this.engine.isPlaying) {
      const now = this.engine.positionBeat;
      const inside = now >= project.loop.start && now < project.loop.end;
      this.engine.seek(inside ? now : project.loop.start);
    }
    this.wake();
  }

  /** Adds a named locator at a beat. A marker already there is reused. */
  addMarkerAt(beat: number): Marker {
    const project = this.store.project;
    const target = clamp(snapBeat(beat, this.store.snap), 0, project.length);
    const existing = markerNear(project.markers, target, 1e-4);
    if (existing) return existing;

    const marker = createMarker(project.markers, target);
    this.store.edit('structure', (next) => {
      next.markers.push(marker);
      next.markers = sortMarkers(next.markers);
    });
    return marker;
  }

  /** M: drop a marker at the playhead and name it straight away. */
  addMarkerAtPlayhead(): Marker {
    const marker = this.addMarkerAt(this.engine.positionBeat);
    this.ensurePlayheadVisible();
    this.wake();
    this.editMarkerName(marker.id);
    return marker;
  }

  /** Alt+M: remove the marker under the playhead, if there is one. */
  deleteMarkerAtPlayhead(): boolean {
    const marker = markerNear(this.store.project.markers, this.engine.positionBeat, 0.01);
    if (!marker) return false;
    this.deleteMarker(marker.id);
    return true;
  }

  /** `,` / `.`: jump to the previous or next named locator. */
  jumpMarker(direction: 1 | -1): Marker | null {
    const target =
      direction > 0
        ? nextMarker(this.store.project.markers, this.engine.positionBeat)
        : previousMarker(this.store.project.markers, this.engine.positionBeat);
    if (!target) return null;
    this.seek(target.beat);
    return target;
  }

  private deleteMarker(markerId: string): void {
    this.store.edit('structure', (project) => {
      project.markers = project.markers.filter((marker) => marker.id !== markerId);
    });
    this.wake();
  }

  /** A small inline field over the ruler, so renaming feels like a DAW. */
  private editMarkerName(markerId: string): void {
    const marker = this.store.project.markers.find((entry) => entry.id === markerId);
    if (!marker) return;

    this.markerEditor?.remove();
    const rect = this.els.ruler.getBoundingClientRect();
    const offset = this.els.headers.offsetWidth;
    const x = rect.left + offset + this.xAtBeat(marker.beat);
    const input = document.createElement('input');
    input.className = 'marker-name-input';
    input.value = marker.name;
    input.maxLength = 48;
    input.setAttribute('aria-label', 'Marker name');
    input.style.left = `${clamp(x - 4, 8, window.innerWidth - 174)}px`;
    input.style.top = `${rect.top + BAR_BAND_H - 2}px`;
    document.body.append(input);
    this.markerEditor = input;

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value.trim().slice(0, 48);
      if (commit && name) {
        this.store.edit('structure', (project) => {
          const entry = project.markers.find((item) => item.id === markerId);
          if (entry) entry.name = name;
        });
      }
      input.remove();
      if (this.markerEditor === input) this.markerEditor = null;
      this.wake();
    };

    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  /** Sets the loop braces to the selected clip, without touching the clips. */
  loopSelectedClip(): boolean {
    const clip = this.store.selectedClip;
    if (!clip) return false;
    this.store.edit('structure', (project) => {
      project.loop.enabled = true;
      project.loop.start = Math.max(0, clip.start);
      project.loop.end = Math.max(clip.start + clip.length, clip.start + 0.25);
    });
    if (this.engine.isPlaying) this.engine.seek(clip.start);
    this.ensurePlayheadVisible();
    this.wake();
    return true;
  }

  /** L with a range drawn on the ruler: loops exactly that range. */
  loopRange(): boolean {
    const range = this.store.range;
    if (!range) return false;
    const project = this.store.project;
    const start = Math.max(0, range.start);
    const end = Math.min(project.length, Math.max(start + 0.25, range.end));

    this.store.edit('structure', (next) => {
      next.loop.enabled = true;
      next.loop.start = start;
      next.loop.end = end;
    });
    // The loop now owns the span, so Space should roll the loop rather than
    // replay the ephemeral range once.
    this.store.clearRange();
    if (this.engine.isPlaying) this.engine.seek(start);
    this.ensurePlayheadVisible();
    this.wake();
    return true;
  }

  /** Space with a range drawn on the ruler: plays the range once and stops. */
  playRange(): boolean {
    const range = this.store.range;
    if (!range) return false;
    void this.engine.play(range.start, { until: range.end });
    this.ensurePlayheadVisible();
    return true;
  }

  /**
   * L: loops between the markers either side of the playhead (or the last
   * pair when the playhead is past them). Pressing it on an already exact
   * marker loop turns the loop off again.
   */
  toggleMarkerLoop(): { start: number; end: number } | null {
    const markers = sortMarkers(this.store.project.markers);
    if (markers.length < 2) return null;
    const position = this.engine.positionBeat;
    let index = markers.findIndex((marker) => marker.beat > position + 1e-6);
    if (index === -1) index = markers.length;
    const startIndex = Math.max(0, Math.min(markers.length - 2, index - 1));
    const start = markers[startIndex].beat;
    const end = markers[startIndex + 1].beat;
    const project = this.store.project;
    const already =
      project.loop.enabled && Math.abs(project.loop.start - start) < 1e-4 && Math.abs(project.loop.end - end) < 1e-4;

    this.store.edit('structure', (next) => {
      next.loop.enabled = !already;
      next.loop.start = start;
      next.loop.end = Math.max(start + 0.25, end);
    });
    if (!already) {
      this.seek(position >= start && position < end ? position : start);
    }
    this.ensurePlayheadVisible();
    this.wake();
    return { start, end };
  }

  /** Shift+Space: starts at the selected clip instead of the current playhead. */
  playFromSelection(): boolean {
    const clip = this.store.selectedClip;
    if (!clip) return false;
    this.engine.seek(clip.start);
    void this.engine.play(clip.start);
    this.ensurePlayheadVisible();
    return true;
  }

  /** Scrolls only when the playhead is outside the view; used by keyboard seeks. */
  private ensurePlayheadVisible(): void {
    const width = this.els.lanes.clientWidth;
    if (width <= 0) return;
    const visible = this.visibleBeats();
    const beat = this.engine.positionBeat;
    if (beat < this.scrollX || beat > this.scrollX + visible * 0.9) {
      this.setScroll(beat - visible * 0.3);
    }
  }

  /**
   * Arrangement coordinates for a pointer over the lanes.
   *
   * File drag and drop uses this to place a clip where it was released: the
   * beat under the pointer and the lane it was dropped on, instead of the
   * playhead and whichever track happened to be selected.
   */
  dropTarget(clientX: number, clientY: number): {
    beat: number;
    trackIndex: number;
    x: number;
    y: number;
    rowTop: number;
    rowHeight: number;
  } {
    const rect = this.els.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const rows = this.store.project.tracks.length;
    const trackIndex = rows === 0 ? 0 : clamp(Math.floor(y / TRACK_H), 0, rows - 1);
    return {
      beat: Math.max(0, this.scrollX + x / this.store.zoom),
      trackIndex,
      x,
      y,
      rowTop: trackIndex * TRACK_H,
      rowHeight: TRACK_H,
    };
  }

  zoomBy(factor: number): void {
    const anchorBeat = this.scrollX + this.visibleBeats() / 2;
    this.store.zoom = clamp(this.store.zoom * factor, 6, 400);
    this.setScroll(anchorBeat - this.visibleBeats() / 2);
    this.store.emit('view');
  }

  deleteSelected(): void {
    const clip = this.store.selectedClip;
    if (!clip) return;
    this.store.edit('structure', (project) => {
      project.clips = project.clips.filter((c) => c.id !== clip.id);
    });
    this.store.selectedClipId = null;
    this.store.emit('selection');
  }

  duplicateSelected(): void {
    const clip = this.store.selectedClip;
    if (!clip) return;
    const copy: Clip = {
      ...clip,
      id: uid('clip'),
      start: clip.start + clip.length,
      notes: clip.notes.map((n) => ({ ...n, id: uid('n') })),
    };
    this.store.edit('structure', (project) => {
      project.clips.push(copy);
    });
    this.store.selectClip(copy.id);
  }

  splitSelected(): void {
    const clip = this.store.selectedClip;
    if (!clip) return;
    const position = this.engine.positionBeat;
    const local = position - clip.start;
    if (local <= 0.05 || local >= clip.length - 0.05) return;

    const left: Clip = {
      ...clip,
      length: local,
      notes: clip.notes
        .filter((n) => n.start < local)
        .map((n) => ({ ...n, duration: Math.min(n.duration, Math.max(0.05, local - n.start)) })),
    };
    const right: Clip = {
      ...clip,
      id: uid('clip'),
      start: position,
      length: clip.length - local,
      offset: clip.offset + local,
      notes: clip.notes
        .filter((n) => n.start >= local)
        .map((n) => ({ ...n, id: uid('n'), start: n.start - local })),
    };

    this.store.edit('structure', (project) => {
      const index = project.clips.findIndex((c) => c.id === clip.id);
      if (index === -1) return;
      project.clips.splice(index, 1, left, right);
    });
    this.store.selectClip(right.id);
  }

  addClipAtPlayhead(trackId?: string): void {
    const project = this.store.project;
    const track = project.tracks.find((t) => t.id === (trackId ?? this.store.selectedTrackId));
    if (!track) return;
    const start = Math.max(0, snapBeat(this.engine.positionBeat, this.store.snap || 1));
    const clip: Clip = {
      id: uid('clip'),
      trackId: track.id,
      name: track.kind === 'midi' ? 'New Clip' : 'Audio Clip',
      kind: track.kind,
      start,
      length: 4,
      color: track.color,
      notes: [],
      offset: 0,
      gain: 1,
    };
    this.store.edit('structure', (p) => {
      p.clips.push(clip);
      p.length = Math.max(p.length, start + 4);
    });
    this.store.selectClip(clip.id);
  }

  // ------------------------------------------------------------- rendering

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, this.els.lanes.clientWidth);
    const height = Math.max(1, this.store.project.tracks.length * TRACK_H);
    this.els.canvas.style.height = `${height}px`;
    this.els.canvas.width = Math.floor(width * dpr);
    this.els.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const rulerWidth = Math.max(1, this.els.ruler.clientWidth);
    const rulerHeight = RULER_H;
    this.els.ruler.width = Math.floor(rulerWidth * dpr);
    this.els.ruler.height = Math.floor(rulerHeight * dpr);
    this.rulerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private visibleBeats(): number {
    return this.els.lanes.clientWidth / this.store.zoom;
  }

  private xAtBeat(beat: number): number {
    return (beat - this.scrollX) * this.store.zoom;
  }

  private beatAtX(clientX: number): number {
    const rect = this.els.canvas.getBoundingClientRect();
    return this.scrollX + (clientX - rect.left) / this.store.zoom;
  }

  private draw(): void {
    this.scrollX = clamp(this.scrollX, 0, this.maxScroll());
    this.updateRail();
    this.drawLanes();
    this.drawRuler();
  }

  private drawLanes(): void {
    const ctx = this.ctx;
    const project = this.store.project;
    const width = this.els.lanes.clientWidth;
    const height = this.els.canvas.height / (window.devicePixelRatio || 1);
    if (width <= 0 || height <= 0) return;

    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < project.tracks.length; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#0c0e13' : '#0d1016';
      ctx.fillRect(0, i * TRACK_H, width, TRACK_H);
      ctx.strokeStyle = '#171b24';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, i * TRACK_H + TRACK_H - 0.5);
      ctx.lineTo(width, i * TRACK_H + TRACK_H - 0.5);
      ctx.stroke();
    }

    const zoom = this.store.zoom;
    const startBeat = this.scrollX;
    const endBeat = startBeat + width / zoom;
    const gridStep = zoom < 10 ? 4 : zoom < 22 ? 2 : 1;

    if (project.loop.enabled) {
      const loopX = this.xAtBeat(project.loop.start);
      const loopW = (project.loop.end - project.loop.start) * zoom;
      ctx.fillStyle = 'rgba(244, 63, 94, 0.045)';
      ctx.fillRect(loopX, 0, loopW, height);
    }

    // A drawn range is a lighter, one-shot selection over the loop colour.
    const range = this.store.range;
    if (range) {
      const rangeX = this.xAtBeat(range.start);
      const rangeW = Math.max(1, (range.end - range.start) * zoom);
      ctx.fillStyle = 'rgba(96, 165, 250, 0.09)';
      ctx.fillRect(rangeX, 0, rangeW, height);
      ctx.strokeStyle = 'rgba(147, 197, 253, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(rangeX + 0.5, 0);
      ctx.lineTo(rangeX + 0.5, height);
      ctx.moveTo(rangeX + rangeW - 0.5, 0);
      ctx.lineTo(rangeX + rangeW - 0.5, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (let beat = Math.floor(startBeat); beat <= endBeat; beat += gridStep) {
      const x = this.xAtBeat(beat);
      const isBar = beat % project.beatsPerBar === 0;
      ctx.strokeStyle = isBar ? '#20252f' : '#161a21';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }

    for (const clip of project.clips) {
      const index = project.tracks.findIndex((t) => t.id === clip.trackId);
      if (index === -1) continue;
      this.drawClip(clip, index);
    }

    // Locator lines run through the arrangement, so a section boundary is
    // visible where the clips are, not only on the ruler.
    for (const marker of project.markers ?? []) {
      const x = this.xAtBeat(marker.beat);
      if (x < -2 || x > width + 2) continue;
      ctx.save();
      ctx.globalAlpha = 0.24;
      ctx.strokeStyle = marker.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
      ctx.restore();
    }

    // The playhead runs through the lanes, not just the ruler, so the current
    // position stays obvious even on a tall arrangement. It is drawn on a half
    // pixel with a soft halo and a grab cap, so it stays crisp at any DPI.
    const playhead = Math.round(this.xAtBeat(this.engine.positionBeat) * 2) / 2;
    if (playhead >= -10 && playhead <= width + 10) {
      ctx.save();
      ctx.fillStyle = 'rgba(255, 84, 112, 0.08)';
      ctx.fillRect(playhead - 5, 0, 10, height);
      ctx.strokeStyle = 'rgba(255, 84, 112, 0.22)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(playhead, 0);
      ctx.lineTo(playhead, height);
      ctx.stroke();
      ctx.strokeStyle = '#ff5b76';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(playhead, 0);
      ctx.lineTo(playhead, height);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(playhead, 0);
      ctx.lineTo(playhead, height);
      ctx.stroke();
      ctx.fillStyle = '#ff5470';
      ctx.beginPath();
      ctx.moveTo(playhead - 5, 0);
      ctx.lineTo(playhead + 5, 0);
      ctx.lineTo(playhead, 7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  private drawClip(clip: Clip, trackIndex: number): void {
    const ctx = this.ctx;
    const zoom = this.store.zoom;
    const x = this.xAtBeat(clip.start);
    const width = Math.max(6, clip.length * zoom);
    const y = trackIndex * TRACK_H + 4;
    const height = TRACK_H - 12;
    if (x + width < 0 || x > this.els.lanes.clientWidth) return;

    const selected = this.store.selectedClipId === clip.id;

    ctx.save();
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, width, height, 4);
    else ctx.rect(x, y, width, height);
    ctx.fillStyle = `${clip.color}22`;
    ctx.fill();
    ctx.strokeStyle = selected ? '#f4f6fb' : `${clip.color}88`;
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.stroke();

    ctx.clip();
    ctx.fillStyle = `${clip.color}33`;
    ctx.fillRect(x, y, width, 15);

    ctx.fillStyle = selected ? '#ffffff' : '#d6dae4';
    ctx.font = '600 10px Inter, ui-sans-serif, system-ui, sans-serif';
    const flags =
      clip.kind === 'audio'
        ? `${clip.reverse ? ' ⟲' : ''}${clip.warp?.stretch ? ' ≈' : ''}${
            clip.warp?.semitones ? ` ${clip.warp.semitones > 0 ? '+' : ''}${clip.warp.semitones}st` : ''
          }`
        : '';
    const full = `${clip.name}${flags}`;
    const label = full.length > 22 ? `${full.slice(0, 21)}…` : full;
    ctx.fillText(label, x + 5, y + 11);

    if (clip.kind === 'midi' && clip.notes.length) {
      let minPitch = 127;
      let maxPitch = 0;
      for (const note of clip.notes) {
        if (note.pitch < minPitch) minPitch = note.pitch;
        if (note.pitch > maxPitch) maxPitch = note.pitch;
      }
      const span = Math.max(12, maxPitch - minPitch + 1);
      const areaTop = y + 18;
      const areaHeight = height - 22;
      const noteHeight = Math.max(1.5, areaHeight / span);
      ctx.fillStyle = selected ? '#ffe4e9' : '#e7ebf5';
      for (const note of clip.notes) {
        const nx = x + note.start * zoom;
        if (nx + note.duration * zoom < x || nx > x + width) continue;
        const ny = areaTop + (maxPitch - note.pitch) * noteHeight;
        ctx.globalAlpha = 0.35 + note.velocity * 0.5;
        ctx.fillRect(nx, ny, Math.max(1.5, note.duration * zoom), Math.max(1.4, noteHeight - 1));
      }
      ctx.globalAlpha = 1;
    } else if (clip.kind === 'audio' && clip.assetId) {
      const asset = this.store.assetById(clip.assetId);
      if (asset) {
        const mid = y + height / 2 + 8;
        const amplitude = (height - 26) / 2;
        const secondsPerBeat = 60 / this.store.project.bpm;
        const windowStart = clip.offset * secondsPerBeat;
        const windowLength = Math.max(0.001, clip.length * secondsPerBeat);

        // Only the on-screen part is measured: a five-minute clip scrolled half
        // out of view should not cost five minutes of peaks every redraw.
        const left = Math.max(x, 0);
        const right = Math.min(x + width, this.els.lanes.clientWidth);
        if (right - left > 0.5) {
          const progressAt = (fraction: number): number => {
            const fractionInClip = clamp((left + fraction * (right - left) - x) / Math.max(1, width), 0, 1);
            // Reversed clips draw their waveform mirrored, matching playback.
            const sourceTime = windowStart + windowLength * (clip.reverse ? 1 - fractionInClip : fractionInClip);
            return clamp(sourceTime / Math.max(0.001, asset.duration), 0, 1);
          };
          const a = progressAt(0);
          const b = progressAt(1);

          drawWaveform(ctx, {
            x: left,
            y: mid - amplitude,
            width: right - left,
            height: amplitude * 2,
            peaks: asset.peaks,
            source: asset.buffer,
            from: Math.min(a, b),
            to: Math.max(a, b),
            reversed: Boolean(clip.reverse),
            color: clip.color,
            edge: `${clip.color}ee`,
          });
        }
      }
    }

    if (clip.kind === 'audio') {
      // Clip gain is a draggable line inside the clip, the familiar DAW handle.
      const gainY = this.gainLineY(clip, trackIndex);
      const db = clamp(gainToDb(clip.gain), -24, 12);
      ctx.strokeStyle = selected ? 'rgba(250, 204, 21, 0.85)' : 'rgba(250, 204, 21, 0.30)';
      ctx.lineWidth = 1;
      ctx.setLineDash(selected ? [] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(x + 2, gainY + 0.5);
      ctx.lineTo(x + width - 2, gainY + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      if (selected) {
        ctx.fillStyle = '#facc15';
        ctx.strokeStyle = '#0b0d12';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x + Math.min(width - 6, Math.max(6, 8)), gainY, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (width > 96) {
          ctx.fillStyle = '#ffe9a3';
          ctx.font = '600 9px "JetBrains Mono", ui-monospace, monospace';
          const label = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
          ctx.fillText(label, x + 16, gainY - 4);
        }
      }
    }

    if (clip.kind === 'audio') {
      const bpm = this.store.project.bpm;
      const clipSeconds = (clip.length * 60) / bpm;
      const fades = resolveFades(clip, this.store.autoFade, clipSeconds);
      const fadeInX = x + Math.min(width, ((fades.in * bpm) / 60) * zoom);
      const fadeOutX = x + width - Math.min(width, ((fades.out * bpm) / 60) * zoom);

      ctx.strokeStyle = 'rgba(244, 246, 251, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + height);
      ctx.lineTo(fadeInX, y);
      ctx.lineTo(fadeOutX, y);
      ctx.lineTo(x + width, y + height);
      ctx.stroke();

      if (selected) {
        ctx.fillStyle = '#f4f6fb';
        ctx.beginPath();
        ctx.arc(fadeInX, y + 3, 3, 0, Math.PI * 2);
        ctx.arc(fadeOutX, y + 3, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (selected) {
      ctx.fillStyle = '#f4f6fb';
      ctx.fillRect(x, y, 3, height);
      ctx.fillRect(x + width - 3, y, 3, height);
    }

    ctx.restore();
  }

  private drawRuler(): void {
    const ctx = this.rulerCtx;
    const project = this.store.project;
    const width = this.els.ruler.clientWidth;
    const height = RULER_H;
    const offset = this.els.headers.offsetWidth;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0f1218';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#242833';
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();

    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, offset, height);
    // The lower two bands are for locators and for drawing a loop.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.018)';
    ctx.fillRect(offset, BAR_BAND_H, width - offset, MARKER_BAND_H);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.028)';
    ctx.fillRect(offset, height - LOOP_BAND_H, width - offset, LOOP_BAND_H);
    ctx.fillStyle = '#565b67';
    ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText('BARS', 10, 13);
    ctx.fillStyle = '#424854';
    ctx.font = '700 8px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText('MARKERS', 10, BAR_BAND_H + 10);
    ctx.fillText('LOOP', 10, height - 3);

    const zoom = this.store.zoom;
    const startBeat = this.scrollX;
    const endBeat = startBeat + (width - offset) / zoom;
    const barStep = zoom < 10 ? 8 : zoom < 20 ? 4 : zoom < 40 ? 2 : 1;

    for (let bar = Math.floor(startBeat / project.beatsPerBar) * project.beatsPerBar; bar <= endBeat; bar += project.beatsPerBar * barStep) {
      const x = offset + this.xAtBeat(bar);
      if (x < offset - 1) continue;
      ctx.strokeStyle = '#333a49';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, height - 10);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
      ctx.fillStyle = '#7b808d';
      ctx.font = '500 9px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText(String(Math.floor(bar / project.beatsPerBar) + 1), x + 4, 13);
    }

    const position = this.engine.positionBeat;
    let labelRight = offset - 4;
    ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
    for (const marker of project.markers ?? []) {
      const x = offset + this.xAtBeat(marker.beat);
      if (x < offset - 1 || x > width + 1) continue;
      const active = Math.abs(position - marker.beat) < 0.02;

      ctx.save();
      ctx.globalAlpha = active ? 1 : 0.86;
      ctx.strokeStyle = marker.color;
      ctx.lineWidth = active ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, BAR_BAND_H - 2);
      ctx.lineTo(x + 0.5, height - LOOP_BAND_H);
      ctx.stroke();

      if (x >= labelRight + 2) {
        const text = marker.name.length > 18 ? `${marker.name.slice(0, 17)}…` : marker.name;
        const labelWidth = this.markerLabelWidth(text);
        const boxX = x + labelWidth > width - 2 ? Math.max(offset, x - labelWidth) : x;
        ctx.fillStyle = marker.color;
        ctx.fillRect(boxX + 1, BAR_BAND_H + 1, labelWidth - 2, MARKER_BAND_H - 2);
        if (active) {
          ctx.strokeStyle = '#fff2d2';
          ctx.lineWidth = 1;
          ctx.strokeRect(boxX + 1.5, BAR_BAND_H + 1.5, labelWidth - 3, MARKER_BAND_H - 3);
        }
        ctx.fillStyle = '#0a0c10';
        ctx.fillText(text, boxX + 5, BAR_BAND_H + 10);
        labelRight = boxX + labelWidth + 4;
      }
      ctx.restore();
    }

    if (project.loop.enabled) {
      const startX = offset + this.xAtBeat(project.loop.start);
      const endX = offset + this.xAtBeat(project.loop.end);
      ctx.fillStyle = 'rgba(244, 63, 94, 0.16)';
      ctx.fillRect(startX, height - 7, endX - startX, 6);
      ctx.fillStyle = '#f43f5e';
      ctx.fillRect(startX, height - 9, 2, 8);
      ctx.fillRect(endX - 2, height - 9, 2, 8);
    }

    const range = this.store.range;
    if (range) {
      const rangeX = offset + this.xAtBeat(range.start);
      const rangeW = Math.max(2, (range.end - range.start) * this.store.zoom);
      ctx.fillStyle = 'rgba(96, 165, 250, 0.20)';
      ctx.fillRect(rangeX, 0, rangeW, BAR_BAND_H);
      ctx.fillStyle = 'rgba(147, 197, 253, 0.9)';
      ctx.fillRect(rangeX, 0, 1.5, height);
      ctx.fillRect(rangeX + rangeW - 1.5, 0, 1.5, height);
      ctx.fillStyle = '#bfdbfe';
      ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
      const bars = (range.end - range.start) / project.beatsPerBar;
      if (rangeW > 54) ctx.fillText(`${bars.toFixed(2)} bars`, rangeX + 5, 12);
    }

    const playheadX = Math.round((offset + this.xAtBeat(position)) * 2) / 2;
    if (playheadX >= offset - 8 && playheadX <= width + 8) {
      ctx.save();
      // Soft glow under the grab tab, then the tab itself with a crisp rim.
      ctx.fillStyle = 'rgba(255, 84, 112, 0.16)';
      ctx.fillRect(playheadX - 5, 0, 10, height);
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(playheadX - 6, 1, 12, 14, 3);
      else ctx.rect(playheadX - 6, 1, 12, 14);
      ctx.fillStyle = '#ff5470';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 219, 226, 0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(12, 14, 19, 0.55)';
      ctx.fillRect(playheadX - 1, 5, 2, 7);
      ctx.fillStyle = '#ff5470';
      ctx.beginPath();
      ctx.moveTo(playheadX - 5, 15);
      ctx.lineTo(playheadX + 5, 15);
      ctx.lineTo(playheadX, 21);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  private renderHeaders(): void {
    const project = this.store.project;
    const signature = project.tracks
      .map((t) => `${t.id}:${t.name}:${t.mute}:${t.solo}:${t.armed}:${t.color}:${t.instrument?.type ?? ''}`)
      .join('|') + `#${this.store.selectedTrackId}`;
    if (signature === this.headerSignature) return;
    this.headerSignature = signature;

    this.els.headers.innerHTML = '';
    for (const track of project.tracks) {
      this.els.headers.appendChild(this.buildHeader(track));
    }
    this.resize();
  }

  private buildHeader(track: Track): HTMLElement {
    const head = el('div', 'track-head');
    head.dataset.trackId = track.id;
    head.dataset.dragId = track.id;
    if (track.id === this.store.selectedTrackId) head.classList.add('is-selected');
    head.style.height = `${TRACK_H}px`;

    const accent = el('span', 'accent');
    accent.style.background = track.color;

    const row = el('div', 'track-name-row');
    const grip = el('span', 'track-grip', '⠿');
    grip.title = 'Drag to reorder this track';
    const dot = el('span', 'dot');
    dot.style.background = track.color;
    dot.style.width = '7px';
    dot.style.height = '7px';
    dot.style.borderRadius = '50%';
    row.append(grip, dot, el('span', 'track-name', track.name));

    const sub = el('div', 'track-sub');
    sub.textContent =
      track.kind === 'midi'
        ? `MIDI · ${(track.instrument?.type ?? 'instrument').toUpperCase()}`
        : 'AUDIO';

    const buttons = el('div', 'track-buttons');
    const mute = el('button', 'tiny', 'M');
    mute.dataset.action = 'mute';
    mute.classList.toggle('is-on', track.mute);
    mute.title = 'Mute';

    const solo = el('button', 'tiny is-solo', 'S');
    solo.dataset.action = 'solo';
    solo.classList.toggle('is-on', track.solo);
    solo.title = 'Solo';

    const arm = el('button', 'tiny is-rec', '●');
    arm.dataset.action = 'arm';
    arm.classList.toggle('is-on', track.armed);
    arm.title = 'Arm for recording';

    const add = el('button', 'tiny', '+');
    add.dataset.action = 'add-clip';
    add.title = 'Add clip at playhead';

    buttons.append(mute, solo, arm, add);

    head.append(accent, row, sub, buttons);
    return head;
  }

  // ------------------------------------------------------------ interaction

  private bindHeaders(): void {
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement;
      const head = target.closest<HTMLElement>('.track-head');
      if (!head) return;
      const trackId = head.dataset.trackId;
      if (!trackId) return;
      const track = this.store.trackById(trackId);
      if (!track) return;
      this.store.selectTrack(trackId);

      const action = target.dataset.action;
      if (!action) return;
      if (action === 'mute') {
        this.store.edit('structure', () => {
          track.mute = !track.mute;
        });
      } else if (action === 'solo') {
        this.store.edit('structure', () => {
          track.solo = !track.solo;
        });
      } else if (action === 'arm') {
        this.store.edit('structure', () => {
          track.armed = !track.armed;
        });
      } else if (action === 'add-clip') {
        this.addClipAtPlayhead(trackId);
      }
    };
    this.els.headers.addEventListener('click', onClick);
    this.disposers.push(() => this.els.headers.removeEventListener('click', onClick));
  }

  private bindCanvas(): void {
    const canvas = this.els.canvas;

    const onPointerDown = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const trackIndex = Math.floor(y / TRACK_H);
      const track = this.store.project.tracks[trackIndex];
      if (!track) return;

      const hit = this.clipAt(track.id, x);
      if (!hit) {
        this.store.selectClip(null);
        this.engine.seek(Math.max(0, this.beatAtX(event.clientX)));
        return;
      }

      this.store.selectClip(hit.id);
      const clipX = this.xAtBeat(hit.start);
      const clipW = hit.length * this.store.zoom;
      const edge = Math.min(7, clipW / 3);
      let mode: DragState['mode'] = 'move';
      if (x - clipX <= edge) mode = 'trim-left';
      else if (clipX + clipW - x <= edge) mode = 'trim-right';

      // The gain line sits below the header, so it never fights the fades.
      if (hit.kind === 'audio' && y - trackIndex * TRACK_H > 22) {
        const gainY = this.gainLineY(hit, trackIndex);
        if (Math.abs(y - gainY) <= 6) mode = 'gain';
      }

      // Fade handles live in the clip header, at the top of the fade curve.
      if (hit.kind === 'audio' && y - trackIndex * TRACK_H <= 18) {
        const fades = resolveFades(hit, this.store.autoFade, (hit.length * 60) / this.store.project.bpm);
        const inX = clipX + ((fades.in * this.store.project.bpm) / 60) * this.store.zoom;
        const outX = clipX + clipW - ((fades.out * this.store.project.bpm) / 60) * this.store.zoom;

        if (Math.abs(x - inX) <= 10) mode = 'fade-in';
        else if (Math.abs(x - outX) <= 10) mode = 'fade-out';
      }

      this.store.beginGesture();
      this.drag = {
        mode,
        clipId: hit.id,
        startX: event.clientX,
        startY: event.clientY,
        origStart: hit.start,
        origLength: hit.length,
        origGain: hit.gain,
      };
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!this.drag) {
        const rect = canvas.getBoundingClientRect();
        const y = event.clientY - rect.top;
        const trackIndex = Math.floor(y / TRACK_H);
        const track = this.store.project.tracks[trackIndex];
        if (!track) {
          canvas.style.cursor = 'default';
          return;
        }
        const x = event.clientX - rect.left;
        const hit = this.clipAt(track.id, x);
        if (!hit) {
          canvas.style.cursor = 'text';
          return;
        }
        const clipX = this.xAtBeat(hit.start);
        const clipW = hit.length * this.store.zoom;
        const edge = Math.min(7, clipW / 3);
        canvas.style.cursor = x - clipX <= edge || clipX + clipW - x <= edge ? 'ew-resize' : 'grab';
        return;
      }

      const deltaBeats = (event.clientX - this.drag.startX) / this.store.zoom;
      const snap = this.store.snap;
      const clip = this.store.project.clips.find((c) => c.id === this.drag?.clipId);
      if (!clip) return;

      if (this.drag.mode === 'move') {
        const next = Math.max(0, snapBeat(this.drag.origStart + deltaBeats, snap));

        // Dragging up or down moves the clip to another track, the way every
        // DAW handles it. Only a track of the same kind can take the clip: an
        // audio clip has no instrument to play it on a MIDI lane, and a MIDI
        // clip has no audio file to play on an audio one.
        const rect = this.ctx.canvas.getBoundingClientRect();
        const pointerY = event.clientY - rect.top;
        const tracks = this.store.project.tracks;
        const index = trackIndexAtY(pointerY, TRACK_H, tracks.length);
        const target = index >= 0 ? tracks[index] : undefined;

        this.store.touch('params', () => {
          clip.start = next;
          if (target && target.id !== clip.trackId && canDropClipOn(target.kind, clip.kind)) {
            clip.trackId = target.id;
            // The clip takes the colour of the track it now lives on, so the
            // arrangement keeps reading as one colour per track.
            clip.color = target.color;
          }
        });
      } else if (this.drag.mode === 'trim-right') {
        const next = Math.max(snap || 0.25, snapBeat(this.drag.origLength + deltaBeats, snap));
        this.store.touch('params', () => {
          clip.length = next;
        });
      } else if (this.drag.mode === 'trim-left') {
        const maxShift = this.drag.origLength - Math.max(0.25, snap || 0.25);
        const shift = clamp(snapBeat(deltaBeats, snap), -this.drag.origStart, maxShift);
        this.store.touch('params', () => {
          clip.start = this.drag ? this.drag.origStart + shift : clip.start;
          clip.length = this.drag ? this.drag.origLength - shift : clip.length;
        });
      } else if (this.drag.mode === 'fade-in') {
        const secondsPerBeat = 60 / this.store.project.bpm;
        const maxFade = (clip.length * secondsPerBeat) / 2;
        const seconds = clamp((this.beatAtX(event.clientX) - clip.start) * secondsPerBeat, 0, maxFade);
        this.store.touch('params', () => {
          clip.fadeIn = seconds;
        });
      } else if (this.drag.mode === 'fade-out') {
        const secondsPerBeat = 60 / this.store.project.bpm;
        const maxFade = (clip.length * secondsPerBeat) / 2;
        const seconds = clamp((clip.start + clip.length - this.beatAtX(event.clientX)) * secondsPerBeat, 0, maxFade);
        this.store.touch('params', () => {
          clip.fadeOut = seconds;
        });
      } else if (this.drag.mode === 'gain') {
        const startDb = gainToDb(this.drag.origGain ?? 1);
        const deltaDb = ((this.drag.startY ?? event.clientY) - event.clientY) * (36 / (TRACK_H - 24));
        const db = clamp(startDb + deltaDb, -24, 12);
        this.store.touch('params', () => {
          clip.gain = dbToGain(db);
        });
        this.showTip(
          event.clientX,
          event.clientY,
          `Clip gain ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`,
        );
      }
    };

    const onPointerUp = (): void => {
      const drag = this.drag;
      this.drag = null;
      this.hideTip();
      if (!drag) return;
      this.store.endGesture();
      this.store.emit('structure');

      // Warp and reverse are rendered off the audio thread; warm the cache so
      // the next roll uses the processed buffer, and restart a rolling
      // transport where it stands so the change is heard immediately.
      const clip = this.store.project.clips.find((entry) => entry.id === drag.clipId);
      if (clip && clip.kind === 'audio') {
        if (clip.warp?.stretch || clip.reverse) void prepareClipAudio(this.store, clip);
        if (drag.mode === 'gain' && this.engine.isPlaying) {
          this.engine.seek(this.engine.positionBeat);
        }
      }
    };

    const onDoubleClick = (event: MouseEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const y = event.clientY - rect.top;
      const track = this.store.project.tracks[Math.floor(y / TRACK_H)];
      if (!track) return;
      const x = event.clientX - rect.left;
      const hit = this.clipAt(track.id, x);
      if (hit) {
        this.store.selectClip(hit.id);
        if (hit.kind === 'midi') this.options.onEditNotes?.(hit.id);
        else if (Math.abs(y - this.gainLineY(hit, Math.floor(y / TRACK_H))) <= 8) {
          // Double-click the gain line: back to unity in one undo step.
          this.store.edit('structure', (project) => {
            const target = project.clips.find((entry) => entry.id === hit.id);
            if (target) target.gain = 1;
          });
          if (this.engine.isPlaying) this.engine.seek(this.engine.positionBeat);
        }
        return;
      }
      const start = Math.max(0, snapBeat(this.beatAtX(event.clientX), this.store.snap || 1));
      const clip: Clip = {
        id: uid('clip'),
        trackId: track.id,
        name: 'New Clip',
        kind: track.kind,
        start,
        length: 4,
        color: track.color,
        notes: [],
        offset: 0,
        gain: 1,
      };
      this.store.edit('structure', (project) => {
        project.clips.push(clip);
        project.length = Math.max(project.length, start + 4);
      });
      this.store.selectClip(clip.id);
    };

    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const anchor = this.beatAtX(event.clientX);
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        this.store.zoom = clamp(this.store.zoom * factor, 6, 400);
        this.setScroll(anchor - (event.clientX - canvas.getBoundingClientRect().left) / this.store.zoom);
        this.store.emit('view');
        return;
      }
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        this.scrollByPixels(event.deltaX || event.deltaY);
        this.wake();
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    this.disposers.push(() => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('wheel', onWheel);
    });
  }

  /** Pixel row of the clip-gain line, shared by drawing and hit testing. */
  private gainLineY(clip: Clip, trackIndex: number): number {
    const y = trackIndex * TRACK_H + 4;
    const height = TRACK_H - 12;
    const top = y + 20;
    const bottom = y + height - 4;
    const db = clamp(gainToDb(clip.gain), -24, 12);
    return bottom - ((db + 24) / 36) * (bottom - top);
  }

  private showTip(clientX: number, clientY: number, text: string): void {
    if (!this.tip) return;
    this.tip.textContent = text;
    this.tip.hidden = false;
    this.tip.style.left = `${clamp(clientX + 14, 8, window.innerWidth - 190)}px`;
    this.tip.style.top = `${Math.max(8, clientY - 32)}px`;
  }

  private hideTip(): void {
    if (this.tip) this.tip.hidden = true;
  }

  /** Marker badge width; falls back to a character estimate in canvas doubles. */
  private markerLabelWidth(text: string): number {
    const measured = this.rulerCtx.measureText(text) as TextMetrics | undefined;
    const width = measured && Number.isFinite(measured.width) ? measured.width : text.length * 5.4;
    return Math.min(112, width + 12);
  }

  private markerAtPointer(clientX: number, clientY: number): Marker | null {
    const rect = this.els.ruler.getBoundingClientRect();
    const y = clientY - rect.top;
    if (y < BAR_BAND_H || y >= BAR_BAND_H + MARKER_BAND_H) return null;

    const x = clientX - rect.left;
    const offset = this.els.headers.offsetWidth;
    const width = this.els.ruler.clientWidth;
    const ctx = this.rulerCtx;
    ctx.save();
    ctx.font = '700 9px "JetBrains Mono", ui-monospace, monospace';

    // Later markers are painted on top, so test them first.
    for (const marker of [...sortMarkers(this.store.project.markers)].reverse()) {
      const markerX = offset + this.xAtBeat(marker.beat);
      if (markerX < offset - 6 || markerX > width + 6) continue;
      if (Math.abs(x - markerX) <= 6) {
        ctx.restore();
        return marker;
      }
      const text = marker.name.length > 18 ? `${marker.name.slice(0, 17)}…` : marker.name;
      const labelWidth = this.markerLabelWidth(text);
      const boxX = markerX + labelWidth > width - 2 ? Math.max(offset, markerX - labelWidth) : markerX;
      if (x >= boxX - 2 && x <= boxX + labelWidth + 2) {
        ctx.restore();
        return marker;
      }
    }

    ctx.restore();
    return null;
  }

  private bindRuler(): void {
    const ruler = this.els.ruler;
    ruler.title =
      'Click to locate · drag to scrub (Shift+drag selects a range) · Space plays the range · M adds a marker · double-click the marker band to add or rename · lower strip sets the loop';

    const beatAt = (clientX: number): number => {
      const offset = this.els.headers.offsetWidth;
      return this.scrollX + (clientX - ruler.getBoundingClientRect().left - offset) / this.store.zoom;
    };

    const onPointerDown = (event: PointerEvent): void => {
      const offset = this.els.headers.offsetWidth;
      const rect = ruler.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < offset) return;

      const project = this.store.project;
      const loopStartX = offset + this.xAtBeat(project.loop.start);
      const loopEndX = offset + this.xAtBeat(project.loop.end);
      const beat = beatAt(event.clientX);

      if (y >= BAR_BAND_H && y < BAR_BAND_H + MARKER_BAND_H) {
        const marker = this.markerAtPointer(event.clientX, event.clientY);
        if (marker) {
          if (event.altKey) {
            this.deleteMarker(marker.id);
            return;
          }
          const wasPlaying = this.engine.isPlaying;
          if (wasPlaying) this.engine.seek(marker.beat);
          else this.engine.locate(marker.beat);
          this.store.beginGesture();
          this.drag = {
            mode: 'marker',
            markerId: marker.id,
            startX: event.clientX,
            origStart: marker.beat,
            origLength: 0,
            moved: false,
            gesture: true,
            wasPlaying,
          };
          ruler.setPointerCapture(event.pointerId);
          this.ensurePlayheadVisible();
          this.wake();
          return;
        }
      }

      // Shift+drag draws a time range; Space then plays just that range.
      if (event.shiftKey) {
        const anchor = Math.max(0, Math.min(project.length, snapBeat(beat, this.store.snap || 0.25)));
        this.store.setRange(anchor, anchor);
        this.drag = {
          mode: 'range',
          startX: event.clientX,
          origStart: anchor,
          origLength: 0,
          anchor,
          moved: false,
        };
        this.showTip(event.clientX, event.clientY, `Range from ${formatBars(anchor, project.beatsPerBar)}`);
        ruler.setPointerCapture(event.pointerId);
        return;
      }

      if (project.loop.enabled && Math.abs(x - loopStartX) < 6) {
        this.store.beginGesture();
        this.drag = {
          mode: 'loop-start',
          startX: event.clientX,
          origStart: 0,
          origLength: 0,
          loopOrig: project.loop.start,
          gesture: true,
        };
      } else if (project.loop.enabled && Math.abs(x - loopEndX) < 6) {
        this.store.beginGesture();
        this.drag = {
          mode: 'loop-end',
          startX: event.clientX,
          origStart: 0,
          origLength: 0,
          loopOrig: project.loop.end,
          gesture: true,
        };
      } else if (y >= rect.height - LOOP_BAND_H) {
        // The lower strip is the loop lane. A click still locates; a drag
        // draws new loop braces from the anchor.
        const anchor = Math.max(0, Math.min(project.length - 0.25, snapBeat(beat, this.store.snap || 0.25)));
        this.drag = {
          mode: 'loop-range',
          startX: event.clientX,
          origStart: 0,
          origLength: 0,
          loopOrig: anchor,
          anchor,
          moved: false,
          gesture: false,
        };
      } else {
        const target = Math.max(0, snapBeat(beat, this.store.snap));
        const wasPlaying = this.engine.isPlaying;
        this.store.clearRange();
        if (wasPlaying) this.engine.seek(target);
        else this.engine.locate(target);
        this.scrub = { time: performance.now(), x: event.clientX, beat: target };
        this.drag = {
          mode: 'playhead',
          startX: event.clientX,
          origStart: target,
          origLength: 0,
          anchor: target,
          moved: false,
          wasPlaying,
        };
      }
      ruler.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      const drag = this.drag;
      if (!drag) return;
      const project = this.store.project;

      if (drag.mode === 'range') {
        if (!drag.moved && Math.abs(event.clientX - drag.startX) < 3) return;
        drag.moved = true;
        const anchor = drag.anchor ?? 0;
        const current = Math.max(0, Math.min(project.length, snapBeat(beatAt(event.clientX), this.store.snap || 0.25)));
        this.store.setRange(Math.min(anchor, current), Math.max(anchor, current));
        const range = this.store.range;
        if (range) {
          const bars = (range.end - range.start) / project.beatsPerBar;
          this.showTip(
            event.clientX,
            event.clientY,
            `${bars.toFixed(bars < 10 ? 2 : 1)} bars · ${formatBars(range.start, project.beatsPerBar)} – ${formatBars(range.end, project.beatsPerBar)}`,
          );
        }
        this.wake();
        return;
      }

      if (drag.mode === 'playhead') {
        if (Math.abs(event.clientX - drag.startX) < 2) return;
        drag.moved = true;
        if (drag.wasPlaying && this.engine.isPlaying) this.engine.pause();
        const beat = Math.max(0, beatAt(event.clientX));
        this.engine.locate(beat);
        // Tape-style scrub: short grains of the audio clips under the pointer.
        const now = performance.now();
        const dt = (now - this.scrub.time) / 1000;
        const dx = event.clientX - this.scrub.x;
        if (dt > 0.012) {
          const velocity = Math.abs(dx / dt) / this.store.zoom;
          void this.engine.scrubAt(beat, velocity);
          this.scrub = { time: now, x: event.clientX, beat };
        }
        this.showTip(
          event.clientX,
          event.clientY,
          `${formatBars(beat, project.beatsPerBar)} · ${formatTime(beat * (60 / project.bpm))}`,
        );
        this.wake();
        return;
      }

      if (drag.mode === 'marker') {
        if (!drag.moved && Math.abs(event.clientX - drag.startX) < 3) return;
        const marker = project.markers.find((entry) => entry.id === drag.markerId);
        if (!marker) return;
        drag.moved = true;
        const beat = clamp(snapBeat(beatAt(event.clientX), this.store.snap || 0.25), 0, project.length);
        this.store.touch('params', () => {
          marker.beat = beat;
          project.markers = sortMarkers(project.markers);
        });
        if (!this.engine.isPlaying) this.engine.locate(beat);
        this.wake();
        return;
      }

      if (drag.mode === 'loop-range') {
        if (!drag.moved && Math.abs(event.clientX - drag.startX) < 3) return;
        const anchor = drag.anchor ?? 0;
        const current = Math.max(0, Math.min(project.length, snapBeat(beatAt(event.clientX), this.store.snap || 0.25)));
        if (!drag.gesture) {
          this.store.beginGesture();
          drag.gesture = true;
        }
        drag.moved = true;
        const start = Math.max(0, Math.min(anchor, current));
        const end = Math.min(project.length, Math.max(start + 0.25, Math.max(anchor, current)));
        this.store.touch('params', () => {
          project.loop.enabled = true;
          project.loop.start = start;
          project.loop.end = end;
        });
        this.wake();
        return;
      }

      if (drag.loopOrig === undefined) return;
      const delta = (event.clientX - drag.startX) / this.store.zoom;
      const snap = this.store.snap;
      if (drag.mode === 'loop-start') {
        const next = clamp(snapBeat(drag.loopOrig + delta, snap), 0, project.loop.end - 0.25);
        this.store.touch('params', () => {
          project.loop.start = next;
        });
      } else if (drag.mode === 'loop-end') {
        const next = Math.max(project.loop.start + 0.25, snapBeat(drag.loopOrig + delta, snap));
        this.store.touch('params', () => {
          project.loop.end = Math.min(project.length, next);
        });
      }
    };

    const onPointerUp = (): void => {
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;

      this.hideTip();

      if (drag.mode === 'range') {
        if (!drag.moved) this.store.clearRange();
        return;
      }

      if (drag.mode === 'playhead') {
        if (drag.wasPlaying) void this.engine.play(this.engine.positionBeat, { countIn: false });
        return;
      }

      if (drag.mode === 'marker') {
        if (drag.gesture) this.store.endGesture();
        if (drag.moved && drag.wasPlaying) {
          const marker = this.store.project.markers.find((entry) => entry.id === drag.markerId);
          if (marker) this.engine.seek(marker.beat);
        }
        this.wake();
        return;
      }

      if (drag.mode === 'loop-range') {
        if (!drag.moved) {
          this.engine.locate(drag.anchor ?? 0);
          this.ensurePlayheadVisible();
        } else if (drag.gesture) {
          this.store.endGesture();
          if (this.engine.isPlaying) this.engine.seek(this.store.project.loop.start);
        }
        return;
      }

      if (drag.gesture) this.store.endGesture();
    };

    const onDoubleClick = (event: MouseEvent): void => {
      const rect = ruler.getBoundingClientRect();
      const y = event.clientY - rect.top;
      if (y < BAR_BAND_H || y >= BAR_BAND_H + MARKER_BAND_H) return;
      if (event.clientX - rect.left < this.els.headers.offsetWidth) return;
      event.preventDefault();

      const marker = this.markerAtPointer(event.clientX, event.clientY);
      if (marker) {
        this.editMarkerName(marker.id);
        return;
      }

      const added = this.addMarkerAt(snapBeat(beatAt(event.clientX), this.store.snap || 0.25));
      this.editMarkerName(added.id);
    };

    ruler.addEventListener('pointerdown', onPointerDown);
    ruler.addEventListener('pointermove', onPointerMove);
    ruler.addEventListener('pointerup', onPointerUp);
    ruler.addEventListener('pointercancel', onPointerUp);
    ruler.addEventListener('dblclick', onDoubleClick);
    ruler.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.scrollByPixels(event.deltaX || event.deltaY);
      this.wake();
    }, { passive: false });

    this.disposers.push(() => {
      ruler.removeEventListener('pointerdown', onPointerDown);
      ruler.removeEventListener('pointermove', onPointerMove);
      ruler.removeEventListener('pointerup', onPointerUp);
      ruler.removeEventListener('pointercancel', onPointerUp);
      ruler.removeEventListener('dblclick', onDoubleClick);
    });
  }

  private clipAt(trackId: string, x: number): Clip | null {
    const clip = this.store.project.clips.find(
      (c) => c.trackId === trackId && x >= this.xAtBeat(c.start) && x <= this.xAtBeat(c.start + c.length),
    );
    return clip ?? null;
  }

  private followPlayhead(): void {
    const width = this.els.lanes.clientWidth;
    if (width <= 0) return;
    this.setScroll(followScroll(this.scrollX, this.engine.positionBeat, this.visibleBeats(), this.followMode));
  }

  private ensureVisible(): void {
    const clip = this.store.selectedClip;
    if (!clip) return;
    const x = this.xAtBeat(clip.start);
    const width = this.els.lanes.clientWidth;
    if (x < 0) this.setScroll(clip.start - 1);
    else if (x > width - 40) this.setScroll(clip.start - this.visibleBeats() * 0.5);
    this.draw();
  }

  /** Full timeline width in pixels, and the furthest the view can scroll. */
  private contentWidth(): number {
    return Math.max(this.store.project.length, this.visibleBeats()) * this.store.zoom;
  }

  private maxScroll(): number {
    return Math.max(0, this.store.project.length - this.visibleBeats());
  }

  private setScroll(beat: number): void {
    this.scrollX = clamp(beat, 0, this.maxScroll());
    this.updateRail();
  }

  private scrollByPixels(pixels: number): void {
    this.setScroll(this.scrollX + pixels / this.store.zoom);
  }

  private updateRail(): void {
    const rail = this.rail;
    const thumb = this.railThumb;
    if (!rail || !thumb) return;
    const metrics = scrollRailMetrics(this.els.lanes.clientWidth, this.contentWidth(), this.scrollX * this.store.zoom);
    if (!metrics) {
      rail.hidden = true;
      return;
    }
    rail.hidden = false;
    thumb.style.width = `${metrics.thumbWidth}px`;
    thumb.style.transform = `translateX(${metrics.thumbLeft}px)`;
  }

  /**
   * Drags the view through time. The rail is a custom scrollbar because the
   * canvas paints a window into the timeline instead of scrolling natively.
   */
  private bindRail(): void {
    const rail = document.getElementById('timeline-rail');
    const track = document.getElementById('timeline-rail-track');
    const thumb = document.getElementById('timeline-rail-thumb');
    if (!rail || !track || !thumb) return;
    this.rail = rail;
    this.railThumb = thumb;

    let grab: number | null = null;

    const scrollToPointer = (clientX: number, offset: number): void => {
      const rect = track.getBoundingClientRect();
      const metrics = scrollRailMetrics(this.els.lanes.clientWidth, this.contentWidth(), this.scrollX * this.store.zoom);
      if (!metrics || rect.width <= 0) return;
      this.setScroll(
        scrollBeatFromRail(
          clientX - rect.left,
          rect.width,
          metrics.thumbWidth,
          metrics.maxScroll,
          this.store.zoom,
          offset,
        ),
      );
      this.wake();
    };

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      const thumbRect = thumb.getBoundingClientRect();
      const onThumb = event.clientX >= thumbRect.left && event.clientX <= thumbRect.right;
      grab = onThumb ? event.clientX - thumbRect.left : thumbRect.width / 2;
      track.setPointerCapture?.(event.pointerId);
      scrollToPointer(event.clientX, grab);
    };
    const onMove = (event: PointerEvent): void => {
      if (grab === null) return;
      scrollToPointer(event.clientX, grab);
    };
    const onUp = (): void => {
      grab = null;
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      this.scrollByPixels(event.deltaX || event.deltaY);
      this.wake();
    };

    track.addEventListener('pointerdown', onDown);
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
    track.addEventListener('pointercancel', onUp);
    track.addEventListener('wheel', onWheel, { passive: false });
    this.disposers.push(() => {
      track.removeEventListener('pointerdown', onDown);
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onUp);
      track.removeEventListener('pointercancel', onUp);
      track.removeEventListener('wheel', onWheel);
    });
  }
}
