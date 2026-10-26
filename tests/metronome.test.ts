import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METRONOME_SETTINGS,
  countInBeats,
  countInClickLevel,
  countInLabel,
  normalizeMetronomeSettings,
} from '../src/audio/metronome';

describe('metronome settings', () => {
  it('provides safe defaults for a missing or malformed block', () => {
    expect(normalizeMetronomeSettings(undefined)).toEqual(DEFAULT_METRONOME_SETTINGS);
    expect(
      normalizeMetronomeSettings({
        enabled: 'yes',
        volume: 4,
        accent: false,
        sound: 'noise',
        subdivision: 3,
        countIn: 1,
        countInBars: 9,
      }),
    ).toEqual({
      enabled: false,
      volume: 1,
      accent: false,
      sound: 'classic',
      subdivision: 1,
      countIn: false,
      countInBars: 1,
    });
  });

  it('keeps valid values and normalises fractional volume', () => {
    expect(
      normalizeMetronomeSettings({
        enabled: true,
        volume: -0.3,
        accent: true,
        sound: 'wood',
        subdivision: 4,
        countIn: true,
        countInBars: 4,
      }),
    ).toEqual({
      enabled: true,
      volume: 0,
      accent: true,
      sound: 'wood',
      subdivision: 4,
      countIn: true,
      countInBars: 4,
    });
  });
});

describe('count-in maths', () => {
  it('uses the project meter and the selected number of bars', () => {
    expect(countInBeats({ countIn: false, countInBars: 2 }, 4)).toBe(0);
    expect(countInBeats({ countIn: true, countInBars: 1 }, 4)).toBe(4);
    expect(countInBeats({ countIn: true, countInBars: 2 }, 4)).toBe(8);
    expect(countInBeats({ countIn: true, countInBars: 1 }, 3)).toBe(3);
  });

  it('accents the first beat of each count-in bar', () => {
    expect(countInClickLevel({ accent: true }, 0, 4)).toBe('accent');
    expect(countInClickLevel({ accent: true }, 1, 4)).toBe('beat');
    expect(countInClickLevel({ accent: true }, 4, 4)).toBe('accent');
    expect(countInClickLevel({ accent: false }, 0, 4)).toBe('beat');
  });

  it('labels the two states readably', () => {
    expect(countInLabel({ countIn: false, countInBars: 2 })).toBe('Count-in off');
    expect(countInLabel({ countIn: true, countInBars: 1 })).toBe('Count-in 1 bar');
    expect(countInLabel({ countIn: true, countInBars: 2 })).toBe('Count-in 2 bars');
  });
});
