import type { AudioAsset, Clip, Project, Track } from './types';

export type ChangeReason = 'structure' | 'params' | 'selection' | 'view' | 'transport';

export type Listener = (reason: ChangeReason) => void;

const HISTORY_LIMIT = 100;

export class Store {
  project: Project;
  assets = new Map<string, AudioAsset>();
  selectedTrackId = '';
  selectedClipId: string | null = null;
  /** pixels per beat */
  zoom = 46;
  snap = 0.25;
  /** short crossfades at every audio clip boundary to stop clicks and pops */
  autoFade = true;
  /** an explicit time range, drawn on the ruler; Space plays it once */
  range: { start: number; end: number } | null = null;

  private listeners = new Set<Listener>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private gestureSnapshot: string | null = null;

  constructor(project: Project) {
    this.project = project;
    this.selectedTrackId = project.tracks[0]?.id ?? '';
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(reason: ChangeReason = 'params'): void {
    for (const listener of this.listeners) listener(reason);
  }

  get selectedTrack(): Track | undefined {
    return this.project.tracks.find((t) => t.id === this.selectedTrackId);
  }

  get selectedClip(): Clip | undefined {
    return this.project.clips.find((c) => c.id === this.selectedClipId);
  }

  trackById(id: string): Track | undefined {
    return this.project.tracks.find((t) => t.id === id);
  }

  assetById(id: string): AudioAsset | undefined {
    return this.assets.get(id);
  }

  selectTrack(id: string): void {
    if (this.selectedTrackId === id) return;
    // A remote command can name a track that was just deleted; ignore it
    // rather than leaving the session pointing at nothing.
    if (!this.trackById(id)) return;
    this.selectedTrackId = id;
    this.emit('selection');
  }

  /**
   * Reorders the track list, as dragged in the mixer or the arrangement.
   * The index is the final position, and the move is a single undo step.
   */
  moveTrack(trackId: string, targetIndex: number): void {
    const from = this.project.tracks.findIndex((t) => t.id === trackId);
    if (from === -1) return;
    const to = Math.max(0, Math.min(this.project.tracks.length - 1, targetIndex));
    if (to === from) return;
    this.edit('structure', (project) => {
      const [track] = project.tracks.splice(from, 1);
      project.tracks.splice(to, 0, track);
    });
  }

  setRange(start: number, end: number): void {
    const low = Math.max(0, Math.min(start, end));
    const high = Math.max(low + 0.05, Math.max(start, end));
    this.range = { start: low, end: high };
    this.emit('selection');
  }

  clearRange(): void {
    if (!this.range) return;
    this.range = null;
    this.emit('selection');
  }

  selectClip(id: string | null): void {
    this.selectedClipId = id;
    if (id) {
      const clip = this.project.clips.find((c) => c.id === id);
      if (clip) this.selectedTrackId = clip.trackId;
    }
    this.emit('selection');
  }

  /** Discrete edit: creates one undo step. */
  edit(reason: ChangeReason, mutate: (project: Project) => void): void {
    this.pushUndo(this.snapshot());
    mutate(this.project);
    this.emit(reason);
  }

  /** Start a drag gesture: one undo step covers every change until endGesture. */
  beginGesture(): void {
    if (this.gestureSnapshot) return;
    this.gestureSnapshot = this.snapshot();
  }

  /** Continuous change during a gesture, no new undo step. */
  touch(reason: ChangeReason, mutate: (project: Project) => void): void {
    mutate(this.project);
    this.emit(reason);
  }

  endGesture(): void {
    if (!this.gestureSnapshot) return;
    const current = this.snapshot();
    if (current !== this.gestureSnapshot) {
      this.pushUndo(this.gestureSnapshot);
    }
    this.gestureSnapshot = null;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.snapshot());
    this.restore(previous);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
  }

  load(project: Project): void {
    this.pushUndo(this.snapshot());
    this.project = project;
    this.selectedTrackId = project.tracks[0]?.id ?? '';
    this.selectedClipId = null;
    this.emit('structure');
  }

  private snapshot(): string {
    return JSON.stringify(this.project);
  }

  private restore(snapshot: string): void {
    this.project = JSON.parse(snapshot) as Project;
    if (!this.project.tracks.some((t) => t.id === this.selectedTrackId)) {
      this.selectedTrackId = this.project.tracks[0]?.id ?? '';
    }
    if (!this.project.clips.some((c) => c.id === this.selectedClipId)) {
      this.selectedClipId = null;
    }
    this.emit('structure');
  }

  private pushUndo(snapshot: string): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }
}
