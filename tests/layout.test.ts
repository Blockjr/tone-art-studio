import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  clampLayout,
  fittedLayout,
  layoutPreset,
  readLayout,
  sameLayout,
} from '../src/core/layout';

describe('workspace layout', () => {
  it('keeps panels inside their limits on a large screen', () => {
    const layout = clampLayout({ browserWidth: 9999, rackWidth: -50, mixerHeight: 9999 }, { width: 2560, height: 1440 });
    expect(layout.browserWidth).toBe(LAYOUT_LIMITS.browserMax);
    expect(layout.rackWidth).toBe(LAYOUT_LIMITS.rackMin);
    expect(layout.mixerHeight).toBeLessThanOrEqual(LAYOUT_LIMITS.mixerMax);
  });

  it('gives the arrangement room on a small laptop', () => {
    const layout = clampLayout({ browserWidth: 380, rackWidth: 540, mixerHeight: 600 }, { width: 1024, height: 700 });
    const used = layout.browserWidth + layout.rackWidth;
    expect(used + LAYOUT_LIMITS.arrangeMin).toBeLessThanOrEqual(1024);
    expect(layout.mixerHeight).toBeLessThanOrEqual(700 - 420);
  });

  it('never returns a mixer shorter than its minimum', () => {
    const layout = clampLayout({ mixerHeight: 500 }, { width: 800, height: 500 });
    expect(layout.mixerHeight).toBe(LAYOUT_LIMITS.mixerMin);
  });

  it('falls back to defaults for missing or broken numbers', () => {
    const layout = clampLayout({ browserWidth: Number.NaN } as never, { width: 1440, height: 900 });
    expect(layout.browserWidth).toBe(DEFAULT_LAYOUT.browserWidth);
    expect(layout.rackWidth).toBe(DEFAULT_LAYOUT.rackWidth);
    expect(layout.mixerCollapsed).toBe(false);
  });

  it('applies presets within the current window', () => {
    const big = { width: 1600, height: 1080 };
    const arrange = layoutPreset('arrange', big);
    expect(arrange.mixerCollapsed).toBe(true);

    const mix = layoutPreset('mix', big);
    expect(mix.mixerHeight).toBeGreaterThan(arrange.mixerHeight);
    expect(mix.mixerCollapsed).toBe(false);

    const master = layoutPreset('master', big);
    expect(master.rackWidth).toBeGreaterThan(mix.rackWidth);

    const studio = layoutPreset('default', big);
    expect(studio).toEqual(clampLayout(DEFAULT_LAYOUT, big));
  });

  it('fits the same presets into a small window without spilling', () => {
    const small = { width: 1024, height: 700 };
    for (const preset of ['default', 'arrange', 'mix', 'master'] as const) {
      const layout = layoutPreset(preset, small);
      expect(layout.browserWidth + layout.rackWidth + LAYOUT_LIMITS.arrangeMin).toBeLessThanOrEqual(small.width);
      expect(layout.mixerHeight).toBeLessThanOrEqual(small.height - 420);
    }
  });

  it('fits panels to the window instead of only clamping the old sizes', () => {
    const laptop = fittedLayout({ width: 1440, height: 900 });
    expect(laptop.browserWidth).toBeGreaterThanOrEqual(200);
    expect(laptop.rackWidth).toBeGreaterThanOrEqual(280);
    expect(laptop.mixerCollapsed).toBe(false);

    const uhd = fittedLayout({ width: 3840, height: 2160 });
    expect(uhd.browserWidth).toBeGreaterThan(laptop.browserWidth);
    expect(uhd.rackWidth).toBeGreaterThan(laptop.rackWidth);
    expect(uhd.mixerHeight).toBeGreaterThan(laptop.mixerHeight);
    expect(uhd.browserWidth + uhd.rackWidth + LAYOUT_LIMITS.arrangeMin).toBeLessThanOrEqual(3840);

    const short = fittedLayout({ width: 1024, height: 600 });
    expect(short.mixerCollapsed).toBe(true);
    expect(short.browserWidth + short.rackWidth + LAYOUT_LIMITS.arrangeMin).toBeLessThanOrEqual(1024);
  });

  it('compares layouts field by field', () => {
    expect(sameLayout(DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT })).toBe(true);
    expect(sameLayout(DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT, mixerCollapsed: true })).toBe(false);
  });

  it('rejects stored values that are not a layout', () => {
    expect(readLayout(null)).toBeNull();
    expect(readLayout('nope')).toBeNull();
    expect(readLayout({ browserWidth: 240 })).toBeNull();
    expect(readLayout({ browserWidth: 240, rackWidth: 340 })).toEqual({
      browserWidth: 240,
      rackWidth: 340,
      mixerHeight: DEFAULT_LAYOUT.mixerHeight,
      mixerCollapsed: false,
    });
  });
});
