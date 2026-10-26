import type { Note } from './types';
import { uid } from './time';

/**
 * Note editing operations for the piano roll.
 *
 * Everything here mutates the note array in place so the caller can run it
 * inside a single `store.edit` (one undo step). The functions are free of DOM
 * and audio, which is what makes the piano roll's behaviour testable.
 */

export const PITCH_MIN = 0;
export const PITCH_MAX = 127;

export function clampPitch(pitch: number): number {
  return Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.round(pitch)));
}

export function createNote(pitch: number, start: number, duration: number, velocity = 0.75): Note {
  return {
    id: uid('n'),
    pitch: clampPitch(pitch),
    start: Math.max(0, start),
    duration: Math.max(0.03125, duration),
    velocity: Math.max(0.01, Math.min(1, velocity)),
  };
}

/** Adds a note and keeps the array ordered by pitch then time, for stable drawing. */
export function addNote(notes: Note[], note: Note): Note {
  notes.push(note);
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return note;
}

/** Removes notes by id. Returns how many were removed. */
export function removeNotes(notes: Note[], ids: readonly string[]): number {
  const drop = new Set(ids);
  let removed = 0;
  for (let index = notes.length - 1; index >= 0; index--) {
    if (drop.has(notes[index].id)) {
      notes.splice(index, 1);
      removed++;
    }
  }
  return removed;
}

/** The subset an edit applies to: the selected ids, or every note when none. */
function targets(notes: Note[], ids?: readonly string[]): Note[] {
  if (!ids || ids.length === 0) return notes;
  const keep = new Set(ids);
  return notes.filter((note) => keep.has(note.id));
}

/**
 * Snaps note starts, and optionally lengths, to the grid.
 * A zero grid is a no-op. Returns the number of notes that actually moved.
 */
export function quantizeNotes(
  notes: Note[],
  grid: number,
  ids?: readonly string[],
  alsoLengths = false,
): number {
  if (grid <= 0) return 0;
  let changed = 0;
  for (const note of targets(notes, ids)) {
    const start = Math.round(note.start / grid) * grid;
    const duration = alsoLengths
      ? Math.max(grid, Math.round(note.duration / grid) * grid)
      : note.duration;
    if (Math.abs(start - note.start) > 1e-9 || Math.abs(duration - note.duration) > 1e-9) {
      note.start = Math.max(0, start);
      note.duration = duration;
      changed++;
    }
  }
  return changed;
}

/** Moves notes by semitones, clamped to the MIDI range. Returns notes changed. */
export function transposeNotes(notes: Note[], semitones: number, ids?: readonly string[]): number {
  let changed = 0;
  for (const note of targets(notes, ids)) {
    const pitch = clampPitch(note.pitch + semitones);
    if (pitch !== note.pitch) {
      note.pitch = pitch;
      changed++;
    }
  }
  return changed;
}

/** Sets velocity on the selection (or all notes). Returns notes changed. */
export function setVelocity(notes: Note[], velocity: number, ids?: readonly string[]): number {
  const value = Math.max(0.01, Math.min(1, velocity));
  let changed = 0;
  for (const note of targets(notes, ids)) {
    if (Math.abs(note.velocity - value) > 1e-9) {
      note.velocity = value;
      changed++;
    }
  }
  return changed;
}

/**
 * Moves a note in time and pitch, keeping it inside the clip.
 * `maxDuration` is the clip length in beats.
 */
export function moveNote(note: Note, start: number, pitch: number, maxDuration: number): void {
  note.start = Math.max(0, Math.min(maxDuration - note.duration, start));
  note.pitch = clampPitch(pitch);
}

/** Resizes a note from its right edge, never shorter than the grid step. */
export function resizeNote(note: Note, duration: number, minDuration: number, maxDuration: number): void {
  const room = Math.max(minDuration, maxDuration - note.start);
  note.duration = Math.max(minDuration, Math.min(room, duration));
}

/** Lowest and highest pitch in the set, or null when it is empty. */
export function notesSpan(notes: readonly Note[]): { low: number; high: number } | null {
  if (!notes.length) return null;
  let low = PITCH_MAX;
  let high = PITCH_MIN;
  for (const note of notes) {
    if (note.pitch < low) low = note.pitch;
    if (note.pitch > high) high = note.pitch;
  }
  return { low, high };
}

/** Copies notes for a duplicated clip, keeping their relative positions. */
export function cloneNotes(notes: readonly Note[]): Note[] {
  return notes.map((note) => ({ ...note, id: uid('n') }));
}

/** Human label for a note's pitch, e.g. C4. */
export { noteName as pitchName } from './time';
