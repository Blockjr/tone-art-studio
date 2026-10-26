import { describe, expect, it } from 'vitest';
import { blankProject } from '../src/core/project';
import {
  MIN_NOTE_BEATS,
  endAllNotes,
  endNote,
  placeMidiPass,
  punchAllowsEnd,
  punchAllowsOn,
  startNote,
  wrapIntoLoop,
  type CapturedNote,
  type HeldNote,
} from '../src/core/midicapture';

const midiTrackId = (project: ReturnType<typeof blankProject>): string =>
  project.tracks.find((track) => track.kind === 'midi')!.id;

describe('MIDI note capture', () => {
  it('pairs a note-on with its note-off', () => {
    const held: HeldNote[] = [];
    const done: CapturedNote[] = [];
    startNote(held, done, 60, 0.8, 1);
    expect(held).toHaveLength(1);
    expect(endNote(held, done, 60, 2.5)).toBe(true);
    expect(held).toHaveLength(0);
    expect(done).toEqual([{ pitch: 60, velocity: 0.8, start: 1, duration: 1.5 }]);
  });

  it('ignores a note-off for a key that was never held', () => {
    const held: HeldNote[] = [];
    const done: CapturedNote[] = [];
    expect(endNote(held, done, 64, 4)).toBe(false);
    expect(done).toHaveLength(0);
  });

  it('closes a retriggered pitch at the second note-on', () => {
    const held: HeldNote[] = [];
    const done: CapturedNote[] = [];
    startNote(held, done, 60, 0.5, 0);
    startNote(held, done, 60, 0.9, 0.75);
    expect(done).toHaveLength(1);
    expect(done[0].duration).toBeCloseTo(0.75);
    expect(held).toHaveLength(1);
    expect(held[0].velocity).toBe(0.9);
  });

  it('keeps a minimum length for a tap', () => {
    const held: HeldNote[] = [];
    const done: CapturedNote[] = [];
    startNote(held, done, 72, 0.7, 3);
    endNote(held, done, 72, 3);
    expect(done[0].duration).toBe(MIN_NOTE_BEATS);
  });

  it('closes notes still held when recording stops', () => {
    const held: HeldNote[] = [];
    const done: CapturedNote[] = [];
    startNote(held, done, 55, 0.6, 0);
    startNote(held, done, 59, 0.6, 0);
    expect(endAllNotes(held, done, 4)).toBe(2);
    expect(held).toHaveLength(0);
    expect(done.map((note) => note.duration)).toEqual([4, 4]);
  });

  it('never produces a negative start or an out-of-range velocity', () => {
    const held: HeldNote[] = [];
    const done: CapturedNote[] = [];
    startNote(held, done, 60, 5, -2);
    endNote(held, done, 60, 1);
    expect(done[0].start).toBe(0);
    expect(done[0].velocity).toBe(1);
  });
});

describe('punch in and out', () => {
  const punch = { start: 8, end: 16, in: true, out: true };

  it('captures only between the braces', () => {
    expect(punchAllowsOn(punch, 7.5)).toBe(false);
    expect(punchAllowsOn(punch, 8)).toBe(true);
    expect(punchAllowsOn(punch, 15.9)).toBe(true);
    expect(punchAllowsOn(punch, 16.5)).toBe(false);
  });

  it('lets punch-in and punch-out be chosen separately', () => {
    expect(punchAllowsOn({ ...punch, in: false }, 2)).toBe(true);
    expect(punchAllowsOn({ ...punch, out: false }, 20)).toBe(true);
    expect(punchAllowsEnd({ ...punch, out: false }, 20)).toBe(20);
  });

  it('truncates a note held past punch-out', () => {
    expect(punchAllowsEnd(punch, 18)).toBe(16);
    expect(punchAllowsEnd(punch, 12)).toBe(12);
    expect(punchAllowsEnd(null, 18)).toBe(18);
  });
});

describe('loop folding', () => {
  it('keeps a multi-lap pass inside one lap', () => {
    const loop = { start: 4, end: 12 };
    expect(wrapIntoLoop(loop, 4)).toBe(0);
    expect(wrapIntoLoop(loop, 9)).toBe(5);
    expect(wrapIntoLoop(loop, 21)).toBe(1);
    expect(wrapIntoLoop(loop, 12)).toBe(0);
  });

  it('uses the transport position when there is no loop', () => {
    expect(wrapIntoLoop(null, 6)).toBe(6);
    expect(wrapIntoLoop(null, -3)).toBe(0);
  });
});

describe('placing a finished pass', () => {
  it('creates a MIDI clip rounded up to whole bars', () => {
    const project = blankProject('Test');
    const trackId = midiTrackId(project);
    const placed = placeMidiPass(project, trackId, 8, [
      { pitch: 60, velocity: 0.8, start: 0, duration: 1 },
      { pitch: 64, velocity: 0.8, start: 1, duration: 5 },
    ]);

    expect(placed).not.toBeNull();
    expect(placed!.merged).toBe(false);
    const clip = project.clips.find((candidate) => candidate.id === placed!.clipId)!;
    expect(clip.start).toBe(8);
    expect(clip.length).toBe(8);
    expect(clip.notes.map((note) => note.start)).toEqual([0, 1]);
    expect(clip.notes[1].duration).toBe(5);
    expect(clip.color).toBe(project.tracks.find((track) => track.id === trackId)!.color);
  });

  it('overdubs into the clip under the pass start', () => {
    const project = blankProject('Test');
    const trackId = midiTrackId(project);
    placeMidiPass(project, trackId, 0, [{ pitch: 48, velocity: 0.6, start: 0, duration: 2 }]);

    const placed = placeMidiPass(project, trackId, 0, [
      { pitch: 55, velocity: 0.7, start: 3, duration: 1 },
    ]);

    expect(placed!.merged).toBe(true);
    expect(project.clips).toHaveLength(1);
    const clip = project.clips[0];
    expect(clip.notes).toHaveLength(2);
    expect(clip.notes.map((note) => note.pitch)).toEqual([48, 55]);
  });

  it('grows the clip when an overdub runs past its end', () => {
    const project = blankProject('Test');
    const trackId = midiTrackId(project);
    placeMidiPass(project, trackId, 0, [{ pitch: 48, velocity: 0.6, start: 0, duration: 1 }]);
    placeMidiPass(project, trackId, 0, [{ pitch: 50, velocity: 0.6, start: 9, duration: 2 }]);

    const clip = project.clips[0];
    expect(clip.length).toBe(11);
    expect(clip.notes.map((note) => note.start)).toEqual([0, 9]);
  });

  it('starts a new clip when the pass begins after the existing one', () => {
    const project = blankProject('Test');
    const trackId = midiTrackId(project);
    placeMidiPass(project, trackId, 0, [{ pitch: 48, velocity: 0.6, start: 0, duration: 1 }]);
    const placed = placeMidiPass(project, trackId, 16, [{ pitch: 52, velocity: 0.6, start: 0, duration: 1 }]);

    expect(project.clips).toHaveLength(2);
    expect(placed!.merged).toBe(false);
    expect(project.clips[1].name).toContain('Rec 2');
  });

  it('clamps captured pitches and refuses an empty pass', () => {
    const project = blankProject('Test');
    const trackId = midiTrackId(project);
    expect(placeMidiPass(project, trackId, 0, [])).toBeNull();

    placeMidiPass(project, trackId, 0, [{ pitch: 200, velocity: 0.5, start: 0, duration: 1 }]);
    expect(project.clips[0].notes[0].pitch).toBe(127);
  });
});
