import { describe, expect, it } from 'vitest';
import { canDropClipOn, trackIndexAtY } from '../src/core/dragdrop';

/**
 * Where a drag lands, and what may be dropped there.
 *
 * These two answers are what make dragging a clip onto another track work
 * instead of quietly doing nothing, so they are checked directly rather than
 * through a canvas.
 */

const ROW = 84;

describe('trackIndexAtY', () => {
  it('maps a pointer inside a row to that row', () => {
    expect(trackIndexAtY(0, ROW, 4)).toBe(0);
    expect(trackIndexAtY(ROW - 1, ROW, 4)).toBe(0);
    expect(trackIndexAtY(ROW, ROW, 4)).toBe(1);
    expect(trackIndexAtY(ROW * 2 + 10, ROW, 4)).toBe(2);
  });

  it('clamps at both ends instead of losing the drop', () => {
    // Dragged above the first track: it belongs to the first, not to nothing.
    expect(trackIndexAtY(-60, ROW, 4)).toBe(0);
    // Dragged past the last track: the last one takes it.
    expect(trackIndexAtY(ROW * 9, ROW, 4)).toBe(3);
  });

  it('returns -1 when there is nothing to drop on', () => {
    expect(trackIndexAtY(100, ROW, 0)).toBe(-1);
    expect(trackIndexAtY(100, 0, 4)).toBe(-1);
    expect(trackIndexAtY(Number.NaN, ROW, 4)).toBe(-1);
  });
});

describe('canDropClipOn', () => {
  it('lets a clip move between tracks of the same kind', () => {
    expect(canDropClipOn('audio', 'audio')).toBe(true);
    expect(canDropClipOn('midi', 'midi')).toBe(true);
  });

  it('refuses a mismatched lane', () => {
    // An audio clip on a MIDI lane has no instrument to play it, and a MIDI
    // clip on an audio lane has no file: both would be silent.
    expect(canDropClipOn('midi', 'audio')).toBe(false);
    expect(canDropClipOn('audio', 'midi')).toBe(false);
  });
});
