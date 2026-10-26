import { describe, expect, it } from 'vitest';
import { clipWarpLabel, planSliceQuantize } from '../src/audio/clipedits';

const base = {
  start: 0,
  length: 4,
  offset: 0,
  bpm: 120,
  snap: 0.25,
  onsets: [] as number[],
};

describe('slice-and-quantize planning', () => {
  it('does nothing without transients or a grid', () => {
    expect(planSliceQuantize({ ...base, onsets: [] })).toEqual([]);
    expect(planSliceQuantize({ ...base, snap: 0, onsets: [0.5, 1] })).toEqual([]);
  });

  it('keeps already-gridded onsets where they are', () => {
    const specs = planSliceQuantize({ ...base, onsets: [0.5, 1.0] });
    expect(specs).toHaveLength(3);
    expect(specs.map((spec) => spec.start)).toEqual([0, 1, 2]);
    expect(specs.map((spec) => spec.length)).toEqual([1, 1, 2]);
    expect(specs.map((spec) => spec.offset)).toEqual([0, 1, 2]);
    expect(specs.some((spec) => spec.stretch)).toBe(false);
  });

  it('pulls late onsets back to the nearest grid line and stretches the slice', () => {
    // 120 BPM: 0.56 s is 1.12 beats, which snaps back to 1 beat.
    const specs = planSliceQuantize({ ...base, onsets: [0.56] });
    expect(specs.map((spec) => spec.start)).toEqual([0, 1]);
    expect(specs[0].stretch).toBe(true);
    expect(specs[1].stretch).toBe(true);
    // The source offset follows the transient, not the snapped start.
    expect(specs[1].offset).toBeCloseTo(1.12, 2);
    expect(specs[0].length).toBeCloseTo(1, 5);
    expect(specs[1].length).toBeCloseTo(3, 5);
  });

  it('stacks onsets that collapse onto one grid line instead of overlapping', () => {
    const specs = planSliceQuantize({ ...base, onsets: [0.53, 1.03] });
    expect(specs.map((spec) => spec.start)).toEqual([0, 1, 2]);
    expect(specs.map((spec) => spec.length)).toEqual([1, 1, 2]);
  });

  it('never overlaps slices and stays inside the clip', () => {
    const specs = planSliceQuantize({
      ...base,
      start: 8,
      length: 4,
      offset: 4,
      onsets: [0.02, 0.31, 0.32, 0.6, 1.9, 1.95],
    });
    expect(specs.length).toBeGreaterThan(1);
    for (let index = 1; index < specs.length; index++) {
      expect(specs[index].start).toBeGreaterThanOrEqual(specs[index - 1].start + specs[index - 1].length - 1e-9);
    }
    expect(specs[0].start).toBe(8);
    expect((specs.at(-1)?.start ?? 0) + (specs.at(-1)?.length ?? 0)).toBeLessThanOrEqual(12 + 1e-9);
    expect(specs[0].offset).toBe(4);
  });
});

describe('warp labels', () => {
  it('describes stretch and pitch compactly', () => {
    expect(clipWarpLabel(undefined)).toBe('off');
    expect(clipWarpLabel({ stretch: true, semitones: 0 })).toBe('stretch');
    expect(clipWarpLabel({ stretch: true, semitones: -3 })).toBe('stretch · -3 st');
    expect(clipWarpLabel({ stretch: false, semitones: 5 })).toBe('+5 st');
  });
});
