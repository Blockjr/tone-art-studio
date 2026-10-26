import { clamp } from '../core/time';
import type { Clip } from '../core/types';

/** Default declick length applied to every audio clip boundary. */
export const AUTO_FADE_SECONDS = 0.012;
export const MAX_FADE_SECONDS = 8;

export interface FadeShape {
  /** seconds */
  in: number;
  /** seconds */
  out: number;
}

export interface FadePoint {
  /** absolute context time in seconds */
  time: number;
  gain: number;
}

function clampFade(value: number, clipSeconds: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return clamp(value, 0, Math.min(MAX_FADE_SECONDS, clipSeconds));
}

/**
 * Resolves the fades for one clip. A clip without explicit values gets the
 * short auto declick when `autoFade` is on, so starts and stops never click.
 */
export function resolveFades(
  clip: Pick<Clip, 'fadeIn' | 'fadeOut'>,
  autoFade: boolean,
  clipSeconds: number,
): FadeShape {
  const duration = Math.max(0, clipSeconds);
  const fallback = autoFade ? Math.min(AUTO_FADE_SECONDS, duration / 4) : 0;
  let fadeIn = clampFade(clip.fadeIn ?? fallback, duration);
  let fadeOut = clampFade(clip.fadeOut ?? fallback, duration);

  const total = fadeIn + fadeOut;

  if (total > duration && total > 0) {
    const scale = duration / total;
    fadeIn *= scale;
    fadeOut *= scale;
  }

  return { in: fadeIn, out: fadeOut };
}

/**
 * Linear fade breakpoints for one playback of a clip, in absolute audio time.
 * Always starts and ends at silence, so the surrounding gain stays click-free.
 */
export function fadeEnvelope(at: number, duration: number, shape: FadeShape, level = 1): FadePoint[] {
  const length = Math.max(0, duration);
  const peak = clamp(level, 0, 4);
  const fadeIn = clamp(shape.in, 0, length);
  const fadeOut = clamp(shape.out, 0, length - fadeIn);
  const points: FadePoint[] = [{ time: at, gain: fadeIn > 0 ? 0 : peak }];

  if (fadeIn > 0) points.push({ time: at + fadeIn, gain: peak });
  points.push({ time: at + length - fadeOut, gain: peak });

  if (fadeOut > 0) points.push({ time: at + length, gain: 0 });

  return points;
}

/** Schedules a fade envelope on a Web Audio gain parameter. */
export function applyFadeEnvelope(
  param: AudioParam,
  points: FadePoint[],
  when: number,
): void {
  const first = points[0];
  if (!first) return;

  param.cancelScheduledValues(when);
  param.setValueAtTime(first.gain, first.time);

  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    if (point.time <= points[i - 1].time) {
      param.setValueAtTime(point.gain, point.time);
    } else {
      param.linearRampToValueAtTime(point.gain, point.time);
    }
  }
}
