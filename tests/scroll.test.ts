import { describe, expect, it } from 'vitest';
import { scrollBeatFromRail, scrollRailMetrics } from '../src/ui/scrollrail';

describe('arrangement scroll rail', () => {
  it('stays hidden while the whole project fits', () => {
    expect(scrollRailMetrics(600, 600, 0)).toBeNull();
    expect(scrollRailMetrics(600, 420, 0)).toBeNull();
    expect(scrollRailMetrics(600, 600.4, 0)).toBeNull();
    expect(scrollRailMetrics(0, 2400, 0)).toBeNull();
    expect(scrollRailMetrics(Number.NaN, 2400, 0)).toBeNull();
  });

  it('sizes the thumb from the visible share of the timeline', () => {
    const metrics = scrollRailMetrics(600, 2400, 0)!;
    expect(metrics.maxScroll).toBe(1800);
    expect(metrics.thumbWidth).toBeCloseTo(150);
    expect(metrics.thumbLeft).toBeCloseTo(0);
  });

  it('keeps a grabbable minimum thumb on a very long project', () => {
    const metrics = scrollRailMetrics(600, 60000, 0)!;
    expect(metrics.thumbWidth).toBe(24);
    expect(metrics.thumbLeft).toBe(0);
  });

  it('moves the thumb across the full rail and clamps both ends', () => {
    const view = 600;
    const content = 2400;
    const left = scrollRailMetrics(view, content, 0)!;
    const middle = scrollRailMetrics(view, content, 900)!;
    const right = scrollRailMetrics(view, content, 1800)!;

    expect(left.thumbLeft).toBeCloseTo(0);
    expect(middle.thumbLeft).toBeCloseTo((600 - left.thumbWidth) / 2);
    expect(right.thumbLeft).toBeCloseTo(600 - left.thumbWidth);

    // Past the ends, or nonsense, cannot drag the thumb off the rail.
    expect(scrollRailMetrics(view, content, -500)!.thumbLeft).toBeCloseTo(0);
    expect(scrollRailMetrics(view, content, 99999)!.thumbLeft).toBeCloseTo(right.thumbLeft);
    expect(scrollRailMetrics(view, content, Number.NaN)!.thumbLeft).toBeCloseTo(0);
  });

  it('turns a rail drag into a time offset', () => {
    const metrics = scrollRailMetrics(600, 2400, 0)!;
    const zoom = 40;

    // Grabbing the thumb itself: clicking its middle does not jump the view.
    expect(scrollBeatFromRail(metrics.thumbWidth / 2, 600, metrics.thumbWidth, metrics.maxScroll, zoom, metrics.thumbWidth / 2)).toBe(0);

    // Clicking the far end of the rail lands on the last beat in view.
    expect(scrollBeatFromRail(600, 600, metrics.thumbWidth, metrics.maxScroll, zoom, metrics.thumbWidth / 2)).toBeCloseTo(
      metrics.maxScroll / zoom,
    );

    // Halfway down the usable track is halfway through the project.
    const half = (600 - metrics.thumbWidth) / 2;
    expect(scrollBeatFromRail(half, 600, metrics.thumbWidth, metrics.maxScroll, zoom, 0)).toBeCloseTo(
      metrics.maxScroll / zoom / 2,
    );

    // Off the left edge never goes negative.
    expect(scrollBeatFromRail(-80, 600, metrics.thumbWidth, metrics.maxScroll, zoom, 0)).toBe(0);
  });

  it('falls back to the start when there is nothing to scroll', () => {
    expect(scrollBeatFromRail(200, 600, 600, 0, 40)).toBe(0);
    expect(scrollBeatFromRail(200, 600, 24, 500, 0)).toBe(0);
    expect(scrollBeatFromRail(200, 600, 700, 500, 40)).toBe(0);
  });
});
