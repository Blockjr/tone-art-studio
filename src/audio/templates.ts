import { createDevice } from '../core/project';
import type { Store } from '../core/store';
import type { DeviceState, DeviceType } from '../core/types';
import { DEVICE_SPECS } from './specs';

/**
 * Built-in mix and master chains, arranged the way a console workflow would
 * stack them: trim/tone first, dynamics next, colour last, limiter at the end
 * of the master. They are starting points with safe gain staging, not a
 * substitute for listening in context.
 *
 * The modules are inspired by the workflows of classic SSL-style console
 * strips and modular Slate-style racks. Names, panels and code are original;
 * no product branding or trade dress is reproduced.
 */
export interface TemplateModule {
  type: DeviceType;
  params?: Record<string, number>;
  enabled?: boolean;
}

export interface ChainTemplate {
  id: string;
  name: string;
  target: 'track' | 'master';
  category: 'Vocal' | 'Drums' | 'Bass' | 'Keys & Guitar' | 'Bus' | 'Mastering';
  description: string;
  /** short signal-flow summary shown in the template picker */
  chain: string;
  modules: TemplateModule[];
}

export const CHAIN_TEMPLATES: ChainTemplate[] = [
  {
    id: 'vocal-pop',
    name: 'Vocal — Pop Presence',
    target: 'track',
    category: 'Vocal',
    description:
      'Clean the low end, control peaks with a fast FET, then level smoothly with the opto and add air. Built for a lead that has to sit forward without harshness.',
    chain: 'Console Strip → FET Comp → Opto Leveler → Air',
    modules: [
      {
        type: 'console',
        params: {
          hpf: 90,
          lowFreq: 120,
          lowGain: -1,
          midFreq: 3200,
          midGain: 2.5,
          midQ: 1.1,
          highFreq: 10000,
          highGain: 1.5,
          threshold: -24,
          ratio: 3,
          attack: 0.01,
          release: 0.2,
          makeup: 3,
          drive: 0.05,
        },
      },
      { type: 'fet', params: { input: 3, ratio: 4, attack: 0.003, release: 0.12, output: 4, mix: 1, all: 0 } },
      { type: 'opto', params: { peak: 35, gain: 2, mode: 0, mix: 1 } },
      { type: 'air', params: { mid: 30, high: 45, drive: 0.12, trim: -1 } },
    ],
  },
  {
    id: 'vocal-warm',
    name: 'Vocal — Warm Double',
    target: 'track',
    category: 'Vocal',
    description:
      'Subtractive console EQ, two gentle dynamics stages for density, then tape for weight. Suits double-tracks and soulful leads where smoothness matters more than air.',
    chain: 'Console Strip → FET Comp → Opto Leveler → Tape',
    modules: [
      {
        type: 'console',
        params: {
          hpf: 100,
          lowFreq: 180,
          lowGain: -2,
          midFreq: 500,
          midGain: -1.5,
          midQ: 1.2,
          highFreq: 8500,
          highGain: 0.5,
          threshold: -26,
          ratio: 2.5,
          attack: 0.02,
          release: 0.25,
          makeup: 2,
          drive: 0.1,
        },
      },
      { type: 'fet', params: { input: 2, ratio: 4, attack: 0.006, release: 0.2, output: 3, mix: 0.85, all: 0 } },
      { type: 'opto', params: { peak: 45, gain: 2, mode: 0, mix: 1 } },
      { type: 'tape', params: { drive: 0.32, tone: 11000, mix: 0.4, output: 0 } },
    ],
  },
  {
    id: 'drums-punch',
    name: 'Drums — Console Punch',
    target: 'track',
    category: 'Drums',
    description:
      'Fast console compression grabs the shells without killing the transient, the FET adds snap, and tape rounds the cymbals. Aim for 3–4 dB of console gain reduction.',
    chain: 'Console Strip → FET Comp → Tape',
    modules: [
      {
        type: 'console',
        params: {
          hpf: 35,
          lowFreq: 80,
          lowGain: 2,
          midFreq: 400,
          midGain: -2,
          midQ: 0.9,
          highFreq: 8000,
          highGain: 3,
          threshold: -20,
          ratio: 4,
          attack: 0.02,
          release: 0.15,
          makeup: 4,
          drive: 0.12,
        },
      },
      { type: 'fet', params: { input: 2, ratio: 8, attack: 0.003, release: 0.1, output: 4, mix: 0.8, all: 0 } },
      { type: 'tape', params: { drive: 0.3, tone: 10000, mix: 0.35, output: -1 } },
    ],
  },
  {
    id: 'drums-bus',
    name: 'Drums — Glue & Weight',
    target: 'track',
    category: 'Drums',
    description:
      'A 4:1 VCA bus compressor with a slow attack for glue, a little console mid-scoop, and tape. Use on a drum submix rather than a single close mic.',
    chain: 'Bus Glue → Console Strip → Tape',
    modules: [
      { type: 'busglue', params: { threshold: -20, ratio: 4, attack: 0.01, release: 0.3, makeup: 3, mix: 1, auto: 1 } },
      {
        type: 'console',
        params: {
          hpf: 30,
          lowFreq: 70,
          lowGain: 1,
          midFreq: 500,
          midGain: -1,
          midQ: 1,
          highFreq: 9000,
          highGain: 1.5,
          threshold: -6,
          ratio: 1,
          attack: 0.03,
          release: 0.3,
          makeup: 0,
          drive: 0.08,
        },
      },
      { type: 'tape', params: { drive: 0.18, tone: 14000, mix: 0.25, output: 0 } },
    ],
  },
  {
    id: 'bass-anchor',
    name: 'Bass — Solid Anchor',
    target: 'track',
    category: 'Bass',
    description:
      'Opto leveling first for even notes, a focused low shelf and a small mid cut to make room for guitars, then a touch of tape. Keep the opto under 4 dB.',
    chain: 'Opto Leveler → Console Strip → Tape',
    modules: [
      { type: 'opto', params: { peak: 45, gain: 3, mode: 0, mix: 1 } },
      {
        type: 'console',
        params: {
          hpf: 30,
          lowFreq: 70,
          lowGain: 2.5,
          midFreq: 500,
          midGain: -2,
          midQ: 1.1,
          highFreq: 4500,
          highGain: 0.5,
          threshold: -6,
          ratio: 1,
          attack: 0.02,
          release: 0.25,
          makeup: 0,
          drive: 0.06,
        },
      },
      { type: 'tape', params: { drive: 0.25, tone: 9000, mix: 0.3, output: 0 } },
    ],
  },
  {
    id: 'keys-wide',
    name: 'Keys — Wide & Clean',
    target: 'track',
    category: 'Keys & Guitar',
    description:
      'Gentle console tone shaping, a light opto pass for even chords, and air on top. Leaves space for vocals instead of competing with them.',
    chain: 'Console Strip → Opto Leveler → Air',
    modules: [
      {
        type: 'console',
        params: {
          hpf: 60,
          lowFreq: 150,
          lowGain: -1,
          midFreq: 350,
          midGain: -1,
          midQ: 0.8,
          highFreq: 7000,
          highGain: 1.5,
          threshold: -8,
          ratio: 1,
          attack: 0.02,
          release: 0.3,
          makeup: 0,
          drive: 0.04,
        },
      },
      { type: 'opto', params: { peak: 30, gain: 1.5, mode: 0, mix: 1 } },
      { type: 'air', params: { mid: 20, high: 30, drive: 0.1, trim: -0.5 } },
    ],
  },
  {
    id: 'guitar-edge',
    name: 'Guitar — Edge & Bite',
    target: 'track',
    category: 'Keys & Guitar',
    description:
      'Console mid-forward EQ, FET peak control for pick attack, and tape to soften the top. Back the drive off for clean guitars.',
    chain: 'Console Strip → FET Comp → Tape',
    modules: [
      {
        type: 'console',
        params: {
          hpf: 100,
          lowFreq: 150,
          lowGain: -2,
          midFreq: 1500,
          midGain: 2,
          midQ: 1,
          highFreq: 7000,
          highGain: 1,
          threshold: -20,
          ratio: 3,
          attack: 0.01,
          release: 0.2,
          makeup: 2,
          drive: 0.08,
        },
      },
      { type: 'fet', params: { input: 2, ratio: 8, attack: 0.002, release: 0.15, output: 4, mix: 0.75, all: 0 } },
      { type: 'tape', params: { drive: 0.2, tone: 11000, mix: 0.3, output: 0 } },
    ],
  },
  {
    id: 'bus-glue',
    name: 'Bus — Glue & Tone',
    target: 'track',
    category: 'Bus',
    description:
      '2:1 bus compression with a slow attack, a flat-ish console stage, and a whisper of tape. Put this on a group bus, not the master.',
    chain: 'Bus Glue → Console Strip → Tape',
    modules: [
      { type: 'busglue', params: { threshold: -18, ratio: 2, attack: 0.03, release: 0.3, makeup: 2, mix: 1, auto: 1 } },
      {
        type: 'console',
        params: {
          hpf: 20,
          lowFreq: 100,
          lowGain: 0,
          midFreq: 700,
          midGain: -0.5,
          midQ: 0.7,
          highFreq: 12000,
          highGain: 0.5,
          threshold: -6,
          ratio: 1,
          attack: 0.03,
          release: 0.3,
          makeup: 0,
          drive: 0.03,
        },
      },
      { type: 'tape', params: { drive: 0.12, tone: 16000, mix: 0.2, output: 0 } },
    ],
  },
  {
    id: 'master-streaming',
    name: 'Master — Streaming Ready',
    target: 'master',
    category: 'Mastering',
    description:
      'Conservative 2:1 glue, a small tonal tilt, tape colour and a −1 dBTP limiter. Built for −14 LUFS streaming targets; push the limiter only after the mix is balanced.',
    chain: 'Bus Glue → Console Strip → Tape → Limiter',
    modules: [
      { type: 'busglue', params: { threshold: -20, ratio: 2, attack: 0.03, release: 0.3, makeup: 2, mix: 1, auto: 1 } },
      {
        type: 'console',
        params: {
          hpf: 20,
          lowFreq: 70,
          lowGain: 0.5,
          midFreq: 500,
          midGain: -0.5,
          midQ: 0.6,
          highFreq: 12000,
          highGain: 1,
          threshold: -6,
          ratio: 1,
          attack: 0.03,
          release: 0.3,
          makeup: 0,
          drive: 0.02,
        },
      },
      { type: 'tape', params: { drive: 0.16, tone: 15000, mix: 0.25, output: 0 } },
      { type: 'limiter', params: { ceiling: -1, release: 0.1, gain: 0 } },
    ],
  },
  {
    id: 'master-club',
    name: 'Master — Club Weight',
    target: 'master',
    category: 'Mastering',
    description:
      'A firmer 4:1 bus compressor, weight at 60 Hz and a little top, tape drive, and a −0.3 dBTP ceiling. Use after you have checked the mix on a full-range system.',
    chain: 'Bus Glue → Console Strip → Tape → Limiter',
    modules: [
      { type: 'busglue', params: { threshold: -22, ratio: 4, attack: 0.01, release: 0.3, makeup: 3, mix: 1, auto: 1 } },
      {
        type: 'console',
        params: {
          hpf: 20,
          lowFreq: 60,
          lowGain: 1.5,
          midFreq: 500,
          midGain: -0.5,
          midQ: 0.7,
          highFreq: 10000,
          highGain: 1,
          threshold: -6,
          ratio: 1,
          attack: 0.03,
          release: 0.3,
          makeup: 0,
          drive: 0.05,
        },
      },
      { type: 'tape', params: { drive: 0.38, tone: 13000, mix: 0.4, output: -1 } },
      { type: 'limiter', params: { ceiling: -0.3, release: 0.08, gain: 0 } },
    ],
  },
  {
    id: 'master-warm',
    name: 'Master — Warm Analog',
    target: 'master',
    category: 'Mastering',
    description:
      'Console tone first, then tape for harmonic weight and a gentle bus compressor to tie it together. Finish with a −1 dBTP limiter.',
    chain: 'Console Strip → Tape → Bus Glue → Limiter',
    modules: [
      {
        type: 'console',
        params: {
          hpf: 20,
          lowFreq: 80,
          lowGain: 1,
          midFreq: 400,
          midGain: -1,
          midQ: 0.7,
          highFreq: 11000,
          highGain: 0.5,
          threshold: -6,
          ratio: 1,
          attack: 0.03,
          release: 0.3,
          makeup: 0,
          drive: 0.06,
        },
      },
      { type: 'tape', params: { drive: 0.45, tone: 12000, mix: 0.5, output: -1.5 } },
      { type: 'busglue', params: { threshold: -18, ratio: 2, attack: 0.03, release: 0.3, makeup: 1, mix: 1, auto: 1 } },
      { type: 'limiter', params: { ceiling: -1, release: 0.12, gain: 0 } },
    ],
  },
  {
    id: 'master-clean',
    name: 'Master — Clean & Loud',
    target: 'master',
    category: 'Mastering',
    description:
      'The least coloured option: a small console tilt, a transparent 2:1 glue stage, and a limiter. For already-polished mixes that only need level and a little cohesion.',
    chain: 'Console Strip → Bus Glue → Limiter',
    modules: [
      {
        type: 'console',
        params: {
          hpf: 20,
          lowFreq: 100,
          lowGain: 0,
          midFreq: 800,
          midGain: -0.3,
          midQ: 0.6,
          highFreq: 12000,
          highGain: 0.3,
          threshold: -6,
          ratio: 1,
          attack: 0.03,
          release: 0.3,
          makeup: 0,
          drive: 0,
        },
      },
      { type: 'busglue', params: { threshold: -16, ratio: 2, attack: 0.03, release: 0.3, makeup: 1, mix: 1, auto: 1 } },
      { type: 'limiter', params: { ceiling: -1, release: 0.1, gain: 0 } },
    ],
  },
];

