/**
 * Workspace layout: the three resizable regions of the studio window.
 *
 * The numbers are plain pixels and every path into this module is clamped
 * against the current viewport, so a window that is dragged to a smaller screen
 * (or a laptop that loses an external monitor) can never restore a layout that
 * pushes the arrangement off-screen.
 */

export interface LayoutState {
  /** browser panel width on the left */
  browserWidth: number;
  /** device rack width on the right */
  rackWidth: number;
  /** mixer height at the bottom */
  mixerHeight: number;
  mixerCollapsed: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

export const LAYOUT_LIMITS = {
  browserMin: 170,
  browserMax: 380,
  rackMin: 250,
  rackMax: 540,
  mixerMin: 200,
  mixerMax: 620,
  /** the arrangement keeps at least this much width, if the window allows it */
  arrangeMin: 360,
} as const;

export const DEFAULT_LAYOUT: LayoutState = {
  browserWidth: 240,
  rackWidth: 340,
  mixerHeight: 520,
  mixerCollapsed: false,
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Fits any stored or preset layout to the window it is about to open in. */
export function clampLayout(layout: Partial<LayoutState>, viewport: Viewport): LayoutState {
  const width = Math.max(320, viewport.width);
  const height = Math.max(320, viewport.height);

  let browserWidth = clampNumber(
    finite(layout.browserWidth, DEFAULT_LAYOUT.browserWidth),
    LAYOUT_LIMITS.browserMin,
    LAYOUT_LIMITS.browserMax,
  );
  let rackWidth = clampNumber(
    finite(layout.rackWidth, DEFAULT_LAYOUT.rackWidth),
    LAYOUT_LIMITS.rackMin,
    LAYOUT_LIMITS.rackMax,
  );

  // Give the arrangement its minimum before shrinking the side panels.
  const overflow = browserWidth + rackWidth + 10 + LAYOUT_LIMITS.arrangeMin - width;
  if (overflow > 0) {
    const browserRoom = browserWidth - LAYOUT_LIMITS.browserMin;
    const rackRoom = rackWidth - LAYOUT_LIMITS.rackMin;
    const total = browserRoom + rackRoom;
    if (total > 0) {
      const takeBrowser = Math.round(overflow * (browserRoom / total));
      const takeRack = overflow - takeBrowser;
      browserWidth -= Math.min(browserRoom, Math.max(0, takeBrowser));
      rackWidth -= Math.min(rackRoom, Math.max(0, takeRack));
    } else {
      browserWidth = Math.max(LAYOUT_LIMITS.browserMin, browserWidth - overflow);
    }
  }

  // Leave room for the top bar, the transport row and a usable arrangement.
  const mixerCeiling = Math.max(LAYOUT_LIMITS.mixerMin, height - 420);
  const mixerHeight = clampNumber(
    finite(layout.mixerHeight, DEFAULT_LAYOUT.mixerHeight),
    LAYOUT_LIMITS.mixerMin,
    Math.min(LAYOUT_LIMITS.mixerMax, mixerCeiling),
  );

  return {
    browserWidth,
    rackWidth,
    mixerHeight,
    mixerCollapsed: Boolean(layout.mixerCollapsed),
  };
}

export type LayoutPreset = 'default' | 'arrange' | 'mix' | 'master';

export const LAYOUT_PRESETS: { id: LayoutPreset; label: string; detail: string }[] = [
  { id: 'default', label: 'Studio', detail: 'Browser, rack and console at their balanced sizes' },
  { id: 'arrange', label: 'Arrangement', detail: 'Hide the console, widen the timeline' },
  { id: 'mix', label: 'Mix', detail: 'Tall console, compact browser and rack' },
  { id: 'master', label: 'Mastering', detail: 'Wide rack for the master chain and AI insert' },
];

/** One click layouts, still clamped to the current window. */
export function layoutPreset(preset: LayoutPreset, viewport: Viewport): LayoutState {
  const base: LayoutState = { ...DEFAULT_LAYOUT };
  switch (preset) {
    case 'arrange':
      return clampLayout({ ...base, mixerCollapsed: true, browserWidth: 230, rackWidth: 300 }, viewport);
    case 'mix':
      return clampLayout({ ...base, mixerHeight: 600, browserWidth: 200, rackWidth: 290 }, viewport);
    case 'master':
      return clampLayout({ ...base, mixerHeight: 430, browserWidth: 200, rackWidth: 500 }, viewport);
    case 'default':
    default:
      return clampLayout(base, viewport);
  }
}

/**
 * A layout chosen from the window itself: side panels take a share of the
 * width, the console a share of the height, and everything is clamped. This is
 * what "Fit to window" applies, so the same command feels right on a 13" laptop
 * and on a 4K monitor.
 */
export function fittedLayout(viewport: Viewport): LayoutState {
  const width = Math.max(320, viewport.width);
  const height = Math.max(320, viewport.height);
  return clampLayout(
    {
      browserWidth: Math.round(Math.max(200, width * 0.17)),
      rackWidth: Math.round(Math.max(280, width * 0.22)),
      mixerHeight: Math.round(Math.max(240, height * 0.42)),
      mixerCollapsed: height < 700,
    },
    { width, height },
  );
}

/** True when two layouts differ in anything the workspace cares about. */
export function sameLayout(a: LayoutState, b: LayoutState): boolean {
  return (
    a.browserWidth === b.browserWidth &&
    a.rackWidth === b.rackWidth &&
    a.mixerHeight === b.mixerHeight &&
    a.mixerCollapsed === b.mixerCollapsed
  );
}

/** Last-resort validation for layout values read back from localStorage. */
export function readLayout(value: unknown): LayoutState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LayoutState>;
  if (typeof candidate.browserWidth !== 'number' || typeof candidate.rackWidth !== 'number') return null;
  return {
    browserWidth: candidate.browserWidth,
    rackWidth: candidate.rackWidth,
    mixerHeight: finite(candidate.mixerHeight, DEFAULT_LAYOUT.mixerHeight),
    mixerCollapsed: Boolean(candidate.mixerCollapsed),
  };
}
