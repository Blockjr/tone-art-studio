import type { TrackKind } from './types';

/**
 * Where a drag lands.
 *
 * Both the arrangement and the mixer drop onto fixed rows, so the geometry is
 * plain arithmetic — which is why it lives here, free of the DOM, and is
 * checked directly. The clamp matters: a pointer dragged past the last track or
 * above the first must still resolve to a real row, or the drop would silently
 * do nothing at the edges of the list.
 */

/** Row index for a pointer at `y` inside a list of equally tall rows. */
export function trackIndexAtY(y: number, rowHeight: number, trackCount: number): number {
  if (trackCount <= 0 || rowHeight <= 0) return -1;
  const index = Math.floor(y / rowHeight);
  if (!Number.isFinite(index)) return -1;
  return Math.max(0, Math.min(trackCount - 1, index));
}

/**
 * Whether a clip may move to a track of this kind.
 *
 * Audio needs an audio lane (it has a file to play) and MIDI needs a MIDI lane
 * (it needs an instrument), so a mismatched drop is refused rather than
 * producing a clip that would never make a sound.
 */
export function canDropClipOn(target: TrackKind, clip: TrackKind): boolean {
  return target === clip;
}