export function templatesFor(target: 'track' | 'master'): ChainTemplate[] {
  return CHAIN_TEMPLATES.filter((template) => template.target === target);
}

export function templateCategories(templates: ChainTemplate[]): string[] {
  return [...new Set(templates.map((template) => template.category))];
}

/** Builds real device states, clamping every preset value to its spec range. */
export function buildTemplateDevices(template: ChainTemplate): DeviceState[] {
  return template.modules.map((module) => {
    const device = createDevice(module.type);
    const spec = DEVICE_SPECS[module.type];
    for (const [key, value] of Object.entries(module.params ?? {})) {
      const param = spec.params.find((entry) => entry.key === key);
      if (!param || !Number.isFinite(value)) continue;
      device.params[key] = Math.max(param.min, Math.min(param.max, value));
    }
    if (module.enabled === false) device.enabled = false;
    return device;
  });
}

/**
 * Replaces a track's insert chain (or the master chain) with a template.
 * One undo step; the previous chain comes back with Ctrl+Z.
 */
export function applyChainTemplate(store: Store, template: ChainTemplate, trackId?: string): boolean {
  const devices = buildTemplateDevices(template);
  if (template.target === 'master') {
    store.edit('structure', (project) => {
      project.master.devices = devices;
    });
    return true;
  }
  const targetId = trackId ?? store.selectedTrackId;
  const track = store.project.tracks.find((entry) => entry.id === targetId);
  if (!track) return false;
  store.edit('structure', () => {
    track.devices = devices;
  });
  return true;
}
