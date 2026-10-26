import type { Store } from '../core/store';
import type { Project } from '../core/types';
import { beatsToSeconds, clamp } from '../core/time';
import { buildGraph } from './graph';
import { applyFadeEnvelope, fadeEnvelope, resolveFades } from './fades';
import { prepareProjectAudio, resolveClipAudio } from './clipsource';

/**
 * What a render needs to read: the project, its assets, and the auto-fade
 * preference. A bounce can pass a modified copy of the project this way
 * instead of mutating the live session.
 */
export type RenderSource = Pick<Store, 'autoFade' | 'assetById'> & { project: Project };

export interface RenderOptions {
  startBeat?: number;
  endBeat?: number;
  sampleRate?: number;
  bitDepth?: 16 | 24;
  /** render only one track (used by the mix assistant for analysis) */
  soloTrackId?: string;
  tailSeconds?: number;
  /**
   * Print one dry track for the native VST3 mixer: post-insert and pre-fader,
   * with no sends, master rack or master fader. Mute and solo are ignored
   * because the native mixer owns them at playback time.
   */
  forStems?: boolean;
}

/** Renders the arrangement (master chain included) to an AudioBuffer. */
export async function renderProjectBuffer(store: RenderSource, options: RenderOptions = {}): Promise<AudioBuffer> {
  const project = store.project;
  if (!project.tracks.length) throw new Error('Nothing to render: the project has no tracks.');
  await prepareProjectAudio(store);

  const startBeat = clamp(options.startBeat ?? 0, 0, project.length);
  const endBeat = clamp(options.endBeat ?? project.length, startBeat + 0.5, project.length + 8);
  const sampleRate = options.sampleRate ?? 48000;
  const tailSeconds = options.tailSeconds ?? 2.5;
  const durationSeconds = beatsToSeconds(endBeat - startBeat, project.bpm) + tailSeconds;
  const frames = Math.max(1, Math.ceil(durationSeconds * sampleRate));

  const offline = new OfflineAudioContext(2, frames, sampleRate);
  const graph = buildGraph(offline, project, { masterDevices: !options.forStems });

  // A stem must be bit-clean: the master soft clipper belongs to playback and
  // to the final mixdown, not to a channel print.
  if (options.forStems) graph.safety.curve = null;

  const anySolo = project.tracks.some((t) => t.solo) || project.returns.some((r) => r.solo);
  for (const track of project.tracks) {
    const chain = graph.tracks.get(track.id);
    if (!chain) continue;
    const audible = !track.mute && (!anySolo || track.solo);
    const isolated = !options.soloTrackId || track.id === options.soloTrackId;
    chain.gain.gain.value = options.forStems ? (isolated ? 1 : 0) : audible && isolated ? track.volume : 0;
    // A stem is dry: sends would print the same reverb into every file.
    if (options.forStems) {
      for (const send of chain.sends) send.gain.value = 0;
    }
  }

  project.returns.forEach((bus, index) => {
    const chain = graph.returns[index];
    if (!chain) return;
    const audible = !bus.mute && (!anySolo || bus.soloSafe || bus.solo);
    chain.gain.gain.value = options.forStems ? 0 : audible ? bus.volume : 0;
    chain.panner.pan.value = bus.pan;
  });

  if (options.forStems) graph.masterGain.gain.value = 1;

  const secondsPerBeat = 60 / project.bpm;

  for (const clip of project.clips) {
    if (options.soloTrackId && clip.trackId !== options.soloTrackId) continue;
    const chain = graph.tracks.get(clip.trackId);
    if (!chain) continue;

    if (clip.kind === 'midi' && chain.instrument) {
      for (const note of clip.notes) {
        const beat = clip.start + note.start;
        if (beat < startBeat || beat >= endBeat) continue;
        const when = (beat - startBeat) * secondsPerBeat;
        chain.instrument.noteOn(when, note.pitch, note.velocity, Math.max(0.03, note.duration * secondsPerBeat));
      }
    } else if (clip.kind === 'audio' && clip.assetId) {
      const audio = resolveClipAudio(store, clip, secondsPerBeat);
      if (!audio) continue;
      const clipEnd = clip.start + clip.length;
      if (clipEnd <= startBeat || clip.start >= endBeat) continue;
      const when = Math.max(0, (clip.start - startBeat) * secondsPerBeat);
      const skipped = Math.max(0, startBeat - clip.start);
      const playLength = Math.min(clip.length - skipped, endBeat - Math.max(clip.start, startBeat));
      if (playLength <= 0) continue;
      const source = offline.createBufferSource();
      const gain = offline.createGain();

      // Same fades the transport applies, so the render matches what you hear.
      // Edges cut by the render range keep their original fade only if the clip
      // actually starts or ends inside it.
      const renderedSeconds = playLength * secondsPerBeat;
      const fades = resolveFades(clip, store.autoFade, renderedSeconds);
      const shape = {
        in: clip.start < startBeat ? 0 : fades.in,
        out: clip.start + clip.length > endBeat ? 0 : fades.out,
      };

      applyFadeEnvelope(
        gain.gain,
        fadeEnvelope(when, renderedSeconds, shape, clip.gain),
        when,
      );

      const scale = clip.warp?.stretch
        ? audio.buffer.duration / Math.max(0.001, clip.length * secondsPerBeat)
        : 1;
      const offset = Math.min(audio.buffer.duration, audio.offset + skipped * secondsPerBeat * scale);
      const seconds = Math.min(renderedSeconds, Math.max(0, audio.buffer.duration - offset));
      if (seconds <= 0.002) continue;

      source.buffer = audio.buffer;
      source.connect(gain);
      gain.connect(chain.input);
      source.start(when, offset, seconds);
    }
  }

  return offline.startRendering();
}

export async function renderMixdown(store: RenderSource, options: RenderOptions = {}): Promise<Blob> {
  const rendered = await renderProjectBuffer(store, options);
  return encodeWav(rendered, options.bitDepth ?? 24);
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function encodeWav(buffer: AudioBuffer, bitDepth: 16 | 24): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));

  const maxValue = bitDepth === 16 ? 0x7fff : 0x7fffff;
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = clamp(data[ch][i], -1, 1);
      const int = Math.round(sample * maxValue);
      if (bitDepth === 16) {
        view.setInt16(offset, int, true);
        offset += 2;
      } else {
        view.setUint8(offset, int & 0xff);
        view.setUint8(offset + 1, (int >> 8) & 0xff);
        view.setUint8(offset + 2, (int >> 16) & 0xff);
        offset += 3;
      }
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
