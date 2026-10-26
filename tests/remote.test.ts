import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '../src/audio/engine';
import { blankProject, demoProject } from '../src/core/project';
import { Store } from '../src/core/store';
import { applyRemoteCommand, buildRemoteState, type RemoteCommand } from '../src/remote/remote';

function fakeEngine() {
  return {
    isPlaying: false,
    positionBeat: 6.5,
    masterPeak: () => 0.5,
    trackPeak: () => 0.25,
    returnPeak: () => 0.15,
    play: vi.fn(async () => undefined),
    stop: vi.fn(),
    togglePlay: vi.fn(),
    seek: vi.fn(),
  } as unknown as Engine;
}

describe('remote state', () => {
  it('serialises transport, tracks and master', () => {
    const store = new Store(demoProject());
    const state = buildRemoteState(store, fakeEngine());

    expect(state.type).toBe('state');
    expect(state.projectName).toBe(store.project.name);
    expect(state.length).toBe(store.project.length);
    expect(state.bpm).toBe(124);
    expect(state.selectedTrackId).toBe(store.selectedTrackId);
    expect(state.loopStart).toBe(store.project.loop.start);
    expect(state.loopEnd).toBe(store.project.loop.end);
    expect(state.tracks).toHaveLength(4);
    expect(state.tracks[0].name).toBe('Drums');
    expect(state.tracks[0].kind).toBe('midi');
    expect(state.tracks[0].armed).toBe(false);
    expect(state.tracks[0].peak).toBe(0.25);
    expect(state.recording).toBe(false);
    expect(state.recordingStarting).toBe(false);
    expect(state.recordingTrackId).toBeNull();
    expect(state.countingIn).toBe(false);
    expect(state.tracks[0].sends).toHaveLength(4);
    expect(state.tracks[0].preSends).toHaveLength(4);
    expect(state.masterPeak).toBe(0.5);
    expect(state.masterChain).toContain('limiter');

    expect(state.returns.map((bus) => bus.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(state.returns[0].name).toBe('Reverb');
    expect(state.returns[0].peak).toBe(0.15);
  });

  it('reports the live record state and count-in', () => {
    const store = new Store(blankProject('Take'));
    const engine = {
      ...fakeEngine(),
      isCountingIn: true,
      countInState: { active: true, bars: 1, totalBeats: 4, remaining: 3, position: 0 },
    } as unknown as Engine;
    const state = buildRemoteState(store, engine, {
      isRecording: () => true,
      isStarting: () => false,
      recordingTrackId: () => store.project.tracks[0].id,
    });

    expect(state.recording).toBe(true);
    expect(state.recordingTrackId).toBe(store.project.tracks[0].id);
    expect(state.countingIn).toBe(true);
    expect(state.countInRemaining).toBe(3);
    expect(state.tracks[0]).toMatchObject({ kind: 'audio', armed: false });
  });

  it('ships the arrangement map and caps it to one websocket frame', () => {
    const store = new Store(demoProject());
    const state = buildRemoteState(store, fakeEngine());

    expect(state.clips).toHaveLength(store.project.clips.length);
    expect(state.clips[0]).toMatchObject({
      id: store.project.clips[0].id,
      trackId: store.project.clips[0].trackId,
      name: store.project.clips[0].name,
      start: store.project.clips[0].start,
      length: store.project.clips[0].length,
    });

    const template = store.project.clips[0];
    for (let index = 0; index < 300; index += 1) {
      store.project.clips.push({ ...template, id: `extra-${index}`, name: `Extra ${index}` });
    }
    expect(buildRemoteState(store, fakeEngine()).clips).toHaveLength(240);
  });
});

describe('remote commands', () => {
  it('moves faders, pans, trim, sends and master within range', () => {
    const store = new Store(demoProject());
    const engine = fakeEngine();
    const track = store.project.tracks[0];

    const send = (command: RemoteCommand): void => applyRemoteCommand(store, engine, command);

    send({ type: 'command', kind: 'volume', trackId: track.id, value: 2 });
    expect(track.volume).toBe(1.4);

    send({ type: 'command', kind: 'pan', trackId: track.id, value: -3 });
    expect(track.pan).toBe(-1);

    send({ type: 'command', kind: 'gain', trackId: track.id, value: 40 });
    expect(track.gain).toBe(24);

    send({ type: 'command', kind: 'send', trackId: track.id, index: 1, value: 0.4 });
    expect(track.sends[1]).toBeCloseTo(0.4);

    send({ type: 'command', kind: 'send', trackId: track.id, index: 3, value: 0.7 });
    expect(track.sends[3]).toBeCloseTo(0.7);

    send({ type: 'command', kind: 'sendMode', trackId: track.id, index: 2, pre: true });
    expect(track.preSends[2]).toBe(true);

    send({ type: 'command', kind: 'master', value: 0.55 });
    expect(store.project.master.volume).toBeCloseTo(0.55);
  });

  it('drives the aux returns from the tablet', () => {
    const store = new Store(demoProject());
    const engine = fakeEngine();
    const bus = store.project.returns[0];

    applyRemoteCommand(store, engine, { type: 'command', kind: 'returnLevel', returnId: bus.id, value: 2 });
    expect(bus.volume).toBe(1.4);

    applyRemoteCommand(store, engine, { type: 'command', kind: 'returnPan', returnId: bus.id, value: -5 });
    expect(bus.pan).toBe(-1);

    applyRemoteCommand(store, engine, { type: 'command', kind: 'returnMute', returnId: bus.id });
    expect(bus.mute).toBe(true);
  });

  it('toggles mute, solo, loop and clamps tempo', () => {
    const store = new Store(demoProject());
    const engine = fakeEngine();
    const track = store.project.tracks[1];

    applyRemoteCommand(store, engine, { type: 'command', kind: 'mute', trackId: track.id });
    expect(store.trackById(track.id)?.mute).toBe(true);

    applyRemoteCommand(store, engine, { type: 'command', kind: 'solo', trackId: track.id });
    expect(store.trackById(track.id)?.solo).toBe(true);

    applyRemoteCommand(store, engine, { type: 'command', kind: 'loop', value: false });
    expect(store.project.loop.enabled).toBe(false);

    applyRemoteCommand(store, engine, { type: 'command', kind: 'tempo', value: 999 });
    expect(store.project.bpm).toBe(260);
  });

  it('selects a track from the tablet', () => {
    const store = new Store(demoProject());
    const engine = fakeEngine();
    const second = store.project.tracks[1];

    applyRemoteCommand(store, engine, { type: 'command', kind: 'select', trackId: second.id });
    expect(store.selectedTrackId).toBe(second.id);

    applyRemoteCommand(store, engine, { type: 'command', kind: 'select', trackId: 'missing' });
    expect(store.selectedTrackId).toBe(second.id);
  });

  it('arms an audio track from the tablet and makes it the record target', () => {
    const store = new Store(blankProject('Arm'));
    const engine = fakeEngine();
    const audio = store.project.tracks[0];
    const midi = store.project.tracks[2];

    applyRemoteCommand(store, engine, { type: 'command', kind: 'arm', trackId: audio.id, armed: true });
    expect(store.trackById(audio.id)?.armed).toBe(true);
    expect(store.selectedTrackId).toBe(audio.id);

    applyRemoteCommand(store, engine, { type: 'command', kind: 'arm', trackId: audio.id, armed: false });
    expect(store.trackById(audio.id)?.armed).toBe(false);

    // MIDI arm is not a recording path in this build (same as the desktop).
    applyRemoteCommand(store, engine, { type: 'command', kind: 'arm', trackId: midi.id, armed: true });
    expect(store.trackById(midi.id)?.armed).toBe(false);
  });

  it('starts and stops takes through the record hooks', () => {
    const store = new Store(blankProject('Record'));
    const engine = fakeEngine();
    const calls: string[] = [];
    let recording = false;
    let starting = false;
    const hooks = {
      start: () => {
        calls.push('start');
        starting = true;
      },
      stop: () => {
        calls.push('stop');
        recording = false;
        starting = false;
      },
      isRecording: () => recording,
      isStarting: () => starting,
    };

    applyRemoteCommand(store, engine, { type: 'command', kind: 'record', action: 'start' }, hooks);
    expect(calls).toEqual(['start']);

    // A second start while the shell is still opening the input is ignored.
    applyRemoteCommand(store, engine, { type: 'command', kind: 'record', action: 'start' }, hooks);
    expect(calls).toEqual(['start']);

    starting = false;
    recording = true;
    applyRemoteCommand(store, engine, { type: 'command', kind: 'record', action: 'start' }, hooks);
    expect(calls).toEqual(['start']);

    applyRemoteCommand(store, engine, { type: 'command', kind: 'record', action: 'toggle' }, hooks);
    expect(calls).toEqual(['start', 'stop']);

    applyRemoteCommand(store, engine, { type: 'command', kind: 'record', action: 'stop' }, hooks);
    expect(calls).toEqual(['start', 'stop', 'stop']);
  });

  it('drives the transport through the engine', () => {
    const store = new Store(demoProject());
    const engine = fakeEngine();

    applyRemoteCommand(store, engine, { type: 'command', kind: 'transport', action: 'toggle' });
    expect(engine.togglePlay).toHaveBeenCalledOnce();

    applyRemoteCommand(store, engine, { type: 'command', kind: 'transport', action: 'stop' });
    expect(engine.stop).toHaveBeenCalledOnce();

    applyRemoteCommand(store, engine, { type: 'command', kind: 'seek', beat: 12 });
    expect(engine.seek).toHaveBeenCalledWith(12);
  });
});

import {
  bridgeForHost,
  linkLabel,
  parseBridgeLink,
  reconnectDelay,
  tabletLink,
  withToken,
} from '../src/remote/link';

describe('remote bridge addresses', () => {
  it('accepts every shape a user might paste', () => {
    expect(parseBridgeLink('192.168.1.20:8787')).toEqual({
      http: 'http://192.168.1.20:8787',
      ws: 'ws://192.168.1.20:8787/ws',
      kind: 'lan',
    });
    expect(parseBridgeLink('http://studio.local:8787/')?.ws).toBe('ws://studio.local:8787/ws');
    expect(parseBridgeLink('ws://10.0.0.5:8787/ws')?.http).toBe('http://10.0.0.5:8787');
    expect(parseBridgeLink('https://remote.example.com')).toEqual({
      http: 'https://remote.example.com',
      ws: 'wss://remote.example.com/ws',
      kind: 'internet',
    });
    expect(parseBridgeLink('')).toBeNull();
    expect(parseBridgeLink('ftp://example.com')).toBeNull();
    expect(parseBridgeLink('not a host')).toBeNull();
  });

  it('tells local, Wi-Fi and internet addresses apart', () => {
    expect(parseBridgeLink('http://localhost:8787')?.kind).toBe('local');
    expect(parseBridgeLink('http://127.0.0.1:8787')?.kind).toBe('local');
    expect(parseBridgeLink('http://192.168.0.8:8787')?.kind).toBe('lan');
    expect(parseBridgeLink('http://172.20.1.4:8787')?.kind).toBe('lan');
    expect(parseBridgeLink('http://studio:8787')?.kind).toBe('lan');
    expect(parseBridgeLink('http://8.8.8.8:8787')?.kind).toBe('internet');
    expect(linkLabel('lan')).toBe('Wi-Fi / LAN');
  });

  it('builds tablet links with a token, without leaking it into the panel label', () => {
    const link = parseBridgeLink('https://studio.example.com')!;
    const page = tabletLink(link, 's3cret token');
    expect(page).toContain('https://studio.example.com/?token=s3cret+token');
    expect(withToken(link.ws, 'abc')).toBe('wss://studio.example.com/ws?token=abc');
    expect(withToken(link.ws, '')).toBe(link.ws);
    expect(bridgeForHost('').http).toBe('http://localhost:8787');
  });

  it('backs off with a cap and jitter', () => {
    const first = reconnectDelay(1, 0);
    const second = reconnectDelay(2, 0);
    const late = reconnectDelay(20, 0);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(late).toBeLessThanOrEqual(8000);
    expect(late).toBeGreaterThanOrEqual(6000);
    expect(reconnectDelay(3, 1)).toBeGreaterThan(reconnectDelay(3, 0));
  });
});
