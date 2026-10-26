/**
 * Stem printing for the desktop VST3 mixer.
 *
 * A browser cannot load VST3 binaries, so the desktop build mixes through a
 * JUCE host instead. This module renders one dry stem per track — post-insert
 * and pre-fader — plus a `stems.json` manifest that the native mixer reads to
 * rebuild the channel strips. The native host then runs each track through its
 * own VST3 chain, exactly like the built-in rack does in the browser.
 */

import type { Store } from '../core/store';
import type { Project } from '../core/types';
import { beatsToSeconds } from '../core/time';
import { encodeWav, renderProjectBuffer, type RenderSource } from './export';

export interface StemManifestTrack {
  id: string;
  name: string;
  file: string;
  /** channel fader in decibels, applied natively */
  gainDb: number;
  /** -1 hard left, +1 hard right */
  pan: number;
  mute: boolean;
  solo: boolean;
}

export interface StemManifest {
  format: 'hstudio-stems';
  version: 1;
  bpm: number;
  sampleRate: number;
  masterGainDb: number;
  length: number;
  tracks: StemManifestTrack[];
}

export interface RenderedStem {
  trackId: string;
  file: string;
  buffer: AudioBuffer;
}

/** Linear gain to dB, with silence clamped to the mixer's floor. */
export function linearToDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return -96;
  return Math.max(-96, Math.min(12, 20 * Math.log10(value)));
}

/** A safe, ordered file name: "03-lead-vox.wav". */
export function stemFileName(index: number, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return `${String(index + 1).padStart(2, '0')}${slug ? `-${slug}` : ''}.wav`;
}

export function buildStemManifest(
  project: Project,
  stems: { trackId: string; file: string }[],
  sampleRate: number,
): StemManifest {
  const byId = new Map(stems.map((stem) => [stem.trackId, stem.file]));

  return {
    format: 'hstudio-stems',
    version: 1,
    bpm: project.bpm,
    sampleRate,
    masterGainDb: linearToDb(project.master.volume),
    length: beatsToSeconds(project.length, project.bpm),
    tracks: project.tracks
      .filter((track) => byId.has(track.id))
      .map((track) => ({
        id: track.id,
        name: track.name,
        file: byId.get(track.id) as string,
        gainDb: linearToDb(track.volume),
        pan: track.pan,
        mute: track.mute,
        solo: track.solo,
      })),
  };
}

/**
 * Renders every track in the project. Rendering one track at a time keeps the
 * mix assistant's isolation path and the stem path honest: no bleed from the
 * other channels, and the manifest records their faders for the native mixer.
 */
export async function renderStems(
  store: RenderSource,
  sampleRate = 48000,
): Promise<{ manifest: StemManifest; files: RenderedStem[] }> {
  const { project } = store;

  if (!project.tracks.length) throw new Error('There are no tracks to print.');

  const files: RenderedStem[] = [];

  for (const [index, track] of project.tracks.entries()) {
    const buffer = await renderProjectBuffer(store, {
      sampleRate,
      soloTrackId: track.id,
      forStems: true,
      tailSeconds: 0.2,
    });

    files.push({ trackId: track.id, file: stemFileName(index, track.name), buffer });
  }

  return {
    manifest: buildStemManifest(
      project,
      files.map((stem) => ({ trackId: stem.trackId, file: stem.file })),
      sampleRate,
    ),
    files,
  };
}

interface StemDirectoryPicker {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
    id?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

/**
 * Renders the stems, then writes the WAVs and `stems.json` into a folder the
 * user picks. The Folder is what the desktop app's "Load stems" button asks
 * for, so the two halves only ever meet through the file system.
 */
export async function exportStemsForVst(
  store: Store,
  sampleRate = 48000,
): Promise<{ folder: string; tracks: number }> {
  const picker = (window as unknown as StemDirectoryPicker).showDirectoryPicker;

  if (typeof picker !== 'function') {
    throw new Error('This browser cannot write a folder. Use the desktop build, Chrome or Edge.');
  }

  const directory = await picker({ mode: 'readwrite', id: 'hybrid-stems' });
  const { manifest, files } = await renderStems(store, sampleRate);

  const writeFile = async (name: string, data: Blob | string) => {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  };

  for (const stem of files) await writeFile(stem.file, encodeWav(stem.buffer, 24));
  await writeFile('stems.json', JSON.stringify(manifest, null, 2));

  return { folder: directory.name, tracks: files.length };
}
