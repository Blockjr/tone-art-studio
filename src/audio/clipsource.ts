import type { Store } from '../core/store';
import type { AudioAsset, Clip } from '../core/types';
import { clamp } from '../core/time';
import { stretchChannelsAsync } from './dsp';

/**
 * Turns a clip's non-destructive audio settings into the buffer the transport
 * and the offline renderer should play: reverse, pitch-preserving time-stretch
 * and pitch shift, all cached per source/settings pair.
 *
 * The heavy lift uses the same WSOLA engine as the Preview panel. It runs
 * asynchronously and is prepared before the transport starts, so scheduling
 * stays synchronous and playback is always sample-accurate.
 */
export interface ClipAudioPlan {
  /** 1 = original speed; > 1 = faster and shorter */
  tempoRate: number;
  /** 1 = original pitch; 2 = one octave up */
  pitchRatio: number;
  /** timeline length of the clip in seconds */
  timelineSeconds: number;
  stretch: boolean;
  semitones: number;
}

/** The slice of the session these helpers need; a full Store satisfies it. */
export type ClipAudioSource = Pick<Store, 'project' | 'assetById'>;

export interface ResolvedClipAudio {
  buffer: AudioBuffer;
  /** where inside the buffer this clip starts, in seconds */
  offset: number;
  /** how much source remains from that offset, in seconds */
  available: number;
  /** true when a warped/reversed buffer was ready and used */
  transformed: boolean;
}

const CACHE_LIMIT = 64;
/** Soft cap on cached sample frames, so long warps cannot exhaust memory. */
const CACHE_SAMPLE_LIMIT = 16 * 1024 * 1024;
const cache = new Map<string, AudioBuffer>();
const cacheSizes = new Map<string, number>();
let cachedSamples = 0;
const pending = new Map<string, Promise<AudioBuffer | null>>();

export function clampSemitones(value: number): number {
  return clamp(Math.round(value), -12, 12);
}

export function clipAudioPlan(clip: Clip, asset: AudioAsset, secondsPerBeat: number): ClipAudioPlan {
  const semitones = clampSemitones(clip.warp?.semitones ?? 0);
  const stretch = clip.warp?.stretch === true;
  const timelineSeconds = Math.max(0.01, clip.length * secondsPerBeat);
  return {
    tempoRate: stretch ? asset.duration / timelineSeconds : 1,
    pitchRatio: 2 ** (semitones / 12),
    timelineSeconds,
    stretch,
    semitones,
  };
}

/** True when the clip needs a processed buffer at all. */
export function needsProcessing(clip: Clip, plan: ClipAudioPlan): boolean {
  return clip.reverse === true || plan.stretch || Math.abs(plan.pitchRatio - 1) > 1e-4;
}

export function clipAudioKey(assetId: string, clip: Clip, plan: ClipAudioPlan, sampleRate: number): string {
  return [
    assetId,
    clip.reverse ? 'rev' : 'fwd',
    Math.abs(plan.tempoRate - 1) < 1e-3 ? '1' : plan.tempoRate.toFixed(3),
    plan.semitones,
    Math.round(sampleRate),
  ].join('|');
}

function remember(key: string, buffer: AudioBuffer): void {
  const frames = buffer.length * buffer.numberOfChannels;
  const existing = cacheSizes.get(key) ?? 0;
  if (!cache.has(key)) cachedSamples += frames;
  else cachedSamples += frames - existing;
  cache.set(key, buffer);
  cacheSizes.set(key, frames);

  // Evict least-recently-created buffers until both the count and the sample
  // budget fit. Sliced clips are short, so a whole quantized drum part is
  // usually kept; a couple of long warps are not kept forever.
  while ((cache.size > CACHE_LIMIT || cachedSamples > CACHE_SAMPLE_LIMIT) && cache.size > 1) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
    cachedSamples -= cacheSizes.get(oldest) ?? 0;
    cacheSizes.delete(oldest);
  }
}

function reversedChannels(source: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let index = 0; index < source.numberOfChannels; index++) {
    const input = source.getChannelData(index);
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) output[i] = input[input.length - 1 - i];
    channels.push(output);
  }
  return channels;
}

function rawChannels(source: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let index = 0; index < source.numberOfChannels; index++) {
    channels.push(Float32Array.from(source.getChannelData(index)));
  }
  return channels;
}

function makeBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer | null {
  const frames = channels[0]?.length ?? 0;
  if (frames <= 0) return null;
  const buffer = new AudioBuffer({ length: frames, numberOfChannels: channels.length, sampleRate });
  for (let index = 0; index < channels.length; index++) {
    buffer.copyToChannel(channels[index] as Float32Array<ArrayBuffer>, index);
  }
  return buffer;
}

/** Builds (once) and returns the processed buffer for a clip, if it needs one. */
export async function prepareClipAudio(store: ClipAudioSource, clip: Clip): Promise<AudioBuffer | null> {
  if (clip.kind !== 'audio' || !clip.assetId) return null;
  const asset = store.assetById(clip.assetId);
  if (!asset) return null;
  const secondsPerBeat = 60 / store.project.bpm;
  const plan = clipAudioPlan(clip, asset, secondsPerBeat);
  if (!needsProcessing(clip, plan)) return asset.buffer;

  const sampleRate = asset.buffer.sampleRate;
  const key = clipAudioKey(asset.id, clip, plan, sampleRate);
  const ready = cache.get(key);
  if (ready) return ready;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const job = (async (): Promise<AudioBuffer | null> => {
    const source = clip.reverse ? reversedChannels(asset.buffer) : rawChannels(asset.buffer);
    const processed = await stretchChannelsAsync(source, {
      tempoRate: plan.tempoRate,
      pitchRatio: plan.pitchRatio,
    });
    if (!processed || !processed.length) return null;
    const buffer = makeBuffer(processed, sampleRate);
    if (buffer) remember(key, buffer);
    return buffer;
  })();

  pending.set(key, job);
  try {
    return await job;
  } finally {
    if (pending.get(key) === job) pending.delete(key);
  }
}

/** Warms the cache for every clip that needs processing, before playback. */
export async function prepareProjectAudio(store: ClipAudioSource, clips?: Clip[]): Promise<void> {
  const list = clips ?? store.project.clips;
  const seen = new Set<string>();
  for (const clip of list) {
    if (clip.kind !== 'audio' || !clip.assetId) continue;
    const key = `${clip.assetId}|${clip.reverse ? 1 : 0}|${clip.warp?.stretch ? 1 : 0}|${clipAssetLengthKey(clip)}|${clip.warp?.semitones ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await prepareClipAudio(store, clip);
  }
}

function clipAssetLengthKey(clip: Clip): string {
  return `${Math.round(clip.length * 1000)}`;
}

/**
 * Synchronous view for scheduling. A processed buffer that is still being
 * built falls back to the untouched source, so a warp edit never leaves a
 * silent gap; the next play/seek picks up the finished version.
 */
export function resolveClipAudio(store: ClipAudioSource, clip: Clip, secondsPerBeat: number): ResolvedClipAudio | null {
  if (clip.kind !== 'audio' || !clip.assetId) return null;
  const asset = store.assetById(clip.assetId);
  if (!asset) return null;

  const plan = clipAudioPlan(clip, asset, secondsPerBeat);
  const sourceOffset = Math.max(0, clip.offset * secondsPerBeat);

  if (needsProcessing(clip, plan)) {
    const key = clipAudioKey(asset.id, clip, plan, asset.buffer.sampleRate);
    const processed = cache.get(key);
    if (processed) {
      // Source time maps linearly onto the processed buffer, whose length is
      // either the clip's timeline length (stretch) or the source length.
      const scale = processed.duration / Math.max(1e-6, asset.duration);
      const start = Math.min(processed.duration, sourceOffset * scale);
      const window = Math.max(0, Math.min(clip.length * secondsPerBeat, processed.duration - start));

      // A reversed clip is the same source window read backwards, so its window
      // start lands at the mirrored point in the reversed buffer.
      if (clip.reverse) {
        return {
          buffer: processed,
          offset: Math.max(0, processed.duration - start - window),
          available: window,
          transformed: true,
        };
      }

      return {
        buffer: processed,
        offset: start,
        available: Math.max(0, processed.duration - start),
        transformed: true,
      };
    }
  }

  return {
    buffer: asset.buffer,
    offset: Math.min(asset.buffer.duration, sourceOffset),
    available: Math.max(0, asset.buffer.duration - Math.min(asset.buffer.duration, sourceOffset)),
    transformed: false,
  };
}

/** Drops every cached warp; used by tests and when assets are replaced. */
export function clearClipAudioCache(): void {
  cache.clear();
  cacheSizes.clear();
  cachedSamples = 0;
  pending.clear();
}
