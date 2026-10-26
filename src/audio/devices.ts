import { dbToGain } from '../core/time';
import type { DeviceState, DeviceType } from '../core/types';
import {
  EARLY_TAPS,
  analyserPeak,
  chorusDepth,
  chorusMode,
  chorusPan,
  chorusPhaseOffset,
  chorusVoiceDelay,
  dampingCutoff,
  delayMode,
  delayTimeSeconds,
  driveMode,
  duckDepth,
  duckReleaseCutoff,
  freezeFeedback,
  driveShape,
  filterMode,
  limiterMode,
  programRelease,
  reverbMode,
  rt60Gain,
  tapeBiasShape,
  tapeFlutterDepth,
  tapeWowDepth,
} from './fxmath';
import { micChain, micDriveAmount, type MicFilter } from './mics';

export interface AudioDevice {
  type: DeviceType;
  input: AudioNode;
  output: AudioNode;
  setParam(key: string, value: number, when?: number): void;
  dispose(): void;
  /** real output meter, present only when the graph asked for metering */
  analyser?: AnalyserNode | null;
  meterData?: Uint8Array<ArrayBuffer> | null;
}

export interface DeviceOptions {
  /** attach an analyser to the device output for the faceplate meter */
  meter?: boolean;
}

type Params = Record<string, number>;

/** Peak level of a device's own output, 0..1. Zero when it is not metered. */
export function devicePeak(device: AudioDevice | undefined | null): number {
  if (!device?.analyser || !device.meterData) return 0;
  device.analyser.getByteTimeDomainData(device.meterData);
  return analyserPeak(device.meterData);
}

/** Adds a real output analyser to a finished device, without changing its path. */
function metered(ctx: BaseAudioContext, device: AudioDevice, enabled: boolean): AudioDevice {
  if (!enabled) return device;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.55;
  device.output.connect(analyser);
  const meterData = new Uint8Array(analyser.fftSize);
  return {
    ...device,
    analyser,
    meterData,
    dispose() {
      device.dispose();
      analyser.disconnect();
    },
  };
}

/** Builds a WaveShaper curve from any normalised transfer function. */
function shaperCurve(shape: (x: number) => number, size = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  for (let index = 0; index < size; index++) {
    const x = (index / (size - 1)) * 2 - 1;
    curve[index] = shape(x);
  }
  return curve;
}

const now = (ctx: BaseAudioContext) => ctx.currentTime;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Ramps an AudioParam, so an edit never clicks or zippers. */
function ramp(param: AudioParam, value: number, when: number, seconds = 0.02): void {
  param.setTargetAtTime(value, when, seconds);
}

function makeCurve(amount: number): Float32Array<ArrayBuffer> {
  const size = 2048;
  const curve = new Float32Array(size);
  const k = Math.max(0.2, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / norm;
  }
  return curve;
}

/**
 * Level-neutral soft clipper: linear below the knee, rounded above it, unity at
 * full scale. Drive lowers the knee, so quiet material keeps its level and its
 * EQ curve while peaks grow harmonics instead of just getting louder.
 */
function makeSoftClipCurve(amount: number): Float32Array<ArrayBuffer> {
  const size = 2048;
  const curve = new Float32Array(size);
  const drive = Math.max(0, Math.min(1, amount));
  const knee = 0.92 - drive * 0.72;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

function eq3(ctx: BaseAudioContext, params: Params): AudioDevice {
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = params.lowFreq ?? 220;
  low.gain.value = params.lowGain ?? 0;

  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = params.midFreq ?? 1100;
  mid.Q.value = params.midQ ?? 0.9;
  mid.gain.value = params.midGain ?? 0;

  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = params.highFreq ?? 3800;
  high.gain.value = params.highGain ?? 0;

  low.connect(mid);
  mid.connect(high);

  return {
    type: 'eq3',
    input: low,
    output: high,
    setParam(key, value, when = now(ctx)) {
      if (key === 'lowFreq') low.frequency.setTargetAtTime(value, when, 0.01);
      if (key === 'lowGain') low.gain.setTargetAtTime(value, when, 0.01);
      if (key === 'midFreq') mid.frequency.setTargetAtTime(value, when, 0.01);
      if (key === 'midGain') mid.gain.setTargetAtTime(value, when, 0.01);
      if (key === 'midQ') mid.Q.setTargetAtTime(value, when, 0.01);
      if (key === 'highFreq') high.frequency.setTargetAtTime(value, when, 0.01);
      if (key === 'highGain') high.gain.setTargetAtTime(value, when, 0.01);
    },
    dispose() {
      low.disconnect();
      mid.disconnect();
      high.disconnect();
    },
  };
}

function compressor(ctx: BaseAudioContext, params: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  comp.threshold.value = params.threshold ?? -18;
  comp.ratio.value = params.ratio ?? 4;
  comp.attack.value = params.attack ?? 0.012;
  comp.release.value = params.release ?? 0.18;
  comp.knee.value = params.knee ?? 6;
  makeup.gain.value = dbToGain(params.makeup ?? 3);

  input.connect(dry);
  dry.connect(output);
  input.connect(comp);
  comp.connect(makeup);
  makeup.connect(wet);
  wet.connect(output);

  const state: Params = { ...params };
  const apply = (when: number): void => {
    comp.threshold.setTargetAtTime(state.threshold ?? -18, when, 0.012);
    comp.ratio.setTargetAtTime(state.ratio ?? 4, when, 0.012);
    comp.attack.setTargetAtTime(Math.max(0.001, state.attack ?? 0.012), when, 0.012);
    comp.release.setTargetAtTime(Math.max(0.02, state.release ?? 0.18), when, 0.012);
    comp.knee.setTargetAtTime(Math.max(0, Math.min(24, state.knee ?? 6)), when, 0.012);
    makeup.gain.setTargetAtTime(dbToGain(state.makeup ?? 3), when, 0.012);
    const mix = Math.max(0, Math.min(1, state.mix ?? 1));
    wet.gain.setTargetAtTime(mix, when, 0.012);
    dry.gain.setTargetAtTime(1 - mix, when, 0.012);
  };
  apply(now(ctx));

  return {
    type: 'compressor',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      [input, output, dry, wet, comp, makeup].forEach((node) => node.disconnect());
    },
  };
}

