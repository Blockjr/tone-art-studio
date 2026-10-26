import { describe, expect, it } from 'vitest';
import {
  DELAY_MODES,
  NOTE_DIVISIONS,
  REVERB_MODES,
  dampingCutoff,
  dampingSlope,
  delayMode,
  delayTimeSeconds,
  duckDepth,
  duckGain,
  duckReleaseCutoff,
  formatDelayTime,
  freezeFeedback,
  noteDivision,
  reverbMode,
  rt60Gain,
  syncedTime,
} from '../src/audio/fxmath';

describe('delay maths', () => {
  it('offers the four classic delay technologies', () => {
    expect(DELAY_MODES.map((mode) => mode.id)).toEqual(['tape', 'bbd', 'digital', 'pingpong']);
    expect(delayMode(0).name).toBe('Tape');
    expect(delayMode(99).id).toBe('pingpong');
    expect(delayMode(-4).id).toBe('tape');
  });

  it('syncs note divisions to the tempo', () => {
    expect(syncedTime(4, 120)).toBeCloseTo(0.5, 6); // quarter
    expect(syncedTime(2, 120)).toBeCloseTo(0.25, 6); // eighth
    expect(syncedTime(1, 120)).toBeCloseTo(1 / 6, 5); // eighth triplet
    expect(syncedTime(3, 120)).toBeCloseTo(0.375, 6); // dotted eighth
    expect(noteDivision(0).id).toBe('1/16');
    expect(NOTE_DIVISIONS).toHaveLength(5);
    // Extreme tempos are clamped rather than producing silence or a huge time.
    expect(syncedTime(0, 1000)).toBeGreaterThanOrEqual(0.02);
    expect(syncedTime(4, 10)).toBeLessThanOrEqual(2);
  });

  it('respects the storage limit of each technology', () => {
    const bbd = delayMode(1);
    const tape = delayMode(0);
    expect(delayTimeSeconds(2, false, 0, 120, bbd)).toBeCloseTo(bbd.maxTime, 6);
    expect(delayTimeSeconds(2, false, 0, 120, tape)).toBeCloseTo(tape.maxTime, 6);
    expect(delayTimeSeconds(0.001, false, 0, 120, tape)).toBeCloseTo(0.02, 6);
  });

  it('turns a decay time into a stable feedback gain', () => {
    // A 40 ms loop with a 2 s RT60 feeds back at about 0.87.
    expect(rt60Gain(0.04, 2)).toBeCloseTo(0.871, 3);
    // Longer loops need less feedback for the same decay.
    expect(rt60Gain(0.08, 2)).toBeLessThan(rt60Gain(0.04, 2));
    // Longer decays need more feedback, and nothing ever reaches unity.
    expect(rt60Gain(0.04, 8)).toBeGreaterThan(rt60Gain(0.04, 2));
    expect(rt60Gain(0.04, 1000)).toBeLessThanOrEqual(0.999);
    expect(rt60Gain(0.04, 0)).toBe(0);
  });

  it('maps damping to a falling low-pass corner', () => {
    expect(dampingCutoff(0)).toBeGreaterThan(17000);
    expect(dampingCutoff(1)).toBeLessThan(1000);
    expect(dampingCutoff(0.5)).toBeLessThan(dampingCutoff(0.2));
    expect(dampingSlope(1)).toBeGreaterThan(dampingSlope(0));
  });

  it('formats times the way the panel shows them', () => {
    expect(formatDelayTime(0.342)).toBe('342 ms');
    expect(formatDelayTime(1.25)).toBe('1.25 s');
    expect(formatDelayTime(Number.NaN)).toBe('—');
  });

  it('ducks the repeats by an audio-rate envelope', () => {
    expect(duckDepth(0)).toBe(0);
    expect(duckDepth(1)).toBeCloseTo(0.85, 6);
    expect(duckDepth(-3)).toBe(0);
    // Full envelope at full amount leaves 15% of the wet signal (−16.5 dB).
    expect(duckGain(1, 1)).toBeCloseTo(0.15, 6);
    expect(duckGain(0, 1)).toBe(1);
    expect(duckGain(2, 1)).toBeCloseTo(0.15, 6);
    expect(duckGain(1, 0)).toBe(1);
    // More reduction at more amount, but never inverted.
    expect(duckGain(1, 0.6)).toBeLessThan(duckGain(1, 0.2));
    expect(duckGain(1, 1)).toBeGreaterThan(0);
  });

  it('maps release time to a smoothed envelope corner', () => {
    expect(duckReleaseCutoff(0.18)).toBeCloseTo(0.884, 2);
    expect(duckReleaseCutoff(0.05)).toBeGreaterThan(duckReleaseCutoff(0.4));
    expect(duckReleaseCutoff(0.01)).toBeLessThanOrEqual(30);
    expect(duckReleaseCutoff(2)).toBeGreaterThanOrEqual(0.3);
  });

  it('holds the loop just under unity when frozen', () => {
    expect(freezeFeedback(true, 0.3)).toBe(0.9998);
    expect(freezeFeedback(true, 0)).toBe(0.9998);
    expect(freezeFeedback(true, 0.99)).toBeLessThan(1);
    expect(freezeFeedback(false, 0.2)).toBe(0.2);
    expect(freezeFeedback(false, 2)).toBe(0.985);
    expect(freezeFeedback(false, -1)).toBe(0);
  });
});

