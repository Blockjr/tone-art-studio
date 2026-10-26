import type { Store } from '../core/store';
import type { Clip, ClipWarp } from '../core/types';
import { clamp, uid } from '../core/time';
import { resolveClipAudio } from './clipsource';
import { detectOnsets } from './dsp';

/** Peak target for Normalize: −1 dBFS, leaving a little room for the limiter. */
export const NORMALIZE_CEILING = 0.891;

/** Highest absolute sample in the clip's audible source window. */
export function clipPeak(store: Pick<Store, 'project' | 'assetById'>, clip: Clip): number {
  if (clip.kind !== 'audio' || !clip.assetId) return 0;
  const asset = store.assetById(clip.assetId);
  if (!asset) return 0;
  const sampleRate = asset.buffer.sampleRate;
  const secondsPerBeat = 60 / store.project.bpm;
  const start = Math.max(0, Math.floor(clip.offset * secondsPerBeat * sampleRate));
  const window = Math.max(1, Math.min(clip.length * secondsPerBeat, asset.duration - clip.offset * secondsPerBeat));
  const end = Math.min(asset.buffer.length, start + Math.ceil(window * sampleRate));
  let peak = 0;

  for (let channel = 0; channel < asset.buffer.numberOfChannels; channel++) {
    const data = asset.buffer.getChannelData(channel);
    for (let i = start; i < end; i++) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
    }
  }

  return Math.min(1.5, peak);
}

/**
 * Sets clip gain so the loudest sample in the clip sits at −1 dBFS. It is
 * non-destructive: the audio is untouched, only `clip.gain` changes, and the
 * old value comes straight back with Ctrl+Z.
 */
export function normalizeClip(store: Store, clipId: string): number | null {
  const clip = store.project.clips.find((entry) => entry.id === clipId);
  if (!clip) return null;
  const peak = clipPeak(store, clip);
  if (peak < 1e-5) return null;
  const gain = clamp(NORMALIZE_CEILING / peak, 1 / 64, 16);
  store.edit('structure', (project) => {
    const target = project.clips.find((entry) => entry.id === clipId);
    if (target) target.gain = gain;
  });
  return gain;
}

/** Flips the clip's playback direction; the source file is never changed. */
export function toggleReverseClip(store: Store, clipId: string): boolean | null {
  const clip = store.project.clips.find((entry) => entry.id === clipId);
  if (!clip || clip.kind !== 'audio') return null;
  const next = !clip.reverse;
  store.edit('structure', (project) => {
    const target = project.clips.find((entry) => entry.id === clipId);
    if (target) target.reverse = next;
  });
  return next;
}

export function setClipGain(store: Store, clipId: string, gain: number, gesture = false): void {
  const mutate = (project: typeof store.project) => {
    const target = project.clips.find((entry) => entry.id === clipId);
    if (target) target.gain = clamp(gain, 1 / 64, 16);
  };
  if (gesture) {
    store.beginGesture();
    store.touch('params', mutate);
  } else {
    store.edit('structure', mutate);
  }
}

export function setClipPitch(store: Store, clipId: string, semitones: number, gesture = false): void {
  const value = clamp(Math.round(semitones), -12, 12);
  const mutate = (project: typeof store.project) => {
    const target = project.clips.find((entry) => entry.id === clipId);
    if (!target) return;
    target.warp = { stretch: target.warp?.stretch ?? false, semitones: value };
  };
  if (gesture) {
    store.beginGesture();
    store.touch('params', mutate);
  } else {
    store.edit('structure', mutate);
  }
}

export function setClipStretch(store: Store, clipId: string, stretch: boolean): void {
  store.edit('structure', (project) => {
    const target = project.clips.find((entry) => entry.id === clipId);
    if (!target) return;
    target.warp = { stretch, semitones: target.warp?.semitones ?? 0 };
  });
}

export function clipWarpLabel(warp: ClipWarp | undefined): string {
  if (!warp) return 'off';
  const parts: string[] = [];
  if (warp.stretch) parts.push('stretch');
  if (warp.semitones) parts.push(`${warp.semitones > 0 ? '+' : ''}${warp.semitones} st`);
  return parts.length ? parts.join(' · ') : 'off';
}

// --------------------------------------------------------------- slice + grid

export interface SliceQuantizeInput {
  /** clip start on the arrangement, in beats */
  start: number;
  /** clip length, in beats */
  length: number;
  /** source offset, in beats */
  offset: number;
  bpm: number;
  /** grid in beats; 0 = leave the onsets where they are */
  snap: number;
  /** onset times in seconds, measured from the clip's audible start */
  onsets: number[];
}