function limiter(ctx: BaseAudioContext, params: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  const gain = ctx.createGain();
  input.connect(comp);
  comp.connect(gain);
  gain.connect(output);

  const state: Params = { ...params };
  const apply = (when: number): void => {
    const mode = limiterMode(state.mode ?? 0);
    comp.threshold.setTargetAtTime(state.ceiling ?? -0.4, when, 0.005);
    comp.knee.setTargetAtTime(Math.max(mode.knee, Math.min(12, state.knee ?? 0)), when, 0.005);
    comp.ratio.setTargetAtTime(mode.ratio, when, 0.005);
    comp.attack.setTargetAtTime(mode.attack, when, 0.005);
    comp.release.setTargetAtTime(Math.max(0.02, Math.min(0.5, state.release ?? 0.1)), when, 0.005);
    gain.gain.setTargetAtTime(dbToGain(state.gain ?? 0), when, 0.005);
  };
  apply(now(ctx));

  return {
    type: 'limiter',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      [input, output, comp, gain].forEach((node) => node.disconnect());
    },
  };
}

interface EchoLine {
  delay: DelayNode;
  low: BiquadFilterNode;
  high: BiquadFilterNode;
  driveIn: GainNode;
  shaper: WaveShaperNode;
  feedback: GainNode;
  cross: GainNode;
  tap: GainNode;
  pan: StereoPannerNode;
}

/**
 * Echo: four storage technologies behind one engine.
 *
 * Two delay lines with a filtered, saturated feedback path. Tape and BBD modes
 * cap the feedback bandwidth and add speed wander; digital stays clean; ping-pong
 * replaces the self-feedback with a cross-feed so each repeat alternates sides.
 * Tone and low cut sit inside the loop, so repeats darken the way hardware does
 * instead of only dulling the wet signal at the output.
 */
function delay(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const state: Params = { ...initial };
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();

  // Mono sources are upmixed so both lines are fed; stereo keeps its sides.
  const upmix = ctx.createGain();
  upmix.channelCount = 2;
  upmix.channelCountMode = 'explicit';
  upmix.channelInterpretation = 'speakers';
  input.connect(upmix);

  const split = ctx.createChannelSplitter(2);
  upmix.connect(split);

  const mono = ctx.createGain();
  mono.channelCount = 1;
  mono.channelCountMode = 'explicit';
  mono.channelInterpretation = 'speakers';
  input.connect(mono);

  const inL = ctx.createGain();
  const inR = ctx.createGain();
  const inMono = ctx.createGain();
  split.connect(inL, 0);
  split.connect(inR, 1);
  mono.connect(inMono);

  const makeLine = (): EchoLine => {
    const delayNode = ctx.createDelay(2.4);
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    // Q is in dB: −3.01 is a flat Butterworth corner with no resonant gain, so
    // the feedback loop can never creep above unity at the cutoff.
    low.Q.value = -3.01;
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.Q.value = -3.01;
    const driveIn = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    // No oversampling: Chrome's 4× mode adds 4 ms of latency inside the loop,
    // which would make every repeat late against the tempo grid.
    shaper.oversample = 'none';
    const feedback = ctx.createGain();
    const cross = ctx.createGain();
    const tap = ctx.createGain();
    const pan = ctx.createStereoPanner();

    delayNode.connect(low);
    low.connect(high);
    high.connect(driveIn);
    driveIn.connect(shaper);
    shaper.connect(feedback);
    feedback.connect(delayNode);
    shaper.connect(cross);
    shaper.connect(tap);
    tap.connect(pan);
    pan.connect(wet);

    return { delay: delayNode, low, high, driveIn, shaper, feedback, cross, tap, pan };
  };

  const identityCurve = shaperCurve((x) => x);
  const left = makeLine();
  const right = makeLine();

  inL.connect(left.delay);
  inR.connect(right.delay);
  inMono.connect(left.delay);
  // Ping-pong: the repeat hands over to the other side instead of repeating.
  left.cross.connect(right.delay);
  right.cross.connect(left.delay);

  const wow = ctx.createOscillator();
  wow.type = 'sine';
  const wowDepth = ctx.createGain();
  wow.connect(wowDepth);
  wowDepth.connect(left.delay.delayTime);
  wowDepth.connect(right.delay.delayTime);

  const flutter = ctx.createOscillator();
  flutter.type = 'sine';
  const flutterDepth = ctx.createGain();
  flutter.connect(flutterDepth);
  flutterDepth.connect(left.delay.delayTime);
  flutterDepth.connect(right.delay.delayTime);

  wow.start();
  flutter.start();

  input.connect(dry);
  dry.connect(output);

  // Ducking without a worklet: rectify the dry input, smooth the envelope with
  // a low-pass, and subtract it from the wet gain. AudioParam summing makes the
  // sidechain run at sample rate, while the intrinsic value of 1 keeps the wet
  // path at full level whenever nothing is playing into the detector.
  const duckGainNode = ctx.createGain();
  wet.connect(duckGainNode);
  duckGainNode.connect(output);

  const detector = ctx.createGain();
  detector.channelCount = 1;
  detector.channelCountMode = 'explicit';
  detector.channelInterpretation = 'speakers';
  // A full-scale sine rectifies to a mean of 2/π, so trim the detector by the
  // reciprocal: sustained musical material then reaches a useful duck depth.
  detector.gain.value = Math.PI / 2;
  input.connect(detector);

  const rectifier = ctx.createWaveShaper();
  rectifier.curve = shaperCurve((x) => Math.abs(x));
  rectifier.oversample = 'none';
  detector.connect(rectifier);

  const envelope = ctx.createBiquadFilter();
  envelope.type = 'lowpass';
  envelope.Q.value = -3.01;
  rectifier.connect(envelope);

  const duckAmount = ctx.createGain();
  envelope.connect(duckAmount);
  duckAmount.connect(duckGainNode.gain);

  let primed = false;

  const apply = (when: number): void => {
    // The first pass writes values directly: ramping up from node defaults
    // would smear the first repeat and let the mono tap leak into the stereo feed.
    const set = (param: AudioParam, value: number, seconds = 0.02): void => {
      if (primed) ramp(param, value, when, seconds);
      else param.value = value;
    };
    const mode = delayMode(state.mode ?? 0);
    const pingpong = mode.id === 'pingpong';
    const width = clamp01(state.width ?? 0.6);
    const time = delayTimeSeconds(
      state.time ?? 0.34,
      (state.sync ?? 0) >= 0.5,
      state.division ?? 2,
      state.bpm ?? 120,
      mode,
    );
    const feedback = Math.min(0.985, Math.max(0, state.feedback ?? 0.34));
    const drive = clamp01(state.drive ?? 0.18);
    const shaperK = Math.max(0.2, 0.15 + drive * mode.driveScale * 9);
    const driveGain = 1 + drive * mode.driveScale * 3;
    // Saturation and its input stage both add gain at small signals. Dividing
    // by that gain keeps the Feedback knob honest and stops a hot, driven echo
    // from self-oscillating at ordinary settings.
    const loopSlope = driveGain * (shaperK / Math.tanh(shaperK));
    // Freeze holds whatever is already in the lines: input closes, feedback
    // opens to just under unity, and the repeats hang without decaying.
    const frozen = (state.freeze ?? 0) >= 0.5;
    const loop = freezeFeedback(frozen, feedback / Math.max(1, loopSlope));
    const mix = clamp01(state.mix ?? 0.26);
    const tone = Math.min(state.tone ?? 5500, mode.toneCap);
    const lowCut = Math.max(20, Math.min(800, state.lowCut ?? 90));
    const mod = clamp01(state.mod ?? 0.35);
    const rightTime = pingpong ? time : Math.min(mode.maxTime, time * (1 + mode.spread * width));
    // A feedback loop costs one render quantum per pass. Trim it from the stored
    // time so repeats stay on the tempo grid instead of drifting late.
    const latency = 128 / ctx.sampleRate;
    const store = (seconds: number): number => Math.max(0.02, seconds - latency);

    set(left.delay.delayTime, store(time), 0.03);
    set(right.delay.delayTime, store(rightTime), 0.03);
    set(left.feedback.gain, pingpong ? 0 : loop);
    set(right.feedback.gain, pingpong ? 0 : loop);
    set(left.cross.gain, pingpong ? loop : 0);
    set(right.cross.gain, pingpong ? loop : 0);
    set(inL.gain, frozen || pingpong ? 0 : 1);
    set(inR.gain, frozen || pingpong ? 0 : 1);
    set(inMono.gain, frozen ? 0 : pingpong ? 1 : 0);

    for (const line of [left, right]) {
      set(line.low.frequency, tone, 0.03);
      set(line.high.frequency, lowCut, 0.03);
      // Freeze runs the loop clean so the held tail cannot grow through the
      // drive stage; unfreezing hands the character straight back.
      set(line.driveIn.gain, frozen ? 1 : driveGain);
      // A tiny curve at drive 0 stays linear; the character comes with drive.
      line.shaper.curve = frozen ? identityCurve : makeCurve(shaperK);
      // Saturation raises average level; trim it back so the mix knob stays honest.
      set(line.tap.gain, (mode.trim * 1.1) / (1 + drive * 0.5));
    }

    set(left.pan.pan, -0.9 * width);
    set(right.pan.pan, 0.9 * width);

    const duck = clamp01(state.duck ?? 0);
    const release = Math.max(0.05, Math.min(0.8, state.duckRelease ?? 0.18));
    set(duckGainNode.gain, 1);
    set(duckAmount.gain, -duckDepth(duck));
    set(envelope.frequency, duckReleaseCutoff(release), 0.03);

    wow.frequency.setTargetAtTime(mode.wowRate, when, 0.05);
    flutter.frequency.setTargetAtTime(mode.flutterRate, when, 0.05);
    const wander = pingpong ? 0.5 : 1;
    set(wowDepth.gain, mode.wowDepth * (0.15 + mod * 0.85) * wander, 0.05);
    set(flutterDepth.gain, mode.flutterDepth * (0.15 + mod * 0.85) * wander, 0.05);

    set(wet.gain, mix);
    set(dry.gain, 1 - mix);
    primed = true;
  };

  apply(now(ctx));

  return {
    type: 'delay',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      wow.stop();
      flutter.stop();
      [
        input,
        output,
        dry,
        wet,
        upmix,
        split,
        mono,
        inL,
        inR,
        inMono,
        wowDepth,
        flutterDepth,
        duckGainNode,
        detector,
        rectifier,
        envelope,
        duckAmount,
      ].forEach((node) => node.disconnect());
      for (const line of [left, right]) {
        [line.delay, line.low, line.high, line.driveIn, line.shaper, line.feedback, line.cross, line.tap, line.pan].forEach(
          (node) => node.disconnect(),
        );
      }
    },
  };
}