describe('reverb maths', () => {
  it('offers plate, hall and room with distinct space character', () => {
    expect(REVERB_MODES.map((mode) => mode.id)).toEqual(['plate', 'hall', 'room']);
    const plate = reverbMode(0);
    const hall = reverbMode(1);
    const room = reverbMode(2);
    expect(hall.delayScale).toBeGreaterThan(plate.delayScale);
    expect(hall.delayScale).toBeGreaterThan(room.delayScale);
    // A plate has almost no discrete early reflections; a room leans on them.
    expect(plate.early).toBeLessThan(room.early);
    expect(plate.mod).toBeGreaterThan(hall.mod);
    expect(reverbMode(42).id).toBe('room');
  });
});

import {
  CHORUS_MODES,
  DRIVE_MODES,
  FILTER_MODES,
  analyserPeak,
  chorusDepth,
  chorusMode,
  chorusPan,
  chorusPhaseOffset,
  chorusVoiceDelay,
  driveCurvePoints,
  driveMakeup,
  driveMode,
  driveShape,
  filterMode,
  kneeDb,
  lfoShape,
  limiterMode,
  meterDb,
  programRelease,
  tapeBiasShape,
  tapeFlutterDepth,
  tapeWowDepth,
} from '../src/audio/fxmath';

describe('drive maths', () => {
  it('offers four circuits with different harmonic characters', () => {
    expect(DRIVE_MODES.map((mode) => mode.id)).toEqual(['warm', 'tube', 'fuzz', 'fold']);
    expect(driveMode(1).name).toBe('Tube');
    expect(driveMode(99).id).toBe('fold');
    expect(driveMode(-3).id).toBe('warm');
  });

  it('stays bounded and level-matched at every drive setting', () => {
    for (const mode of DRIVE_MODES.keys()) {
      for (const amount of [0, 0.35, 1]) {
        const curve = driveCurvePoints(amount, mode);
        for (const point of curve) {
          expect(Math.abs(point.y)).toBeLessThanOrEqual(1);
        }
        expect(curve[0].y).toBeLessThan(0);
        expect(curve.at(-1)!.y).toBeGreaterThan(0);
      }
    }
  });

  it('bends harder with drive and centres the clean curve', () => {
    const clean = driveCurvePoints(0, 0);
    const driven = driveCurvePoints(0.8, 0);
    expect(clean[60].y).toBeCloseTo(0, 6);
    expect(clean[90].y).toBeCloseTo(0.5, 1);
    // A driven curve reaches closer to full scale for the same input.
    expect(driven[80].y).toBeGreaterThan(clean[80].y);
    expect(driveMakeup(0, 0)).toBeCloseTo(1, 6);
    expect(driveMakeup(1, 2)).toBeLessThan(1);
  });

  it('makes tube drive asymmetric and fuzz saturate early', () => {
    const tubeUp = driveShape(0.4, 0.7, 1);
    const tubeDown = driveShape(-0.4, 0.7, 1);
    expect(Math.abs(tubeUp + tubeDown)).toBeGreaterThan(0.05);
    const warmUp = driveShape(0.4, 0.7, 0);
    const warmDown = driveShape(-0.4, 0.7, 0);
    expect(warmUp + warmDown).toBeCloseTo(0, 4);
    const fuzz = driveCurvePoints(1, 2);
    expect(fuzz[80].y).toBeCloseTo(1, 1);
  });
});

