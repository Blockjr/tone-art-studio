import type { DeviceType, InstrumentType } from '../core/types';
import { MIC_MODELS } from './mics';

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: 'dB' | 'Hz' | 's' | '%' | 'x' | 'ct' | 'st' | 'sw' | '';
  /** log scaling for frequency-style params */
  curve?: 'linear' | 'log';
  /** discrete modes, rendered as buttons and shown by name */
  choices?: string[];
}

export interface DeviceSpec {
  type: DeviceType;
  name: string;
  category:
    | 'Dynamics'
    | 'EQ'
    | 'Modulation'
    | 'Delay & Reverb'
    | 'Distortion'
    | 'Microphone'
    | 'Channel Strip'
    | 'Saturation'
    | 'Utility';
  params: ParamSpec[];
}

export interface InstrumentSpec {
  type: InstrumentType;
  name: string;
  category: 'Drums' | 'Keys' | 'Synth' | 'Bass';
  params: ParamSpec[];
}

const p = (
  key: string,
  label: string,
  min: number,
  max: number,
  def: number,
  unit: ParamSpec['unit'] = '',
  curve: ParamSpec['curve'] = 'linear',
): ParamSpec => ({ key, label, min, max, default: def, unit, curve });

export const DEVICE_SPECS: Record<DeviceType, DeviceSpec> = {
  eq3: {
    type: 'eq3',
    name: 'EQ Three',
    category: 'EQ',
    params: [
      p('lowFreq', 'Low F', 40, 400, 220, 'Hz', 'log'),
      p('lowGain', 'Low', -18, 18, 0, 'dB'),
      p('midFreq', 'Mid F', 300, 6000, 1100, 'Hz', 'log'),
      p('midGain', 'Mid', -18, 18, 0, 'dB'),
      p('midQ', 'Mid Q', 0.3, 6, 0.9, ''),
      p('highFreq', 'High F', 1500, 16000, 3800, 'Hz', 'log'),
      p('highGain', 'High', -18, 18, 0, 'dB'),
    ],
  },
  compressor: {
    type: 'compressor',
    name: 'Compressor',
    category: 'Dynamics',
    params: [
      p('threshold', 'Threshold', -60, 0, -18, 'dB'),
      p('ratio', 'Ratio', 1, 20, 4, 'x'),
      p('attack', 'Attack', 0.001, 0.12, 0.012, 's'),
      p('release', 'Release', 0.02, 1, 0.18, 's'),
      p('knee', 'Knee', 0, 24, 6, 'dB'),
      p('makeup', 'Makeup', 0, 18, 3, 'dB'),
      p('mix', 'Dry/Wet', 0, 1, 1, '%'),
    ],
  },
  limiter: {
    type: 'limiter',
    name: 'Limiter',
    category: 'Dynamics',
    params: [
      { ...p('mode', 'Mode', 0, 1, 0), choices: ['Modern', 'Transparent'] },
      p('ceiling', 'Ceiling', -18, 0, -0.4, 'dB'),
      p('release', 'Release', 0.02, 0.5, 0.1, 's'),
      p('knee', 'Knee', 0, 12, 0, 'dB'),
      p('gain', 'Gain', 0, 18, 0, 'dB'),
    ],
  },
  delay: {
    type: 'delay',
    name: 'Echo',
    category: 'Delay & Reverb',
    params: [
      { ...p('mode', 'Type', 0, 3, 0), choices: ['Tape', 'BBD', 'Digital', 'Ping-Pong'] },
      p('sync', 'Sync', 0, 1, 0, 'sw'),
      { ...p('division', 'Division', 0, 4, 2), choices: ['1/16', '1/8T', '1/8', '1/8.', '1/4'] },
      p('time', 'Time', 0.02, 2, 0.34, 's'),
      p('feedback', 'Feedback', 0, 0.98, 0.34, '%'),
      p('tone', 'Tone', 400, 16000, 5500, 'Hz', 'log'),
      p('lowCut', 'Low Cut', 20, 800, 90, 'Hz', 'log'),
      p('mod', 'Mod', 0, 1, 0.35, '%'),
      p('drive', 'Drive', 0, 1, 0.18, '%'),
      p('width', 'Width', 0, 1, 0.6, '%'),
      p('mix', 'Dry/Wet', 0, 1, 0.26, '%'),
      p('duck', 'Duck', 0, 1, 0, '%'),
      p('duckRelease', 'Duck Rel', 0.05, 0.8, 0.18, 's'),
      p('freeze', 'Freeze', 0, 1, 0, 'sw'),
    ],
  },
  reverb: {
    type: 'reverb',
    name: 'Reverb',
    category: 'Delay & Reverb',
    params: [
      { ...p('mode', 'Type', 0, 2, 1), choices: ['Plate', 'Hall', 'Room'] },
      p('decay', 'Decay', 0.4, 12, 2.4, 's'),
      p('space', 'Space', 0.3, 2, 1, 'x'),
      p('preDelay', 'Pre Delay', 0, 0.2, 0.02, 's'),
      p('damping', 'Damping', 0, 1, 0.45, '%'),
      p('lowCut', 'Low Cut', 20, 500, 90, 'Hz', 'log'),
      p('diffuse', 'Diffusion', 0, 1, 0.6, '%'),
      p('early', 'Early', 0, 1, 0.6, '%'),
      p('mod', 'Mod', 0, 1, 0.25, '%'),
      p('width', 'Width', 0, 1, 0.8, '%'),
      p('mix', 'Dry/Wet', 0, 1, 0.3, '%'),
    ],
  },
  drive: {
    type: 'drive',
    name: 'Amp Drive',
    category: 'Distortion',
    params: [
      { ...p('mode', 'Type', 0, 3, 0), choices: ['Warm', 'Tube', 'Fuzz', 'Fold'] },
      p('drive', 'Drive', 0, 1, 0.35, '%'),
      p('bias', 'Bias', -0.5, 0.5, 0, ''),
      p('tone', 'Tone', 600, 16000, 6500, 'Hz', 'log'),
      p('mix', 'Dry/Wet', 0, 1, 1, '%'),
      p('output', 'Output', 0, 2, 0.85, 'x'),
    ],
  },
  filter: {
    type: 'filter',
    name: 'Auto Filter',
    category: 'Utility',
    params: [
      { ...p('mode', 'Type', 0, 3, 0), choices: ['Low Pass', 'High Pass', 'Band Pass', 'Notch'] },
      p('freq', 'Frequency', 80, 18000, 9000, 'Hz', 'log'),
      p('q', 'Resonance', 0.3, 18, 0.9, ''),
      p('lfo', 'LFO Rate', 0, 12, 0, 'Hz'),
      p('depth', 'LFO Depth', 0, 1, 0, '%'),
      p('drive', 'Drive', 0, 1, 0, '%'),
      p('mix', 'Dry/Wet', 0, 1, 1, '%'),
    ],
  },
  chorus: {
    type: 'chorus',
    name: 'Chorus',
    category: 'Modulation',
    params: [
      { ...p('mode', 'Type', 0, 2, 0), choices: ['Chorus', 'Ensemble', 'Vibrato'] },
      p('rate', 'Rate', 0.05, 6, 0.8, 'Hz'),
      p('depth', 'Depth', 0, 1, 0.35, '%'),
      p('delay', 'Delay', 0.002, 0.06, 0.018, 's'),
      p('feedback', 'Feedback', -0.8, 0.8, 0, '%'),
      p('mix', 'Dry/Wet', 0, 1, 0.35, '%'),
      p('spread', 'Spread', 0, 1, 0.6, '%'),
    ],
  },
  aimix: {
    type: 'aimix',
    name: 'AI Mix & Master',
    category: 'Utility',
    params: [
      // 0 = mix this track, 1 = master the whole mix
      p('mode', 'Mode', 0, 1, 0),
      // index into MASTER_TARGETS (streaming / club / speech)
      p('target', 'Target', 0, 2, 0),
      p('intensity', 'Intensity', 0.2, 1, 0.8, '%'),
    ],
  },
  console: {
    type: 'console',
    name: 'Console Strip',
    category: 'Channel Strip',
    params: [
      p('hpf', 'HPF', 20, 300, 30, 'Hz', 'log'),
      p('lowFreq', 'Low F', 40, 400, 100, 'Hz', 'log'),
      p('lowGain', 'Low', -18, 18, 0, 'dB'),
      p('midFreq', 'Mid F', 150, 7000, 1200, 'Hz', 'log'),
      p('midGain', 'Mid', -18, 18, 0, 'dB'),
      p('midQ', 'Mid Q', 0.4, 4, 1, ''),
      p('highFreq', 'High F', 2000, 16000, 8000, 'Hz', 'log'),
      p('highGain', 'High', -18, 18, 0, 'dB'),
      p('threshold', 'Thresh', -48, 0, -22, 'dB'),
      p('ratio', 'Ratio', 1, 10, 3, 'x'),
      p('attack', 'Attack', 0.001, 0.1, 0.012, 's'),
      p('release', 'Release', 0.05, 1, 0.2, 's'),
      p('knee', 'Knee', 0, 24, 6, 'dB'),
      p('comp', 'Comp In', 0, 1, 1, 'sw'),
      p('makeup', 'Makeup', 0, 18, 2, 'dB'),
      p('drive', 'Drive', 0, 1, 0, '%'),
    ],
  },
  busglue: {
    type: 'busglue',
    name: 'Bus Glue',
    category: 'Dynamics',
    params: [
      p('threshold', 'Thresh', -40, 0, -18, 'dB'),
      p('ratio', 'Ratio', 1.5, 10, 2, 'x'),
      p('attack', 'Attack', 0.0001, 0.03, 0.01, 's'),
      p('release', 'Release', 0.05, 1.2, 0.3, 's'),
      p('knee', 'Knee', 0, 12, 2, 'dB'),
      p('makeup', 'Makeup', 0, 18, 1.5, 'dB'),
      p('mix', 'Mix', 0, 1, 1, '%'),
      p('auto', 'Auto Rel', 0, 1, 1, 'sw'),
    ],
  },
  fet: {
    type: 'fet',
    name: 'FET Comp',
    category: 'Dynamics',
    params: [
      p('input', 'Input', 0, 24, 4, 'dB'),
      p('ratio', 'Ratio', 4, 20, 4, 'x'),
      p('attack', 'Attack', 0.0005, 0.03, 0.004, 's'),
      p('release', 'Release', 0.05, 0.6, 0.15, 's'),
      p('knee', 'Knee', 0, 12, 1, 'dB'),
      p('output', 'Output', 0, 24, 6, 'dB'),
      p('dist', 'Transform', 0, 1, 0, '%'),
      p('mix', 'Mix', 0, 1, 1, '%'),
      p('all', 'All Buttons', 0, 1, 0, 'sw'),
    ],
  },
  opto: {
    type: 'opto',
    name: 'Opto Leveler',
    category: 'Dynamics',
    params: [
      p('peak', 'Peak Red', 0, 100, 40, '%'),
      p('gain', 'Gain', 0, 24, 3, 'dB'),
      p('release', 'Release', 0.1, 2, 0.6, 's'),
      p('mode', 'Mode', 0, 1, 0, 'sw'),
      p('mix', 'Mix', 0, 1, 1, '%'),
    ],
  },
  tape: {
    type: 'tape',
    name: 'Tape',
    category: 'Saturation',
    params: [
      p('drive', 'Drive', 0, 1, 0.3, '%'),
      p('tone', 'Tone', 4000, 18000, 12000, 'Hz', 'log'),
      p('wow', 'Wow', 0, 1, 0.25, '%'),
      p('flutter', 'Flutter', 0, 1, 0.15, '%'),
      p('bias', 'Bias', 0, 1, 0.35, '%'),
      p('mix', 'Mix', 0, 1, 1, '%'),
      p('output', 'Output', -12, 12, 0, 'dB'),
    ],
  },
  air: {
    type: 'air',
    name: 'Air',
    category: 'EQ',
    params: [
      p('freq', 'Air Freq', 6000, 16000, 12000, 'Hz', 'log'),
      p('mid', 'Mid Air', 0, 100, 25, '%'),
      p('high', 'High Air', 0, 100, 35, '%'),
      p('drive', 'Drive', 0, 1, 0.15, '%'),
      p('trim', 'Trim', -12, 12, 0, 'dB'),
    ],
  },
  micemu: {
    type: 'micemu',
    name: 'Mic Emulator',
    category: 'Microphone',
    params: [
      p('model', 'Model', 0, MIC_MODELS.length - 1, 0),
      p('proximity', 'Proximity', -1, 1, 0, '%'),
      p('presence', 'Presence', -6, 6, 0, 'dB'),
      p('air', 'Air', -6, 6, 0, 'dB'),
      p('drive', 'Drive', 0, 1, 0, '%'),
      p('output', 'Output', -18, 18, 0, 'dB'),
    ],
  },
};

