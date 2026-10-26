/**
 * Geometry for the arrangement scroll rail.
 *
 * The timeline paints a window into the project instead of scrolling a DOM
 * element, so the rail is the visible, draggable stand-in for `scrollX`. The
 * maths lives here, away from the canvas, so it can be checked directly.
 */

export interface ScrollRailMetrics {
  /** Draggable thumb width in pixels. */
  thumbWidth: number;
  /** Thumb offset from the left edge of the rail. */
  thumbLeft: number;
  /** Largest scroll offset the content allows, in pixels. */
  maxScroll: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Returns null when the whole timeline fits, so the rail can stay hidden.
 * `scroll` is the current offset in pixels; the thumb is clamped into range.
 */
export function scrollRailMetrics(view: number, content: number, scroll: number): ScrollRailMetrics | null {
  if (!Number.isFinite(view) || !Number.isFinite(content) || view <= 0) return null;
  if (content <= view + 0.5) return null;
  const maxScroll = content - view;
  const thumbWidth = Math.max(24, Math.min(view, (view / content) * view));
  const safeScroll = Number.isFinite(scroll) ? clamp(scroll, 0, maxScroll) : 0;
  const thumbLeft = (safeScroll / maxScroll) * (view - thumbWidth);
  return { thumbWidth, thumbLeft, maxScroll };
}

/**
 * Beats to scroll for a pointer on the rail. `pointerX` is relative to the
 * left edge of the rail and `pointerOffset` places the thumb under the cursor.
 */
export function scrollBeatFromRail(
  pointerX: number,
  railWidth: number,
  thumbWidth: number,
  maxScroll: number,
  zoom: number,
  pointerOffset = 0,
): number {
  const usable = railWidth - thumbWidth;
  if (usable <= 0 || zoom <= 0 || maxScroll <= 0) return 0;
  const x = clamp(pointerX - pointerOffset, 0, usable);
  return (x / usable) * (maxScroll / zoom);
}
