import type { Clip, Project, Take, Track } from './types';
import { uid } from './time';

/**
 * Recorded passes ("takes") live next to the arrangement, not in it.
 *
 * Every pass keeps its own audio asset and the beat range it was recorded over.
 * Comping writes an ordinary audio clip into the arrangement that reads a slice
 * of one take, so playback, export, bounce and the mixer need no special case;
 * the takes stay available for the next decision.
 */

export interface TakeRange {
  start: number;
  end: number;
}

export function normalizeTakes(value: unknown, tracks: Pick<Track, 'id'>[]): Take[] {
  const valid = new Set(tracks.map((track) => track.id));
  const seen = new Set<string>();
  if (!Array.isArray(value)) return [];

  const takes: Take[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<Take>;
    const trackId = typeof candidate.trackId === 'string' ? candidate.trackId : '';
    const assetId = typeof candidate.assetId === 'string' ? candidate.assetId : '';
    const start = Number(candidate.start);
    const length = Number(candidate.length);

    if (!valid.has(trackId) || !assetId) continue;
    if (!Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(length) || length <= 0) continue;

    let id = typeof candidate.id === 'string' && candidate.id ? candidate.id : uid('take');
    while (seen.has(id)) id = uid('take');
    seen.add(id);

    const offset = Number(candidate.offset);
    const gain = Number(candidate.gain);
    const pass = Math.round(Number(candidate.pass));

    takes.push({
      id,
      trackId,
      assetId,
      name: typeof candidate.name === 'string' && candidate.name ? candidate.name : 'Take',
      start,
      length,
      offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
      gain: Number.isFinite(gain) && gain > 0 ? gain : 1,
      pass: Number.isFinite(pass) && pass > 0 ? pass : 1,
      createdAt: Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : Date.now(),
    });
  }

  return takes;
}

export function takesForTrack(project: Pick<Project, 'takes'>, trackId: string): Take[] {
  return project.takes
    .filter((take) => take.trackId === trackId)
    .slice()
    .sort((a, b) => a.pass - b.pass || a.start - b.start);
}

export function takeEnd(take: Pick<Take, 'start' | 'length'>): number {
  return take.start + take.length;
}

/** The part of a take a selection covers, or null when they do not meet. */
export function takeOverlap(take: Take, range: TakeRange | null): TakeRange | null {
  const start = range ? Math.max(take.start, range.start) : take.start;
  const end = range ? Math.min(takeEnd(take), range.end) : takeEnd(take);
  if (end - start <= 0.001) return null;
  return { start, end };
}

export function takeName(track: Track, pass: number): string {
  return `${track.name} · Take ${pass}`;
}

/**
 * Builds the clip that plays one take over a beat range. The asset is shared,
 * so a comp costs a clip rather than a copy of the audio.
 */
export function clipFromTake(take: Take, track: Track, bpm: number, range: TakeRange): Clip {
  const secondsPerBeat = 60 / Math.max(1, bpm);
  return {
    id: uid('clip'),
    trackId: take.trackId,
    name: `${track.name} · Comp`,
    kind: 'audio',
    start: range.start,
    length: Math.max(0.01, range.end - range.start),
    color: track.color,
    notes: [],
    assetId: take.assetId,
    offset: Math.max(0, take.offset + (range.start - take.start) * secondsPerBeat),
    gain: take.gain,
    fadeIn: 0.008,
    fadeOut: 0.008,
  };
}

/**
 * Places a comp clip over `[from, to)` on one track: clips fully covered are
 * replaced, clips crossing an edge are trimmed, and a clip spanning the whole
 * range is split into the material before and after it. Everything else on the
 * track is left untouched, so comping one section never disturbs another.
 */
export function compOverRange(
  clips: Clip[],
  trackId: string,
  from: number,
  to: number,
  replacement: Clip,
  bpm: number,
): Clip[] {
  const secondsPerBeat = 60 / Math.max(1, bpm);
  const result: Clip[] = [];
  const low = Math.min(from, to);
  const high = Math.max(from, to);

  for (const clip of clips) {
    if (clip.trackId !== trackId) {
      result.push(clip);
      continue;
    }

    const start = clip.start;
    const end = clip.start + clip.length;

    if (end <= low || start >= high) {
      result.push(clip);
      continue;
    }

    if (start < low) {
      // Material before the comp: keep it, trimmed to the boundary.
      result.push({ ...clip, id: clip.id, length: low - start });
    }

    if (end > high) {
      // Material after the comp: keep it and move its read offset forward.
      result.push({
        ...clip,
        id: start < low ? uid('clip') : clip.id,
        start: high,
        length: end - high,
        offset: clip.offset + (high - start) * secondsPerBeat,
      });
    }
    // The covered middle is dropped.
  }

  result.push(replacement);
  return result.sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));
}
