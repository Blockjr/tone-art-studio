import { micCurve, micModelAt } from '../audio/mics';

const GRID = '#232833';
const CURVE = '#f5a524';
const TEXT = '#6d7380';

/** Plots the emulation's magnitude response, 20 Hz – 20 kHz, with a 0 dB line. */
export function drawMicCurve(canvas: HTMLCanvasElement, params: Record<string, number>): void {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const width = Math.max(120, Math.round(canvas.clientWidth || 300));
  const height = Math.max(54, Math.round(canvas.clientHeight || 78));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, width, height);

  const points = micCurve(params, 128, 20, 20000, 48000);
  let min = 0;
  let max = 0;
  for (const point of points) {
    min = Math.min(min, point.db);
    max = Math.max(max, point.db);
  }
  const pad = Math.max(2, (max - min) * 0.15);
  // Keep the plot readable: cap the window at ±18 dB and let steep roll-offs run
  // off the bottom instead of squashing the whole curve into a flat line.
  const lo = Math.max(-18, Math.min(-6, Math.floor(min - pad)));
  const hi = Math.min(18, Math.max(6, Math.ceil(max + pad)));
  const span = Math.max(6, hi - lo);

  const padLeft = 20;
  const padRight = 4;
  const padTop = 6;
  const padBottom = 12;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xFor = (freq: number): number =>
    padLeft + (Math.log(freq / 20) / Math.log(1000)) * plotW;
  const yFor = (db: number): number => padTop + ((hi - db) / span) * plotH;

  ctx.lineWidth = 1;
  ctx.strokeStyle = GRID;
  ctx.fillStyle = TEXT;
  ctx.font = '8px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (const freq of [100, 1000, 10000]) {
    const x = Math.round(xFor(freq)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();
    ctx.fillText(freq >= 1000 ? `${freq / 1000}k` : String(freq), x - 3, height - 5);
  }

  for (const db of [hi, 0, lo]) {
    const y = Math.round(yFor(db)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.strokeStyle = db === 0 ? '#3a4152' : GRID;
    ctx.stroke();
    ctx.fillText(`${db > 0 ? '+' : ''}${db}`, padLeft - 3, y);
  }

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xFor(point.freq);
    const y = yFor(point.db);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  const fill = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
  fill.addColorStop(0, 'rgba(245, 165, 36, 0.28)');
  fill.addColorStop(1, 'rgba(245, 165, 36, 0.02)');
  ctx.save();
  ctx.lineTo(padLeft + plotW, yFor(0));
  ctx.lineTo(padLeft, yFor(0));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xFor(point.freq);
    const y = yFor(point.db);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = CURVE;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  const model = micModelAt(params.model ?? 0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#8b93a3';
  ctx.font = '8px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(model.name.toUpperCase(), padLeft + 2, 4);
}

/** Redraw after the canvas has been laid out. */
export function scheduleMicCurve(canvas: HTMLCanvasElement, params: Record<string, number>): void {
  const draw = (): void => drawMicCurve(canvas, params);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(draw);
  else draw();
}
