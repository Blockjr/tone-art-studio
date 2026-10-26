import { describe, expect, it } from 'vitest';
import {
  MASTER_TARGETS,
  measureAudio,
  planMaster,
  planTrackMix,
  planWholeMix,
  type AudioStats,
  type StereoAudio,
} from '../src/audio/mixai';
import { createInstrument, createTrack, demoProject } from '../src/core/project';
import { Store } from '../src/core/store';
import type { Project, Track } from '../src/core/types';

const SAMPLE_RATE = 48000;

function stereo(
  generator: (index: number) => [number, number],
  seconds = 4,
  sampleRate = SAMPLE_RATE,
): StereoAudio {
  const length = Math.round(seconds * sampleRate);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const [l, r] = generator(i);
    left[i] = l;
    right[i] = r;
  }
  return { left, right, sampleRate };
}

const sine = (frequency: number, amplitude: number, sampleRate = SAMPLE_RATE) =>
  stereo(
    (i) => {
      const value = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
      return [value, value];
    },
    4,
    sampleRate,
  );

const stats = (overrides: Partial<AudioStats> = {}): AudioStats => ({
  lufs: -20,
  shortTermLufs: -19,
  rmsDb: -20,
  truePeakDb: -6,
  peakDb: -6,
  crestDb: 14,
  bands: { low: 25, lowMid: 25, mid: 25, high: 25 },
  correlation: 0.9,
  clipped: 0,
  silent: false,
  ...overrides,
});

const clone = (project: Project): Project => JSON.parse(JSON.stringify(project)) as Project;

function track(instrument: 'drums' | 'bass' | 'epiano' | 'polysynth'): Track {
  const created = createTrack('midi', 'Test', 0);
  created.instrument = createInstrument(instrument);
  return created;
}

function projectWith(...tracks: Track[]): Project {
  const project = clone(demoProject());
  project.tracks = tracks;
  project.clips = [];
  project.master.devices = [];
  return project;
}

describe('loudness measurement', () => {
  it('reads a -20 dBFS 1 kHz tone as about -20 LUFS', () => {
    // 0.1414 amplitude => -20 dBFS RMS, the reference point of BS.1770.
    const measured = measureAudio(sine(1000, 0.1414));
    expect(measured.lufs).toBeGreaterThan(-21);
    expect(measured.lufs).toBeLessThan(-19);
    expect(measured.silent).toBe(false);
  });

  it('reports relative loudness correctly between two levels', () => {
    const quiet = measureAudio(sine(1000, 0.1414));
    const loud = measureAudio(sine(1000, 0.2828));
    expect(loud.lufs - quiet.lufs).toBeCloseTo(6, 0);
  });

  it('treats silence as silent instead of a number', () => {
    const measured = measureAudio(stereo(() => [0, 0], 1));
    expect(measured.silent).toBe(true);
    expect(measured.lufs).toBe(-Infinity);
  });

  it('catches inter-sample peaks above the sample peak', () => {
    // A 11 kHz tone at 0.95 has its crest between samples.
    const measured = measureAudio(sine(11000, 0.95));
    expect(measured.truePeakDb).toBeGreaterThan(measured.peakDb - 0.01);
    expect(measured.truePeakDb).toBeGreaterThan(-0.6);
  });

  it('counts clipped samples', () => {
    const measured = measureAudio(stereo(() => [1.4, 1.4], 0.3));
    expect(measured.clipped).toBeGreaterThan(100);
    expect(measured.truePeakDb).toBeGreaterThan(2);
  });
});

describe('spectrum and stereo', () => {
  it('puts a 100 Hz tone in the low band', () => {
    const measured = measureAudio(sine(100, 0.3));
    expect(measured.bands.low).toBeGreaterThan(60);
    expect(measured.bands.high).toBeLessThan(10);
  });

  it('puts a 9 kHz tone in the high band', () => {
    const measured = measureAudio(sine(9000, 0.3));
    expect(measured.bands.high).toBeGreaterThan(55);
  });

  it('measures correlation of anti-phase channels as -1', () => {
    const measured = measureAudio(
      stereo((i) => {
        const value = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
        return [value, -value];
      }),
    );
    expect(measured.correlation).toBeLessThan(-0.98);
  });

  it('treats identical channels as fully correlated', () => {
    expect(measureAudio(sine(220, 0.3)).correlation).toBeGreaterThan(0.99);
  });
});

