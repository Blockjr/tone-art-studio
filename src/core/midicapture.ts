import type { Clip, Note, Project } from './types';
import { uid } from './time';

/**
 * MIDI recording, modelled on Ableton Live's arrangement record.
 *
 * Two separate concerns live here, both free of DOM and audio so they can be
 * tested directly:
 *
 *  - pairing note-on with note-off into timed notes, where the caller supplies
 *    the transport position of each event;
 *  - placing a finished pass into the project, which either creates a clip or
 *    overdubs into the clip already under the pass start.
 *
 * Punch in/out is part of the first: a take is only captured between the punch
 * points, exactly like Live, where the Arrangement loop braces double as the
 * punch range and the In/Out switches decide which ends are enforced.
 */

/** A note still held down. `start` is pass-local beats. */
export interface HeldNote {
  pitch: number;
  velocity: number;
  start: number;
}

/** A completed note. `start`/`duration` are pass-local beats. */
export interface CapturedNote {
  pitch: number;
  velocity: number;
  start: number;
  duration: number;
}

/** Punch points, taken from the loop braces the way Ableton does. */
export interface PunchRange {
  start: number;
  end: number;
  /** do not capture before `start` */
  in: boolean;
  /** do not capture after `end` */
  out: boolean;
}

/** Shortest note a captured tap can produce; also the piano roll's minimum. */
export const MIN_NOTE_BEATS = 0.03125;

export function clampVelocity(velocity: number): number {
  return Math.max(0.05, Math.min(1, Number.isFinite(velocity) ? velocity : 0.8));
}

/** Whether a note starting at this arrangement beat may be captured. */
export function punchAllowsOn(punch: PunchRange | null, beat: number): boolean {
  if (!punch) return true;
  if (punch.in && beat < punch.start - 1e-6) return false;
  if (punch.out && beat > punch.end + 1e-6) return false;
  return true;
}

/** Where a note that is still held when punch-out passes must end. */
export function punchAllowsEnd(punch: PunchRange | null, beat: number): number {
  if (!punch || !punch.out) return beat;
  return Math.min(beat, punch.end);
}

/**
 * Folds an arrangement beat into a loop lap, so a pass recorded over several
 * laps keeps every note inside one clip-length instead of running off the end.
 */
export function wrapIntoLoop(loop: { start: number; end: number } | null, beat: number): number {
  const local = beat - (loop ? loop.start : 0);
  if (!loop || loop.end - loop.start < 1e-6) return Math.max(0, local);
  const span = loop.end - loop.start;
  const wrapped = ((local % span) + span) % span;
  return wrapped;
}

/**
 * Records a note-on. A second note-on for a pitch already held closes the
 * first note at the same position rather than dropping the input, which is
 * what a keyboard with note retrigger sends.
 */
export function startNote(
  held: HeldNote[],
  done: CapturedNote[],
  pitch: number,
  velocity: number,
  beat: number,
): void {
  const start = Math.max(0, beat);
  const existing = held.findIndex((note) => note.pitch === pitch);
  if (existing !== -1) endNote(held, done, pitch, start);
  held.push({ pitch, velocity: clampVelocity(velocity), start });
}

/**
 * Records a note-off. Returns false when the pitch was not held (a controller
 * that was already down when recording started), which the caller can ignore.
 */
export function endNote(held: HeldNote[], done: CapturedNote[], pitch: number, beat: number): boolean {
  const index = held.findIndex((note) => note.pitch === pitch);
  if (index === -1) return false;
  const [note] = held.splice(index, 1);
  done.push({
    pitch: note.pitch,
    velocity: note.velocity,
    start: note.start,
    duration: Math.max(MIN_NOTE_BEATS, beat - note.start),
  });
  return true;
}

/** Closes every held note, for the moment recording stops. */
export function endAllNotes(held: HeldNote[], done: CapturedNote[], beat: number): number {
  let closed = 0;
  while (held.length > 0) {
    const note = held[0];
    // A note whose start is past the stop position keeps a minimum length
    // instead of collapsing to zero.
    const end = Math.max(note.start + MIN_NOTE_BEATS, beat);
    if (endNote(held, done, note.pitch, end)) closed++;
  }
  return closed;
}

export interface PlacedPass {
  clipId: string;
  /** notes written, including those that joined an existing clip */
  added: number;
  /** true when the pass was overdubbed into a clip that already existed */
  merged: boolean;
}

/**
 * Puts a finished pass on a track.
 *
 * A clip already covering the pass start is overdubbed — the notes are added to
 * it and its length grows if the pass runs past the old end — which is Live's
 * MIDI Arrangement Overdub. Anything else creates a new clip starting on the
 * recorded position and rounded up to whole bars.
 *
 * Mutates the project, so call it inside one `store.edit`.
 */
export function placeMidiPass(
  project: Project,
  trackId: string,
  passStart: number,
  captured: readonly CapturedNote[],
): PlacedPass | null {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (!track || captured.length === 0) return null;

  const absolute = captured
    .map((note) => ({
      pitch: Math.max(0, Math.min(127, Math.round(note.pitch))),
      velocity: clampVelocity(note.velocity),
      start: passStart + Math.max(0, note.start),
      duration: Math.max(MIN_NOTE_BEATS, note.duration),
    }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const first = absolute[0].start;
  const last = absolute.reduce((end, note) => Math.max(end, note.start + note.duration), first);

  // A clip containing the pass start is the one being recorded over. Matching
  // on the start rather than any overlap stops a pass near a clip's edge from
  // silently extending that clip instead of making its own.
  const existing = project.clips.find(
    (clip) =>
      clip.trackId === trackId &&
      clip.kind === 'midi' &&
      clip.start <= passStart + 1e-6 &&
      clip.start + clip.length > passStart + 1e-6,
  );

  if (existing) {
    for (const note of absolute) {
      const local: Note = {
        id: uid('n'),
        pitch: note.pitch,
        start: Math.max(0, note.start - existing.start),
        duration: note.duration,
        velocity: note.velocity,
      };
      existing.notes.push(local);
    }
    existing.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    existing.length = Math.max(existing.length, last - existing.start);
    return { clipId: existing.id, added: absolute.length, merged: true };
  }

  const bars = project.beatsPerBar > 0 ? project.beatsPerBar : 4;
  const length = Math.max(bars, Math.ceil((last - passStart) / bars) * bars);
  const take = project.clips.filter((clip) => clip.trackId === trackId).length + 1;

  const clip: Clip = {
    id: uid('clip'),
    trackId,
    name: `${track.name} Rec ${take}`,
    kind: 'midi',
    start: passStart,
    length,
    color: track.color,
    notes: absolute.map((note) => ({
      id: uid('n'),
      pitch: note.pitch,
      start: note.start - passStart,
      duration: note.duration,
      velocity: note.velocity,
    })),
    offset: 0,
    gain: 1,
  };

  project.clips.push(clip);
  return { clipId: clip.id, added: absolute.length, merged: false };
}
