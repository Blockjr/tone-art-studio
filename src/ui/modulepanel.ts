/**
 * Faceplates for the built-in effect modules.
 *
 * Every panel draws from the same maths the audio graph uses: EQ and filter
 * panels plot the real biquad response, dynamics panels plot the real transfer
 * curve with its knee, drive and tape show the curve written into their
 * WaveShaper, and chorus shows the LFO phases of its voices. The meter bar is a
 * live analyser reading of the device's own output, not a decoration.
 *
 * Echo, reverb, the mic emulator and the AI insert keep their bespoke cards.
 */

import {
  chorusMode,
  chorusPhaseOffset,
  driveCurvePoints,
  driveMode,
  filterMode,
  limiterMode,
  meterDb,
  tapeBiasShape,
} from '../audio/fxmath';
import {
  biquadGainDb,
  chainGainDb,
  compressorGainDb,
  responsePoints,
  type EqBand,
} from '../audio/response';
import { DEVICE_SPECS, formatParam, type ParamSpec } from '../audio/specs';
import type { DeviceType } from '../core/types';
import { createKnob, el } from './controls';

export interface ModulePanelOptions {
  type: DeviceType;
  values: Record<string, number>;
  accent: string;
  bpm: number;
  /** real output peak of this insert, 0..1 */
  level: () => number;
  onChange: (key: string, value: number) => void;
  onCommit: () => void;
  rerender: () => void;
}

type Values = Record<string, number>;

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