interface Diffuser {
  input: GainNode;
  output: GainNode;
  set: (coefficient: number, when: number, immediate?: boolean) => void;
}

/** One allpass section: unity magnitude, energy spread in time. */
function diffuser(ctx: BaseAudioContext, milliseconds: number): Diffuser {
  const input = ctx.createGain();
  const delayNode = ctx.createDelay(0.2);
  delayNode.delayTime.value = milliseconds / 1000;
  const feedback = ctx.createGain();
  const feedforward = ctx.createGain();
  const output = ctx.createGain();

  input.connect(delayNode);
  delayNode.connect(feedback);
  feedback.connect(input);
  delayNode.connect(output);
  input.connect(feedforward);
  feedforward.connect(output);

  return {
    input,
    output,
    set(coefficient, when, immediate = false) {
      if (immediate) {
        feedback.gain.value = coefficient;
        feedforward.gain.value = -coefficient;
      } else {
        ramp(feedback.gain, coefficient, when, 0.03);
        ramp(feedforward.gain, -coefficient, when, 0.03);
      }
    },
  };
}

/**
 * Reverb: early reflections plus two banks of damped comb filters feeding
 * allpass diffusion, in the classic Schroeder/Moorer arrangement.
 *
 * Decay is set in seconds and converted to per-comb feedback with the RT60
 * formula, so every comb decays together no matter how the space scales. The
 * damping filter sits inside each loop, which is what makes highs die away
 * before lows instead of only darkening the output, and a DC blocker keeps a
 * long tail from accumulating offset. The two banks use different lengths, so
 * left and right decorrelate instead of arriving as a mono double.
 */
