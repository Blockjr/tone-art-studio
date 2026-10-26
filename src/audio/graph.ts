import { dbToGain } from '../core/time';
import type { Project } from '../core/types';
import { createDevice, type AudioDevice } from './devices';
import { createInstrument, type Instrument } from './instruments';

export interface TrackChain {
  input: GainNode;
  trim: GainNode;
  hp: BiquadFilterNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  devices: AudioDevice[];
  instrument: Instrument | null;
  /** post-insert, pre-fader tap: what a native stem print carries */
  postInsert: AudioNode;
  panner: StereoPannerNode;
  gain: GainNode;
  /** aux sends A–D, after the insert rack (pre) or after the fader (post) */
  sends: GainNode[];
  analyser: AnalyserNode | null;
  meter: Uint8Array<ArrayBuffer> | null;
}

/** An aux return channel: effect chain -> pan -> fader -> master. */
export interface ReturnChain {
  input: GainNode;
  devices: AudioDevice[];
  panner: StereoPannerNode;
  gain: GainNode;
  analyser: AnalyserNode | null;
  meter: Uint8Array<ArrayBuffer> | null;
}

export interface Graph {
  ctx: BaseAudioContext;
  tracks: Map<string, TrackChain>;
  masterInput: GainNode;
  masterDevices: AudioDevice[];
  masterGain: GainNode;
  /** the −1 dBFS soft clipper on the master bus */
  safety: WaveShaperNode;
  /** monitor-only: −18 dB dim and L/R sum for mono checking */
  masterDim: GainNode;
  monoSum: GainNode;
  stereoLeft: GainNode;
  stereoRight: GainNode;
  masterAnalyser: AnalyserNode | null;
  masterMeter: Uint8Array<ArrayBuffer> | null;
  returns: ReturnChain[];
  dispose(): void;
}

export interface GraphOptions {
  meters?: boolean;
  /** false leaves the master insert rack out, as a stem print needs */
  masterDevices?: boolean;
}

