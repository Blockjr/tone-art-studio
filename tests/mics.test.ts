import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIC_PARAMS,
  MIC_MODELS,
  MIC_PRESETS,
  micChain,
  micCurve,
  micModelIndex,
  micPresetParams,
  micResponseDb,
  presetsForModel,
} from '../src/audio/mics';
import { DEVICE_SPECS } from '../src/audio/specs';

const base = (overrides: Record<string, number> = {}): Record<string, number> => ({
  ...DEFAULT_MIC_PARAMS,
  ...overrides,
});

const at = (freq: number, params: Record<string, number>): number => micResponseDb(params, freq, 48000);

describe('microphone models', () => {
  it('ships a distinct, documented model for every capsule type', () => {
    expect(MIC_MODELS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(MIC_MODELS.map((model) => model.id)).size).toBe(MIC_MODELS.length);
    expect(new Set(MIC_MODELS.map((model) => model.name)).size).toBe(MIC_MODELS.length);

    for (const model of MIC_MODELS) {
      expect(model.tagline.length).toBeGreaterThan(10);
      expect(model.best.length).toBeGreaterThan(3);
      expect(model.hp).toBeGreaterThanOrEqual(20);
      expect(model.hp).toBeLessThan(200);
      expect(model.presence.freq).toBeGreaterThan(model.mud.freq);
      expect(model.air.freq).toBeGreaterThan(model.presence.freq);
      expect(model.drive).toBeGreaterThanOrEqual(0);
      expect(model.drive).toBeLessThanOrEqual(1);
    }
  });

  it('gives every model its own presets and covers each use case', () => {
    for (const model of MIC_MODELS) {
      const presets = presetsForModel(model.id);
      expect(presets.length, model.id).toBeGreaterThanOrEqual(3);
      for (const entry of presets) {
        expect(entry.modelId).toBe(model.id);
        expect(entry.use.length).toBeGreaterThan(5);
        expect(entry.params.proximity).toBeGreaterThanOrEqual(-1);
        expect(entry.params.proximity).toBeLessThanOrEqual(1);
        expect(Math.abs(entry.params.presence)).toBeLessThanOrEqual(6);
        expect(Math.abs(entry.params.air)).toBeLessThanOrEqual(6);
        expect(entry.params.drive).toBeGreaterThanOrEqual(0);
        expect(entry.params.drive).toBeLessThanOrEqual(1);
      }
    }

    const modelIds = new Set(MIC_MODELS.map((model) => model.id));
    for (const entry of MIC_PRESETS) expect(modelIds.has(entry.modelId)).toBe(true);
    expect(new Set(MIC_PRESETS.map((entry) => entry.id)).size).toBe(MIC_PRESETS.length);
  });

  it('describes the mic emulator as a real, adjustable device', () => {
    const spec = DEVICE_SPECS.micemu;
    expect(spec.category).toBe('Microphone');
    expect(spec.params.map((param) => param.key)).toEqual([
      'model',
      'proximity',
      'presence',
      'air',
      'drive',
      'output',
    ]);
    expect(spec.params[0].max).toBe(MIC_MODELS.length - 1);
  });
});

describe('mic emulation response', () => {
  it('stays flat and finite for the neutral model', () => {
    const curve = micCurve({ ...DEFAULT_MIC_PARAMS, model: micModelIndex('custom') }, 64);
    expect(curve.length).toBe(64);
    expect(curve[0].freq).toBeCloseTo(20, 5);
    expect(curve[curve.length - 1].freq).toBeCloseTo(20000, 0);

    for (const point of curve) {
      expect(Number.isFinite(point.db)).toBe(true);
      // the 20 Hz high-pass corner legitimately costs a few dB at the very bottom
      if (point.freq >= 60) expect(Math.abs(point.db)).toBeLessThan(0.6);
    }
    // neutral = custom model with a wide-open high-pass
    expect(Math.abs(at(1000, { ...DEFAULT_MIC_PARAMS, model: micModelIndex('custom') }))).toBeLessThan(0.3);
  });

  it('rolls the ribbon off far below a condenser', () => {
    const ribbon = at(10000, base({ model: micModelIndex('ribbon') }));
    const condenser = at(10000, base({ model: micModelIndex('condenser') }));
    expect(condenser - ribbon).toBeGreaterThan(4);
  });

  it('lifts presence and air with the trim knobs', () => {
    const flat = base({ model: micModelIndex('condenser') });
    const lifted = base({ model: micModelIndex('condenser'), presence: 6, air: 6 });
    expect(at(3200, lifted) - at(3200, flat)).toBeGreaterThan(4);
    expect(at(14000, lifted) - at(14000, flat)).toBeGreaterThan(4);
    // presence should not act like a broadband gain
    expect(Math.abs(at(60, lifted) - at(60, flat))).toBeLessThan(0.5);
  });

  it('adds proximity low end without changing the top', () => {
    const far = base({ model: micModelIndex('broadcast'), proximity: -1 });
    const close = base({ model: micModelIndex('broadcast'), proximity: 1 });
    expect(at(90, close) - at(90, far)).toBeGreaterThan(4);
    expect(Math.abs(at(12000, close) - at(12000, far))).toBeLessThan(1);
  });

  it('applies the output trim as a broadband offset', () => {
    const flat = base({ model: micModelIndex('pencil') });
    const trimmed = base({ model: micModelIndex('pencil'), output: -6 });
    expect(at(1000, trimmed) - at(1000, flat)).toBeCloseTo(-6, 2);
    expect(at(8000, trimmed) - at(8000, flat)).toBeCloseTo(-6, 1);
  });

  it('uses a high-pass to reject handling rumble on stage mics', () => {
    const handheld = base({ model: micModelIndex('handheld') });
    const custom = base({ model: micModelIndex('custom') });
    expect(at(40, custom) - at(40, handheld)).toBeGreaterThan(8);
    expect(Math.abs(at(3000, handheld) - at(3000, custom))).toBeLessThan(12);
  });

  it('builds a top-end roll-off only for models that have one', () => {
    expect(micChain(base({ model: micModelIndex('ribbon') })).some((filter) => filter.type === 'lowpass')).toBe(true);
    expect(micChain(base({ model: micModelIndex('condenser') })).some((filter) => filter.type === 'lowpass')).toBe(
      false,
    );
  });
});

describe('mic presets', () => {
  it('loads the model and full parameter set when a preset is applied', () => {
    const params = micPresetParams('broadcast', 'broadcast-warm');
    expect(params.model).toBe(micModelIndex('broadcast'));
    expect(params.proximity).toBe(0.5);
    expect(params.presence).toBe(-1);
    expect(params.output).toBe(0);

    const defaults = micPresetParams('ribbon');
    expect(defaults.model).toBe(micModelIndex('ribbon'));
    expect(defaults.proximity).toBe(0.55);

    // A preset always carries every knob the device expects.
    for (const key of ['model', 'proximity', 'presence', 'air', 'drive', 'output']) {
      expect(typeof defaults[key], key).toBe('number');
    }
  });

  it('makes an actual audible difference between two presets of the same mic', () => {
    const tight = micPresetParams('broadcast', 'broadcast-tight');
    const warm = micPresetParams('broadcast', 'broadcast-warm');
    expect(Math.abs(at(200, tight) - at(200, warm))).toBeGreaterThan(1);
    expect(Math.abs(at(2600, tight) - at(2600, warm))).toBeGreaterThan(1);
  });
});