function reverb(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const state: Params = { ...initial };
  // Sessions saved before the decay knob existed stored seconds in `size`.
  if (state.decay === undefined && state.size !== undefined) state.decay = state.size;

  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const preDelay = ctx.createDelay(0.5);
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.Q.value = -3.01;

  input.connect(dry);
  dry.connect(output);
  input.connect(preDelay);
  preDelay.connect(highpass);

  interface EarlyTap {
    delay: DelayNode;
    gain: GainNode;
    toL: GainNode;
    toR: GainNode;
  }

  interface Comb {
    /** base length in seconds, before space and mode scaling */
    base: number;
    delay: DelayNode;
    block: BiquadFilterNode;
    damp: BiquadFilterNode;
    feedback: GainNode;
    tap: GainNode;
  }

  const lateL = ctx.createGain();
  const lateR = ctx.createGain();

  // Early reflections: a sparse tap set with its own stereo placement.
  const early: EarlyTap[] = [];
  for (const tap of EARLY_TAPS) {
    const delayNode = ctx.createDelay(0.3);
    const gain = ctx.createGain();
    const toL = ctx.createGain();
    const toR = ctx.createGain();
    const angle = ((tap.pan + 1) * Math.PI) / 4;
    toL.gain.value = Math.cos(angle);
    toR.gain.value = Math.sin(angle);
    highpass.connect(delayNode);
    delayNode.connect(gain);
    gain.connect(toL);
    gain.connect(toR);
    toL.connect(lateL);
    toR.connect(lateR);
    early.push({ delay: delayNode, gain, toL, toR });
  }

  /**
   * A bank of four parallel damped comb filters. Each comb is its own loop, so
   * its feedback can be set from its own length: every comb decays in the same
   * time, which is what makes the decay knob read in seconds. The DC blocker
   * keeps a long tail from accumulating offset.
   */
  const makeBank = (lengths: number[], destination: GainNode): Comb[] => {
    const combs: Comb[] = [];
    for (const milliseconds of lengths) {
      const delayNode = ctx.createDelay(2);
      delayNode.delayTime.value = milliseconds / 1000;
      const block = ctx.createBiquadFilter();
      block.type = 'highpass';
      block.frequency.value = 26;
      block.Q.value = -3.01;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.Q.value = -3.01;
      const feedback = ctx.createGain();
      const tap = ctx.createGain();
      tap.gain.value = 0.3;

      delayNode.connect(block);
      block.connect(damp);
      damp.connect(feedback);
      feedback.connect(delayNode);
      damp.connect(tap);
      tap.connect(destination);
      highpass.connect(delayNode);

      combs.push({ base: milliseconds / 1000, delay: delayNode, block, damp, feedback, tap });
    }
    return combs;
  };

  // Diffusion after the comb bank turns the echoes into a smooth wash.
  const leftDiffusers = [diffuser(ctx, 5.1), diffuser(ctx, 1.7)];
  const rightDiffusers = [diffuser(ctx, 4.3), diffuser(ctx, 1.3)];
  const leftBank = ctx.createGain();
  const rightBank = ctx.createGain();
  leftBank.connect(leftDiffusers[0].input);
  leftDiffusers[0].output.connect(leftDiffusers[1].input);
  leftDiffusers[1].output.connect(lateL);
  rightBank.connect(rightDiffusers[0].input);
  rightDiffusers[0].output.connect(rightDiffusers[1].input);
  rightDiffusers[1].output.connect(lateR);

  // Mutually incommensurate lengths: the two banks differ so the sides decorrelate.
  const leftCombs = makeBank([29.7, 37.1, 43.7, 53.3], leftBank);
  const rightCombs = makeBank([31.3, 36.7, 41.9, 47.9], rightBank);

  // Width matrix: mid untouched, side scaled, recombined.
  const mid = ctx.createGain();
  const side = ctx.createGain();
  const sideWidth = ctx.createGain();
  const leftMid = ctx.createGain();
  const rightMid = ctx.createGain();
  const leftSide = ctx.createGain();
  const rightSide = ctx.createGain();
  leftMid.gain.value = 0.5;
  rightMid.gain.value = 0.5;
  leftSide.gain.value = 0.5;
  rightSide.gain.value = -0.5;
  lateL.connect(leftMid);
  lateL.connect(leftSide);
  lateR.connect(rightMid);
  lateR.connect(rightSide);
  leftMid.connect(mid);
  rightMid.connect(mid);
  leftSide.connect(side);
  rightSide.connect(side);

  const leftBus = ctx.createGain();
  const rightBus = ctx.createGain();
  const invertSide = ctx.createGain();
  invertSide.gain.value = -1;
  mid.connect(leftBus);
  mid.connect(rightBus);
  side.connect(sideWidth);
  sideWidth.connect(leftBus);
  sideWidth.connect(invertSide);
  invertSide.connect(rightBus);

  const merger = ctx.createChannelMerger(2);
  leftBus.connect(merger, 0, 0);
  rightBus.connect(merger, 0, 1);
  merger.connect(wet);
  wet.connect(output);

  const modA = ctx.createOscillator();
  modA.type = 'sine';
  modA.frequency.value = 0.27;
  const modB = ctx.createOscillator();
  modB.type = 'sine';
  modB.frequency.value = 0.41;
  const modAGain = ctx.createGain();
  const modBGain = ctx.createGain();
  modA.connect(modAGain);
  modB.connect(modBGain);
  modAGain.connect(leftCombs[1].delay.delayTime);
  modAGain.connect(rightCombs[2].delay.delayTime);
  modBGain.connect(leftCombs[2].delay.delayTime);
  modB.connect(rightCombs[1].delay.delayTime);
  modA.start();
  modB.start();

  let primed = false;

  const apply = (when: number): void => {
    const set = (param: AudioParam, value: number, seconds = 0.02): void => {
      if (primed) ramp(param, value, when, seconds);
      else param.value = value;
    };
    const mode = reverbMode(state.mode ?? 1);
    const space = Math.max(0.3, Math.min(2, state.space ?? 1));
    const decay = Math.max(0.4, Math.min(12, state.decay ?? 2.4));
    const damp = clamp01(state.damping ?? 0.45);
    const mod = clamp01(state.mod ?? 0.25);
    const diffuse = clamp01(state.diffuse ?? 0.6);
    const earlyLevel = clamp01(state.early ?? 0.6);
    const width = clamp01(state.width ?? 0.8);
    const mix = clamp01(state.mix ?? 0.3);

    set(preDelay.delayTime, Math.max(0, Math.min(0.2, state.preDelay ?? 0.02)), 0.03);
    set(highpass.frequency, Math.max(20, Math.min(500, state.lowCut ?? 90)), 0.03);

    // Avoid a resonant peak inside the loops; −3.01 dB is flat.
    const cutoff = dampingCutoff(damp);
    const coefficient = Math.min(0.82, 0.38 + 0.38 * diffuse * (0.75 + mode.diffusion * 0.35));
    for (const section of [...leftDiffusers, ...rightDiffusers]) section.set(coefficient, when, !primed);

    for (const comb of [...leftCombs, ...rightCombs]) {
      const seconds = Math.max(0.012, comb.base * space * mode.delayScale);
      set(comb.delay.delayTime, seconds, 0.08);
      set(comb.damp.frequency, cutoff, 0.05);
      set(comb.feedback.gain, rt60Gain(seconds, decay), 0.05);
      set(comb.tap.gain, 0.3 / Math.sqrt(leftCombs.length), 0.03);
    }

    for (let index = 0; index < early.length; index++) {
      set(early[index].gain.gain, EARLY_TAPS[index].gain * earlyLevel * mode.early * 0.9, 0.03);
      const scaled = (EARLY_TAPS[index].time / 1000) * (0.7 + space * 0.3) * (0.7 + mode.delayScale * 0.3);
      set(early[index].delay.delayTime, scaled, 0.05);
    }

    const depth = 0.00012 * mod * mode.mod;
    set(modAGain.gain, depth * (space * mode.delayScale), 0.05);
    set(modBGain.gain, depth * 0.7 * (space * mode.delayScale), 0.05);
    set(sideWidth.gain, width);
    set(wet.gain, mix * 2);
    set(dry.gain, 1 - mix);
    primed = true;
  };

  apply(now(ctx));

  return {
    type: 'reverb',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      if (key === 'size') state.decay = value;
      else state[key] = value;
      apply(when);
    },
    dispose() {
      modA.stop();
      modB.stop();
      [
        input,
        output,
        dry,
        wet,
        preDelay,
        highpass,
        lateL,
        lateR,
        mid,
        side,
        sideWidth,
        leftMid,
        rightMid,
        leftSide,
        rightSide,
        leftBus,
        rightBus,
        invertSide,
        merger,
        leftBank,
        rightBank,
        modAGain,
        modBGain,
      ].forEach((node) => node.disconnect());
      for (const section of [...leftDiffusers, ...rightDiffusers]) {
        section.input.disconnect();
        section.output.disconnect();
      }
      for (const comb of [...leftCombs, ...rightCombs]) {
        comb.delay.disconnect();
        comb.block.disconnect();
        comb.damp.disconnect();
        comb.feedback.disconnect();
        comb.tap.disconnect();
      }
      for (const tap of early) {
        tap.delay.disconnect();
        tap.gain.disconnect();
        tap.toL.disconnect();
        tap.toR.disconnect();
      }
    },
  };
}

