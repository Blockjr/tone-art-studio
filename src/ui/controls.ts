import { clamp } from '../core/time';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface KnobOptions {
  label: string;
  value: number;
  min: number;
  max: number;
  size?: number;
  color?: string;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  onCommit?: () => void;
  defaultValue?: number;
}

export interface KnobHandle {
  element: HTMLElement;
  setValue(value: number, silent?: boolean): void;
}

const START_ANGLE = -135;
const END_ANGLE = 135;

function polar(cx: number, cy: number, radius: number, angle: number): [number, number] {
  const rad = ((angle - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
}

function arc(cx: number, cy: number, radius: number, from: number, to: number): string {
  const [x0, y0] = polar(cx, cy, radius, from);
  const [x1, y1] = polar(cx, cy, radius, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function createKnob(options: KnobOptions): KnobHandle {
  const size = options.size ?? 44;
  const min = options.min;
  const max = options.max;
  const range = max - min;
  const color = options.color ?? 'var(--rose)';
  let value = clamp(options.value, min, max);

  const root = el('div', 'knob');
  const dial = el('div', 'knob-dial');
  dial.style.width = `${size}px`;
  dial.style.height = `${size}px`;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

  const center = size / 2;
  const radius = size / 2 - 7;

  // A soft metal cap, so knobs read as hardware rather than flat rings.
  const defs = document.createElementNS(SVG_NS, 'defs');
  const gradientId = `knob-hub-${Math.random().toString(36).slice(2, 9)}`;
  const gradient = document.createElementNS(SVG_NS, 'radialGradient');
  gradient.setAttribute('id', gradientId);
  gradient.setAttribute('cx', '34%');
  gradient.setAttribute('cy', '26%');
  gradient.setAttribute('r', '80%');
  for (const [offset, colour] of [
    ['0%', '#414a5a'],
    ['55%', '#1b2029'],
    ['100%', '#0c0f14'],
  ] as [string, string][]) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', colour);
    gradient.appendChild(stop);
  }
  defs.appendChild(gradient);
  svg.appendChild(defs);

  const ticks = document.createElementNS(SVG_NS, 'g');
  ticks.setAttribute('class', 'knob-ticks');
  for (let step = 0; step <= 10; step++) {
    const angle = START_ANGLE + ((END_ANGLE - START_ANGLE) * step) / 10;
    const [x1, y1] = polar(center, center, radius + 1.6, angle);
    const [x2, y2] = polar(center, center, radius + 3.6, angle);
    const tick = document.createElementNS(SVG_NS, 'line');
    tick.setAttribute('x1', String(x1));
    tick.setAttribute('y1', String(y1));
    tick.setAttribute('x2', String(x2));
    tick.setAttribute('y2', String(y2));
    tick.setAttribute('stroke', 'rgba(255, 255, 255, 0.16)');
    tick.setAttribute('stroke-width', '1');
    tick.setAttribute('stroke-linecap', 'round');
    ticks.appendChild(tick);
  }
  svg.appendChild(ticks);

  const track = document.createElementNS(SVG_NS, 'path');
  track.setAttribute('d', arc(center, center, radius, START_ANGLE, END_ANGLE));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', '#2a2f3b');
  track.setAttribute('stroke-width', '3');
  track.setAttribute('stroke-linecap', 'round');

  const valueArc = document.createElementNS(SVG_NS, 'path');
  valueArc.setAttribute('fill', 'none');
  valueArc.setAttribute('stroke', color);
  valueArc.setAttribute('stroke-width', '3');
  valueArc.setAttribute('stroke-linecap', 'round');

  const pointer = document.createElementNS(SVG_NS, 'line');
  pointer.setAttribute('stroke', '#e9ecf3');
  pointer.setAttribute('stroke-width', '1.6');
  pointer.setAttribute('stroke-linecap', 'round');

  const hub = document.createElementNS(SVG_NS, 'circle');
  hub.setAttribute('class', 'knob-hub');
  hub.setAttribute('cx', String(center));
  hub.setAttribute('cy', String(center));
  hub.setAttribute('r', String(Math.max(2, radius - 6)));
  hub.setAttribute('fill', `url(#${gradientId})`);
  hub.setAttribute('stroke', 'rgba(255, 255, 255, 0.12)');
  hub.setAttribute('stroke-width', '0.7');

  svg.append(track, valueArc, pointer, hub);
  dial.appendChild(svg);

  const readout = el('div', 'knob-value');
  const label = el('div', 'knob-label', options.label);
  root.append(dial, readout, label);
  dial.setAttribute('tabindex', '0');
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', options.label);
  dial.setAttribute('aria-valuemin', String(min));
  dial.setAttribute('aria-valuemax', String(max));
  dial.title = `${options.label} — drag, scroll or use arrow keys; double-click to reset`;

  const format = options.format ?? ((v: number) => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0)));

  const paint = (): void => {
    const t = range === 0 ? 0 : (value - min) / range;
    const angle = START_ANGLE + (END_ANGLE - START_ANGLE) * clamp(t, 0, 1);
    if (angle > START_ANGLE + 0.4) {
      valueArc.setAttribute('d', arc(center, center, radius, START_ANGLE, angle));
    } else {
      valueArc.setAttribute('d', '');
    }
    const [px, py] = polar(center, center, radius - 1.5, angle);
    const [ix, iy] = polar(center, center, radius * 0.32, angle);
    pointer.setAttribute('x1', String(ix));
    pointer.setAttribute('y1', String(iy));
    pointer.setAttribute('x2', String(px));
    pointer.setAttribute('y2', String(py));
    readout.textContent = format(value);
    dial.setAttribute('aria-valuenow', String(value));
    dial.setAttribute('aria-valuetext', format(value));
  };

  const setValue = (next: number, silent = false): void => {
    const clamped = clamp(next, min, max);
    if (clamped === value) return;
    value = clamped;
    paint();
    if (!silent) options.onChange(value);
  };

  dial.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startValue = value;
    dial.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent): void => {
      const fine = moveEvent.shiftKey ? 0.2 : 1;
      const delta = ((startY - moveEvent.clientY) / 150) * range * fine;
      setValue(startValue + delta);
    };
    const up = (): void => {
      dial.removeEventListener('pointermove', move);
      dial.removeEventListener('pointerup', up);
      options.onCommit?.();
    };
    dial.addEventListener('pointermove', move);
    dial.addEventListener('pointerup', up);
  });

  dial.addEventListener('dblclick', () => {
    if (options.defaultValue === undefined) return;
    setValue(options.defaultValue);
    options.onCommit?.();
  });

  dial.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const fine = event.shiftKey ? 0.2 : 1;
      setValue(value - Math.sign(event.deltaY) * (range / 100) * 2 * fine);
      options.onCommit?.();
    },
    { passive: false },
  );

  dial.addEventListener('keydown', (event) => {
    const step = Math.max(range / 100, event.shiftKey ? range / 1000 : 0);
    let next: number | null = null;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = value + step;
    if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = value - step;
    if (event.key === 'PageUp') next = value + step * 10;
    if (event.key === 'PageDown') next = value - step * 10;
    if (event.key === 'Home') next = min;
    if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    setValue(next);
    options.onCommit?.();
  });

  paint();

  return {
    element: root,
    setValue: (v: number, silent = false) => {
      value = clamp(v, min, max);
      paint();
      if (!silent) options.onChange(value);
    },
  };
}