describe('track mix plan', () => {
  it('raises a quiet track towards its role target', () => {
    const subject = track('epiano');
    const corrections = planTrackMix(subject, stats({ lufs: -30 }), 1);
    const level = corrections.find((c) => c.area === 'level');
    expect(level).toBeDefined();
    const before = subject.gain;
    const project = clone(projectWith(subject));
    level?.apply(project);
    expect(project.tracks[0].gain).toBeGreaterThan(before);
  });

  it('scales the correction with intensity', () => {
    const subject = track('epiano');
    const gentle = planTrackMix(subject, stats({ lufs: -30 }), 0.3).find((c) => c.area === 'level');
    const strong = planTrackMix(subject, stats({ lufs: -30 }), 1).find((c) => c.area === 'level');
    const number = (title: string | undefined): number => Number(/([+-]?\d+\.\d)/.exec(title ?? '')?.[1] ?? 0);
    expect(number(strong?.title)).toBeGreaterThan(number(gentle?.title));
  });

  it('high-passes a melodic track and lifts a dull top end', () => {
    const subject = track('polysynth');
    subject.eq = { ...subject.eq, hp: 20, high: 0 };
    const corrections = planTrackMix(
      subject,
      stats({ lufs: -21, bands: { low: 20, lowMid: 25, mid: 47, high: 8 } }),
      1,
    );
    const eq = corrections.find((c) => c.area === 'eq');
    expect(eq).toBeDefined();
    expect(eq?.detail).toContain('high-pass at 100 Hz');
    const project = projectWith(subject);
    eq?.apply(project);
    expect(project.tracks[0].eq.hp).toBe(100);
    expect(project.tracks[0].eq.high).toBeGreaterThan(0);
  });

  it('cuts mud on a track that is heavy in the low-mid', () => {
    const subject = track('polysynth');
    const corrections = planTrackMix(
      subject,
      stats({ lufs: -21, bands: { low: 20, lowMid: 45, mid: 30, high: 5 } }),
      1,
    );
    const eq = corrections.find((c) => c.area === 'eq');
    const project = projectWith(subject);
    eq?.apply(project);
    expect(project.tracks[0].eq.mid).toBeLessThan(0);
    expect(project.tracks[0].eq.midFreq).toBe(420);
  });

  it('adds a compressor to a spiky drum track', () => {
    const subject = track('drums');
    const corrections = planTrackMix(subject, stats({ lufs: -18, crestDb: 20 }), 1);
    const dynamics = corrections.find((c) => c.area === 'dynamics');
    expect(dynamics).toBeDefined();
    const project = projectWith(subject);
    dynamics?.apply(project);
    const inserted = project.tracks[0].devices.find((d) => d.type === 'compressor');
    expect(inserted).toBeDefined();
    expect(inserted?.params.ratio).toBeGreaterThan(1);
  });

  it('does not stack a second compressor on a track that has one', () => {
    const subject = track('drums');
    const project = projectWith(subject);
    planTrackMix(subject, stats({ crestDb: 20 }), 1)
      .find((c) => c.area === 'dynamics')
      ?.apply(project);
    const again = planTrackMix(project.tracks[0], stats({ crestDb: 20 }), 1);
    expect(again.some((c) => c.area === 'dynamics')).toBe(false);
  });

  it('flags out-of-phase material', () => {
    const subject = track('polysynth');
    subject.pan = -0.5;
    const corrections = planTrackMix(subject, stats({ correlation: -0.4 }), 1);
    const phase = corrections.find((c) => c.area === 'stereo');
    expect(phase).toBeDefined();
    const project = projectWith(subject);
    phase?.apply(project);
    expect(project.tracks[0].pan).toBe(0);
  });

  it('says nothing about a silent track', () => {
    expect(planTrackMix(track('drums'), stats({ silent: true }), 1)).toEqual([]);
  });

  it('is idempotent once the level is right', () => {
    const subject = track('epiano');
    subject.gain = -4;
    const corrections = planTrackMix(subject, stats({ lufs: -21 }), 1);
    expect(corrections.some((c) => c.area === 'level')).toBe(false);
  });
});