const mono = (size: number): string => `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;

function paintBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#0b0f16');
  gradient.addColorStop(1, '#06080d');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
  ctx.lineWidth = 1;
  for (let x = 0.5; x < width; x += 26) {
    ctx.beginPath();
    ctx.moveTo(x, 4);
    ctx.lineTo(x, height - 4);
    ctx.stroke();
  }
}

/** Live output meter in the right-hand gutter of every display. */
export function paintMeter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  level: number,
  accent: string,
): void {
  const x = width - 12;
  const top = 8;
  const bottom = height - 8;
  const span = bottom - top;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.fillRect(x, top, 4, span);

  const db = meterDb(level);
  const filled = Math.max(0, Math.min(1, (db + 60) / 60));
  const barHeight = filled * span;
  const fill = ctx.createLinearGradient(0, bottom, 0, top);
  fill.addColorStop(0, `${accent}aa`);
  fill.addColorStop(0.7, accent);
  fill.addColorStop(1, '#f87171');
  ctx.fillStyle = fill;
  ctx.fillRect(x, bottom - barHeight, 4, barHeight);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.font = mono(6);
  ctx.textAlign = 'center';
  ctx.fillText('OUT', x + 2, height - 1);
  ctx.textAlign = 'left';
}

function grid(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  rows = 3,
): void {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
  ctx.lineWidth = 1;
  for (let row = 0; row <= rows; row++) {
    const y = top + (height * row) / rows;
    ctx.beginPath();
    ctx.moveTo(left, y + 0.5);
    ctx.lineTo(left + width, y + 0.5);
    ctx.stroke();
  }
  for (let column = 0; column <= 4; column++) {
    const x = left + (width * column) / 4;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, top + height);
    ctx.stroke();
  }
}

/* --------------------------------------------------------------- EQ / air */

function eqBands(type: DeviceType, values: Values): EqBand[] {
  const band = (shape: EqBand['shape']): EqBand => ({ shape });
  if (type === 'eq3') {
    return [
      band({ type: 'lowshelf', freq: values.lowFreq ?? 220, q: 0.707, gain: values.lowGain ?? 0 }),
      band({ type: 'peaking', freq: values.midFreq ?? 1100, q: values.midQ ?? 0.9, gain: values.midGain ?? 0 }),
      band({ type: 'highshelf', freq: values.highFreq ?? 3800, q: 0.707, gain: values.highGain ?? 0 }),
    ];
  }
  if (type === 'console') {
    return [
      band({ type: 'highpass', freq: values.hpf ?? 30, q: 0.707 }),
      band({ type: 'lowshelf', freq: values.lowFreq ?? 100, q: 0.707, gain: values.lowGain ?? 0 }),
      band({ type: 'peaking', freq: values.midFreq ?? 1200, q: values.midQ ?? 1, gain: values.midGain ?? 0 }),
      band({ type: 'highshelf', freq: values.highFreq ?? 8000, q: 0.707, gain: values.highGain ?? 0 }),
    ];
  }
  // Air: presence bell plus the variable air shelf.
  return [
    band({ type: 'peaking', freq: 3800, q: 0.8, gain: ((values.mid ?? 25) / 100) * 12 }),
    band({
      type: 'highshelf',
      freq: values.freq ?? 12000,
      q: 0.707,
      gain: ((values.high ?? 35) / 100) * 12,
    }),
  ];
}

function drawEq(
  canvas: HTMLCanvasElement,
  type: DeviceType,
  values: Values,
  accent: string,
  level: number,
  phase: number,
): void {
  const ctx = getContext(canvas);
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  paintBackdrop(ctx, width, height);

  const left = 16;
  const right = width - 22;
  const top = 8;
  const bottom = height - 10;
  const plotHeight = bottom - top;
  const bands = eqBands(type, values);
  const points = responsePoints(bands, 48000, 130);
  const maxDb = 20;

  grid(ctx, left, top, right - left, plotHeight, 4);

  // 0 dB line, brighter than the rest of the grid.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.beginPath();
  ctx.moveTo(left, top + plotHeight / 2);
  ctx.lineTo(right, top + plotHeight / 2);
  ctx.stroke();

  const xAt = (freq: number): number => left + (Math.log(freq / 20) / Math.log(1000)) * (right - left);
  const yAt = (db: number): number =>
    top + plotHeight / 2 - (Math.max(-maxDb, Math.min(maxDb, db)) / maxDb) * (plotHeight / 2);

  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, `${accent}44`);
  fill.addColorStop(0.5, `${accent}10`);
  fill.addColorStop(1, `${accent}44`);

  ctx.beginPath();
  ctx.moveTo(xAt(points[0].freq), yAt(0));
  for (const point of points) ctx.lineTo(xAt(point.freq), yAt(point.db));
  ctx.lineTo(xAt(points.at(-1)!.freq), yAt(0));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xAt(point.freq);
    const y = yAt(point.db);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.8;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Band handles mark the frequencies the knobs are actually moving.
  for (const band of bands) {
    if (band.shape.type === 'highpass') continue;
    const x = xAt(band.shape.freq);
    const y = yAt(chainGainDb(bands, 48000, band.shape.freq));
    const pulse = 0.72 + 0.28 * Math.sin(phase * 2 + band.shape.freq);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.26)';
  ctx.font = mono(7);
  ctx.fillText('20', left, height - 1);
  ctx.fillText('1k', left + (right - left) / 3, height - 1);
  ctx.fillText('20k', right - 12, height - 1);

  paintMeter(ctx, width, height, level, accent);
}

/* --------------------------------------------------------------- dynamics */

interface DynamicsShape {
  threshold: number;
  ratio: number;
  knee: number;
  ceiling?: number;
}

function dynamicsShape(type: DeviceType, values: Values): DynamicsShape {
  if (type === 'compressor') {
    return { threshold: values.threshold ?? -18, ratio: values.ratio ?? 4, knee: values.knee ?? 6 };
  }
  if (type === 'limiter') {
    const mode = limiterMode(values.mode ?? 0);
    return {
      threshold: values.ceiling ?? -0.4,
      ratio: mode.ratio,
      knee: Math.max(mode.knee, values.knee ?? 0),
      ceiling: values.ceiling ?? -0.4,
    };
  }
  if (type === 'busglue') {
    return { threshold: values.threshold ?? -18, ratio: values.ratio ?? 2, knee: values.knee ?? 2 };
  }
  if (type === 'fet') {
    const all = (values.all ?? 0) >= 0.5;
    return {
      threshold: all ? -30 : -20,
      ratio: all ? 20 : values.ratio ?? 4,
      knee: all ? 0 : values.knee ?? 1,
    };
  }
  // Opto: peak reduction moves the threshold, mode changes the ratio.
  const peak = Math.max(0, Math.min(100, values.peak ?? 40));
  return {
    threshold: -40 + (peak / 100) * 32,
    ratio: (values.mode ?? 0) >= 0.5 ? 10 : 3,
    knee: 8,
  };
}

function drawDynamics(
  canvas: HTMLCanvasElement,
  type: DeviceType,
  values: Values,
  accent: string,
  level: number,
  phase: number,
): void {
  const ctx = getContext(canvas);
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  paintBackdrop(ctx, width, height);

  const left = 14;
  const right = width - 24;
  const top = 7;
  const bottom = height - 11;
  const plotWidth = right - left;
  const plotHeight = bottom - top;
  const shape = dynamicsShape(type, values);
  const minDb = -60;
  const maxDb = 0;
  const xAt = (db: number): number => left + ((db - minDb) / (maxDb - minDb)) * plotWidth;
  const yAt = (db: number): number => bottom - ((db - minDb) / (maxDb - minDb)) * plotHeight;

  grid(ctx, left, top, plotWidth, plotHeight, 3);

  // Unity reference.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(right, top);
  ctx.stroke();
  ctx.setLineDash([]);

  // The knee: a shaded band where the curve rounds into the ratio.
  if (shape.knee > 0.5) {
    const from = xAt(shape.threshold + shape.knee / 2);
    const to = xAt(shape.threshold - shape.knee / 2);
    const shade = ctx.createLinearGradient(from, 0, to, 0);
    shade.addColorStop(0, `${accent}26`);
    shade.addColorStop(1, `${accent}05`);
    ctx.fillStyle = shade;
    ctx.fillRect(Math.min(from, to), top, Math.abs(to - from) + 1, plotHeight);
  }

  ctx.beginPath();
  for (let db = minDb; db <= maxDb; db += 0.75) {
    const out = compressorGainDb(db, shape);
    const x = xAt(db);
    const y = yAt(out);
    if (db === minDb) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // A live signal dot: the input level comes from the real meter, the height
  // from the same transfer curve the graph is running.
  const inputDb = -54 + Math.max(0, Math.min(1, level)) * 54;
  const liveY = yAt(compressorGainDb(inputDb, shape));
  const liveX = xAt(inputDb);
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(liveX, liveY, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Threshold marker pulses at the panel's own tempo.
  const thresholdX = xAt(shape.threshold);
  ctx.strokeStyle = `${accent}88`;
  ctx.globalAlpha = 0.5 + 0.3 * Math.sin(phase * 1.6);
  ctx.beginPath();
  ctx.moveTo(thresholdX, top);
  ctx.lineTo(thresholdX, bottom);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.font = mono(7);
  ctx.fillText('-60', left, height - 1);
  ctx.fillText(`${shape.threshold.toFixed(0)} dB · ${shape.ratio.toFixed(1)}:1`, left + 22, height - 1);

  paintMeter(ctx, width, height, level, accent);
}

/* ------------------------------------------------------------ drive / tape */

function drawDrive(
  canvas: HTMLCanvasElement,
  values: Values,
  accent: string,
  level: number,
  phase: number,
  tape: boolean,
): void {
  const ctx = getContext(canvas);
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  paintBackdrop(ctx, width, height);

  const left = 14;
  const right = width - 24;
  const top = 7;
  const bottom = height - 11;
  const plotWidth = right - left;
  const plotHeight = bottom - top;
  const xAt = (x: number): number => left + ((x + 1) / 2) * plotWidth;
  const yAt = (y: number): number => bottom - ((y + 1) / 2) * plotHeight;

  grid(ctx, left, top, plotWidth, plotHeight, 2);

  const points = tape
    ? Array.from({ length: 121 }, (_, index) => {
        const x = (index / 120) * 2 - 1;
        const bias = values.bias ?? 0.35;
        const drive = values.drive ?? 0.3;
        const bent = tapeBiasShape(x, bias);
        const hot = Math.max(-1, Math.min(1, x * (1 + drive * 2.4)));
        return { x, y: (1 - drive) * bent + drive * tapeBiasShape(hot, bias) };
      })
    : driveCurvePoints(values.drive ?? 0.35, values.mode ?? 0, values.bias ?? 0);
  if (!tape) {
    const mode = driveMode(values.mode ?? 0);
    ctx.fillStyle = `${accent}10`;
    ctx.fillRect(left, top, plotWidth, plotHeight);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.font = mono(7);
    ctx.fillText(mode.character, left + 3, top + 8);
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(right, top);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xAt(point.x);
    const y = yAt(point.y);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.9;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 5;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // The signal walks the curve; on tape it also drifts with wow and flutter.
  const wobble = tape
    ? Math.sin(phase * 0.9) * 0.035 * (values.wow ?? 0.25) + Math.sin(phase * 7.1) * 0.012 * (values.flutter ?? 0.15)
    : 0;
  const travel = -0.85 + ((phase * 0.32) % 1.7) + wobble;
  const probe = Math.max(-1, Math.min(1, travel));
  const probeY = tape
    ? (1 - (values.drive ?? 0.3)) * tapeBiasShape(probe, values.bias ?? 0.35) +
      (values.drive ?? 0.3) * tapeBiasShape(Math.max(-1, Math.min(1, probe * (1 + (values.drive ?? 0.3) * 2.4))), values.bias ?? 0.35)
    : driveCurvePoints(values.drive ?? 0.35, values.mode ?? 0, values.bias ?? 0).find(
        (point) => Math.abs(point.x - probe) < 0.02,
      )?.y ?? probe;
  ctx.fillStyle = '#fff';
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(xAt(probe), yAt(probeY), 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.font = mono(7);
  ctx.fillText('−1', left, height - 1);
  ctx.fillText('+1', right - 9, height - 1);
  if (tape) ctx.fillText('transport', left + 18, height - 1);

  paintMeter(ctx, width, height, level, accent);
}

/* ----------------------------------------------------------------- filter */

function drawFilter(
  canvas: HTMLCanvasElement,
  values: Values,
  accent: string,
  level: number,
  phase: number,
): void {
  const ctx = getContext(canvas);
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  paintBackdrop(ctx, width, height);

  const left = 14;
  const right = width - 24;
  const top = 7;
  const bottom = height - 11;
  const plotWidth = right - left;
  const plotHeight = bottom - top;
  const mode = filterMode(values.mode ?? 0);
  const base = Math.max(80, Math.min(18000, values.freq ?? 9000));
  const depth = Math.max(0, Math.min(1, values.depth ?? 0));
  const rate = Math.max(0, Math.min(12, values.lfo ?? 0));
  const swing = Math.sin(phase * Math.max(0.35, rate) * 1.4) * depth;
  const cutoff = Math.max(80, Math.min(18000, base * Math.pow(2, swing * 3.2)));

  const xAt = (freq: number): number => left + (Math.log(freq / 20) / Math.log(1000)) * plotWidth;
  const yAt = (db: number): number => top + plotHeight / 2 - (Math.max(-30, Math.min(24, db)) / 30) * (plotHeight / 2);

  grid(ctx, left, top, plotWidth, plotHeight, 4);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
  ctx.beginPath();
  ctx.moveTo(left, top + plotHeight / 2);
  ctx.lineTo(right, top + plotHeight / 2);
  ctx.stroke();

  const band = { type: mode.id, freq: cutoff, q: values.q ?? 0.9 };
  const points: { freq: number; db: number }[] = [];
  for (let index = 0; index < 130; index++) {
    const freq = Math.exp(Math.log(20) + ((Math.log(20000) - Math.log(20)) * index) / 129);
    points.push({ freq, db: biquadGainDb(band, 48000, freq) });
  }

  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, `${accent}44`);
  fill.addColorStop(1, `${accent}00`);
  ctx.beginPath();
  ctx.moveTo(left, yAt(0));
  for (const point of points) ctx.lineTo(xAt(point.freq), yAt(point.db));
  ctx.lineTo(right, yAt(0));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xAt(point.freq);
    const y = yAt(point.db);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.9;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // The cutoff rides the LFO, so this dot moves when the modulation does.
  const markerX = xAt(cutoff);
  const markerY = yAt(biquadGainDb(band, 48000, cutoff));
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(markerX, markerY, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // LFO trail along the bottom.
  ctx.strokeStyle = `${accent}99`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let step = 0; step <= 60; step++) {
    const x = left + (plotWidth * step) / 60;
    const y = height - 4 - (Math.sin(step / 60 * Math.PI * 4 + phase * rate) * 0.5 + 0.5) * 4 * Math.max(0.15, depth);
    if (step === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.font = mono(7);
  ctx.fillText(`${mode.name.toUpperCase()} · ${Math.round(cutoff)} Hz`, left, height - 1);

  paintMeter(ctx, width, height, level, accent);
}

/* ---------------------------------------------------------------- chorus */

function drawChorus(
  canvas: HTMLCanvasElement,
  values: Values,
  accent: string,
  level: number,
  phase: number,
): void {
  const ctx = getContext(canvas);
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  paintBackdrop(ctx, width, height);

  const left = 14;
  const right = width - 24;
  const top = 9;
  const bottom = height - 12;
  const plotWidth = right - left;
  const plotHeight = bottom - top;
  const mode = chorusMode(values.mode ?? 0);
  const rate = Math.max(0.05, Math.min(6, values.rate ?? 0.8));
  const depth = Math.max(0, Math.min(1, values.depth ?? 0.35));

  grid(ctx, left, top, plotWidth, plotHeight, 2);

  for (let voice = 0; voice < mode.voices; voice++) {
    const offset = chorusPhaseOffset(voice, mode.voices);
    const drift = (phase * rate * mode.rateScale) % 1;
    const voiceColour = voice === 0 ? accent : voice === 1 ? '#a78bfa' : '#38bdf8';

    ctx.beginPath();
    for (let step = 0; step <= 90; step++) {
      const turn = step / 90;
      const y =
        top + plotHeight / 2 - Math.sin((turn + offset + drift) * Math.PI * 2) * (plotHeight / 2 - 3) * (0.25 + depth * 0.75);
      const x = left + turn * plotWidth;
      if (step === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = voiceColour;
    ctx.globalAlpha = 0.45 + (voice + 1) / mode.voices / 2;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Current tap position, panned by the spread control.
    const tapPhase = drift + offset;
    const tapY =
      top + plotHeight / 2 - Math.sin(tapPhase * Math.PI * 2) * (plotHeight / 2 - 3) * (0.25 + depth * 0.75);
    const tapX = left + ((tapPhase % 1) + 1) % 1 * plotWidth;
    ctx.fillStyle = voiceColour;
    ctx.beginPath();
    ctx.arc(tapX, tapY, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  const panWidth = Math.max(0, Math.min(1, values.spread ?? 0.6));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.font = mono(7);
  ctx.fillText(`${mode.name.toUpperCase()} · ${mode.voices} voice${mode.voices === 1 ? '' : 's'}`, left, height - 1);
  const barLeft = right - 44;
  const barWidth = 40 * panWidth;
  ctx.fillStyle = `${accent}66`;
  ctx.fillRect(barLeft, height - 5, barWidth, 2);

  paintMeter(ctx, width, height, level, accent);
}

/* -------------------------------------------------------------- dispatch */

function draw(
  canvas: HTMLCanvasElement,
  type: DeviceType,
  values: Values,
  accent: string,
  level: number,
  phase: number,
): void {
  switch (type) {
    case 'eq3':
    case 'console':
    case 'air':
      drawEq(canvas, type, values, accent, level, phase);
      return;
    case 'compressor':
    case 'limiter':
    case 'busglue':
    case 'fet':
    case 'opto':
      drawDynamics(canvas, type, values, accent, level, phase);
      return;
    case 'drive':
      drawDrive(canvas, values, accent, level, phase, false);
      return;
    case 'tape':
      drawDrive(canvas, values, accent, level, phase, true);
      return;
    case 'filter':
      drawFilter(canvas, values, accent, level, phase);
      return;
    case 'chorus':
      drawChorus(canvas, values, accent, level, phase);
      return;
    default: {
      const ctx = getContext(canvas);
      if (ctx) paintBackdrop(ctx, canvas.width, canvas.height);
    }
  }
}

/* ----------------------------------------------------------- hero readout */

const HERO: Partial<Record<DeviceType, { key: string; tag: (values: Values) => string; speed: number }>> = {
  eq3: { key: 'midGain', tag: (v) => `${Math.round(v.lowGain ?? 0)}/${Math.round(v.midGain ?? 0)}/${Math.round(v.highGain ?? 0)} dB`, speed: 0.9 },
  console: {
    key: 'midGain',
    tag: (v) => `${(v.comp ?? 1) >= 0.5 ? 'comp in' : 'comp out'} · ${Math.round(v.hpf ?? 30)} Hz HPF`,
    speed: 0.9,
  },
  air: { key: 'high', tag: (v) => `${Math.round(v.freq ?? 12000)} Hz shelf`, speed: 0.9 },
  compressor: {
    key: 'threshold',
    tag: (v) => `${(v.ratio ?? 4).toFixed(1)}:1 · ${Math.round(v.knee ?? 6)} dB knee`,
    speed: 1.1,
  },
  limiter: {
    key: 'ceiling',
    tag: (v) => `${limiterMode(v.mode ?? 0).name} · ${Math.round(v.release ?? 0.1 * 1000)} ms`,
    speed: 1.1,
  },
  busglue: {
    key: 'threshold',
    tag: (v) => `${(v.ratio ?? 2).toFixed(1)}:1 · ${Math.round(v.knee ?? 2)} dB knee`,
    speed: 1.1,
  },
  fet: { key: 'input', tag: (v) => `${(v.ratio ?? 4).toFixed(0)}:1 · ${(v.all ?? 0) >= 0.5 ? 'all buttons' : 'FET'}`, speed: 1.1 },
  opto: { key: 'peak', tag: (v) => `${(v.mode ?? 0) >= 0.5 ? 'limit' : 'compress'} · ${(v.release ?? 0.6).toFixed(2)} s`, speed: 1.1 },
  drive: { key: 'drive', tag: (v) => `${driveMode(v.mode ?? 0).name} · ${Math.round(v.tone ?? 6500)} Hz`, speed: 1.4 },
  tape: { key: 'drive', tag: (v) => `${Math.round((v.wow ?? 0.25) * 100)}% wow · ${Math.round((v.flutter ?? 0.15) * 100)}% flutter`, speed: 1.4 },
  filter: {
    key: 'freq',
    tag: (v) => `${filterMode(v.mode ?? 0).name} · ${Math.round(v.q ?? 0.9)} Q`,
    speed: 1.2,
  },
  chorus: { key: 'rate', tag: (v) => `${chorusMode(v.mode ?? 0).name} · ${Math.round((v.spread ?? 0.6) * 100)}% spread`, speed: 1.3 },
};

function heroValue(type: DeviceType, values: Values): { text: string; unit: string } {
  const hero = HERO[type];
  const spec = DEVICE_SPECS[type];
  if (!hero) return { text: '—', unit: '' };
  const param = spec.params.find((entry) => entry.key === hero.key);
  if (!param) return { text: '—', unit: '' };
  const raw = values[hero.key] ?? param.default;
  const text = formatParam(param, raw);
  const unit = param.choices ? '' : param.unit === '%' ? '' : (param.unit ?? '');
  return { text, unit };
}

function modeRows(
  type: DeviceType,
  options: ModulePanelOptions,
  onRefresh: () => void,
): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const param of DEVICE_SPECS[type].params) {
    if (!param.choices) continue;
    const row = el('div', 'fx-modes');
    const current = Math.round(options.values[param.key] ?? param.default);
    param.choices.forEach((name, index) => {
      const button = el('button', `fx-mode${current === index ? ' is-on' : ''}`, name);
      button.type = 'button';
      button.setAttribute('aria-pressed', current === index ? 'true' : 'false');
      button.title = `${param.label}: ${name}`;
      button.addEventListener('click', () => {
        options.onChange(param.key, index);
        options.onCommit();
        onRefresh();
      });
      row.appendChild(button);
    });
    rows.push(row);
  }
  return rows;
}

function knobRows(
  type: DeviceType,
  options: ModulePanelOptions,
  repaint: () => void,
): HTMLElement[] {
  const params = DEVICE_SPECS[type].params.filter((param) => !param.choices);
  const rows: HTMLElement[] = [];
  for (let start = 0; start < params.length; start += 4) {
    const row = el('div', 'fx-knobs');
    for (const param of params.slice(start, start + 4)) {
      const spec: ParamSpec = param;
      const knob = createKnob({
        label: spec.label,
        value: options.values[spec.key] ?? spec.default,
        min: spec.min,
        max: spec.max,
        size: 44,
        color: options.accent,
        format: (value) => formatParam(spec, value),
        defaultValue: spec.default,
        onChange: (value) => {
          options.onChange(spec.key, value);
          repaint();
        },
        onCommit: options.onCommit,
      });
      row.appendChild(knob.element);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Mounts the full faceplate: mode selectors, a live display, the readout and
 * every parameter as a knob. Animation stops as soon as the card is detached.
 */
export function mountModulePanel(host: HTMLElement, options: ModulePanelOptions): void {
  host.replaceChildren();
  host.classList.add('fx-panel', 'is-module');
  host.style.setProperty('--fx-accent', options.accent);

  const display = el('div', 'fx-display is-module');
  const canvas = el('canvas', 'fx-scope') as HTMLCanvasElement;
  canvas.width = 320;
  canvas.height = 64;
  const readout = el('div', 'fx-readout');
  const value = el('strong');
  const unit = el('span');
  readout.append(value, unit);
  const tag = el('span', 'fx-tag');
  display.append(canvas, readout, tag);

  const hero = HERO[options.type];
  const spec = DEVICE_SPECS[options.type];
  const paramByKey = new Map(spec.params.map((param) => [param.key, param]));
  let phase = 0;
  let raf = 0;
  let previous = performance.now();

  const paint = (): void => {
    if (hero) {
      const read = heroValue(options.type, options.values);
      value.textContent = read.text;
      unit.textContent = read.unit;
      tag.textContent = hero.tag(options.values);
    }
    draw(canvas, options.type, options.values, options.accent, options.level(), phase);
  };

  const tick = (stamp: number): void => {
    if (!canvas.isConnected) {
      raf = 0;
      return;
    }
    const elapsed = Math.max(0, Math.min(0.1, (stamp - previous) / 1000));
    previous = stamp;
    phase += elapsed * (hero?.speed ?? 1);
    paint();
    raf = requestAnimationFrame(tick);
  };

  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);
  else paint();

  const refresh = (): void => options.rerender();

  const rows = [
    ...modeRows(options.type, options, refresh),
    display,
    ...knobRows(options.type, options, paint),
  ];
  host.append(...rows);

  // A short legend naming the hero parameter keeps the readout unambiguous.
  if (hero && paramByKey.has(hero.key)) {
    const legend = el('div', 'fx-legend');
    legend.textContent = paramByKey.get(hero.key)!.label;
    display.appendChild(legend);
  }

  paint();

  // A re-render replaces this card; stop the loop when it goes away.
  host.closest('.device')?.addEventListener('remove', () => {
    if (raf) cancelAnimationFrame(raf);
  });

}
