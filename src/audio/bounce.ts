import { createTrack } from '../core/project';
import type { Store } from '../core/store';
import { uid } from '../core/time';
import type { AudioAsset, Clip, Project } from '../core/types';
import { computePeaks } from './dsp';
import { peakBuckets } from './waveform';
import { renderProjectBuffer, type RenderSource } from './export';

/**
 * Bounce in place: print what a track sounds like into an audio clip.
 *
 * A bounce includes the instrument, channel EQ, inserts, pan, fader and sends,
 * because that is what makes MIDI into a finished audio file. It deliberately
 * skips the master chain: the printed audio goes back into the session, so
 * printing the master too would apply it twice.
 */

export interface BouncePlan {
  /** a copy of the project, reduced to the clips being printed */
  project: Project;
  /** the source track name, for the new track and clip names */
  trackName: string;
  clips: Clip[];
  startBeat: number;
  endBeat: number;
}

/**
 * Reduces a project to the clips a bounce should print.
 *
 * Clearing solos and the source track's mute is what makes an explicit bounce
 * predictable: you asked for this track, so you get this track, even if another
 * channel happens to be soloed or this one is muted at the time.
 */
export function prepareBounceProject(
  project: Project,
  trackId: string,
  clipIds?: readonly string[],
): Project | null {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return null;

  const keep = clipIds ? new Set(clipIds) : null;
  const clips = project.clips.filter(
    (clip) => clip.trackId === trackId && (!keep || keep.has(clip.id)),
  );
  if (!clips.length) return null;

  const copy = JSON.parse(JSON.stringify(project)) as Project;
  copy.master.devices = [];
  copy.master.volume = 1;
  copy.clips = copy.clips.filter((clip) => clips.some((source) => source.id === clip.id));
  for (const other of copy.tracks) {
    other.solo = false;
    if (other.id === trackId) other.mute = false;
  }
  for (const bus of copy.returns) bus.solo = false;
  return copy;
}

function planFor(project: Project, trackId: string, clipIds?: readonly string[]): BouncePlan | null {
  const reduced = prepareBounceProject(project, trackId, clipIds);
  if (!reduced) return null;
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return null;

  const startBeat = Math.min(...reduced.clips.map((clip) => clip.start));
  const endBeat = Math.max(...reduced.clips.map((clip) => clip.start + clip.length));
  if (!(endBeat > startBeat)) return null;

  return { project: reduced, trackName: track.name, clips: reduced.clips, startBeat, endBeat };
}

/** One clip, printed through its track's chain. */
export function planClipBounce(project: Project, clipId: string): BouncePlan | null {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || clip.length <= 0) return null;
  return planFor(project, clip.trackId, [clip.id]);
}

/** Every clip on a track, printed as one continuous audio clip. */
export function planTrackBounce(project: Project, trackId: string): BouncePlan | null {
  return planFor(project, trackId);
}

/** Renders a plan offline. The result is exactly the planned length. */
export async function renderBounce(store: Store, plan: BouncePlan, sampleRate = 48000): Promise<AudioBuffer> {
  const source: RenderSource = {
    project: plan.project,
    autoFade: store.autoFade,
    assetById: (id) => store.assetById(id),
  };

  return renderProjectBuffer(source, {
    startBeat: plan.startBeat,
    endBeat: plan.endBeat,
    sampleRate,
    tailSeconds: 0.05,
  });
}

export interface BounceResult {
  asset: AudioAsset;
  trackId: string;
  clipId: string;
}

/**
 * Turns a rendered buffer into an audio track directly below the source and
 * returns the new ids. The source track is left untouched: the MIDI stays
 * editable, and muting it is the user's call.
 */
export function insertBounce(
  store: Store,
  plan: BouncePlan,
  buffer: AudioBuffer,
  sourceTrackId: string,
): BounceResult {
  const asset: AudioAsset = {
    id: uid('asset'),
    name: `${plan.trackName} bounce`,
    buffer,
    duration: buffer.duration,      peaks: computePeaks(
        Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index)),
        peakBuckets(buffer.duration),
      ),
  };
  store.assets.set(asset.id, asset);

  const sourceIndex = store.project.tracks.findIndex((track) => track.id === sourceTrackId);
  const track = createTrack('audio', `${plan.trackName} Bounce`, Math.max(0, sourceIndex + 1));
  track.color = store.project.tracks[sourceIndex]?.color ?? track.color;
  // The buffer already carries the source fader, pan and EQ, so the print track
  // stays at unity with a neutral channel: no double gain, no double filtering.
  track.volume = 1;
  track.pan = 0;
  track.eq = { hp: 20, low: 0, mid: 0, midFreq: 1000, high: 0 };

  const clip: Clip = {
    id: uid('clip'),
    trackId: track.id,
    name: `${plan.trackName} Bounce`,
    kind: 'audio',
    start: plan.startBeat,
    length: plan.endBeat - plan.startBeat,
    color: track.color,
    notes: [],
    assetId: asset.id,
    offset: 0,
    gain: 1,
  };

  store.edit('structure', (project) => {
    project.tracks.splice(Math.max(0, sourceIndex + 1), 0, track);
    project.clips.push(clip);
    project.length = Math.max(project.length, clip.start + clip.length);
  });
  store.selectClip(clip.id);

  return { asset, trackId: track.id, clipId: clip.id };
}
