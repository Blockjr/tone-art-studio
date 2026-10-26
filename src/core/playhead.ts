/**
 * Playhead navigation maths.
 *
 * The arrangement keeps the playhead on screen by moving the horizontal
 * scroll origin. Keeping that decision here, away from the canvas, makes it
 * testable and keeps the timeline free of layout special cases.
 */

import type { Marker } from './types';
import { uid } from './time';

export type FollowMode = 'page' | 'continuous' | 'center' | 'off';

/** Marker colours, cycled as locators are added. */
export const MARKER_COLORS = ['#f5a524', '#4d8dff', '#22c98a', '#a78bfa', '#38bdf8', '#f43f5e'];

/**
 * Reads markers from a saved project and drops anything malformed. Older
 * documents have no marker list at all, so this also fills that gap.
 */
export function normalizeMarkers(value: unknown, length = Infinity): Marker[] {
  if (!Array.isArray(value)) return [];
  const limit = Number.isFinite(length) && length > 0 ? length : Infinity;
  const seen = new Set<string>();
  const markers: Marker[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<Marker>;
    if (typeof candidate.beat !== 'number' || !Number.isFinite(candidate.beat)) continue;
    const id = typeof candidate.id === 'string' && candidate.id && !seen.has(candidate.id) ? candidate.id : uid('marker');
    seen.add(id);
    const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 48) : '';
    const color = typeof candidate.color === 'string' && candidate.color ? candidate.color : MARKER_COLORS[markers.length % MARKER_COLORS.length];
    markers.push({
      id,
      name,
      beat: Math.min(limit, Math.max(0, candidate.beat)),
      color,
    });
  }

  return sortMarkers(markers).map((marker, index) => ({
    ...marker,
    name: marker.name || `Marker ${index + 1}`,
  }));
}

/** A new numbered marker, ready to insert at the playhead. */
export function createMarker(markers: Marker[], beat: number, name?: string): Marker {
  return {
    id: uid('marker'),
    name: name?.trim().slice(0, 48) || `Marker ${markers.length + 1}`,
    beat: Math.max(0, beat),
    color: MARKER_COLORS[markers.length % MARKER_COLORS.length],
  };
}

export function sortMarkers(markers: Marker[]): Marker[] {
  return [...markers].sort((a, b) => a.beat - b.beat || a.id.localeCompare(b.id));
}

/** Closest marker to a beat, if it is within the tolerance. */
export function markerNear(markers: Marker[], beat: number, tolerance: number): Marker | null {
  let best: Marker | null = null;
  let bestDistance = tolerance;
  for (const marker of markers) {
    const distance = Math.abs(marker.beat - beat);
    if (distance <= bestDistance) {
      best = marker;
      bestDistance = distance;
    }
  }
  return best;
}

/** First marker strictly after `beat`, for the next-locator command. */
export function nextMarker(markers: Marker[], beat: number): Marker | null {
  return sortMarkers(markers).find((marker) => marker.beat > beat + 1e-4) ?? null;
}

/** Last marker strictly before `beat`, for the previous-locator command. */
export function previousMarker(markers: Marker[], beat: number): Marker | null {
  return [...sortMarkers(markers)].reverse().find((marker) => marker.beat < beat - 1e-4) ?? null;
}

export interface FollowModeInfo {
  id: FollowMode;
  label: string;
  detail: string;
}

export const FOLLOW_MODES: FollowModeInfo[] = [
  { id: 'page', label: 'Page', detail: 'Jump a page when the playhead reaches the right edge' },
  { id: 'continuous', label: 'Scroll', detail: 'Keep scrolling once the playhead passes the middle' },
  { id: 'center', label: 'Center', detail: 'Lock the playhead to the centre of the arrangement' },
  { id: 'off', label: 'Off', detail: 'Leave the view where you put it' },
];

export function normalizeFollow(value: unknown): FollowMode {
  return value === 'continuous' || value === 'center' || value === 'off' || value === 'page' ? value : 'page';
}

/** Cycles Page → Scroll → Center → Off, which is the order of the toolbar menu. */
export function nextFollowMode(mode: FollowMode): FollowMode {
  const index = FOLLOW_MODES.findIndex((entry) => entry.id === mode);
  return FOLLOW_MODES[(index + 1) % FOLLOW_MODES.length].id;
}

/**
 * Returns the scroll origin (in beats) that keeps `beat` visible under the
 * chosen follow mode. `scrollX` is the leftmost visible beat and
 * `visibleBeats` is how much of the song the viewport currently shows.
 */
export function followScroll(
  scrollX: number,
  beat: number,
  visibleBeats: number,
  mode: FollowMode,
): number {
  const safeScroll = Math.max(0, scrollX);
  const visible = Math.max(0.001, visibleBeats);
  if (mode === 'off') return safeScroll;

  if (mode === 'center') return Math.max(0, beat - visible / 2);

  if (mode === 'continuous') {
    if (beat > safeScroll + visible * 0.62) return Math.max(0, beat - visible * 0.62);
    if (beat < safeScroll) return Math.max(0, beat - visible * 0.15);
    return safeScroll;
  }

  // Page: move only when the playhead would leave the view.
  if (beat > safeScroll + visible * 0.85 || beat < safeScroll) {
    return Math.max(0, beat - visible * 0.15);
  }
  return safeScroll;
}

/** A keyboard nudge, clamped to the project length. */
export function nudgeBeat(position: number, delta: number, length: number): number {
  return Math.min(Math.max(0, length), Math.max(0, position + delta));
}

/** Grid step for an arrow-key nudge; snap Off still moves by a 16th. */
export function playheadStep(snap: number, beatsPerBar: number, bar: boolean): number {
  if (bar) return Math.max(1, beatsPerBar);
  return snap > 0 ? snap : 0.25;
}