describe('whole-mix plan', () => {
  const streaming = MASTER_TARGETS[0];

  function ensemble(): { project: Project; measured: { track: Track; stats: AudioStats }[] } {
    const kick = track('drums');
    kick.name = 'Kick';
    const bass = track('bass');
    bass.name = 'Bass';
    const keys = track('epiano');
    keys.name = 'Keys';
    keys.eq = { ...keys.eq, hp: 100, low: 0, mid: 0, high: 0 };
    const lead = track('polysynth');
    lead.name = 'Lead';
    lead.eq = { ...lead.eq, hp: 100, low: 0, mid: 0, high: 0 };
    const project = projectWith(kick, bass, keys, lead);
    return {
      project,
      measured: [
        { track: kick, stats: stats({ lufs: -18, bands: { low: 64, lowMid: 20, mid: 10, high: 6 } }) },
        { track: bass, stats: stats({ lufs: -19, bands: { low: 72, lowMid: 18, mid: 6, high: 4 } }) },
        { track: keys, stats: stats({ lufs: -24, bands: { low: 32, lowMid: 30, mid: 28, high: 10 } }) },
        { track: lead, stats: stats({ lufs: -25, bands: { low: 8, lowMid: 24, mid: 55, high: 13 } }) },
      ],
    };
  }

  it('judges every track in context and adds cross-track corrections', () => {
    const { project, measured } = ensemble();
    const mixStats = stats({
      lufs: -12,
      truePeakDb: -1,
      bands: { low: 46, lowMid: 32, mid: 18, high: 4 },
      correlation: 0.99,
    });
    const plan = planWholeMix(project, mixStats, measured, streaming, 1);

    const low = plan.corrections.find((correction) => correction.id.startsWith('mix-low-'));
    expect(low).toBeDefined();
    expect(low?.targetName).not.toBe('Bass');
    expect(low?.targetName).not.toBe('Kick');
    expect(low?.holistic).toBe(true);
    expect(plan.findings.length).toBeGreaterThan(0);

    expect(plan.corrections.some((correction) => correction.id === 'mix-width')).toBe(true);
    expect(plan.corrections.some((correction) => correction.targetId === 'master')).toBe(true);
    expect(plan.corrections.some((correction) => correction.holistic && correction.targetName === 'Bass')).toBe(false);
  });

  it('leaves muted tracks out of the ensemble decisions', () => {
    const { project, measured } = ensemble();
    project.tracks[3].mute = true;
    const plan = planWholeMix(
      project,
      stats({ lufs: -14, truePeakDb: -4, bands: { low: 30, lowMid: 25, mid: 30, high: 15 } }),
      measured,
      streaming,
      1,
    );
    expect(plan.corrections.some((correction) => correction.targetId === project.tracks[3].id)).toBe(false);
  });

  it('applies the whole plan through one undoable store edit', () => {
    const { project, measured } = ensemble();
    const store = new Store(project);
    const before = JSON.stringify(store.project);
    const plan = planWholeMix(
      project,
      stats({ lufs: -12, truePeakDb: -1, bands: { low: 46, lowMid: 32, mid: 18, high: 4 }, correlation: 0.99 }),
      measured,
      streaming,
      1,
    );
    store.edit('structure', (scope) => {
      for (const correction of plan.corrections) correction.apply(scope);
    });
    expect(JSON.stringify(store.project)).not.toBe(before);
    store.undo();
    expect(JSON.stringify(store.project)).toBe(before);
  });
});

describe('master plan', () => {
  const streaming = MASTER_TARGETS[0];

  it('drives the limiter to the loudness target', () => {
    const corrections = planMaster(stats({ lufs: -22, truePeakDb: -20 }), streaming, 1, 0.9);
    const limiter = corrections.find((c) => c.id === 'master-limiter');
    expect(limiter).toBeDefined();
    const project = projectWith(track('polysynth'));
    limiter?.apply(project);
    const device = project.master.devices.find((d) => d.type === 'limiter');
    expect(device?.params.ceiling).toBe(streaming.ceiling);
    expect(device?.params.gain).toBeCloseTo(8, 0);
  });

  it('aims higher for the club target', () => {
    const club = MASTER_TARGETS[1];
    const idle = projectWith(track('polysynth'));
    const clubProject = clone(idle);
    planMaster(stats({ lufs: -20, truePeakDb: -12 }), club, 1, 0.9)
      .find((c) => c.id === 'master-limiter')
      ?.apply(clubProject);
    const gain = clubProject.master.devices.find((d) => d.type === 'limiter')?.params.gain ?? 0;
    expect(gain).toBeGreaterThan(8);
  });

  it('pulls a too-loud but clean mix back toward the target', () => {
    const corrections = planMaster(stats({ lufs: -11, truePeakDb: -3 }), streaming, 1, 0.9);
    const level = corrections.find((c) => c.id === 'master-level');
    expect(level).toBeDefined();
    const project = projectWith(track('polysynth'));
    level?.apply(project);
    expect(project.master.volume).toBeLessThan(0.9);
  });

  it('trims the master fader when the true peak is over the ceiling', () => {
    const corrections = planMaster(stats({ lufs: -12, truePeakDb: -0.4 }), streaming, 1, 1);
    const headroom = corrections.find((c) => c.id === 'master-headroom');
    expect(headroom).toBeDefined();
    const project = projectWith(track('polysynth'));
    headroom?.apply(project);
    expect(project.master.volume).toBeLessThan(1);
  });

  it('suggests tonal balance moves for a bass-heavy mix', () => {
    const corrections = planMaster(
      stats({ lufs: -16, bands: { low: 46, lowMid: 30, mid: 18, high: 6 } }),
      streaming,
      1,
      0.9,
    );
    const eq = corrections.find((c) => c.id === 'master-eq');
    expect(eq?.detail).toContain('low shelf');
    const project = projectWith(track('polysynth'));
    eq?.apply(project);
    const device = project.master.devices.find((d) => d.type === 'eq3');
    expect(device?.params.lowGain).toBeLessThan(0);
    expect(device?.params.highGain).toBeGreaterThan(0);
  });

  it('leaves a silent mix alone', () => {
    expect(planMaster(stats({ silent: true }), streaming, 1, 0.9)).toEqual([]);
  });
});
