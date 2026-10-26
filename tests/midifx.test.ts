import { describe, expect, it } from 'vitest';
import {
  applyMidiFx,
  applyMidiFxDevice,
  createMidiFx,
  defaultMidiFxParams,
  describeMidiFx,
  scalePitch,
  transformNotes,
} from '../src/core/midifx';
import { decodeMidiMessage, keyToPitch } from '../src/audio/midiinput';
import type { MidiFxState } from '../src/core/types';

const note = (pitch: number, start = 0, duration = 1, velocity = 0.8) => ({ pitch, start, duration, velocity });

function device(type: MidiFxState['type'], params: Record<string, number> = {}): MidiFxState {
  return {
    id: `mfx-${type}`,
    type,
    enabled: true,
    params: { ...defaultMidiFxParams(type), ...params },
  };
}

describe('MIDI effects: defaults', () => {
  it('starts every device neutral, so adding one changes nothing at first', () => {
    for (const type of ['chord', 'scale', 'arp', 'velocity', 'pitch', 'notelength'] as const) {
      const state = createMidiFx(type);
      expect(state.enabled).toBe(true);
      expect(state.params).toEqual(defaultMidiFxParams(type));
    }

    // A device at its defaults is transparent for a plain in-range note.
    const played = applyMidiFxDevice(device('chord'), [note(60)], { secondsPerBeat: 0.5 });
    expect(played).toHaveLength(1);
    expect(played[0].pitch).toBe(60);
  });

  it('has a description for every device', () => {
    for (const type of ['chord', 'scale', 'arp', 'velocity', 'pitch', 'notelength'] as const) {
      expect(describeMidiFx(device(type)).length).toBeGreaterThan(0);
    }
  });
});

describe('Chord', () => {
  it('adds each configured shift to the input note', () => {
    const state = device('chord', { shift1: 4, shift2: 7 });
    const played = applyMidiFxDevice(state, [note(60)], { secondsPerBeat: 0.5 });
    expect(played.map((entry) => entry.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67]);
    expect(played).toHaveLength(3);
  });

  it('ignores a shift of zero and de-duplicates identical shifts', () => {
    const state = device('chord', { shift1: 12, shift2: 12, shift3: 0 });
    const played = applyMidiFxDevice(state, [note(60)], { secondsPerBeat: 0.5 });
    expect(played.map((entry) => entry.pitch).sort((a, b) => a - b)).toEqual([60, 72]);
  });

  it('clamps generated notes into the MIDI range', () => {
    const state = device('chord', { shift1: 36 });
    const played = applyMidiFxDevice(state, [note(120)], { secondsPerBeat: 0.5 });
    expect(played.map((entry) => entry.pitch)).toContain(127);
  });

  it('scales velocity and keeps chance at 100 by default', () => {
    const state = device('chord', { shift1: 7, velocity: 50 });
    const played = applyMidiFxDevice(state, [note(60, 0, 1, 0.8)], { secondsPerBeat: 0.5 });
    expect(played.every((entry) => entry.velocity === 0.4)).toBe(true);
  });

  it('strums the added notes, in seconds converted to beats', () => {
    const state = device('chord', { shift1: 4, shift2: 7, strum: 100 });
    // 100 ms at 120 bpm (0.5 s per beat) is 0.2 beats.
    const played = applyMidiFxDevice(state, [note(60)], { secondsPerBeat: 0.5 });
    expect(played.map((entry) => entry.start)).toEqual([0, 0.2, 0.4]);
  });
});