function drive(ctx: BaseAudioContext, params: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const preGain = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.Q.value = 0.6;
  const makeup = ctx.createGain();
  shaper.oversample = '4x';

  input.connect(dry);
  dry.connect(output);
  input.connect(preGain);
  preGain.connect(shaper);
  shaper.connect(tone);
  tone.connect(makeup);
  makeup.connect(wet);
  wet.connect(output);

  const state: Params = { ...params };
  const apply = (when: number): void => {
    const amount = Math.max(0, Math.min(1, state.drive ?? 0.35));
    const mode = driveMode(state.mode ?? 0);
    const bias = Math.max(-0.5, Math.min(0.5, state.bias ?? 0));
    preGain.gain.setTargetAtTime(1 + amount * 3.2, when, 0.012);
    shaper.curve = shaperCurve((x) => driveShape(x, amount, state.mode ?? 0, bias));
    const trim = 1 / (1 + amount * (1 - mode.trim) * 1.4);
    makeup.gain.setTargetAtTime(trim, when, 0.012);
    tone.frequency.setTargetAtTime(state.tone ?? 6500, when, 0.012);
    output.gain.setTargetAtTime(state.output ?? 0.85, when, 0.012);
    const mix = Math.max(0, Math.min(1, state.mix ?? 1));
    wet.gain.setTargetAtTime(mix, when, 0.012);
    dry.gain.setTargetAtTime(1 - mix, when, 0.012);
  };
  apply(now(ctx));

  return {
    type: 'drive',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      [input, output, dry, wet, preGain, shaper, tone, makeup].forEach((n) => n.disconnect());
    },
  };
}

function filter(ctx: BaseAudioContext, params: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const driveIn = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '4x';
  const node = ctx.createBiquadFilter();
  node.type = 'lowpass';
  node.frequency.value = params.freq ?? 9000;
  node.Q.value = params.q ?? 0.9;
  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  const depth = ctx.createGain();

  input.connect(dry);
  dry.connect(output);
  input.connect(driveIn);
  driveIn.connect(shaper);
  shaper.connect(node);
  node.connect(wet);
  wet.connect(output);
  lfo.connect(depth);
  depth.connect(node.detune);
  lfo.start();

  const state: Params = { ...params };
  const apply = (when: number): void => {
    const mode = filterMode(state.mode ?? 0);
    node.type = mode.id;
    node.frequency.setTargetAtTime(state.freq ?? 9000, when, 0.012);
    node.Q.setTargetAtTime(state.q ?? 0.9, when, 0.012);
    const rate = Math.max(0, Math.min(12, state.lfo ?? 0));
    lfo.frequency.setTargetAtTime(rate > 0 ? rate : 0.01, when, 0.02);
    depth.gain.setTargetAtTime(Math.max(0, Math.min(1, state.depth ?? 0)) * 2400, when, 0.02);
    const amount = Math.max(0, Math.min(1, state.drive ?? 0));
    driveIn.gain.setTargetAtTime(1 + amount * 3, when, 0.012);
    shaper.curve = shaperCurve((x) => (1 - amount) * x + amount * Math.tanh(x * 2.6) / Math.tanh(2.6));
    const mix = Math.max(0, Math.min(1, state.mix ?? 1));
    wet.gain.setTargetAtTime(mix, when, 0.012);
    dry.gain.setTargetAtTime(1 - mix, when, 0.012);
  };
  apply(now(ctx));

  return {
    type: 'filter',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      lfo.stop();
      [input, output, dry, wet, driveIn, shaper, node, lfo, depth].forEach((n) => n.disconnect());
    },
  };
}

interface ChorusVoice {
  delay: DelayNode;
  lfo: OscillatorNode;
  depth: GainNode;
  level: GainNode;
  pan: StereoPannerNode;
  feedback: GainNode;
}

/**
 * Chorus with one to three modulated taps. Each voice has its own oscillator
 * phase, delay length and pan position, so an ensemble really is three
 * decorrelated pitch wobbles rather than one delay panned twice.
 */
