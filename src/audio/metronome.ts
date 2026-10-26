import { clamp } from '../core/time';

/** The three click characters offered by the transport. */
export type ClickSound = 'classic' | 'click' | 'wood';

/** Quarter notes, eighth notes or sixteenth notes. */
export type ClickSubdivision = 1 | 2 | 4;

/** Count-in lengths offered in the settings panel. */
export type CountInBars = 1 | 2 | 4;

/** A scheduled click's role, which decides its pitch and level. */
export type ClickLevel = 'accent' | 'beat' | 'subdivision';

export interface MetronomeSettings {
  /** the transport click is audible during playback */
  enabled: boolean;
  /** 0..1, scaled before the click bus */
  volume: number;
  /** accent beat one of every bar */
  accent: boolean;
  sound: ClickSound;
  /** how many clicks fit in one beat */
  subdivision: ClickSubdivision;
  /** count down before the transport starts rolling */
  countIn: boolean;
  countInBars: CountInBars;
}

export interface ClickSoundInfo {
  id: ClickSound;
  label: string;
  detail: string;
}

export const CLICK_SOUNDS: ClickSoundInfo[] = [
  { id: 'classic', label: 'Classic', detail: 'Warm sine blip' },
  { id: 'click', label: 'Click', detail: 'Short, bright tick' },
  { id: 'wood', label: 'Wood', detail: 'Dry woodblock knock' },
];

export const COUNT_IN_OPTIONS: { id: CountInBars; label: string }[] = [
  { id: 1, label: '1 bar' },
  { id: 2, label: '2 bars' },
  { id: 4, label: '4 bars' },
];

export const DEFAULT_METRONOME_SETTINGS: MetronomeSettings = {
  enabled: false,
  volume: 0.55,
  accent: true,
  sound: 'classic',
  subdivision: 1,
  countIn: false,
  countInBars: 1,
};

function isClickSound(value: unknown): value is ClickSound {
  return value === 'classic' || value === 'click' || value === 'wood';
}

function isCountInBars(value: unknown): value is CountInBars {
  return value === 1 || value === 2 || value === 4;
}

/**
 * Reads metronome settings from storage or the engine. Unknown or malformed
 * values fall back to the defaults instead of leaving the transport with a
 * silent or impossibly long click.
 */
export function normalizeMetronomeSettings(value: unknown): MetronomeSettings {
  const candidate = value && typeof value === 'object' ? (value as Partial<MetronomeSettings>) : {};
  const volume = typeof candidate.volume === 'number' && Number.isFinite(candidate.volume)
    ? clamp(candidate.volume, 0, 1)
    : DEFAULT_METRONOME_SETTINGS.volume;

  return {
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : DEFAULT_METRONOME_SETTINGS.enabled,
    volume,
    accent: typeof candidate.accent === 'boolean' ? candidate.accent : DEFAULT_METRONOME_SETTINGS.accent,
    sound: isClickSound(candidate.sound) ? candidate.sound : DEFAULT_METRONOME_SETTINGS.sound,
    subdivision: candidate.subdivision === 2 || candidate.subdivision === 4 ? candidate.subdivision : 1,
    countIn: typeof candidate.countIn === 'boolean' ? candidate.countIn : DEFAULT_METRONOME_SETTINGS.countIn,
    countInBars: isCountInBars(candidate.countInBars)
      ? candidate.countInBars
      : DEFAULT_METRONOME_SETTINGS.countInBars,
  };
}

/** Total quarter-note clicks in a count-in: bars × beats per bar. */
export function countInBeats(settings: Pick<MetronomeSettings, 'countIn' | 'countInBars'>, beatsPerBar: number): number {
  if (!settings.countIn) return 0;
  return Math.max(1, Math.round(beatsPerBar)) * settings.countInBars;
}

/** Human label for a count-in, used in the transport tooltip and help. */
export function countInLabel(settings: Pick<MetronomeSettings, 'countIn' | 'countInBars'>): string {
  if (!settings.countIn) return 'Count-in off';
  return `Count-in ${settings.countInBars} bar${settings.countInBars === 1 ? '' : 's'}`;
}

/** Click level for each quarter-note count-in beat, accenting bar downbeats. */
export function countInClickLevel(
  settings: Pick<MetronomeSettings, 'accent'>,
  beatIndex: number,
  beatsPerBar: number,
): ClickLevel {
  const bar = Math.max(1, Math.round(beatsPerBar));
  return settings.accent && beatIndex % bar === 0 ? 'accent' : 'beat';
}
