import type { AudioAsset, Project } from '../core/types';

/**
 * Audio embedded in a project file.
 *
 * Imported clips are stored as 16-bit PCM, interleaved and base64 encoded.
 * That keeps a project self-contained when it is saved to disk: reopen the
 * file on another machine and the clips are still there. The peaks are shipped
 * too, so the arrangement can draw waveforms before anything is decoded.
 */
export interface SerializedAsset {
  id: string;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  /** min/max pairs, 0..1 */
  peaks: number[];
  /** base64 of interleaved little-endian int16 samples */
  data: string;
}

const B64_CHUNK = 8192;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeAudioAsset(asset: AudioAsset): SerializedAsset {
  const channels = asset.buffer.numberOfChannels;
  const frames = asset.buffer.length;
  const interleaved = new Int16Array(frames * channels);

  for (let channel = 0; channel < channels; channel++) {
    const data = asset.buffer.getChannelData(channel);
    for (let frame = 0; frame < frames; frame++) {
      const sample = Math.max(-1, Math.min(1, data[frame]));
      interleaved[frame * channels + channel] = Math.round(sample * 0x7fff);
    }
  }

  return {
    id: asset.id,
    name: asset.name,
    duration: asset.duration,
    sampleRate: asset.buffer.sampleRate,
    channels,
    peaks: asset.peaks,
    data: toBase64(new Uint8Array(interleaved.buffer)),
  };
}

interface BufferFactory {
  createBuffer(channels: number, frames: number, sampleRate: number): AudioBuffer;
}

export function decodeAudioAsset(asset: SerializedAsset, ctx: BufferFactory): AudioAsset {
  const bytes = fromBase64(asset.data);
  const interleaved = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const channels = Math.max(1, Math.min(8, Math.round(asset.channels) || 1));
  const frames = Math.floor(interleaved.length / channels);
  const buffer = ctx.createBuffer(channels, Math.max(1, frames), asset.sampleRate || 48000);

  for (let channel = 0; channel < channels; channel++) {
    const target = buffer.getChannelData(channel);
    for (let frame = 0; frame < frames; frame++) {
      target[frame] = interleaved[frame * channels + channel] / 0x7fff;
    }
  }

  return {
    id: asset.id,
    name: asset.name,
    buffer,
    duration: asset.duration || buffer.duration,
    peaks: Array.isArray(asset.peaks) ? asset.peaks : [],
  };
}

/** Ids of the assets an arrangement actually needs. */
export function projectAssetIds(project: Project): string[] {
  const ids = new Set<string>();
  for (const clip of project.clips) {
    if (clip.assetId) ids.add(clip.assetId);
  }
  // Takes stay in the project even when no clip currently plays them, so their
  // audio has to travel with the file for comping to survive a reopen.
  for (const take of project.takes ?? []) {
    ids.add(take.assetId);
  }
  return [...ids];
}

/** Encodes the assets used by the project, skipping duplicates and strays. */
export function encodeProjectAssets(project: Project, assets: Map<string, AudioAsset>): SerializedAsset[] {
  const encoded: SerializedAsset[] = [];
  for (const id of projectAssetIds(project)) {
    const asset = assets.get(id);
    if (asset) encoded.push(encodeAudioAsset(asset));
  }
  return encoded;
}

/** Rough byte size of the encoded payload, for the save toast. */
export function encodedAssetBytes(assets: SerializedAsset[]): number {
  return assets.reduce((total, asset) => total + asset.data.length, 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