function chorus(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const upmix = ctx.createGain();
  upmix.channelCount = 2;
  upmix.channelCountMode = 'explicit';
  upmix.channelInterpretation = 'speakers';
  const merge = ctx.createChannelMerger(2);

  input.connect(dry);
  dry.connect(output);
  input.connect(upmix);
  upmix.connect(merge);

  const voices: ChorusVoice[] = [];
  for (let index = 0; index < 3; index++) {
    const delay = ctx.createDelay(0.12);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const depth = ctx.createGain();
    const level = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const feedback = ctx.createGain();
    lfo.connect(depth);
    depth.connect(delay.delayTime);
    merge.connect(delay);
    delay.connect(level);
    level.connect(pan);
    pan.connect(wet);
    delay.connect(feedback);
    feedback.connect(delay);
    lfo.start();
    voices.push({ delay, lfo, depth, level, pan, feedback });
  }
  wet.connect(output);

  const state: Params = { ...initial };
  const apply = (when: number): void => {
    const mode = chorusMode(state.mode ?? 0);
    const rate = Math.max(0.05, Math.min(6, state.rate ?? 0.8));
    const base = Math.max(0.002, Math.min(0.06, state.delay ?? 0.018));
    const amount = Math.max(0, Math.min(1, state.depth ?? 0.35));
    const spread = Math.max(0, Math.min(1, state.spread ?? 0.6));
    const feedback = Math.max(-0.8, Math.min(0.8, state.feedback ?? 0));

    voices.forEach((voice, index) => {
      const active = index < mode.voices;
      const phase = chorusPhaseOffset(index, mode.voices);
      // Shift the sine by building its Fourier pair instead of waiting for a phase.
      const real = new Float32Array([0, Math.sin(phase * Math.PI * 2)]);
      const imag = new Float32Array([0, Math.cos(phase * Math.PI * 2)]);
      voice.lfo.setPeriodicWave(ctx.createPeriodicWave(real, imag));
      voice.lfo.frequency.setTargetAtTime(rate * mode.rateScale * (1 + index * 0.06), when, 0.03);
      voice.depth.gain.setTargetAtTime(chorusDepth(amount, state.mode ?? 0) * (1 + index * 0.08), when, 0.03);
      voice.delay.delayTime.setTargetAtTime(chorusVoiceDelay(index, base, state.mode ?? 0), when, 0.03);
      voice.level.gain.setTargetAtTime(active ? 1 / Math.max(1, mode.voices) : 0, when, 0.03);
      voice.pan.pan.setTargetAtTime(chorusPan(index, mode.voices, spread), when, 0.03);
      voice.feedback.gain.setTargetAtTime(active ? feedback : 0, when, 0.03);
    });

    const vibrato = mode.id === 'vibrato';
    const mix = Math.max(0, Math.min(1, state.mix ?? 0.35));
    const wetLevel = vibrato ? Math.max(mix, mode.wetFloor) : mix;
    wet.gain.setTargetAtTime(wetLevel, when, 0.03);
    dry.gain.setTargetAtTime(1 - wetLevel, when, 0.03);
  };
  apply(now(ctx));

  return {
    type: 'chorus',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      for (const voice of voices) voice.lfo.stop();
      [input, output, dry, wet, upmix, merge].forEach((node) => node.disconnect());
      for (const voice of voices) {
        voice.delay.disconnect();
        voice.depth.disconnect();
        voice.level.disconnect();
        voice.pan.disconnect();
        voice.feedback.disconnect();
      }
    },
  };
}

/**
 * Web Audio takes Q for low/high-pass corners in dB, while the model describes
 * them as plain Q. Convert so playback matches the plotted response.
 */
function nodeQ(filter: MicFilter): number {
  if (filter.type === 'highpass' || filter.type === 'lowpass') {
    return 20 * Math.log10(Math.max(0.05, filter.q));
  }
  return filter.q;
}

/**
 * Microphone emulation: high-pass, model shelves/bells and top roll-off feeding
 * a saturation stage. The curve comes from `micChain`, the same description the
 * rack plots and the tests measure.
 */
function micEmu(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  const low = ctx.createBiquadFilter();
  const mud = ctx.createBiquadFilter();
  const presence = ctx.createBiquadFilter();
  const air = ctx.createBiquadFilter();
  const top = ctx.createBiquadFilter();
  const driveIn = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const output = ctx.createGain();
  const filters = [hp, low, mud, presence, air, top];

  for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
  input.connect(hp);
  top.connect(driveIn);
  driveIn.connect(shaper);
  shaper.connect(output);
  shaper.oversample = '4x';

  const state: Params = { ...initial };

  const apply = (when: number): void => {
    const chain = micChain(state, ctx.sampleRate);
    filters.forEach((node, index) => {
      const spec = chain[index];
      if (!spec) {
        // No top roll-off for this model: park the last stage wide open.
        node.type = 'lowpass';
        node.frequency.setTargetAtTime(ctx.sampleRate / 2 - 20, when, 0.01);
        node.gain.setTargetAtTime(0, when, 0.01);
        node.Q.setTargetAtTime(20 * Math.log10(0.707), when, 0.01);
        return;
      }
      node.type = spec.type;
      node.frequency.setTargetAtTime(spec.freq, when, 0.015);
      node.gain.setTargetAtTime(spec.gain, when, 0.015);
      node.Q.setTargetAtTime(nodeQ(spec), when, 0.015);
    });

    const amount = micDriveAmount(state);
    driveIn.gain.setTargetAtTime(1, when, 0.015);
    shaper.curve = makeSoftClipCurve(amount);
    output.gain.setTargetAtTime(dbToGain(state.output ?? 0), when, 0.015);
  };

  apply(now(ctx));

  return {
    type: 'micemu',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      [input, ...filters, driveIn, shaper, output].forEach((node) => node.disconnect());
    },
  };
}

/**
 * The AI Mix & Master insert is a controller, not a processor: it measures the
 * render and writes corrections into the channel strip and other inserts, so
 * its own audio path is a plain gain stage at unity.
 */
function aimix(ctx: BaseAudioContext): AudioDevice {
  const node = ctx.createGain();
  return {
    type: 'aimix',
    input: node,
    output: node,
    setParam() {},
    dispose() {
      node.disconnect();
    },
  };
}

/**
 * Console strip: filters, four bands and a VCA compressor in one insert, with
 * a drive stage for harmonic weight. Modelled on the workflow of an SSL-style
 * channel strip; no trade dress or branding is copied.
 */
