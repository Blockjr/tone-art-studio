/**
 * The analysis and decision engine behind the AI Mix & Master insert.
 *
 * It measures a rendered buffer the way a mastering engineer would - gated
 * loudness to ITU-R BS.1770, an interpolated true peak, four-band balance,
 * stereo correlation and clipping - and turns those numbers into concrete
 * corrections for the existing channel strip and insert chain.
 *
 * Everything here is deterministic: the same audio always produces the same
 * plan, so an applied correction can be explained, tested and undone.
 */

import type { Store } from '../core/store';
import { clamp } from '../core/time';
import type { DeviceState, DeviceType, Project, Track } from '../core/types';
import { renderProjectBuffer } from './export';

export type TrackRole = 'drums' | 'bass' | 'keys' | 'melodic' | 'audio';

/** What a track is doing in the arrangement, from its kind and instrument. */
export function roleOf(track: Track): TrackRole {
  if (track.kind === 'audio') return 'audio';
  switch (track.instrument?.type) {
    case 'drums':
      return 'drums';
    case 'bass':
      return 'bass';
    case 'epiano':
      return 'keys';
    default:
      return 'melodic';
  }
}

export interface StereoAudio {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export interface BandBalance {
  /** percentage of measured energy, 0..100 */
  low: number;
  lowMid: number;
  mid: number;
  high: number;
}

export interface AudioStats {
  /** integrated loudness, LUFS; -Infinity for silence */
  lufs: number;
  /** loudest gated 3 s window, LUFS */
  shortTermLufs: number;
  rmsDb: number;
  truePeakDb: number;
  peakDb: number;
  crestDb: number;
  bands: BandBalance;
  /** Pearson correlation of L/R, -1..1 */
  correlation: number;
  /** sample count at or above full scale */
  clipped: number;
  silent: boolean;
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const toDb = (value: number): number => (value > 1e-9 ? 20 * Math.log10(value) : -120);

/** BS.1770 K-weighting, stage 1: the +4 dB high shelf at 1681 Hz. */
function shelfCoefficients(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** BS.1770 K-weighting, stage 2: the ~38 Hz high pass. */
function kWeightHighPass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + k / q + k * k;
  return {
    b0: 1 / a0,
    b1: -2 / a0,
    b2: 1 / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

function lowPass(sampleRate: number, frequency: number, q = 0.707): Biquad {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highPass(sampleRate: number, frequency: number, q = 0.707): Biquad {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Direct-form I biquad, out-of-place so the source stays untouched. */
function runBiquad(input: Float32Array, coefficients: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  const { b0, b1, b2, a1, a2 } = coefficients;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function kWeighted(samples: Float32Array, sampleRate: number): Float32Array {
  return runBiquad(runBiquad(samples, shelfCoefficients(sampleRate)), kWeightHighPass(sampleRate));
}

/** Gated integrated loudness in LUFS, per ITU-R BS.1770-4. */
function integratedLoudness(channels: Float32Array[], sampleRate: number): { lufs: number; shortTerm: number } {
  const weighted = channels.map((channel) => kWeighted(channel, sampleRate));
  const blockSize = Math.max(1, Math.round(sampleRate * 0.4));
  const hop = Math.max(1, Math.round(sampleRate * 0.1));
  const length = weighted[0]?.length ?? 0;
  if (length < blockSize) {
    // Too short to gate: measure the whole thing as one block.
    let sum = 0;
    for (const channel of weighted) for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    const mean = sum / Math.max(1, length * weighted.length);
    const lufs = mean > 0 ? -0.691 + 10 * Math.log10(mean) : -Infinity;
    return { lufs, shortTerm: lufs };
  }

  const blocks: number[] = [];
  for (let start = 0; start + blockSize <= length; start += hop) {
    let sum = 0;
    for (const channel of weighted) {
      for (let i = start; i < start + blockSize; i++) sum += channel[i] * channel[i];
    }
    blocks.push(sum / (blockSize * weighted.length));
  }

  const loudnessOf = (mean: number): number => (mean > 0 ? -0.691 + 10 * Math.log10(mean) : -Infinity);

  // Absolute gate at -70 LUFS.
  const above = blocks.filter((mean) => loudnessOf(mean) > -70);
  const pool = above.length ? above : blocks;
  if (!pool.length) return { lufs: -Infinity, shortTerm: -Infinity };

  const average = pool.reduce((sum, value) => sum + value, 0) / pool.length;
  // Relative gate, 10 LU below the ungated average.
  const relativeThreshold = average * Math.pow(10, -1);
  const gated = pool.filter((mean) => mean > relativeThreshold);
  const finalPool = gated.length ? gated : pool;

  const finalAverage = finalPool.reduce((sum, value) => sum + value, 0) / finalPool.length;
  // Short-term maximum: the loudest 3 s (30 blocks) window.
  let shortTerm = finalAverage;
  const window = Math.max(1, Math.round(3 / 0.1));
  if (blocks.length >= window) {
    let sum = 0;
    for (let i = 0; i < window; i++) sum += blocks[i];
    let best = sum;
    for (let i = window; i < blocks.length; i++) {
      sum += blocks[i] - blocks[i - window];
      if (sum > best) best = sum;
    }
    shortTerm = Math.max(shortTerm, best / window);
  }

  return { lufs: loudnessOf(finalAverage), shortTerm: loudnessOf(shortTerm) };
}

/** Catmull-Rom interpolation to 4x, catching inter-sample overs. */
function truePeakOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    const length = channel.length;
    for (let i = 0; i < length; i++) {
      const y0 = channel[i];
      const magnitude = Math.abs(y0);
      if (magnitude > peak) peak = magnitude;
      const ym1 = i > 0 ? channel[i - 1] : y0;
      const y1 = i + 1 < length ? channel[i + 1] : y0;
      const y2 = i + 2 < length ? channel[i + 2] : y1;
      for (const t of [0.25, 0.5, 0.75]) {
        const a = -0.5 * ym1 + 1.5 * y0 - 1.5 * y1 + 0.5 * y2;
        const b = ym1 - 2.5 * y0 + 2 * y1 - 0.5 * y2;
        const c = -0.5 * ym1 + 0.5 * y1;
        const value = Math.abs(((a * t + b) * t + c) * t + y0);
        if (value > peak) peak = value;
      }
    }
  }
  return peak;
}

function bandEnergy(channels: Float32Array[], filter: (input: Float32Array) => Float32Array): number {
  let sum = 0;
  for (const channel of channels) {
    const filtered = filter(channel);
    for (let i = 0; i < filtered.length; i++) sum += filtered[i] * filtered[i];
  }
  return sum;
}

/** Full measurement of a stereo render. */
export function measureAudio(audio: StereoAudio): AudioStats {
  const { left, right, sampleRate } = audio;
  const channels = [left, right];
  const length = Math.min(left.length, right.length);

  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  let sumLR = 0;
  let sumL = 0;
  let sumR = 0;
  let sumL2 = 0;
  let sumR2 = 0;

  for (let i = 0; i < length; i++) {
    const l = left[i];
    const r = right[i];
    const magnitude = Math.max(Math.abs(l), Math.abs(r));
    if (magnitude > peak) peak = magnitude;
    sumSq += l * l + r * r;
    if (magnitude >= 0.999) clipped++;
    sumLR += l * r;
    sumL += l;
    sumR += r;
    sumL2 += l * l;
    sumR2 += r * r;
  }

  const n = Math.max(1, length);
  const rms = Math.sqrt(sumSq / (2 * n));
  const { lufs, shortTerm } = integratedLoudness(channels, sampleRate);

  // Population correlation; perfectly anti-phase material reads -1.
  const covariance = sumLR / n - (sumL / n) * (sumR / n);
  const varianceL = sumL2 / n - (sumL / n) ** 2;
  const varianceR = sumR2 / n - (sumR / n) ** 2;
  const correlation = varianceL > 1e-12 && varianceR > 1e-12 ? covariance / Math.sqrt(varianceL * varianceR) : 1;

  const lp150 = lowPass(sampleRate, 150);
  const lp800 = lowPass(sampleRate, 800);
  const lp3000 = lowPass(sampleRate, 3000);
  const hp150 = highPass(sampleRate, 150);
  const hp800 = highPass(sampleRate, 800);
  const hp3000 = highPass(sampleRate, 3000);

  const low = bandEnergy(channels, (input) => runBiquad(input, lp150));
  const lowMid = bandEnergy(channels, (input) => runBiquad(runBiquad(input, hp150), lp800));
  const mid = bandEnergy(channels, (input) => runBiquad(runBiquad(input, hp800), lp3000));
  const high = bandEnergy(channels, (input) => runBiquad(input, hp3000));
  const total = low + lowMid + mid + high || 1;

  const truePeak = truePeakOf(channels);
  const silent = lufs === -Infinity || rms < 0.00025;

  return {
    lufs: silent ? -Infinity : lufs,
    shortTermLufs: silent ? -Infinity : shortTerm,
    rmsDb: toDb(rms),
    truePeakDb: toDb(truePeak),
    peakDb: toDb(peak),
    crestDb: Math.max(0, toDb(peak) - toDb(rms)),
    bands: {
      low: (low / total) * 100,
      lowMid: (lowMid / total) * 100,
      mid: (mid / total) * 100,
      high: (high / total) * 100,
    },
    correlation,
    clipped,
    silent,
  };
}

/** Convenience wrapper for an already rendered AudioBuffer. */
export function measureBuffer(buffer: AudioBuffer): AudioStats {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return measureAudio({ left, right, sampleRate: buffer.sampleRate });
}

export type AiArea = 'level' | 'eq' | 'dynamics' | 'stereo' | 'space' | 'master';

export interface AiCorrection {
  id: string;
  area: AiArea;
  title: string;
  detail: string;
  apply: (project: Project) => void;
  /** channel the correction writes to: a track id, 'master' or 'mix' */
  targetId?: string;
  targetName?: string;
  /** true when the decision comes from comparing tracks, not one channel */
  holistic?: boolean;
}

export interface TrackMixSummary {
  trackId: string;
  name: string;
  role: TrackRole;
  lufs: number;
  truePeakDb: number;
  corrections: number;
  silent: boolean;
}

export interface AiAnalysis {
  scope: 'track' | 'master';
  label: string;
  stats: AudioStats;
  corrections: AiCorrection[];
  summary: string;
  /** present for a whole-mix analysis: every track was measured in context */
  tracks?: TrackMixSummary[];
  /** whole-mix observations that explain the cross-track corrections */
  findings?: string[];
}

export interface MasterTarget {
  id: string;
  name: string;
  lufs: number;
  ceiling: number;
}

/** Loudness targets, plus the ceiling each one is mastered to. */
export const MASTER_TARGETS: MasterTarget[] = [
  { id: 'streaming', name: 'Streaming', lufs: -14, ceiling: -1 },
  { id: 'club', name: 'Club / DJ', lufs: -9, ceiling: -0.3 },
  { id: 'podcast', name: 'Speech', lufs: -16, ceiling: -1.5 },
];

const ROLE_TARGET_LUFS: Record<TrackRole, number> = {
  drums: -17,
  bass: -19,
  keys: -21,
  melodic: -22,
  audio: -18,
};

const ROLE_HP: Record<TrackRole, number> = {
  drums: 25,
  bass: 30,
  keys: 90,
  melodic: 100,
  audio: 70,
};

const ROLE_LABEL: Record<TrackRole, string> = {
  drums: 'drums',
  bass: 'bass',
  keys: 'keys',
  melodic: 'melodic',
  audio: 'audio',
};

function masterDevice(project: Project, type: DeviceType): DeviceState {
  const existing = project.master.devices.find((device) => device.type === type);
  if (existing) {
    existing.enabled = true;
    return existing;
  }
  const device: DeviceState = {
    id: `dev-master-${type}`,
    type,
    enabled: true,
    collapsed: false,
    params: type === 'eq3'
      ? { lowGain: 0, midGain: 0, highGain: 0, midFreq: 1100 }
      : type === 'compressor'
        ? { threshold: -18, ratio: 2, attack: 0.03, release: 0.25, makeup: 0 }
        : { ceiling: -1, release: 0.12, gain: 0 },
  };
  project.master.devices.push(device);
  return device;
}

/** Probability that a correction is worth making, given its size. */
const scaled = (value: number, intensity: number): number => value * clamp(intensity, 0.2, 1);

/**
 * Mix corrections for a single track: trim, high-pass and tone, dynamics,
 * phase, and space. Every item explains the measurement it came from.
 */
export function planTrackMix(track: Track, stats: AudioStats, intensity = 0.8): AiCorrection[] {
  const corrections: AiCorrection[] = [];
  if (stats.silent) return corrections;
  const role = roleOf(track);
  const target = ROLE_TARGET_LUFS[role];

  const trim = scaled(clamp(target - stats.lufs, -12, 12), intensity);
  if (Math.abs(trim) >= 0.8) {
    const nextGain = Number(clamp(track.gain + trim, -24, 24).toFixed(1));
    corrections.push({
      id: `level-${track.id}`,
      area: 'level',
      title: `${trim > 0 ? '+' : ''}${trim.toFixed(1)} dB input trim`,
      detail: `Measured ${stats.lufs.toFixed(1)} LUFS, true peak ${stats.truePeakDb.toFixed(1)} dBTP. ${ROLE_LABEL[role]} sits around ${target} LUFS in a balanced mix.`,
      apply: (project) => {
        const targetTrack = project.tracks.find((t) => t.id === track.id);
        if (targetTrack) targetTrack.gain = nextGain;
      },
    });
  }

  const eq = { ...track.eq };
  const changes: string[] = [];
  const hp = ROLE_HP[role];
  if (track.eq.hp < hp - 5) {
    eq.hp = hp;
    changes.push(`high-pass at ${hp} Hz`);
  }
  if (stats.bands.lowMid > 36 && role !== 'drums' && role !== 'bass' && track.eq.mid > -6) {
    eq.mid = Number((track.eq.mid - scaled(2.5, intensity)).toFixed(1));
    eq.midFreq = 420;
    changes.push(`${scaled(-2.5, intensity).toFixed(1)} dB at 420 Hz (low-mid is ${stats.bands.lowMid.toFixed(0)}% of the energy)`);
  }
  if (stats.bands.low > 42 && role !== 'drums' && role !== 'bass' && track.eq.low > -6) {
    eq.low = Number((track.eq.low - scaled(2, intensity)).toFixed(1));
    changes.push(`${scaled(-2, intensity).toFixed(1)} dB low shelf (weight below 150 Hz is ${stats.bands.low.toFixed(0)}%)`);
  }
  if (stats.bands.high < 10 && track.eq.high < 5) {
    eq.high = Number((track.eq.high + scaled(2, intensity)).toFixed(1));
    changes.push(`+${scaled(2, intensity).toFixed(1)} dB high shelf (top end is only ${stats.bands.high.toFixed(0)}%)`);
  }
  if (changes.length) {
    corrections.push({
      id: `eq-${track.id}`,
      area: 'eq',
      title: 'Channel EQ',
      detail: changes.join(', '),
      apply: (project) => {
        const targetTrack = project.tracks.find((t) => t.id === track.id);
        if (targetTrack) targetTrack.eq = { ...eq };
      },
    });
  }

  const existingCompressor = track.devices.find((device) => device.type === 'compressor');
  const wantsGlue = stats.crestDb > 16 && (role === 'drums' || role === 'bass' || role === 'audio');
  if (wantsGlue && !existingCompressor) {
    const threshold = Number(clamp(stats.lufs + 6, -32, -8).toFixed(0));
    const ratio = Number(scaled(2.5, intensity).toFixed(1));
    corrections.push({
      id: `dynamics-${track.id}`,
      area: 'dynamics',
      title: 'Add a compressor',
      detail: `Crest factor is ${stats.crestDb.toFixed(0)} dB, so peaks run well above the body. ${ratio}:1 at ${threshold} dB, 20 ms attack, 180 ms release.`,
      apply: (project) => {
        const targetTrack = project.tracks.find((t) => t.id === track.id);
        if (!targetTrack || targetTrack.devices.some((device) => device.type === 'compressor')) return;
        targetTrack.devices.push({
          id: `dev-${targetTrack.id}-comp`,
          type: 'compressor',
          enabled: true,
          collapsed: false,
          params: { threshold, ratio, attack: 0.02, release: 0.18, makeup: 2 },
        });
      },
    });
  }

  if (stats.correlation < -0.05) {
    corrections.push({
      id: `phase-${track.id}`,
      area: 'stereo',
      title: 'Phase problem',
      detail: `Channels correlate at ${stats.correlation.toFixed(2)}: the sides partly cancel in mono. The fix starts by re-centring the pan; check the source for an inverted channel.`,
      apply: (project) => {
        const targetTrack = project.tracks.find((t) => t.id === track.id);
        if (targetTrack) targetTrack.pan = 0;
      },
    });
  }

  const reverbTarget = role === 'keys' ? 0.2 : role === 'melodic' ? 0.14 : role === 'drums' ? 0.05 : 0.02;
  const delayTarget = role === 'melodic' ? 0.18 : role === 'keys' ? 0.07 : 0;
  if (Math.abs(track.sends[0] - reverbTarget) > 0.06 || Math.abs(track.sends[1] - delayTarget) > 0.06) {
    corrections.push({
      id: `space-${track.id}`,
      area: 'space',
      title: 'Send levels',
      detail: `Reverb ${Math.round(reverbTarget * 100)}%, delay ${Math.round(delayTarget * 100)}% suits a ${ROLE_LABEL[role]} source at this density.`,
      apply: (project) => {
        const targetTrack = project.tracks.find((t) => t.id === track.id);
        if (targetTrack) targetTrack.sends = [reverbTarget, delayTarget, targetTrack.sends[2], targetTrack.sends[3]];
      },
    });
  }

  return corrections;
}

/** Master chain for the whole mix, aimed at a loudness target. */
export function planMaster(
  stats: AudioStats,
  target: MasterTarget,
  intensity = 0.8,
  currentVolume = 0.9,
): AiCorrection[] {
  const corrections: AiCorrection[] = [];
  if (stats.silent) return corrections;
  const desiredGain = Math.max(0, scaled(clamp(target.lufs - stats.lufs, 0, 14), intensity));

  const eqChanges: string[] = [];
  const eqParams = { lowGain: 0, midGain: 0, highGain: 0, midFreq: 1100 };
  if (stats.bands.low > 38) {
    eqParams.lowGain = Number(-scaled(1.5, intensity).toFixed(1));
    eqChanges.push(`${eqParams.lowGain} dB low shelf (${stats.bands.low.toFixed(0)}% below 150 Hz)`);
  }
  if (stats.bands.lowMid > 34) {
    eqParams.midGain = Number(-scaled(1.2, intensity).toFixed(1));
    eqChanges.push(`${eqParams.midGain} dB mid (${stats.bands.lowMid.toFixed(0)}% around 150–800 Hz)`);
  }
  if (stats.bands.high < 9) {
    eqParams.highGain = Number(scaled(1.5, intensity).toFixed(1));
    eqChanges.push(`+${eqParams.highGain} dB high shelf (air is only ${stats.bands.high.toFixed(0)}%)`);
  }
  if (eqChanges.length) {
    corrections.push({
      id: 'master-eq',
      area: 'eq',
      title: 'Master tonal balance',
      detail: eqChanges.join(', '),
      apply: (project) => {
        const eq = masterDevice(project, 'eq3');
        Object.assign(eq.params, eqParams);
      },
    });
  }

  if (stats.crestDb > 9) {
    const threshold = Number(clamp(stats.lufs + 4, -30, -8).toFixed(0));
    corrections.push({
      id: 'master-glue',
      area: 'dynamics',
      title: 'Glue compression',
      detail: `Mix crest is ${stats.crestDb.toFixed(0)} dB. 2:1 at ${threshold} dB with a 30 ms attack holds the body together without flattening transients.`,
      apply: (project) => {
        const compressor = masterDevice(project, 'compressor');
        Object.assign(compressor.params, { threshold, ratio: 2, attack: 0.03, release: 0.25, makeup: 0 });
      },
    });
  }

  corrections.push({
    id: 'master-limiter',
    area: 'master',
    title: `Limiter for ${target.name} at ${target.lufs} LUFS`,
    detail: `${stats.lufs.toFixed(1)} LUFS now, true peak ${stats.truePeakDb.toFixed(1)} dBTP. Ceiling ${target.ceiling} dB with ${desiredGain.toFixed(1)} dB of drive.`,
    apply: (project) => {
      const limiter = masterDevice(project, 'limiter');
      limiter.params.ceiling = target.ceiling;
      limiter.params.release = 0.12;
      limiter.params.gain = Number(desiredGain.toFixed(1));
    },
  });

  // A mix that is already louder than the target cannot be fixed by limiter
  // drive. Trim the master fader first, but only when peaks are not already
  // the bigger problem (the headroom correction below handles those).
  const excessLoudness = stats.lufs - target.lufs;
  const overshoot = stats.truePeakDb - (target.ceiling - 0.2);
  if (excessLoudness > 1.5 && overshoot <= 0) {
    const trimDb = -scaled(clamp(excessLoudness, 0, 10), intensity);
    const nextVolume = Number(clamp(currentVolume * Math.pow(10, trimDb / 20), 0.15, 1.2).toFixed(2));
    corrections.push({
      id: 'master-level',
      area: 'master',
      title: `Trim master ${trimDb.toFixed(1)} dB toward ${target.lufs} LUFS`,
      detail: `The mix is already ${excessLoudness.toFixed(1)} dB above the ${target.name} target. Pulling the master fader down is cleaner than asking the limiter to absorb a mix that is already loud enough.`,
      apply: (project) => {
        project.master.volume = nextVolume;
      },
    });
  }

  if (overshoot > 0) {
    const trimDb = -(overshoot + 0.3);
    const nextVolume = Number(clamp(currentVolume * Math.pow(10, trimDb / 20), 0.15, 1.2).toFixed(2));
    corrections.push({
      id: 'master-headroom',
      area: 'master',
      title: `Trim master ${trimDb.toFixed(1)} dB`,
      detail: `True peak sits at ${stats.truePeakDb.toFixed(1)} dBTP, above the ${target.ceiling} dB ceiling. Trimming the master fader keeps the limiter from doing all the work.`,
      apply: (project) => {
        project.master.volume = nextVolume;
      },
    });
  }

  return corrections;
}

export interface MeasuredTrack {
  track: Track;
  stats: AudioStats;
}

export interface WholeMixPlan {
  corrections: AiCorrection[];
  findings: string[];
}

function tagged(
  correction: AiCorrection,
  targetId: string,
  targetName: string,
  holistic = false,
): AiCorrection {
  return { ...correction, targetId, targetName, holistic };
}

/** Tracks the full mix render actually hears, respecting mute and solo. */
function audibleMeasured(project: Project, measured: MeasuredTrack[]): MeasuredTrack[] {
  const anySolo = project.tracks.some((track) => track.solo) || project.returns.some((bus) => bus.solo);
  return measured.filter(
    (entry) => !entry.track.mute && (!anySolo || entry.track.solo) && !entry.stats.silent,
  );
}

/**
 * Plans a true whole-mix pass: each track is judged against the whole, then
 * the cross-track problems that no solo analysis can see are added — shared
 * low end, a crowded low-mid, a mono stereo field — followed by the master
 * chain. Every correction still writes ordinary project parameters and is
 * applied inside one undo step by the caller.
 */
export function planWholeMix(
  project: Project,
  mixStats: AudioStats,
  measured: MeasuredTrack[],
  target: MasterTarget,
  intensity = 0.8,
): WholeMixPlan {
  const audible = audibleMeasured(project, measured);
  const baseById = new Map<string, AiCorrection[]>();
  const corrections: AiCorrection[] = [];
  const findings: string[] = [];

  for (const entry of audible) {
    const base = planTrackMix(entry.track, entry.stats, intensity);
    baseById.set(entry.track.id, base);
    for (const correction of base) corrections.push(tagged(correction, entry.track.id, entry.track.name));
  }

  const eqAlreadyPlanned = new Set(
    audible
      .filter((entry) => baseById.get(entry.track.id)?.some((correction) => correction.area === 'eq'))
      .map((entry) => entry.track.id),
  );

  const lowHeavy = audible.filter((entry) => entry.stats.bands.low >= 30);
  const lowVictim = lowHeavy
    .filter((entry) => {
      const role = roleOf(entry.track);
      return role !== 'bass' && role !== 'drums' && !eqAlreadyPlanned.has(entry.track.id) && entry.track.eq.low > -8;
    })
    .sort((a, b) => b.stats.bands.low - a.stats.bands.low)[0];

  if (mixStats.bands.low > 36 && lowHeavy.length >= 2 && lowVictim) {
    const cut = Number(scaled(2.2, intensity).toFixed(1));
    const role = roleOf(lowVictim.track);
    const partners = lowHeavy
      .filter((entry) => entry.track.id !== lowVictim.track.id)
      .slice(0, 2)
      .map((entry) => entry.track.name);
    corrections.push({
      id: `mix-low-${lowVictim.track.id}`,
      area: 'eq',
      title: `Clear the shared low end on ${lowVictim.track.name}`,
      detail: `The whole mix carries ${mixStats.bands.low.toFixed(0)}% of its energy below 150 Hz, and ${partners.join(' and ')} overlap there. A ${cut} dB low-shelf cut on ${lowVictim.track.name} keeps the kick and bass solid while opening the shared octave.`,
      targetId: lowVictim.track.id,
      targetName: lowVictim.track.name,
      holistic: true,
      apply: (scope) => {
        const subject = scope.tracks.find((track) => track.id === lowVictim.track.id);
        if (!subject) return;
        subject.eq.low = Number(clamp(subject.eq.low - cut, -12, 12).toFixed(1));
        if (role === 'keys' || role === 'audio') subject.eq.hp = Math.max(subject.eq.hp, 80);
      },
    });
    findings.push(`Low end shared by ${[lowVictim.track.name, ...partners].join(', ')}`);
  }

  const lowMidHeavy = audible.filter((entry) => {
    const role = roleOf(entry.track);
    return (
      entry.stats.bands.lowMid >= 28 &&
      role !== 'bass' &&
      role !== 'drums' &&
      !eqAlreadyPlanned.has(entry.track.id) &&
      entry.track.eq.mid > -6
    );
  });
  const lowMidVictim = lowMidHeavy.sort((a, b) => b.stats.bands.lowMid - a.stats.bands.lowMid)[0];

  if (mixStats.bands.lowMid > 35 && lowMidHeavy.length >= 2 && lowMidVictim) {
    const cut = Number(scaled(2, intensity).toFixed(1));
    const partners = lowMidHeavy
      .filter((entry) => entry.track.id !== lowMidVictim.track.id)
      .slice(0, 2)
      .map((entry) => entry.track.name);
    corrections.push({
      id: `mix-lowmid-${lowMidVictim.track.id}`,
      area: 'eq',
      title: `Thin the 150–800 Hz pile-up on ${lowMidVictim.track.name}`,
      detail: `The mix is ${mixStats.bands.lowMid.toFixed(0)}% low-mid, with ${partners.join(' and ')} crowding ${lowMidVictim.track.name} in the same range. A ${cut} dB dip at 480 Hz separates the parts without hollowing the whole mix.`,
      targetId: lowMidVictim.track.id,
      targetName: lowMidVictim.track.name,
      holistic: true,
      apply: (scope) => {
        const subject = scope.tracks.find((track) => track.id === lowMidVictim.track.id);
        if (!subject) return;
        subject.eq.mid = Number(clamp(subject.eq.mid - cut, -12, 12).toFixed(1));
        subject.eq.midFreq = 480;
      },
    });
    findings.push(`Low-mid pile-up across ${[lowMidVictim.track.name, ...partners].join(', ')}`);
  }

  const centered = audible
    .filter((entry) => {
      const role = roleOf(entry.track);
      return role !== 'bass' && role !== 'drums' && Math.abs(entry.track.pan) < 0.08;
    })
    .slice(0, 2);

  if (mixStats.correlation > 0.97 && centered.length >= 2) {
    const spread = Number(clamp(scaled(0.28, intensity), 0.08, 0.35).toFixed(2));
    corrections.push({
      id: 'mix-width',
      area: 'stereo',
      title: 'Open the stereo field',
      detail: `The full mix correlates at ${mixStats.correlation.toFixed(2)}, almost mono. ${centered[0].track.name} and ${centered[1].track.name} both sit in the centre; spreading them ${Math.round(spread * 100)}% apart gives the master room without touching the mono core.`,
      targetId: 'mix',
      targetName: 'Whole mix',
      holistic: true,
      apply: (scope) => {
        const first = scope.tracks.find((track) => track.id === centered[0].track.id);
        const second = scope.tracks.find((track) => track.id === centered[1].track.id);
        if (first) first.pan = -spread;
        if (second) second.pan = spread;
      },
    });
    findings.push('Stereo field is nearly mono');
  }

  const master = planMaster(mixStats, target, intensity, project.master.volume).map((correction) =>
    tagged(correction, 'master', 'Master bus'),
  );
  corrections.push(...master);
  if (master.length) findings.push(`${master.length} master move${master.length === 1 ? '' : 's'} for ${target.name}`);

  return { corrections, findings };
}

function summarise(stats: AudioStats): string {
  if (stats.silent) return 'No audio measured in this range.';
  return `${stats.lufs.toFixed(1)} LUFS · ${stats.truePeakDb.toFixed(1)} dBTP peak · ${stats.crestDb.toFixed(0)} dB crest`;
}

export async function analyzeTrack(
  store: Store,
  trackId: string,
  intensity = 0.8,
): Promise<AiAnalysis> {
  const track = store.project.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error('That track no longer exists.');
  const buffer = await renderProjectBuffer(store, { soloTrackId: track.id, tailSeconds: 0.4, sampleRate: 32000 });
  const stats = measureBuffer(buffer);
  return {
    scope: 'track',
    label: track.name,
    stats,
    corrections: planTrackMix(track, stats, intensity),
    summary: summarise(stats),
  };
}

async function measureTracks(store: Store): Promise<MeasuredTrack[]> {
  const measured: MeasuredTrack[] = [];
  for (const track of store.project.tracks) {
    const buffer = await renderProjectBuffer(store, {
      soloTrackId: track.id,
      tailSeconds: 0.2,
      sampleRate: 32000,
    });
    measured.push({ track, stats: measureBuffer(buffer) });
  }
  return measured;
}

/**
 * The whole-mix pass behind the master scope. It renders every track in
 * context, then the full mix, and lets planWholeMix compare them before it
 * touches the master chain. This is slower than a solo analysis on purpose:
 * a true master decision needs to know what is sharing the low end, the
 * low-mid and the stereo field.
 */
export async function analyzeMaster(
  store: Store,
  target: MasterTarget,
  intensity = 0.8,
): Promise<AiAnalysis> {
  const [buffer, measured] = await Promise.all([
    renderProjectBuffer(store, { tailSeconds: 1, sampleRate: 32000 }),
    measureTracks(store),
  ]);
  const stats = measureBuffer(buffer);
  const plan = planWholeMix(store.project, stats, measured, target, intensity);
  const tracks: TrackMixSummary[] = measured.map((entry) => ({
    trackId: entry.track.id,
    name: entry.track.name,
    role: roleOf(entry.track),
    lufs: entry.stats.lufs,
    truePeakDb: entry.stats.truePeakDb,
    corrections: plan.corrections.filter((correction) => correction.targetId === entry.track.id).length,
    silent: entry.stats.silent,
  }));
  const heard = tracks.filter((track) => !track.silent).length;
  return {
    scope: 'master',
    label: 'Whole mix',
    stats,
    corrections: plan.corrections,
    summary: `${summarise(stats)} · ${heard} track${heard === 1 ? '' : 's'} in context`,
    tracks,
    findings: plan.findings,
  };
}
