import { describe, expect, it } from 'vitest';
import {
  addNote,
  clampPitch,
  createNote,
  moveNote,
  notesSpan,
  quantizeNotes,
  removeNotes,
  resizeNote,
  setVelocity,
  transposeNotes,
} from '../src/core/midi';
import type { Note } from '../src/core/types';

const note = (pitch: number, start: number, duration: number, velocity = 0.7): Note => ({
  id: `n-${pitch}-${start}`,
  pitch,
  start,
  duration,
  velocity,
});

describe('midi note editing', () => {
  it('creates notes inside the MIDI range with a usable minimum length', () => {
    const created = createNote(200, -2, 0);
    expect(created.pitch).toBe(127);
    expect(created.start).toBe(0);
    expect(created.duration).toBeGreaterThan(0);
    expect(created.velocity).toBeGreaterThan(0);
    expect(clampPitch(-5)).toBe(0);
  });

  it('adds notes in time order and removes them by id', () => {
    const notes: Note[] = [];
    addNote(notes, note(60, 2, 1));
    addNote(notes, note(62, 1, 1));
    expect(notes.map((n) => n.start)).toEqual([1, 2]);
    expect(removeNotes(notes, [notes[0].id])).toBe(1);
    expect(notes.length).toBe(1);
  });

  it('quantizes starts, and lengths only when asked', () => {
    const notes = [note(60, 0.31, 0.9), note(62, 0.94, 0.45)];
    expect(quantizeNotes(notes, 0.25)).toBe(2);
    expect(notes.map((n) => n.start)).toEqual([0.25, 1]);
    expect(notes[0].duration).toBeCloseTo(0.9, 5);

    quantizeNotes(notes, 0.25, undefined, true);
    expect(notes[0].duration).toBeCloseTo(1, 5);
    expect(notes[1].duration).toBeCloseTo(0.5, 5);
  });

  it('only touches the selected notes', () => {
    const notes = [note(60, 0.31, 1), note(62, 0.94, 1)];
    quantizeNotes(notes, 0.25, [notes[0].id]);
    expect(notes[0].start).toBeCloseTo(0.25, 5);
    expect(notes[1].start).toBeCloseTo(0.94, 5);
  });

  it('leaves notes alone when the grid is off', () => {
    const notes = [note(60, 0.31, 1)];
    expect(quantizeNotes(notes, 0)).toBe(0);
    expect(notes[0].start).toBeCloseTo(0.31, 5);
  });

  it('transposes within the MIDI range', () => {
    const notes = [note(60, 0, 1), note(125, 1, 1)];
    expect(transposeNotes(notes, 12)).toBe(2);
    expect(notes[0].pitch).toBe(72);
    expect(notes[1].pitch).toBe(127);
    transposeNotes(notes, -24);
    expect(notes[0].pitch).toBe(48);
  });

  it('sets velocity on a selection or on everything', () => {
    const notes = [note(60, 0, 1), note(62, 1, 1)];
    setVelocity(notes, 0.2, [notes[1].id]);
    expect(notes[0].velocity).toBeCloseTo(0.7, 5);
    expect(notes[1].velocity).toBeCloseTo(0.2, 5);
    setVelocity(notes, 2);
    expect(notes.every((n) => n.velocity === 1)).toBe(true);
  });

  it('keeps a moved note inside the clip', () => {
    const n = note(60, 0, 1);
    moveNote(n, -4, 64, 4);
    expect(n.start).toBe(0);
    expect(n.pitch).toBe(64);
    moveNote(n, 10, 64, 4);
    expect(n.start).toBe(3);
  });

  it('resizes without crossing the clip end or the minimum length', () => {
    const n = note(60, 2, 1);
    resizeNote(n, 99, 0.25, 4);
    expect(n.duration).toBe(2);
    resizeNote(n, 0.01, 0.25, 4);
    expect(n.duration).toBe(0.25);
  });

  it('reports the pitch span and copes with an empty clip', () => {
    expect(notesSpan([])).toBeNull();
    expect(notesSpan([note(48, 0, 1), note(72, 1, 1)])).toEqual({ low: 48, high: 72 });
  });
});
