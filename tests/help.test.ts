import { describe, expect, it } from 'vitest';
import { diagnoseProject } from '../src/help/diagnose';
import { HELP_GROUPS, HELP_TOPICS, groupTopics, searchTopics } from '../src/help/topics';
import { demoProject } from '../src/core/project';
import type { Project } from '../src/core/types';

const clone = (project: Project): Project => JSON.parse(JSON.stringify(project)) as Project;

const ACTION_KINDS = ['ai-track', 'ai-master', 'export', 'rig', 'remote', 'start'];

describe('help library', () => {
  it('gives every topic a group, keywords and body text', () => {
    for (const topic of HELP_TOPICS) {
      expect(HELP_GROUPS).toContain(topic.group);
      expect(topic.keywords.length).toBeGreaterThan(1);
      expect(topic.body.length).toBeGreaterThan(0);
      expect(topic.title.length).toBeGreaterThan(3);
    }
  });

  it('only points at actions the panel can run', () => {
    for (const topic of HELP_TOPICS) {
      if (topic.action) expect(ACTION_KINDS).toContain(topic.action.kind);
    }
  });

  it('finds topics by title, keyword and body', () => {
    expect(searchTopics('vst3').map((t) => t.id)).toContain('vst3');
    expect(searchTopics('loudness').map((t) => t.id)).toContain('loudness');
    expect(searchTopics('undo').map((t) => t.id)).toContain('shortcuts');
    expect(searchTopics('').length).toBe(HELP_TOPICS.length);
    expect(searchTopics('   ').length).toBe(HELP_TOPICS.length);
  });

  it('requires every word to match, so queries narrow instead of widening', () => {
    const broad = searchTopics('mix');
    const narrow = searchTopics('mix ai');
    expect(narrow.length).toBeLessThanOrEqual(broad.length);
    expect(narrow.every((topic) => broad.includes(topic))).toBe(true);
  });

  it('returns nothing for nonsense', () => {
    expect(searchTopics('zzzzqqq')).toEqual([]);
  });

  it('groups topics in the declared order', () => {
    const groups = groupTopics(HELP_TOPICS).map((entry) => entry.group);
    expect(groups).toEqual([...HELP_GROUPS]);
    expect(groups.length).toBeGreaterThan(3);
  });
});

describe('session checks', () => {
  it('finds nothing wrong with the demo session', () => {
    const project = clone(demoProject());
    const found = diagnoseProject(project, project.tracks[0].id);
    expect(found.some((entry) => entry.id === 'no-limiter')).toBe(false);
    expect(found.some((entry) => entry.id === 'muted')).toBe(false);
    expect(found.some((entry) => entry.id === 'clean')).toBe(true);
  });

  it('flags a missing limiter and fixes it at -1 dB', () => {
    const project = clone(demoProject());
    project.master.devices = [];
    const entry = diagnoseProject(project, '').find((d) => d.id === 'no-limiter');
    expect(entry?.severity).toBe('fix');
    entry?.fix?.(project);
    const limiter = project.master.devices.find((device) => device.type === 'limiter');
    expect(limiter?.params.ceiling).toBe(-1);
  });

  it('unmutes tracks and clears solos', () => {
    const project = clone(demoProject());
    project.tracks[0].mute = true;
    project.tracks[1].solo = true;
    const found = diagnoseProject(project, project.tracks[0].id);
    found.find((d) => d.id === 'muted')?.fix?.(project);
    found.find((d) => d.id === 'solo')?.fix?.(project);
    expect(project.tracks.every((track) => !track.mute && !track.solo)).toBe(true);
  });

  it('pulls a hot master fader back to unity', () => {
    const project = clone(demoProject());
    project.master.volume = 1.2;
    const entry = diagnoseProject(project, '').find((d) => d.id === 'master-hot');
    entry?.fix?.(project);
    expect(project.master.volume).toBe(1);
  });

  it('offers a high-pass for tracks that have none', () => {
    const project = clone(demoProject());
    for (const track of project.tracks) track.eq.hp = 10;
    const entry = diagnoseProject(project, project.tracks[0].id).find((d) => d.id === 'no-highpass');
    entry?.fix?.(project);
    expect(project.tracks.every((track) => track.eq.hp >= 30)).toBe(true);
  });

  it('reports an empty session and empty audio tracks', () => {
    const empty = clone(demoProject());
    empty.tracks = [];
    empty.clips = [];
    expect(diagnoseProject(empty, '').map((d) => d.id)).toContain('no-tracks');

    const project = clone(demoProject());
    const audio = project.tracks.find((track) => track.kind === 'audio');
    if (audio) {
      project.clips = project.clips.filter((clip) => clip.trackId !== audio.id);
      expect(diagnoseProject(project, audio.id).map((d) => d.id)).toContain('empty-audio');
    }
  });

  it('orders fixes before warnings and notes', () => {
    const project = clone(demoProject());
    project.master.devices = [];
    project.tracks.forEach((track) => {
      track.eq.hp = 5;
    });
    project.tracks[0].mute = true;
    const severities = diagnoseProject(project, project.tracks[0].id).map((entry) => entry.severity);
    const rank = { fix: 0, warn: 1, info: 2 } as const;
    const ranks = severities.map((severity) => rank[severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