export const INSTRUMENT_SPECS: Record<InstrumentType, InstrumentSpec> = {
  drums: {
    type: 'drums',
    name: 'Studio Drums',
    category: 'Drums',
    params: [
      p('level', 'Level', 0, 1, 0.9, '%'),
      p('tune', 'Tune', -12, 12, 0, 'st'),
      p('decay', 'Decay', 0.05, 0.8, 0.28, 's'),
      p('snap', 'Snap', 0, 1, 0.5, '%'),
    ],
  },
  polysynth: {
    type: 'polysynth',
    name: 'Poly Synth',
    category: 'Synth',
    params: [
      p('cutoff', 'Cutoff', 120, 12000, 3200, 'Hz', 'log'),
      p('resonance', 'Reso', 0.1, 16, 1.2, ''),
      p('attack', 'Attack', 0.001, 0.6, 0.01, 's'),
      p('decay', 'Decay', 0.01, 1, 0.22, 's'),
      p('sustain', 'Sustain', 0, 1, 0.55, '%'),
      p('release', 'Release', 0.01, 2, 0.4, 's'),
      p('detune', 'Detune', 0, 30, 9, 'ct'),
    ],
  },
  epiano: {
    type: 'epiano',
    name: 'Electric Piano',
    category: 'Keys',
    params: [
      p('decay', 'Decay', 0.2, 3, 1.3, 's'),
      p('bell', 'Bell', 0, 1, 0.35, '%'),
      p('tone', 'Tone', 500, 9000, 3800, 'Hz', 'log'),
      p('tremolo', 'Tremolo', 0, 1, 0.15, '%'),
    ],
  },
  bass: {
    type: 'bass',
    name: 'Sub Bass',
    category: 'Bass',
    params: [
      p('cutoff', 'Cutoff', 100, 3000, 700, 'Hz', 'log'),
      p('envAmount', 'Env Amt', 0, 1, 0.6, '%'),
      p('decay', 'Decay', 0.05, 1, 0.25, 's'),
      p('drive', 'Drive', 0, 1, 0.15, '%'),
    ],
  },
};

export function defaultParams(params: ParamSpec[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of params) out[spec.key] = spec.default;
  return out;
}

export function formatParam(spec: ParamSpec, value: number): string {
  if (spec.choices) {
    const index = Math.max(0, Math.min(spec.choices.length - 1, Math.round(value)));
    return spec.choices[index];
  }
  switch (spec.unit) {
    case 'Hz':
      return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : `${Math.round(value)}`;
    case 's':
      return value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(2)}s`;
    case 'dB':
      return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
    case '%':
      return `${Math.round(value * 100)}%`;
    case 'x':
      return `${value.toFixed(2)}x`;
    case 'ct':
      return `${Math.round(value)}ct`;
    case 'st':
      return `${value > 0 ? '+' : ''}${Math.round(value)}st`;
    case 'sw':
      return value >= 0.5 ? 'On' : 'Off';
    default:
      return value < 10 ? value.toFixed(2) : `${Math.round(value)}`;
  }
}