describe('Scale', () => {
  it('snaps a note onto the nearest scale degree', () => {
    // C major: C#, D#, F#, G#, A# are outside and move up one semitone here.
    const steps = [0, 2, 4, 5, 7, 9, 11];
    expect(scalePitch(1, 0, steps, false)).toBe(2);
    expect(scalePitch(3, 0, steps, false)).toBe(4);
    expect(scalePitch(0, 0, steps, false)).toBe(0);
  });

  it('keeps an in-scale note unchanged', () => {
    const state = device('scale', { base: 0, scale: 0 });
    const played = applyMidiFxDevice(state, [note(60), note(64), note(67)], { secondsPerBeat: 0.5 });
    expect(played.map((entry) => entry.pitch)).toEqual([60, 64, 67]);
  });

  it('honours the base note and the transpose', () => {
    const state = device('scale', { base: 2, scale: 0, transpose: 12 });
    // D major, up an octave: 62 stays 62 and then moves to 74.
    const played = applyMidiFxDevice(state, [note(62)], { secondsPerBeat: 0.5 });
    expect(played[0].pitch).toBe(74);
  });

  it('drops notes that fall outside the range after octave folding', () => {
    const state = device('scale', { lowest: 60, range: 1 });
    const played = applyMidiFxDevice(state, [note(40), note(100)], { secondsPerBeat: 0.5 });
    expect(played).toHaveLength(0);
  });
});

