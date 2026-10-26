export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const beatsToSeconds = (beats: number, bpm: number): number => (beats * 60) / bpm;

export const secondsToBeats = (seconds: number, bpm: number): number => (seconds * bpm) / 60;

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(midi: number): string {
  const rounded = Math.round(midi);
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

export function snapBeat(beat: number, grid: number): number {
  if (grid <= 0) return beat;
  return Math.round(beat / grid) * grid;
}

/** 1-based bar.beat.sixteenth, Ableton style. */
export function formatBars(beat: number, beatsPerBar = 4): string {
  const safe = Math.max(0, beat);
  const bar = Math.floor(safe / beatsPerBar) + 1;
  const beatInBar = Math.floor(safe % beatsPerBar) + 1;
  const sixteenth = Math.floor((safe % 1) * 4) + 1;
  return `${bar}.${beatInBar}.${sixteenth}`;
}

/**
 * Reads a typed location back into beats. Accepts `bar`, `bar.beat` or
 * `bar.beat.sixteenth`, with any separator; positions are 1-based like the
 * transport readout. Returns null when the text is not a location.
 */
export function parseBars(text: string, beatsPerBar = 4): number | null {
  const parts = text.trim().split(/[.:\s]+/).filter(Boolean).map(Number);
  if (parts.length === 0 || parts.length > 3) return null;
  if (parts.some((part) => !Number.isFinite(part))) return null;

  const [bar = 1, beat = 1, sixteenth = 1] = parts;
  if (!Number.isInteger(bar) || !Number.isInteger(beat) || !Number.isInteger(sixteenth)) return null;
  if (bar < 1 || beat < 1 || beat > beatsPerBar || sixteenth < 1 || sixteenth > 16) return null;

  return (bar - 1) * beatsPerBar + (beat - 1) + (sixteenth - 1) / 4;
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Gain in dB -> linear (0 dB = 1). */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linear gain -> dB, floored at -Infinity for silence. */
export function gainToDb(gain: number): number {
  if (gain <= 0.000001) return -120;
  return 20 * Math.log10(gain);
}
