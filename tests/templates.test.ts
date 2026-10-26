import { describe, expect, it } from 'vitest';
import { createDevice, demoProject } from '../src/core/project';
import { Store } from '../src/core/store';
import { DEVICE_SPECS } from '../src/audio/specs';
import {
  CHAIN_TEMPLATES,
  applyChainTemplate,
  buildTemplateDevices,
  templateCategories,
  templatesFor,
} from '../src/audio/templates';

const makeStore = (): Store => new Store(demoProject());

describe('chain templates', () => {
  it('ships both track and master starting points', () => {
    expect(templatesFor('track').length).toBeGreaterThanOrEqual(4);
    expect(templatesFor('master').length).toBeGreaterThanOrEqual(3);
    expect(templatesFor('track').every((template) => template.target === 'track')).toBe(true);
    expect(templatesFor('master').every((template) => template.target === 'master')).toBe(true);
  });

  it('only references modules that exist with real specs', () => {
    for (const template of CHAIN_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(3);
      expect(template.description.length).toBeGreaterThan(20);
      expect(template.chain.length).toBeGreaterThan(3);
      expect(template.modules.length).toBeGreaterThan(0);
      for (const module of template.modules) {
        const spec = DEVICE_SPECS[module.type];
        expect(spec, `${template.id} uses unknown module ${module.type}`).toBeTruthy();
        for (const [key, value] of Object.entries(module.params ?? {})) {
          const param = spec.params.find((entry) => entry.key === key);
          expect(param, `${template.id} sets unknown param ${module.type}.${key}`).toBeTruthy();
          expect(value).toBeGreaterThanOrEqual(param!.min);
          expect(value).toBeLessThanOrEqual(param!.max);
        }
      }
    }
  });

  it('builds real device states with unique ids and clamped values', () => {
    const template = CHAIN_TEMPLATES[0];
    const devices = buildTemplateDevices(template);
    expect(devices).toHaveLength(template.modules.length);
    expect(new Set(devices.map((device) => device.id)).size).toBe(devices.length);
    for (const device of devices) {
      expect(device.enabled).toBe(true);
      expect(Object.keys(device.params).length).toBeGreaterThan(0);
    }

    const console = devices.find((device) => device.type === 'console');
    expect(console?.params.hpf).toBe(90);
    expect(console?.params.midGain).toBe(2.5);

    // out-of-range preset values are clamped, never written raw
    const clamped = buildTemplateDevices({
      id: 'test',
      name: 'Test',
      target: 'track',
      category: 'Vocal',
      description: 'test template with an impossible gain',
      chain: 'Console Strip',
      modules: [{ type: 'console', params: { midGain: 42, hpf: -20 }, enabled: false }],
    });
    const spec = DEVICE_SPECS.console;
    const gain = spec.params.find((param) => param.key === 'midGain')!;
    const hpf = spec.params.find((param) => param.key === 'hpf')!;
    expect(clamped[0].params.midGain).toBe(gain.max);
    expect(clamped[0].params.hpf).toBe(hpf.min);
    expect(clamped[0].enabled).toBe(false);
  });

  it('lists categories without duplicates in template order', () => {
    for (const target of ['track', 'master'] as const) {
      const categories = templateCategories(templatesFor(target));
      expect(new Set(categories).size).toBe(categories.length);
      expect(categories.length).toBeGreaterThan(0);
    }
  });

  it('replaces a track chain in one undo step', () => {
    const store = makeStore();
    const track = store.project.tracks[0];
    const original = track.devices.map((device) => device.id);
    track.devices.push(createDevice('delay'));

    const template = templatesFor('track')[0];
    const before = store.project.tracks[0].devices.length;
    expect(applyChainTemplate(store, template, track.id)).toBe(true);
    expect(store.project.tracks[0].devices).toHaveLength(template.modules.length);
    expect(store.project.tracks[0].devices[0].type).toBe(template.modules[0].type);

    store.undo();
    expect(store.project.tracks[0].devices).toHaveLength(before);
    expect(store.project.tracks[0].devices.slice(0, original.length).map((device) => device.id)).toEqual(original);
  });

  it('replaces the master chain and leaves tracks alone', () => {
    const store = makeStore();
    const trackIds = store.project.tracks.map((track) => track.devices.map((device) => device.id));
    const template = templatesFor('master').find((entry) => entry.id === 'master-streaming')!;

    expect(applyChainTemplate(store, template, store.project.tracks[0].id)).toBe(true);
    expect(store.project.master.devices).toHaveLength(template.modules.length);
    expect(store.project.master.devices.at(-1)?.type).toBe('limiter');
    expect(store.project.tracks.map((track) => track.devices.map((device) => device.id))).toEqual(trackIds);
  });

  it('reports a missing track instead of silently doing nothing', () => {
    const store = makeStore();
    expect(applyChainTemplate(store, templatesFor('track')[0], 'track-does-not-exist')).toBe(false);
  });

  it('ends every master template with a limiter below 0 dBFS', () => {
    for (const template of templatesFor('master')) {
      const devices = buildTemplateDevices(template);
      const last = devices.at(-1)!;
      expect(last.type, template.id).toBe('limiter');
      expect(last.params.ceiling).toBeLessThanOrEqual(0);
      expect(last.params.ceiling).toBeGreaterThanOrEqual(-1.5);
    }
  });

  it('keeps track templates free of master-only modules', () => {
    for (const template of templatesFor('track')) {
      expect(template.modules.some((module) => module.type === 'limiter')).toBe(false);
      expect(template.modules.some((module) => module.type === 'aimix')).toBe(false);
      expect(template.modules.some((module) => module.type === 'micemu')).toBe(false);
    }
  });
});