function consoleStrip(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.Q.value = 0.707;
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 6;
  const makeup = ctx.createGain();
  const driveIn = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '4x';
  const driveWet = ctx.createGain();
  const driveDry = ctx.createGain();
  const output = ctx.createGain();

  input.connect(hp);
  hp.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(comp);
  comp.connect(makeup);
  makeup.connect(driveDry);
  driveDry.connect(output);
  makeup.connect(driveIn);
  driveIn.connect(shaper);
  shaper.connect(driveWet);
  driveWet.connect(output);

  const state: Params = { ...initial };
  const apply = (when: number): void => {
    hp.frequency.setTargetAtTime(state.hpf ?? 30, when, 0.015);
    low.frequency.setTargetAtTime(state.lowFreq ?? 100, when, 0.015);
    low.gain.setTargetAtTime(state.lowGain ?? 0, when, 0.015);
    mid.frequency.setTargetAtTime(state.midFreq ?? 1200, when, 0.015);
    mid.gain.setTargetAtTime(state.midGain ?? 0, when, 0.015);
    mid.Q.setTargetAtTime(state.midQ ?? 1, when, 0.015);
    high.frequency.setTargetAtTime(state.highFreq ?? 8000, when, 0.015);
    high.gain.setTargetAtTime(state.highGain ?? 0, when, 0.015);
    // Comp In is a true bypass on the dynamics section: threshold at 0 dB and a
    // ratio of 1:1 means the detector never acts, without a graph rebuild.
    const compOn = (state.comp ?? 1) >= 0.5;
    comp.threshold.setTargetAtTime(compOn ? state.threshold ?? -22 : 0, when, 0.015);
    comp.ratio.setTargetAtTime(compOn ? state.ratio ?? 3 : 1, when, 0.015);
    comp.attack.setTargetAtTime(state.attack ?? 0.012, when, 0.015);
    comp.release.setTargetAtTime(state.release ?? 0.2, when, 0.015);
    comp.knee.setTargetAtTime(Math.max(0, Math.min(24, state.knee ?? 6)), when, 0.015);
    makeup.gain.setTargetAtTime(compOn ? dbToGain(state.makeup ?? 2) : 1, when, 0.015);
    const drive = Math.max(0, Math.min(1, state.drive ?? 0));
    driveIn.gain.setTargetAtTime(1 + drive * 3, when, 0.015);
    shaper.curve = makeCurve(1 + drive * 11);
    driveWet.gain.setTargetAtTime(drive * 0.25, when, 0.015);
    driveDry.gain.setTargetAtTime(1 - drive * 0.25, when, 0.015);
  };
  apply(now(ctx));

  return {
    type: 'console',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      [input, hp, low, mid, high, comp, makeup, driveIn, shaper, driveWet, driveDry, output].forEach((node) =>
        node.disconnect(),
      );
    },
  };
}

/** SSL-style VCA bus compressor: ratio, timing, parallel mix and makeup. */
function busGlue(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();

  input.connect(dry);
  dry.connect(output);
  input.connect(comp);
  comp.connect(makeup);
  makeup.connect(wet);
  wet.connect(output);

  const state: Params = { ...initial };
  const apply = (when: number): void => {
    const auto = (state.auto ?? 1) >= 0.5;
    comp.threshold.setTargetAtTime(state.threshold ?? -18, when, 0.015);
    comp.ratio.setTargetAtTime(state.ratio ?? 2, when, 0.015);
    comp.attack.setTargetAtTime(state.attack ?? 0.01, when, 0.015);
    comp.release.setTargetAtTime(
      auto ? programRelease(state.release ?? 0.3, 1) : state.release ?? 0.3,
      when,
      0.015,
    );
    comp.knee.setTargetAtTime(Math.max(0, Math.min(12, state.knee ?? 2)), when, 0.015);
    makeup.gain.setTargetAtTime(dbToGain(state.makeup ?? 1.5), when, 0.015);
    const mix = Math.max(0, Math.min(1, state.mix ?? 1));
    wet.gain.setTargetAtTime(mix, when, 0.015);
    dry.gain.setTargetAtTime(1 - mix, when, 0.015);
  };
  apply(now(ctx));

  return {
    type: 'busglue',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      [input, output, dry, wet, comp, makeup].forEach((node) => node.disconnect());
    },
  };
}

/** Fast FET peak compressor with input drive, parallel mix and all-buttons mode. */
function fetComp(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const inputGain = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  const transformer = ctx.createWaveShaper();
  transformer.oversample = '4x';

  input.connect(dry);
  dry.connect(output);
  input.connect(inputGain);
  inputGain.connect(comp);
  comp.connect(makeup);
  makeup.connect(transformer);
  transformer.connect(wet);
  wet.connect(output);

  const state: Params = { ...initial };
  const apply = (when: number): void => {
    const all = (state.all ?? 0) >= 0.5;
    inputGain.gain.setTargetAtTime(dbToGain(state.input ?? 4), when, 0.015);
    comp.threshold.setTargetAtTime(all ? -30 : -20, when, 0.015);
    comp.ratio.setTargetAtTime(all ? 20 : state.ratio ?? 4, when, 0.015);
    comp.attack.setTargetAtTime(all ? 0.0005 : state.attack ?? 0.004, when, 0.015);
    comp.release.setTargetAtTime(state.release ?? 0.15, when, 0.015);
    comp.knee.setTargetAtTime(all ? 0 : Math.max(0, Math.min(12, state.knee ?? 1)), when, 0.015);
    makeup.gain.setTargetAtTime(dbToGain(state.output ?? 6), when, 0.015);
    const dist = Math.max(0, Math.min(1, state.dist ?? 0));
    transformer.curve = shaperCurve((x) => (1 - dist) * x + dist * Math.tanh(x * 2.2) / Math.tanh(2.2));
    const mix = Math.max(0, Math.min(1, state.mix ?? 1));
    wet.gain.setTargetAtTime(mix, when, 0.015);
    dry.gain.setTargetAtTime(1 - mix, when, 0.015);
  };
  apply(now(ctx));

  return {
    type: 'fet',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      [input, output, dry, wet, inputGain, comp, makeup, transformer].forEach((node) => node.disconnect());
    },
  };
}

/** Slow opto leveler: smooth leveling with a compress/limit switch. */
function optoLeveler(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  comp.attack.value = 0.01;
  comp.release.value = 0.12;
  comp.knee.value = 8;

  input.connect(dry);
  dry.connect(output);
  input.connect(comp);
  comp.connect(makeup);
  makeup.connect(wet);
  wet.connect(output);

  const state: Params = { ...initial };
  const apply = (when: number): void => {
    const peak = Math.max(0, Math.min(100, state.peak ?? 40));
    const limit = (state.mode ?? 0) >= 0.5;
    comp.threshold.setTargetAtTime(-40 + (peak / 100) * 32, when, 0.02);
    comp.ratio.setTargetAtTime(limit ? 10 : 3, when, 0.02);
    // An opto cell releases from its own memory: slow, and slower still in limit.
    comp.release.setTargetAtTime(Math.max(0.1, Math.min(2, state.release ?? 0.6)) * (limit ? 1.4 : 1), when, 0.02);
    makeup.gain.setTargetAtTime(dbToGain(state.gain ?? 3), when, 0.02);
    const mix = Math.max(0, Math.min(1, state.mix ?? 1));
    wet.gain.setTargetAtTime(mix, when, 0.02);
    dry.gain.setTargetAtTime(1 - mix, when, 0.02);
  };
  apply(now(ctx));

  return {
    type: 'opto',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      [input, output, dry, wet, comp, makeup].forEach((node) => node.disconnect());
    },
  };
}