describe('filter maths', () => {
  it('names the four responses', () => {
    expect(FILTER_MODES.map((mode) => mode.id)).toEqual(['lowpass', 'highpass', 'bandpass', 'notch']);
    expect(filterMode(1).label).toBe('HP');
    expect(filterMode(9).id).toBe('notch');
  });

  it('runs a phase-continuous LFO', () => {
    expect(lfoShape(0)).toBeCloseTo(0, 6);
    expect(lfoShape(0.25)).toBeCloseTo(1, 6);
    expect(lfoShape(1.25)).toBeCloseTo(lfoShape(0.25), 6);
    expect(lfoShape(0, 'triangle')).toBeCloseTo(-1, 6);
    expect(lfoShape(0.5, 'triangle')).toBeCloseTo(1, 6);
  });
});

describe('chorus maths', () => {
  it('spreads two or three voices across the field', () => {
    expect(CHORUS_MODES.map((mode) => mode.id)).toEqual(['chorus', 'ensemble', 'vibrato']);
    expect(chorusMode(1).voices).toBe(3);
    expect(chorusPhaseOffset(0, 3)).toBe(0);
    expect(chorusPhaseOffset(1, 3)).toBeCloseTo(1 / 3, 6);
    expect(chorusPan(0, 2, 1)).toBe(-1);
    expect(chorusPan(1, 2, 1)).toBe(1);
    expect(chorusPan(1, 3, 1)).toBeCloseTo(0, 6);
    expect(chorusPan(0, 1, 1)).toBe(0);
  });

  it('keeps every voice inside the delay budget', () => {
    for (const index of [0, 1, 2]) {
      for (const voice of [0, 1, 2]) {
        const delay = chorusVoiceDelay(voice, 0.018, index);
        expect(delay).toBeGreaterThanOrEqual(0.002);
        expect(delay).toBeLessThanOrEqual(0.06);
      }
      expect(chorusDepth(1, index)).toBeGreaterThan(0);
      expect(chorusDepth(0, index)).toBe(0);
    }
    expect(chorusVoiceDelay(1, 0.018, 1)).toBeGreaterThan(chorusVoiceDelay(1, 0.018, 0));
  });
});

describe('dynamics and meter maths', () => {
  it('maps knees and limiter modes', () => {
    expect(kneeDb(0)).toBe(0);
    expect(kneeDb(0.5)).toBe(12);
    expect(limiterMode(0).ratio).toBeGreaterThan(limiterMode(1).ratio);
    expect(limiterMode(0).attack).toBeLessThan(limiterMode(1).attack);
    expect(limiterMode(4).id).toBe('transparent');
    expect(programRelease(0.3, 1)).toBeLessThan(programRelease(0.3, 0));
    expect(programRelease(0.3, 1)).toBeGreaterThanOrEqual(0.02);
  });

  it('reads analyser bytes as a peak and dB', () => {
    expect(analyserPeak(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(analyserPeak(new Uint8Array([128, 192]))).toBeCloseTo(0.5, 6);
    expect(meterDb(1)).toBeCloseTo(0, 6);
    expect(meterDb(0.5)).toBeCloseTo(-6.02, 1);
    expect(meterDb(0)).toBe(-60);
  });
});

describe('tape maths', () => {
  it('scales wow and flutter and keeps bias asymmetric', () => {
    expect(tapeWowDepth(0)).toBe(0);
    expect(tapeWowDepth(1)).toBeGreaterThan(tapeFlutterDepth(1));
    expect(tapeBiasShape(0.5, 0) + tapeBiasShape(-0.5, 0)).toBeCloseTo(0, 6);
    expect(tapeBiasShape(0.5, 0.7) + tapeBiasShape(-0.5, 0.7)).not.toBeCloseTo(0, 2);
    expect(Math.abs(tapeBiasShape(1, 0.7))).toBeLessThanOrEqual(1);
  });
});
