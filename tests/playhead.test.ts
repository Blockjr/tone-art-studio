import { describe, expect, it } from 'vitest';
import {
  FOLLOW_MODES,
  MARKER_COLORS,
  createMarker,
  followScroll,
  markerNear,
  nextFollowMode,
  nextMarker,
  normalizeFollow,
  normalizeMarkers,
  nudgeBeat,
  playheadStep,
  previousMarker,
  sortMarkers,
} from '../src/core/playhead';

describe('playhead follow modes', () => {
  it('leaves the view alone when follow is off', () => {
    expect(followScroll(12, 80, 32, 'off')).toBe(12);
  });

  it('pages only when the playhead would leave the view', () => {
    expect(followScroll(0, 10, 32, 'page')).toBe(0);
    expect(followScroll(0, 30, 32, 'page')).toBeCloseTo(25.2);
    expect(followScroll(20, 15, 32, 'page')).toBeCloseTo(10.2);
  });

  it('keeps scrolling once the playhead passes the middle', () => {
    expect(followScroll(0, 10, 32, 'continuous')).toBe(0);
    expect(followScroll(0, 25, 32, 'continuous')).toBeCloseTo(5.16);
    expect(followScroll(40, 50, 32, 'continuous')).toBe(40);
    expect(followScroll(40, 65, 32, 'continuous')).toBeCloseTo(45.16);
  });

  it('centres the playhead and clamps the start of the song', () => {
    expect(followScroll(100, 2, 32, 'center')).toBe(0);
    expect(followScroll(0, 50, 32, 'center')).toBe(34);
  });

  it('cycles and validates modes', () => {
    expect(normalizeFollow('scroll')).toBe('page');
    expect(normalizeFollow(undefined)).toBe('page');
    expect(normalizeFollow('off')).toBe('off');

    let mode = FOLLOW_MODES[0].id;
    const seen = [mode];
    for (let i = 0; i < FOLLOW_MODES.length; i += 1) {
      mode = nextFollowMode(mode);
      seen.push(mode);
    }
    expect(new Set(seen)).toEqual(new Set([...FOLLOW_MODES.map((entry) => entry.id), FOLLOW_MODES[0].id]));
  });
});

describe('markers and locators', () => {
  it('reads valid locators and repairs a legacy or malformed list', () => {
    const markers = normalizeMarkers(
      [
        { id: 'b', name: ' Chorus ', beat: 18, color: '#fff' },
        { id: 'a', name: '', beat: -4 },
        { id: 'b', name: 'Duplicate id', beat: 8 },
        { beat: 'nope' },
        null,
      ],
      16,
    );

    expect(markers).toHaveLength(3);
    expect(markers.map((marker) => marker.name)).toEqual(['Marker 1', 'Duplicate id', 'Chorus']);
    expect(markers[0].beat).toBe(0);
    expect(markers[2].beat).toBe(16);
    expect(MARKER_COLORS).toContain(markers[0].color);
    expect(new Set(markers.map((marker) => marker.id)).size).toBe(3);
    expect(normalizeMarkers(undefined)).toEqual([]);
  });

  it('finds the nearest marker and steps strictly forward or back', () => {
    const markers = normalizeMarkers([
      { id: 'one', name: 'One', beat: 4, color: '#111' },
      { id: 'two', name: 'Two', beat: 8, color: '#222' },
      { id: 'three', name: 'Three', beat: 16, color: '#333' },
    ]);

    expect(markerNear(markers, 7.9, 0.2)?.id).toBe('two');
    expect(markerNear(markers, 6, 0.2)).toBeNull();
    expect(previousMarker(markers, 8)?.id).toBe('one');
    expect(nextMarker(markers, 8)?.id).toBe('three');
    expect(previousMarker(markers, 4)).toBeNull();
    expect(nextMarker(markers, 16)).toBeNull();
  });

  it('creates coloured, numbered markers and keeps the list ordered', () => {
    const first = createMarker([], 12);
    const second = createMarker([first], 2, 'Intro');
    const ordered = sortMarkers([first, second]);

    expect(first.name).toBe('Marker 1');
    expect(second.name).toBe('Intro');
    expect(second.color).toBe(MARKER_COLORS[1]);
    expect(ordered.map((marker) => marker.beat)).toEqual([2, 12]);
    expect(ordered[0]).toBe(second);
  });
});

describe('playhead nudging', () => {
  it('uses the snap grid, falls back to a sixteenth, and clamps', () => {
    expect(playheadStep(0.25, 4, false)).toBe(0.25);
    expect(playheadStep(0, 4, false)).toBe(0.25);
    expect(playheadStep(0.5, 4, true)).toBe(4);
    expect(nudgeBeat(0, -4, 32)).toBe(0);
    expect(nudgeBeat(30, 8, 32)).toBe(32);
    expect(nudgeBeat(8, 4, 32)).toBe(12);
  });
});