export interface SliceSpec {
  start: number;
  length: number;
  offset: number;
  /** the slice no longer fits its source, so it time-stretches to the grid */
  stretch: boolean;
}

/**
 * Plans a slice-and-quantize pass: cut at detected onsets, then move each cut
 * to the nearest grid line, time-stretching the audio inside each slice so the
 * original performance still fills it. Times are all in beats.
 */
export function planSliceQuantize(input: SliceQuantizeInput): SliceSpec[] {
  const secondsPerBeat = 60 / input.bpm;
  const clipSeconds = input.length * secondsPerBeat;
  const unique = [
    ...new Set(
      input.onsets
        .filter((time) => Number.isFinite(time) && time > 0.03 && time < clipSeconds - 0.03)
        .map((time) => Math.round(time * 1000) / 1000),
    ),
  ].sort((a, b) => a - b);

  if (!unique.length) return [];

  const snap = Math.max(0, input.snap);
  if (snap <= 0) return [];

  const minLength = Math.max(0.04 / secondsPerBeat, snap * 0.5);
  const boundaries = [0, ...unique, clipSeconds];
  const end = input.start + input.length;
  const starts: number[] = [];

  for (let index = 0; index < boundaries.length - 1; index++) {
    const local = boundaries[index] / secondsPerBeat;
    let beat = input.start + local;
    if (index > 0) {
      beat = Math.round(beat / snap) * snap;
      beat = Math.max(beat, (starts[index - 1] ?? input.start) + minLength);
      if (beat >= end - minLength) break;
    }
    starts.push(beat);
  }

  if (starts.length < 2) return [];

  const specs: SliceSpec[] = [];
  for (let index = 0; index < starts.length; index++) {
    const next = index + 1 < starts.length ? starts[index + 1] : end;
    const length = next - starts[index];
    if (length < 1e-4) continue;
    const sourceLocal = boundaries[index] / secondsPerBeat;
    const sourceLength = (boundaries[index + 1] - boundaries[index]) / secondsPerBeat;
    specs.push({
      start: starts[index],
      length,
      offset: input.offset + sourceLocal,
      stretch: Math.abs(length - sourceLength) > 0.001,
    });
  }

  return specs;
}

/**
 * Detects the transients in an audio clip, cuts it there and lands every cut on
 * the current grid. Returns the number of slices created (0 = no transients or
 * nothing to move).
 */
export async function quantizeAudioClip(store: Store, clipId: string, snap: number): Promise<number> {
  const clip = store.project.clips.find((entry) => entry.id === clipId);
  if (!clip || clip.kind !== 'audio' || !clip.assetId) return 0;
  if (!(snap > 0)) return 0;

  const secondsPerBeat = 60 / store.project.bpm;
  const audio = resolveClipAudio(store, clip, secondsPerBeat);
  if (!audio || audio.available <= 0.05) return 0;

  const sampleRate = audio.buffer.sampleRate;
  const windowSeconds = Math.min(clip.length * secondsPerBeat, audio.available);
  const startFrame = Math.max(0, Math.floor(audio.offset * sampleRate));
  const frames = Math.max(1, Math.floor(windowSeconds * sampleRate));
  const channels: Float32Array[] = [];

  for (let channel = 0; channel < audio.buffer.numberOfChannels; channel++) {
    channels.push(audio.buffer.getChannelData(channel).slice(startFrame, startFrame + frames));
  }

  const onsets = detectOnsets(channels, sampleRate, { threshold: 0.2, minGap: 0.06 }).slice(0, 64);
  const specs = planSliceQuantize({
    start: clip.start,
    length: clip.length,
    offset: clip.offset,
    bpm: store.project.bpm,
    snap,
    onsets,
  });

  if (specs.length < 2) return 0;

  const slices: Clip[] = specs.map((spec) => ({
    ...clip,
    id: uid('clip'),
    start: spec.start,
    length: spec.length,
    offset: spec.offset,
    fadeIn: undefined,
    fadeOut: undefined,
    warp: spec.stretch
      ? { stretch: true, semitones: clip.warp?.semitones ?? 0 }
      : clip.warp,
  }));

  store.edit('structure', (project) => {
    const index = project.clips.findIndex((entry) => entry.id === clipId);
    if (index === -1) return;
    project.clips.splice(index, 1, ...slices);
    project.length = Math.max(project.length, ...slices.map((slice) => slice.start + slice.length));
  });
  store.selectClip(slices[0]?.id ?? null);
  return slices.length;
}
