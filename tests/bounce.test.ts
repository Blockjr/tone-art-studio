import { describe, expect, it } from 'vitest';
import { planClipBounce, planTrackBounce, prepareBounceProject } from '../src/audio/bounce';
import { demoProject } from '../src/core/project';
import type { Project } from '../src/core/types';

const clone = (project: Project): Project => JSON.parse(JSON.stringify(project)) as Project;

function midiClip(project: Project): { clip: Project['clips'][number]; trackId: string } {
  const clip = project.clips.find((c) => c.kind === 'midi');
  if (!clip) throw new Error('the demo session should have a MIDI clip');
  return { clip, trackId: clip.trackId };
}

describe('bounce planning', () => {
  it('prints only the requested clip, through its track and without the master', () => {
    const project = clone(demoProject());
    const { clip, trackId } = midiClip(project);
    const plan = planClipBounce(project, clip.id);
    expect(plan).not.toBeNull();
    expect(plan?.clips.map((c) => c.id)).toEqual([clip.id]);
    expect(plan?.project.master.devices).toEqual([]);
    expect(plan?.project.master.volume).toBe(1);
    expect(plan?.startBeat).toBe(clip.start);
    expect(plan?.endBeat).toBe(clip.start + clip.length);
    expect(plan?.project.tracks.find((t) => t.id === trackId)?.instrument).not.toBeNull();
  });

  it('does not mutate the live project', () => {
    const project = clone(demoProject());
    const { clip } = midiClip(project);
    planClipBounce(project, clip.id);
    expect(project.master.devices.length).toBeGreaterThan(0);
    expect(project.clips.length).toBeGreaterThan(1);
  });

  it('covers every clip on a track and spans them', () => {
    const project = clone(demoProject());
    const { clip, trackId } = midiClip(project);
    const second = { ...clip, id: 'extra', start: clip.start + 8, length: 4 };
    project.clips.push(second);

    const onTrack = project.clips.filter((c) => c.trackId === trackId);
    const plan = planTrackBounce(project, trackId);
    expect(plan?.clips.length).toBe(onTrack.length);
    expect(plan?.startBeat).toBe(Math.min(...onTrack.map((c) => c.start)));
    expect(plan?.endBeat).toBe(Math.max(...onTrack.map((c) => c.start + c.length)));
  });

  it('clears solos and the source mute so an explicit bounce is audible', () => {
    const project = clone(demoProject());
    const { clip, trackId } = midiClip(project);
    project.tracks[0].solo = true;
    project.tracks.find((t) => t.id === trackId)!.mute = true;
    project.returns[0].solo = true;

    const reduced = prepareBounceProject(project, trackId);
    expect(reduced?.tracks.every((t) => !t.solo)).toBe(true);
    expect(reduced?.tracks.find((t) => t.id === trackId)?.mute).toBe(false);
    expect(reduced?.returns.every((r) => !r.solo)).toBe(true);
    expect(reduced?.clips.every((c) => c.trackId === trackId)).toBe(true);
    expect(clip.id).toBeTruthy();
  });

  it('declines empty clips, unknown ids and silent tracks', () => {
    const project = clone(demoProject());
    expect(planClipBounce(project, 'nope')).toBeNull();
    const silent = project.tracks.find((t) => !project.clips.some((c) => c.trackId === t.id));
    if (silent) expect(planTrackBounce(project, silent.id)).toBeNull();
  });
});
