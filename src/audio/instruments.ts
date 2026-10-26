import { midiToFreq } from '../core/time';
import type { InstrumentState, InstrumentType } from '../core/types';

export interface Instrument {
  type: InstrumentType;
  output: GainNode;
  /** when: absolute AudioContext time, duration in seconds */
  noteOn(when: number, pitch: number, velocity: number, duration: number): void;
  setParam(key: string, value: number, when?: number): void;
  dispose(): void;
}

type Params = Record<string, number>;

/** Attack/decay/sustain/release envelope; returns the time the voice goes silent. */
function ampEnv(
  param: AudioParam,
  when: number,
  peak: number,
  attack: number,
  decay: number,
  sustain: number,
  hold: number,
  release: number,
): number {
  const atk = Math.max(0.0015, Math.min(attack, Math.max(0.01, hold * 0.5)));
  const dec = Math.max(0.005, Math.min(decay, Math.max(0.02, hold * 0.8)));
  const sustainLevel = Math.max(0.0002, peak * sustain);
  param.setValueAtTime(0.0001, when);
  param.linearRampToValueAtTime(Math.max(0.0002, peak), when + atk);
  param.exponentialRampToValueAtTime(sustainLevel, when + atk + dec);
  const releaseAt = Math.max(when + atk + dec, when + hold);
  param.setValueAtTime(sustainLevel, releaseAt);
  param.exponentialRampToValueAtTime(0.0001, releaseAt + release);
  return releaseAt + release;
}

function createNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 1);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function polysynth(ctx: BaseAudioContext, params: Params): Instrument {
  const output = ctx.createGain();
  output.gain.value = 0.9;

  return {
    type: 'polysynth',
    output,
    noteOn(when, pitch, velocity, duration) {
      const freq = midiToFreq(pitch);
      const cutoff = params.cutoff ?? 3200;
      const resonance = params.resonance ?? 1.2;
      const attack = params.attack ?? 0.01;
      const decay = params.decay ?? 0.22;
      const sustain = params.sustain ?? 0.55;
      const release = params.release ?? 0.4;
      const detune = params.detune ?? 9;

      const oscA = ctx.createOscillator();
      oscA.type = 'sawtooth';
      oscA.frequency.value = freq;

      const oscB = ctx.createOscillator();
      oscB.type = 'square';
      oscB.frequency.value = freq;
      oscB.detune.value = detune;

      const filterNode = ctx.createBiquadFilter();
      filterNode.type = 'lowpass';
      filterNode.Q.value = resonance;
      const startFreq = Math.min(18000, cutoff * 2.4);
      filterNode.frequency.setValueAtTime(startFreq, when);
      filterNode.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.7), when + Math.max(0.05, duration * 0.7));

      const amp = ctx.createGain();
      const end = ampEnv(amp.gain, when, velocity * 0.32, attack, decay, sustain, duration, release);

      oscA.connect(filterNode);
      oscB.connect(filterNode);
      filterNode.connect(amp);
      amp.connect(output);

      oscA.start(when);
      oscB.start(when);
      oscA.stop(end + 0.02);
      oscB.stop(end + 0.02);
    },
    setParam(key, value, when = ctx.currentTime) {
      params[key] = value;
      if (key === 'level') output.gain.setTargetAtTime(value, when, 0.02);
    },
    dispose() {
      output.disconnect();
    },
  };
}

function epiano(ctx: BaseAudioContext, params: Params): Instrument {
  const output = ctx.createGain();
  output.gain.value = 0.85;

  return {
    type: 'epiano',
    output,
    noteOn(when, pitch, velocity, duration) {
      const freq = midiToFreq(pitch);
      const decay = params.decay ?? 1.3;
      const bell = params.bell ?? 0.35;
      const tone = params.tone ?? 3800;
      const tremolo = params.tremolo ?? 0.15;

      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = freq;

      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = freq * 3.01;

      const modGain = ctx.createGain();
      modGain.gain.setValueAtTime(freq * (0.6 + bell * 3.2), when);
      modGain.gain.exponentialRampToValueAtTime(Math.max(0.5, freq * 0.02), when + 0.35);
      mod.connect(modGain);
      modGain.connect(carrier.frequency);

      const body = ctx.createOscillator();
      body.type = 'triangle';
      body.frequency.value = freq;

      const toneFilter = ctx.createBiquadFilter();
      toneFilter.type = 'lowpass';
      toneFilter.frequency.value = tone;

      const amp = ctx.createGain();
      const hold = Math.max(duration, 0.35);
      const end = ampEnv(amp.gain, when, velocity * 0.3, 0.004, decay * 0.5, 0.18, hold, 0.25);

      if (tremolo > 0.01) {
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 4.6;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = velocity * 0.3 * tremolo * 0.4;
        lfo.connect(lfoGain);
        lfoGain.connect(amp.gain);
        lfo.start(when);
        lfo.stop(end + 0.05);
      }

      carrier.connect(toneFilter);
      body.connect(toneFilter);
      toneFilter.connect(amp);
      amp.connect(output);

      carrier.start(when);
      mod.start(when);
      body.start(when);
      carrier.stop(end + 0.02);
      mod.stop(end + 0.02);
      body.stop(end + 0.02);
    },
    setParam(key, value, when = ctx.currentTime) {
      params[key] = value;
      if (key === 'level') output.gain.setTargetAtTime(value, when, 0.02);
    },
    dispose() {
      output.disconnect();
    },
  };
}

