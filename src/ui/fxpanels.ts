/**
 * Faceplates for the echo and reverb modules.
 *
 * Both keep the same contract as the plain knob cards, but add a mode selector,
 * a live display and a readout that says what the engine is doing: the echo
 * draws its repeat pattern and the active note division, the reverb draws its
 * decay envelope with the early reflections in front of it. Everything is
 * redrawn from the real parameter values, so the picture never lies about the
 * sound.
 */

import {
  DELAY_MODES,
  REVERB_MODES,
  dampingCutoff,
  delayMode,
  delayTimeSeconds,
  noteDivision,
  reverbMode,
} from '../audio/fxmath';
import { DEVICE_SPECS, formatParam, type ParamSpec } from '../audio/specs';
import { createKnob, el } from './controls';
import { paintMeter } from './modulepanel';

export interface FxPanelOptions {
  values: Record<string, number>;
  accent: string;
  bpm: number;
  onChange: (key: string, value: number) => void;
  onCommit: () => void;
  rerender: () => void;
  /** live output peak of the insert, 0..1 */
  level?: () => number;
}

function paramSpec(type: 'delay' | 'reverb', key: string): ParamSpec | undefined {
  return DEVICE_SPECS[type].params.find((entry) => entry.key === key);
}

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

function paintBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#0c1017');
  gradient.addColorStop(1, '#070910');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  for (let x = 0.5; x < width; x += 26) {
    ctx.beginPath();
    ctx.moveTo(x, 5);
    ctx.lineTo(x, height - 5);
    ctx.stroke();
  }
}

function bar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fill();
}

/** Repeat pattern: one bar per echo inside a fixed two-second window. */
function drawEcho(
  canvas: HTMLCanvasElement,
  values: Record<string, number>,
  bpm: number,
  accent: string,
  level = 0,
  phase = 0,
): void {
  const ctx = getContext(canvas);
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  paintBackdrop(ctx, width, height);

  const mode = delayMode(values.mode ?? 0);
  const time = delayTimeSeconds(
    values.time ?? 0.34,
    (values.sync ?? 0) >= 0.5,
    values.division ?? 2,
    bpm,
    mode,
  );
  const frozen = (values.freeze ?? 0) >= 0.5;
  const feedback = frozen ? 1 : Math.min(0.985, Math.max(0, values.feedback ?? 0.34));
  const duck = Math.max(0, Math.min(1, values.duck ?? 0));
  const pingpong = mode.id === 'pingpong';
  const horizon = 2;
  const count = Math.min(12, Math.max(2, Math.ceil(horizon / time) + 1));

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.beginPath();
  ctx.moveTo(10, height / 2 + 0.5);
  ctx.lineTo(width - 10, height / 2 + 0.5);
  ctx.stroke();

  for (let index = 0; index < count; index++) {
    const at = (index + 1) * time;
    if (at > horizon + 0.001) break;
    const x = 12 + (at / horizon) * (width - 24);
    const amplitude = Math.pow(feedback, index);
    const size = 6 + amplitude * 24;

    ctx.globalAlpha = 0.22 + amplitude * 0.78;
    ctx.fillStyle = accent;
    if (pingpong) {
      const y = index % 2 === 0 ? height / 2 - 12 - size / 2 : height / 2 + 12 - size / 2;
      bar(ctx, x - 3, y, 6, size, 3);
    } else {
      bar(ctx, x - 2.5, height / 2 - size / 2, 5, size, 2.5);
    }
  }

  // The wet/dry control shades the whole panel, like the mix it represents.
  const mix = Math.max(0, Math.min(1, values.mix ?? 0.26));
  ctx.globalAlpha = 0.1 + mix * 0.22;
  const wash = ctx.createLinearGradient(0, 0, width, 0);
  wash.addColorStop(0, accent);
  wash.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, height - 2, width, 2);
  ctx.globalAlpha = 1;

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  // A slow scan across the repeat window shows the transport moving.
  const scan = 12 + ((phase * 0.22) % 1) * (width - 36);
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  ctx.moveTo(scan, 6);
  ctx.lineTo(scan, height - 6);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Freeze and ducking are audible states, so the display says so plainly.
  ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = frozen ? '#bae6fd' : 'rgba(255, 255, 255, 0.42)';
  const stateLabel = frozen ? 'HOLD' : duck > 0.01 ? `DUCK ${Math.round(duck * 100)}%` : '';
  if (stateLabel) ctx.fillText(stateLabel, width / 2, 13);
  ctx.textAlign = 'left';

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('0', 10, height - 6);
  ctx.fillText('2 s', width - 22, height - 6);
  paintMeter(ctx, width, height, level, accent);
}

