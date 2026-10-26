import { describe, expect, it } from 'vitest';
import { buildStemManifest, linearToDb, stemFileName } from '../src/audio/stems';
import { demoProject } from '../src/core/project';
import { beatsToSeconds } from '../src/core/time';
import { NativeBridge, type NativeCommand, type NativeSongTrack, type NativeTarget } from '../src/native/bridge';

describe('stem printing', () => {
  it('names stems by order with a safe slug', () => {
    expect(stemFileName(0, 'Lead Vox')).toBe('01-lead-vox.wav');
    expect(stemFileName(2, '  Drums & Bass! ')).toBe('03-drums-bass.wav');
    expect(stemFileName(9, '')).toBe('10.wav');
    expect(stemFileName(0, 'a'.repeat(80))).toHaveLength(2 + 1 + 40 + 4);
  });

  it('converts faders to the decibels the native mixer expects', () => {
    expect(linearToDb(1)).toBeCloseTo(0);
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(linearToDb(0)).toBe(-96);
    expect(linearToDb(-1)).toBe(-96);
  });

  it('builds a manifest the native host can rebuild the session from', () => {
    const project = demoProject();
    const stems = project.tracks.map((track, index) => ({ trackId: track.id, file: stemFileName(index, track.name) }));
    const manifest = buildStemManifest(project, stems, 48000);

    expect(manifest.format).toBe('hstudio-stems');
    expect(manifest.version).toBe(1);
    expect(manifest.sampleRate).toBe(48000);
    expect(manifest.bpm).toBe(project.bpm);
    expect(manifest.length).toBeCloseTo(beatsToSeconds(project.length, project.bpm));
    expect(manifest.masterGainDb).toBeCloseTo(linearToDb(project.master.volume));
    expect(manifest.tracks).toHaveLength(project.tracks.length);

    for (const [index, track] of project.tracks.entries()) {
      const entry = manifest.tracks[index];
      expect(entry.id).toBe(track.id);
      expect(entry.name).toBe(track.name);
      expect(entry.file).toBe(stems[index].file);
      expect(entry.gainDb).toBeCloseTo(linearToDb(track.volume));
      expect(entry.pan).toBe(track.pan);
      expect(entry.mute).toBe(track.mute);
      expect(entry.solo).toBe(track.solo);
    }
  });

  it('keeps the manifest ordered like the project even when stems arrive out of order', () => {
    const project = demoProject();
    const reversed = [...project.tracks].reverse().map((track, index) => ({
      trackId: track.id,
      file: stemFileName(index, track.name),
    }));
    const manifest = buildStemManifest(project, reversed, 44100);
    expect(manifest.tracks.map((track) => track.id)).toEqual(project.tracks.map((track) => track.id));
  });
});

describe('native bridge song commands', () => {
  const sent: NativeCommand[] = [];
  const target: NativeTarget = {
    available: true,
    send: (_event, payload) => sent.push(payload as NativeCommand),
    listen: () => {},
  };

  const track: NativeSongTrack = {
    id: 'track-1',
    name: 'Vox',
    gainDb: -3,
    pan: -0.25,
    mute: false,
    solo: true,
    peakLeft: 0,
    peakRight: 0,
    chain: [],
  };

  it('addresses a plugin to one track instead of the master bus', () => {
    sent.length = 0;
    const bridge = new NativeBridge(target);
    bridge.addTrackPlugin(track.id, 'vendor.plugin');
    bridge.removeTrackPlugin(track.id, 2);
    bridge.moveTrackPlugin(track.id, 2, 0);
    bridge.setTrackPluginBypass(track.id, 0, true);
    bridge.openTrackPluginEditor(track.id, 1);

    expect(sent).toEqual([
      { type: 'addTrackPlugin', trackId: 'track-1', identifier: 'vendor.plugin' },
      { type: 'removeTrackPlugin', trackId: 'track-1', slot: 2 },
      { type: 'moveTrackPlugin', trackId: 'track-1', from: 2, to: 0 },
      { type: 'setTrackPluginBypass', trackId: 'track-1', slot: 0, bypassed: true },
      { type: 'openTrackPluginEditor', trackId: 'track-1', slot: 1 },
    ]);
  });

  it('sends a complete channel strip when only one value changes', () => {
    sent.length = 0;
    new NativeBridge(target).setTrackMix(track, { mute: true });

    expect(sent[0]).toEqual({
      type: 'setTrackMix',
      trackId: 'track-1',
      gainDb: -3,
      pan: -0.25,
      mute: true,
      solo: true,
    });
  });

  it('drives the stem transport', () => {
    sent.length = 0;
    const bridge = new NativeBridge(target);
    bridge.chooseStemsFolder();
    bridge.unloadStems();
    bridge.setSongPlaying(true);
    bridge.locateSong(12.5);
    bridge.setSongLoop(true);

    expect(sent.map((command) => command.type)).toEqual([
      'chooseStemsFolder',
      'unloadStems',
      'songPlay',
      'songLocate',
      'songLoop',
    ]);
  });
});