function bass(ctx: BaseAudioContext, params: Params): Instrument {
  const output = ctx.createGain();
  output.gain.value = 0.9;
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.2);
  }
  shaper.curve = curve;

  return {
    type: 'bass',
    output,
    noteOn(when, pitch, velocity, duration) {
      const freq = midiToFreq(pitch);
      const cutoff = params.cutoff ?? 700;
      const envAmount = params.envAmount ?? 0.6;
      const decay = params.decay ?? 0.25;

      const saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = freq;

      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq / 2;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 5;
      const peakFreq = Math.max(90, cutoff * (1 + envAmount * 3));
      lp.frequency.setValueAtTime(peakFreq, when);
      lp.frequency.exponentialRampToValueAtTime(Math.max(70, cutoff * 0.5), when + Math.max(0.05, decay));

      const subGain = ctx.createGain();
      subGain.gain.value = 0.55;

      const amp = ctx.createGain();
      const end = ampEnv(amp.gain, when, velocity * 0.42, 0.006, decay, 0.72, duration, 0.09);

      saw.connect(lp);
      lp.connect(amp);
      sub.connect(subGain);
      subGain.connect(amp);
      amp.connect(shaper);
      shaper.connect(output);

      saw.start(when);
      sub.start(when);
      saw.stop(end + 0.02);
      sub.stop(end + 0.02);
    },
    setParam(key, value, when = ctx.currentTime) {
      params[key] = value;
      if (key === 'level') output.gain.setTargetAtTime(value, when, 0.02);
    },
    dispose() {
      output.disconnect();
      shaper.disconnect();
    },
  };
}

function drums(ctx: BaseAudioContext, params: Params): Instrument {
  const output = ctx.createGain();
  output.gain.value = params.level ?? 0.9;
  const noise = createNoiseBuffer(ctx);

  const hit = (when: number, node: AudioNode, gain: GainNode, peak: number, decay: number) => {
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    node.connect(gain);
    gain.connect(output);
  };

  const kick = (when: number, velocity: number) => {
    const tune = Math.pow(2, (params.tune ?? 0) / 12);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160 * tune, when);
    osc.frequency.exponentialRampToValueAtTime(44 * tune, when + 0.14);
    const gain = ctx.createGain();
    hit(when, osc, gain, velocity * 0.95, 0.34);
    osc.start(when);
    osc.stop(when + 0.4);
  };

  const snare = (when: number, velocity: number) => {
    const snap = params.snap ?? 0.5;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1800;
    band.Q.value = 0.8;
    src.connect(band);
    const gain = ctx.createGain();
    hit(when, band, gain, velocity * (0.4 + snap * 0.5), 0.19);
    src.start(when);
    src.stop(when + 0.22);

    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(190, when);
    const bodyGain = ctx.createGain();
    hit(when, body, bodyGain, velocity * 0.3, 0.1);
    body.start(when);
    body.stop(when + 0.12);
  };

  const hat = (when: number, velocity: number, open = false) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7600;
    src.connect(hp);
    const gain = ctx.createGain();
    const decay = (open ? 0.42 : 0.06) * ((params.decay ?? 0.28) / 0.28);
    hit(when, hp, gain, velocity * 0.32, decay);
    src.start(when);
    src.stop(when + decay + 0.02);
  };

  const clap = (when: number, velocity: number) => {
    for (let i = 0; i < 3; i++) {
      const t = when + i * 0.012;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1400;
      band.Q.value = 1.4;
      src.connect(band);
      const gain = ctx.createGain();
      hit(t, band, gain, velocity * 0.35, 0.1);
      src.start(t);
      src.stop(t + 0.12);
    }
  };

  const tom = (when: number, velocity: number, pitch: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitch, when);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.55, when + 0.2);
    const gain = ctx.createGain();
    hit(when, osc, gain, velocity * 0.6, 0.28);
    osc.start(when);
    osc.stop(when + 0.32);
  };

  return {
    type: 'drums',
    output,
    noteOn(when, pitch, velocity) {
      switch (pitch) {
        case 36:
        case 35:
          kick(when, velocity);
          break;
        case 38:
        case 40:
          snare(when, velocity);
          break;
        case 42:
        case 44:
          hat(when, velocity, false);
          break;
        case 46:
          hat(when, velocity, true);
          break;
        case 39:
          clap(when, velocity);
          break;
        case 45:
          tom(when, velocity, 190);
          break;
        case 47:
          tom(when, velocity, 150);
          break;
        case 50:
          tom(when, velocity, 120);
          break;
        default:
          hat(when, velocity, false);
      }
    },
    setParam(key, value, when = ctx.currentTime) {
      params[key] = value;
      if (key === 'level') output.gain.setTargetAtTime(value, when, 0.02);
    },
    dispose() {
      output.disconnect();
    },
  };
}

export function createInstrument(ctx: BaseAudioContext, state: InstrumentState): Instrument {
  switch (state.type) {
    case 'drums':
      return drums(ctx, { ...state.params });
    case 'polysynth':
      return polysynth(ctx, { ...state.params });
    case 'epiano':
      return epiano(ctx, { ...state.params });
    case 'bass':
      return bass(ctx, { ...state.params });
  }
}