describe('Arpeggiator', () => {
  it('spreads a chord into steps at the chosen rate', () => {
    const state = device('arp', { style: 0, rate: 0.25, gate: 100, octaves: 1 });
    const played = applyMidiFxDevice(
      state,
      [note(60, 0, 1), note(64, 0, 1), note(67, 0, 1)],
      { secondsPerBeat: 0.5 },
    );
    expect(played.map((entry) => entry.pitch)).toEqual([60, 64, 67, 60]);
    expect(played.map((entry) => entry.start)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('goes down for the Down style', () => {
    const state = device('arp', { style: 1, rate: 0.5 });
    const played = applyMidiFxDevice(state, [note(60, 0, 1), note(67, 0, 1)], { secondsPerBeat: 0.5 });
    expect(played[0].pitch).toBe(67);
  });

  it('adds octaves above the chord', () => {
    const state = device('arp', { octaves: 2, rate: 0.25, repeats: 6 });
    const played = applyMidiFxDevice(state, [note(60, 0, 2), note(64, 0, 2)], { secondsPerBeat: 0.5 });
    expect(Math.max(...played.map((entry) => entry.pitch))).toBe(76);
  });

  it('shortens steps by the gate', () => {
    const state = device('arp', { rate: 1, gate: 50, repeats: 2 });
    const played = applyMidiFxDevice(state, [note(60, 0, 4)], { secondsPerBeat: 0.5 });
    expect(played[0].duration).toBeCloseTo(0.5, 6);
  });
});

describe('Velocity', () => {
  it('maps the input range onto the output range', () => {
    const state = device('velocity', { lowest: 1, range: 127, outLow: 64, outHi: 127 });
    const quiet = applyMidiFxDevice(state, [note(60, 0, 1, 1 / 127)], { secondsPerBeat: 0.5 });
    const loud = applyMidiFxDevice(state, [note(60, 0, 1, 1)], { secondsPerBeat: 0.5 });
    expect(Math.round(quiet[0].velocity * 127)).toBe(64);
    expect(Math.round(loud[0].velocity * 127)).toBe(127);
  });

  it('drops notes outside the range in Gate mode', () => {
    const state = device('velocity', { lowest: 64, range: 64, mode: 1 });
    expect(applyMidiFxDevice(state, [note(60, 0, 1, 0.2)], { secondsPerBeat: 0.5 })).toHaveLength(0);
  });

  it('uses Out Hi for every note in Fixed mode', () => {
    const state = device('velocity', { mode: 2, outHi: 100 });
    const played = applyMidiFxDevice(state, [note(60, 0, 1, 0.3)], { secondsPerBeat: 0.5 });
    expect(Math.round(played[0].velocity * 127)).toBe(100);
  });
});

describe('Pitch', () => {
  it('transposes every note', () => {
    const state = device('pitch', { semitones: 12 });
    expect(applyMidiFxDevice(state, [note(60)], { secondsPerBeat: 0.5 })[0].pitch).toBe(72);
  });

  it('blocks, folds or limits notes that leave the range', () => {
    const blocked = device('pitch', { semitones: 24, mode: 0, lowest: 0, range: 72 });
    expect(applyMidiFxDevice(blocked, [note(60)], { secondsPerBeat: 0.5 })).toHaveLength(0);

    const folded = device('pitch', { semitones: 24, mode: 1, lowest: 0, range: 72 });
    expect(applyMidiFxDevice(folded, [note(60)], { secondsPerBeat: 0.5 })[0].pitch).toBe(60);

    const limited = device('pitch', { semitones: 24, mode: 2, lowest: 0, range: 72 });
    expect(applyMidiFxDevice(limited, [note(60)], { secondsPerBeat: 0.5 })[0].pitch).toBe(71);
  });
});

describe('Note Length', () => {
  it('multiplies length and applies the gate', () => {
    const state = device('notelength', { length: 2, gate: 50 });
    expect(applyMidiFxDevice(state, [note(60, 0, 1)], { secondsPerBeat: 0.5 })[0].duration).toBe(1);
  });
});

describe('Chains', () => {
  it('runs devices left to right', () => {
    const chain = [device('pitch', { semitones: 12 }), device('chord', { shift1: 7 })];
    const played = applyMidiFx(chain, [note(60)], { secondsPerBeat: 0.5 });
    // Pitch first (72), then the chord adds a fifth above it.
    expect(played.map((entry) => entry.pitch).sort((a, b) => a - b)).toEqual([72, 79]);
  });

  it('skips disabled devices and empty chains', () => {
    const disabled = { ...device('pitch', { semitones: 12 }), enabled: false };
    expect(applyMidiFx([disabled], [note(60)]).map((entry) => entry.pitch)).toEqual([60]);
    expect(applyMidiFx(undefined, [note(60)]).map((entry) => entry.pitch)).toEqual([60]);
  });

  it('turns stored notes into playable notes with fresh ids', () => {
    const chain = [device('chord', { shift1: 7 })];
    const generated = transformNotes(
      chain,
      [{ id: 'n1', pitch: 60, start: 1, duration: 1, velocity: 0.8 }],
      { secondsPerBeat: 0.5 },
    );
    expect(generated).toHaveLength(2);
    expect(generated.every((entry) => entry.id !== 'n1')).toBe(true);
    expect(generated.map((entry) => entry.start)).toEqual([1, 1]);
  });
});

describe('MIDI messages', () => {
  it('decodes note on and note off', () => {
    expect(decodeMidiMessage([0x90, 60, 100])).toMatchObject({ kind: 'noteOn', pitch: 60, velocity: 100, channel: 1 });
    expect(decodeMidiMessage([0x80, 60, 0])).toMatchObject({ kind: 'noteOff', pitch: 60 });
  });

  it('treats a note on with velocity 0 as a note off', () => {
    expect(decodeMidiMessage([0x90, 64, 0])).toMatchObject({ kind: 'noteOff', pitch: 64 });
  });

  it('decodes controllers and pitch bend', () => {
    expect(decodeMidiMessage([0xb0, 64, 127])).toMatchObject({ kind: 'control', controller: 64, value: 127 });
    expect(decodeMidiMessage([0xe0, 0x00, 0x40])).toMatchObject({ kind: 'pitchBend', bend: 0 });
  });

  it('ignores system messages and empty data', () => {
    expect(decodeMidiMessage([0xf8])?.kind).toBe('other');
    expect(decodeMidiMessage([])).toBeNull();
  });
});

describe('Computer keyboard', () => {
  it('maps the white keys from C', () => {
    expect(keyToPitch('a', 3)).toBe(48);
    expect(keyToPitch('s', 3)).toBe(50);
    expect(keyToPitch('d', 3)).toBe(52);
    expect(keyToPitch('j', 3)).toBe(59);
  });

  it('maps the black keys onto the sharps', () => {
    expect(keyToPitch('w', 3)).toBe(49);
    expect(keyToPitch('e', 3)).toBe(51);
    expect(keyToPitch('t', 3)).toBe(54);
  });

  it('shifts with the octave and the transpose', () => {
    expect(keyToPitch('a', 4)).toBe(60);
    expect(keyToPitch('a', 3, 12)).toBe(60);
  });

  it('ignores keys that are not notes', () => {
    expect(keyToPitch('1', 3)).toBeNull();
    expect(keyToPitch(' ', 3)).toBeNull();
  });

  it('refuses pitches outside the MIDI range', () => {
    expect(keyToPitch('a', 11)).toBeNull();
  });
});