/** Linear below −1 dBFS, then a smooth knee that tops out at 0 dBFS. */
function safetyCurve(): Float32Array<ArrayBuffer> {
  const size = 4096;
  const curve = new Float32Array(size);
  const knee = 0.891;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

export function buildGraph(ctx: BaseAudioContext, project: Project, options: GraphOptions = {}): Graph {
  const meters = options.meters ?? false;

  const masterInput = ctx.createGain();
  const masterDevices =
    options.masterDevices === false
      ? []
      : project.master.devices.filter((d) => d.enabled).map((d) => createDevice(ctx, d, { meter: meters }));

  let masterCursor: AudioNode = masterInput;
  for (const device of masterDevices) {
    masterCursor.connect(device.input);
    masterCursor = device.output;
  }
  const masterGain = ctx.createGain();
  masterGain.gain.value = project.master.volume;
  masterCursor.connect(masterGain);

  // Last line of defence: a smooth −1 dBFS soft clipper so no converter ever
  // sees a sample above full scale, even when the limiter overshoots.
  const safety = ctx.createWaveShaper();
  safety.curve = safetyCurve();
  safety.oversample = '2x';
  masterGain.connect(safety);

  // Monitor section: dim and mono are listening tools, never part of the
  // exported mix (which builds its own graph with unity defaults).
  const masterDim = ctx.createGain();
  const monitorSplit = ctx.createChannelSplitter(2);
  const monitorMerge = ctx.createChannelMerger(2);
  const stereoLeft = ctx.createGain();
  const stereoRight = ctx.createGain();
  const monoSum = ctx.createGain();
  monoSum.gain.value = 0;
  safety.connect(masterDim);
  masterDim.connect(monitorSplit);
  monitorSplit.connect(stereoLeft, 0);
  monitorSplit.connect(stereoRight, 1);
  monitorSplit.connect(monoSum, 0);
  monitorSplit.connect(monoSum, 1);
  stereoLeft.connect(monitorMerge, 0, 0);
  stereoRight.connect(monitorMerge, 0, 1);
  monoSum.connect(monitorMerge, 0, 0);
  monoSum.connect(monitorMerge, 0, 1);

  let masterAnalyser: AnalyserNode | null = null;
  let masterMeter: Uint8Array<ArrayBuffer> | null = null;
  if (meters) {
    masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 1024;
    monitorMerge.connect(masterAnalyser);
    masterMeter = new Uint8Array(masterAnalyser.fftSize);
  }
  monitorMerge.connect(ctx.destination);

  // Aux returns. Each is a full channel: effect chain, pan, fader, master.
  const returns: ReturnChain[] = project.returns.map((state) => {
    const input = ctx.createGain();
    const devices = state.devices.filter((d) => d.enabled).map((d) => createDevice(ctx, d, { meter: meters }));

    let cursor: AudioNode = input;
    for (const device of devices) {
      cursor.connect(device.input);
      cursor = device.output;
    }

    const panner = ctx.createStereoPanner();
    panner.pan.value = state.pan;

    const gain = ctx.createGain();
    gain.gain.value = state.mute ? 0 : state.volume;

    cursor.connect(panner);
    panner.connect(gain);
    gain.connect(masterInput);

    let analyser: AnalyserNode | null = null;
    let meter: Uint8Array<ArrayBuffer> | null = null;

    if (meters) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(analyser);
      meter = new Uint8Array(analyser.fftSize);
    }

    return { input, devices, panner, gain, analyser, meter };
  });

  const tracks = new Map<string, TrackChain>();

  for (const track of project.tracks) {
    const input = ctx.createGain();

    // channel strip: trim -> high pass -> 3-band EQ -> inserts -> pan -> fader
    const trim = ctx.createGain();
    trim.gain.value = dbToGain(track.gain);

    // Offline renders have to honour the EQ bypass exactly like the transport,
    // or an exported mix would not match what the console was playing.
    const eqOn = track.eqOn !== false;

    const hp = ctx.createBiquadFilter();
    hp.type = eqOn ? 'highpass' : 'allpass';
    hp.frequency.value = eqOn ? track.eq.hp : 20;
    hp.Q.value = 0.7;

    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 180;
    low.gain.value = eqOn ? track.eq.low : 0;

    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = track.eq.midFreq;
    mid.Q.value = 1;
    mid.gain.value = eqOn ? track.eq.mid : 0;

    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4200;
    high.gain.value = eqOn ? track.eq.high : 0;

    input.connect(trim);
    trim.connect(hp);
    hp.connect(low);
    low.connect(mid);
    mid.connect(high);

    const devices = track.devices.filter((d) => d.enabled).map((d) => createDevice(ctx, d, { meter: meters }));
    let cursor: AudioNode = high;
    for (const device of devices) {
      cursor.connect(device.input);
      cursor = device.output;
    }

    // `cursor` is now the post-insert, pre-fader tap.
    const postInsert: AudioNode = cursor;

    const panner = ctx.createStereoPanner();
    panner.pan.value = track.pan;

    const gain = ctx.createGain();
    gain.gain.value = track.volume;

    postInsert.connect(panner);
    panner.connect(gain);
    gain.connect(masterInput);

    const sends: GainNode[] = [];

    for (let index = 0; index < track.sends.length; index++) {
      const send = ctx.createGain();
      send.gain.value = track.sends[index] ?? 0;

      const tap = track.preSends?.[index] ? postInsert : gain;
      tap.connect(send);

      const bus = returns[index];
      if (bus) send.connect(bus.input);
      else send.connect(masterInput);

      sends.push(send);
    }

    let analyser: AnalyserNode | null = null;
    let meter: Uint8Array<ArrayBuffer> | null = null;
    if (meters) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(analyser);
      meter = new Uint8Array(analyser.fftSize);
    }

    const instrument = track.instrument ? createInstrument(ctx, track.instrument) : null;
    instrument?.output.connect(input);

    tracks.set(track.id, {
      input,
      trim,
      hp,
      low,
      mid,
      high,
      devices,
      instrument,
      postInsert,
      panner,
      gain,
      sends,
      analyser,
      meter,
    });
  }

  return {
    ctx,
    tracks,
    masterInput,
    masterDevices,
    masterGain,
    safety,
    masterDim,
    monoSum,
    stereoLeft,
    stereoRight,
    masterAnalyser,
    masterMeter,
    returns,
    dispose() {
      for (const chain of tracks.values()) {
        chain.instrument?.dispose();
        chain.devices.forEach((d) => d.dispose());
        [
          chain.input,
          chain.trim,
          chain.hp,
          chain.low,
          chain.mid,
          chain.high,
          chain.panner,
          chain.gain,
          ...chain.sends,
        ].forEach((node) => node.disconnect());
        chain.analyser?.disconnect();
      }
      for (const bus of returns) {
        bus.devices.forEach((d) => d.dispose());
        bus.input.disconnect();
        bus.panner.disconnect();
        bus.gain.disconnect();
        bus.analyser?.disconnect();
      }
      masterDevices.forEach((d) => d.dispose());
      masterInput.disconnect();
      masterGain.disconnect();
      safety.disconnect();
      masterDim.disconnect();
      monitorSplit.disconnect();
      monitorMerge.disconnect();
      monoSum.disconnect();
      stereoLeft.disconnect();
      stereoRight.disconnect();
      masterAnalyser?.disconnect();
    },
  };
}