/** Tape saturation: input drive, head bump, gentle top loss and wet/dry. */
function tapeSaturation(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '4x';
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.Q.value = 0.6;
  const dc = ctx.createBiquadFilter();
  dc.type = 'highpass';
  dc.frequency.value = 25;
  const transport = ctx.createDelay(0.05);
  transport.delayTime.value = 0.0035;
  const wow = ctx.createOscillator();
  wow.type = 'sine';
  wow.frequency.value = 0.55;
  const wowDepth = ctx.createGain();
  const flutter = ctx.createOscillator();
  flutter.type = 'sine';
  flutter.frequency.value = 7.2;
  const flutterDepth = ctx.createGain();

  wow.connect(wowDepth);
  wowDepth.connect(transport.delayTime);
  flutter.connect(flutterDepth);
  flutterDepth.connect(transport.delayTime);
  wow.start();
  flutter.start();

  input.connect(dry);
  dry.connect(output);
  input.connect(pre);
  pre.connect(shaper);
  shaper.connect(tone);
  tone.connect(transport);
  transport.connect(dc);
  dc.connect(wet);
  wet.connect(output);

  const state: Params = { ...initial };
  const apply = (when: number): void => {
    const drive = Math.max(0, Math.min(1, state.drive ?? 0.3));
    const bias = Math.max(0, Math.min(1, state.bias ?? 0.35));
    pre.gain.setTargetAtTime(1 + drive * 3.2, when, 0.015);
    shaper.curve = shaperCurve((x) => {
      const bent = tapeBiasShape(x, bias);
      const hot = Math.max(-1, Math.min(1, x * (1 + drive * 2.4)));
      return (1 - drive) * bent + drive * tapeBiasShape(hot, bias);
    });
    tone.frequency.setTargetAtTime(state.tone ?? 12000, when, 0.015);
    wowDepth.gain.setTargetAtTime(tapeWowDepth(state.wow ?? 0.25), when, 0.02);
    flutterDepth.gain.setTargetAtTime(tapeFlutterDepth(state.flutter ?? 0.15), when, 0.02);
    output.gain.setTargetAtTime(dbToGain(state.output ?? 0), when, 0.015);
    const mix = Math.max(0, Math.min(1, state.mix ?? 1));
    wet.gain.setTargetAtTime(mix, when, 0.015);
    dry.gain.setTargetAtTime(1 - mix, when, 0.015);
  };
  apply(now(ctx));

  return {
    type: 'tape',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      wow.stop();
      flutter.stop();
      [input, output, dry, wet, pre, shaper, tone, dc, transport, wowDepth, flutterDepth].forEach((node) =>
        node.disconnect(),
      );
    },
  };
}

/** Air/presence enhancer: two shelves plus a parallel high-frequency exciter. */
function airBand(ctx: BaseAudioContext, initial: Params): AudioDevice {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 3800;
  mid.Q.value = 0.8;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 12000;
  const exciter = ctx.createBiquadFilter();
  exciter.type = 'highpass';
  exciter.frequency.value = 6500;
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '4x';
  const exciteGain = ctx.createGain();
  const sum = ctx.createGain();
  const trim = ctx.createGain();

  input.connect(mid);
  mid.connect(high);
  high.connect(sum);
  high.connect(exciter);
  exciter.connect(shaper);
  shaper.connect(exciteGain);
  exciteGain.connect(sum);
  sum.connect(trim);
  trim.connect(output);

  const state: Params = { ...initial };
  const apply = (when: number): void => {
    const airFreq = Math.max(6000, Math.min(16000, state.freq ?? 12000));
    high.frequency.setTargetAtTime(airFreq, when, 0.015);
    // The exciter follows the shelf, so the harmonics land on the band being boosted.
    exciter.frequency.setTargetAtTime(airFreq * 0.55, when, 0.015);
    mid.gain.setTargetAtTime(((state.mid ?? 25) / 100) * 12, when, 0.015);
    high.gain.setTargetAtTime(((state.high ?? 35) / 100) * 12, when, 0.015);
    const drive = Math.max(0, Math.min(1, state.drive ?? 0.15));
    shaper.curve = makeSoftClipCurve(drive * 0.6);
    exciteGain.gain.setTargetAtTime(drive * 0.5, when, 0.015);
    trim.gain.setTargetAtTime(dbToGain(state.trim ?? 0), when, 0.015);
  };
  apply(now(ctx));

  return {
    type: 'air',
    input,
    output,
    setParam(key, value, when = now(ctx)) {
      state[key] = value;
      apply(when);
    },
    dispose() {
      [input, output, mid, high, exciter, shaper, exciteGain, sum, trim].forEach((node) => node.disconnect());
    },
  };
}

export function createDevice(ctx: BaseAudioContext, state: DeviceState, options: DeviceOptions = {}): AudioDevice {
  const build = (): AudioDevice => {
    switch (state.type) {
      case 'eq3':
        return eq3(ctx, state.params);
      case 'compressor':
        return compressor(ctx, state.params);
      case 'limiter':
        return limiter(ctx, state.params);
      case 'delay':
        return delay(ctx, state.params);
      case 'reverb':
        return reverb(ctx, state.params);
      case 'drive':
        return drive(ctx, state.params);
      case 'filter':
        return filter(ctx, state.params);
      case 'chorus':
        return chorus(ctx, state.params);
      case 'micemu':
        return micEmu(ctx, state.params);
      case 'aimix':
        return aimix(ctx);
      case 'console':
        return consoleStrip(ctx, state.params);
      case 'busglue':
        return busGlue(ctx, state.params);
      case 'fet':
        return fetComp(ctx, state.params);
      case 'opto':
        return optoLeveler(ctx, state.params);
      case 'tape':
        return tapeSaturation(ctx, state.params);
      case 'air':
        return airBand(ctx, state.params);
    }
  };
  return metered(ctx, build(), options.meter === true);
}