/** Decay envelope: early taps, the RT60 slope and the damped high band. */
function drawReverb(
  canvas: HTMLCanvasElement,
  values: Record<string, number>,
  accent: string,
  level = 0,
  phase = 0,
): void {
  const ctx = getContext(canvas);
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  paintBackdrop(ctx, width, height);

  const mode = reverbMode(values.mode ?? 1);
  const decay = Math.max(0.4, Math.min(12, values.decay ?? 2.4));
  const pre = Math.max(0, Math.min(0.2, values.preDelay ?? 0.02));
  const damping = Math.max(0, Math.min(1, values.damping ?? 0.45));
  const early = Math.max(0, Math.min(1, values.early ?? 0.6));
  const horizon = decay * 1.02;
  const top = 10;
  const bottom = height - 9;
  const scale = bottom - top;

  const envelope = (t: number): number => {
    if (t <= pre) return 0;
    return Math.exp((-6.9078 * (t - pre)) / decay);
  };

  // Early reflection spikes.
  ctx.strokeStyle = accent;
  for (const tap of [
    { time: 7.3, gain: 0.72 },
    { time: 11.9, gain: 0.58 },
    { time: 16.1, gain: 0.5 },
    { time: 21.7, gain: 0.42 },
    { time: 27.3, gain: 0.36 },
    { time: 34.9, gain: 0.3 },
    { time: 44.3, gain: 0.24 },
    { time: 57.1, gain: 0.18 },
  ]) {
    const at = pre + (tap.time / 1000) * (0.7 + (values.space ?? 1) * 0.3);
    if (at > horizon) continue;
    const x = 14 + (at / horizon) * (width - 28);
    ctx.globalAlpha = 0.12 + early * mode.early * tap.gain * 0.7;
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom - scale * tap.gain * 0.5);
    ctx.stroke();
    // Early reflections twinkle as the tail runs.
    ctx.globalAlpha = 0.2 + 0.25 * (0.5 + 0.5 * Math.sin(phase * 2.4 - tap.time * 0.2));
    ctx.beginPath();
    ctx.arc(x, bottom - scale * tap.gain * 0.5, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }

  // Damped high band falls faster than the reported RT60.
  const damped = (t: number): number => {
    if (t <= pre) return 0;
    return Math.exp((-6.9078 * (t - pre)) / (decay / (1 + damping * 2.4)));
  };

  const steps = 140;
  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, `${accent}55`);
  fill.addColorStop(1, `${accent}00`);

  ctx.beginPath();
  ctx.moveTo(14, bottom);
  for (let step = 0; step <= steps; step++) {
    const t = (step / steps) * horizon;
    const x = 14 + (step / steps) * (width - 28);
    ctx.lineTo(x, bottom - envelope(t) * scale);
  }
  ctx.lineTo(width - 14, bottom);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  for (let step = 0; step <= steps; step++) {
    const t = (step / steps) * horizon;
    const x = 14 + (step / steps) * (width - 28);
    const y = bottom - envelope(t) * scale;
    if (step === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.8;
  ctx.globalAlpha = 0.95;
  ctx.stroke();

  ctx.beginPath();
  for (let step = 0; step <= steps; step++) {
    const t = (step / steps) * horizon;
    const x = 14 + (step / steps) * (width - 28);
    const y = bottom - damped(t) * scale;
    if (step === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('0', 14, height - 2);
  ctx.fillText(`${Math.round(dampingCutoff(damping) / 100) / 10}k`, width - 34, height - 2);
  paintMeter(ctx, width, height, level, accent);
}

function modeRow(
  names: string[],
  current: number,
  onPick: (index: number) => void,
): HTMLElement {
  const row = el('div', 'fx-modes');
  names.forEach((name, index) => {
    const button = el('button', `fx-mode${Math.round(current) === index ? ' is-on' : ''}`, name);
    button.type = 'button';
    button.setAttribute('aria-pressed', Math.round(current) === index ? 'true' : 'false');
    button.addEventListener('click', () => onPick(index));
    row.appendChild(button);
  });
  return row;
}

function knobRow(
  type: 'delay' | 'reverb',
  keys: string[],
  options: FxPanelOptions,
  paint: () => void,
  locked: Map<string, HTMLElement>,
): HTMLElement {
  const row = el('div', `fx-knobs${keys.length > 4 ? ' is-five' : keys.length === 2 ? ' is-two' : ''}`);
  for (const key of keys) {
    const spec = paramSpec(type, key);
    if (!spec) continue;
    const knob = createKnob({
      label: spec.label,
      value: options.values[key] ?? spec.default,
      min: spec.min,
      max: spec.max,
      size: 44,
      color: options.accent,
      format: (value) => formatParam(spec, value),
      defaultValue: spec.default,
      onChange: (value) => {
        options.onChange(key, value);
        paint();
      },
      onCommit: options.onCommit,
    });
    if (key === 'time' || key === 'feedback') locked.set(key, knob.element);
    row.appendChild(knob.element);
  }
  return row;
}

export function mountEchoPanel(host: HTMLElement, options: FxPanelOptions): void {
  host.replaceChildren();
  host.classList.add('fx-panel');
  host.style.setProperty('--fx-accent', options.accent);

  const display = el('div', 'fx-display');
  const canvas = el('canvas', 'fx-scope') as HTMLCanvasElement;
  canvas.width = 320;
  canvas.height = 58;
  const readout = el('div', 'fx-readout');
  const value = el('strong');
  const unit = el('span');
  readout.append(value, unit);
  const sync = el('button', 'fx-sync', 'Sync');
  sync.type = 'button';
  const freeze = el('button', 'fx-freeze', 'Freeze');
  freeze.type = 'button';
  freeze.title = 'Hold the current repeats without adding new ones';
  const tag = el('span', 'fx-tag');
  display.append(canvas, readout, sync, freeze, tag);

  const divisionRow = el('div', 'fx-chips');
  const locked = new Map<string, HTMLElement>();

  let phase = 0;
  let raf = 0;
  let previous = performance.now();
  const currentMode = (): ReturnType<typeof delayMode> => delayMode(options.values.mode ?? 0);
  const isSynced = (): boolean => (options.values.sync ?? 0) >= 0.5;
  const isFrozen = (): boolean => (options.values.freeze ?? 0) >= 0.5;

  const paint = (): void => {
    const mode = currentMode();
    const synced = isSynced();
    const seconds = delayTimeSeconds(
      options.values.time ?? 0.34,
      synced,
      options.values.division ?? 2,
      options.bpm,
      mode,
    );
    value.textContent = seconds < 1 ? String(Math.round(seconds * 1000)) : seconds.toFixed(2);
    unit.textContent = seconds < 1 ? 'ms' : 's';
    const frozen = isFrozen();
    sync.classList.toggle('is-on', synced);
    sync.setAttribute('aria-pressed', synced ? 'true' : 'false');
    freeze.classList.toggle('is-on', frozen);
    freeze.setAttribute('aria-pressed', frozen ? 'true' : 'false');
    const timeLabel = synced
      ? `${noteDivision(options.values.division ?? 2).label} · ${options.bpm} BPM`
      : `${mode.name} · free time`;
    tag.textContent = frozen ? `HOLD · ${timeLabel}` : timeLabel;
    divisionRow.hidden = !synced;
    locked.get('time')?.classList.toggle('is-locked', synced || frozen);
    locked.get('feedback')?.classList.toggle('is-locked', frozen);
    for (const [index, chip] of [...divisionRow.children].entries()) {
      chip.classList.toggle('is-on', index === Math.round(options.values.division ?? 2));
    }
    drawEcho(canvas, options.values, options.bpm, options.accent, options.level?.() ?? 0, phase);
  };

  sync.addEventListener('click', () => {
    options.onChange('sync', isSynced() ? 0 : 1);
    options.onCommit();
    paint();
  });

  freeze.addEventListener('click', () => {
    options.onChange('freeze', isFrozen() ? 0 : 1);
    options.onCommit();
    paint();
  });

  for (const [index, division] of ['1/16', '1/8T', '1/8', '1/8.', '1/4'].entries()) {
    const chip = el('button', 'fx-chip', division);
    chip.type = 'button';
    chip.title = `Set the echo to ${division} notes`;
    chip.addEventListener('click', () => {
      options.onChange('division', index);
      options.onCommit();
      paint();
    });
    divisionRow.appendChild(chip);
  }

  const tick = (stamp: number): void => {
    if (!canvas.isConnected) {
      raf = 0;
      return;
    }
    phase += Math.max(0, Math.min(0.1, (stamp - previous) / 1000)) * 0.9;
    previous = stamp;
    paint();
    raf = requestAnimationFrame(tick);
  };
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);

  host.append(
    modeRow(
      DELAY_MODES.map((mode) => mode.name),
      options.values.mode ?? 0,
      (index) => {
        options.onChange('mode', index);
        options.onCommit();
        options.rerender();
      },
    ),
    display,
    divisionRow,
    knobRow('delay', ['time', 'feedback', 'tone', 'mod'], options, paint, locked),
    knobRow('delay', ['drive', 'lowCut', 'width', 'mix'], options, paint, locked),
    knobRow('delay', ['duck', 'duckRelease'], options, paint, locked),
  );

  host.closest('.device')?.addEventListener('remove', () => {
    if (raf) cancelAnimationFrame(raf);
  });

  paint();
}

export function mountReverbPanel(host: HTMLElement, options: FxPanelOptions): void {
  host.replaceChildren();
  host.classList.add('fx-panel');
  host.style.setProperty('--fx-accent', options.accent);

  const display = el('div', 'fx-display is-reverb');
  const canvas = el('canvas', 'fx-scope') as HTMLCanvasElement;
  canvas.width = 320;
  canvas.height = 62;
  const readout = el('div', 'fx-readout');
  const value = el('strong');
  const unit = el('span');
  readout.append(value, unit);
  const tag = el('span', 'fx-tag');
  display.append(canvas, readout, tag);

  let phase = 0;
  let raf = 0;
  let previous = performance.now();
  const paint = (): void => {
    const decay = Math.max(0.4, Math.min(12, options.values.decay ?? 2.4));
    value.textContent = decay.toFixed(1);
    unit.textContent = 's';
    tag.textContent = `${Math.round((options.values.space ?? 1) * 100)}% space · ${Math.round(
      (options.values.early ?? 0.6) * 100,
    )}% early`;
    drawReverb(canvas, options.values, options.accent, options.level?.() ?? 0, phase);
  };

  const tick = (stamp: number): void => {
    if (!canvas.isConnected) {
      raf = 0;
      return;
    }
    phase += Math.max(0, Math.min(0.1, (stamp - previous) / 1000));
    previous = stamp;
    paint();
    raf = requestAnimationFrame(tick);
  };
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);

  host.append(
    modeRow(
      REVERB_MODES.map((mode) => mode.name),
      options.values.mode ?? 1,
      (index) => {
        options.onChange('mode', index);
        options.onCommit();
        options.rerender();
      },
    ),
    display,
    knobRow('reverb', ['decay', 'space', 'preDelay', 'damping', 'mod'], options, paint, new Map()),
    knobRow('reverb', ['lowCut', 'diffuse', 'early', 'width', 'mix'], options, paint, new Map()),
  );

  host.closest('.device')?.addEventListener('remove', () => {
    if (raf) cancelAnimationFrame(raf);
  });

  paint();
}
