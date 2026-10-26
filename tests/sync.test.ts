import { describe, expect, it } from 'vitest';
import { emptyProject } from '../src/core/project';
import {
  SESSION_CHANNEL,
  SessionLink,
  type ConsoleCommand,
  type LiveState,
  type SessionSnapshot,
  type SyncChannel,
} from '../src/core/sync';

/**
 * Stands in for BroadcastChannel: one process, several links, the same JSON.
 * The bus delivers to every subscriber including the sender, exactly as the
 * real channel does, so a link that fails to ignore its own echo is caught here.
 */
function createBus() {
  const listeners = new Set<(message: unknown) => void>();
  let posted = 0;

  const channel = (): SyncChannel => ({
    post: (message) => {
      posted += 1;
      for (const listener of [...listeners]) listener(message);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {},
  });

  return { channel, posted: () => posted };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function session(name: string): SessionSnapshot {
  return {
    project: { ...emptyProject(), name },
    view: { zoom: 46, snap: 0.25, selectedTrackId: 'track-1', selectedClipId: null },
  };
}

/** A studio window and one console window that are allowed to drift apart. */
function pair() {
  const bus = createBus();
  const receivedByConsole: SessionSnapshot[] = [];
  const receivedByStudio: SessionSnapshot[] = [];
  const commands: ConsoleCommand[] = [];
  const live: LiveState[] = [];

  const studio = new SessionLink({
    channel: bus.channel(),
    role: 'host',
    snapshot: () => session('Studio'),
    onSnapshot: (snapshot) => receivedByStudio.push(snapshot),
    onCommand: (command) => commands.push(command),
    debounceMs: 0,
  });

  const consoleWindow = new SessionLink({
    channel: bus.channel(),
    role: 'satellite',
    onSnapshot: (snapshot) => receivedByConsole.push(snapshot),
    onLive: (state) => live.push(state),
    debounceMs: 0,
  });

  studio.start();
  consoleWindow.start();

  return { bus, studio, consoleWindow, receivedByConsole, receivedByStudio, commands, live };
}

describe('console windows share the studio session', () => {
  it('hands a console that just opened the session it should show', async () => {
    const { receivedByConsole } = pair();
    await tick();

    expect(receivedByConsole.map((snapshot) => snapshot.project.name)).toEqual(['Studio']);
    expect(receivedByConsole[0].view.zoom).toBe(46);
  });

  it('carries an edit made in a console window back to the studio', async () => {
    const { consoleWindow, receivedByStudio } = pair();
    await tick();

    consoleWindow.publish(session('Fader moved in the mixer window'));
    await tick();

    expect(receivedByStudio.map((snapshot) => snapshot.project.name)).toEqual(['Fader moved in the mixer window']);
  });

  it('carries the studio session out to a console window', async () => {
    const { studio, receivedByConsole } = pair();
    await tick();

    studio.publish(session('Edited in the studio'));
    await tick();

    expect(receivedByConsole.map((snapshot) => snapshot.project.name)).toEqual(['Studio', 'Edited in the studio']);
  });

  it('applies a console edit without publishing it straight back, and settles', async () => {
    const bus = createBus();
    const applied: string[] = [];
    const applyingWhileHandling: boolean[] = [];

    const studio = new SessionLink({
      channel: bus.channel(),
      role: 'host',
      snapshot: () => session('Studio'),
      onSnapshot: (snapshot) => {
        applyingWhileHandling.push(studio.applying);
        applied.push(snapshot.project.name);
      },
      debounceMs: 0,
    });
    const consoleWindow = new SessionLink({ channel: bus.channel(), role: 'satellite', debounceMs: 0 });
    studio.start();
    consoleWindow.start();
    await tick();

    const before = bus.posted();
    consoleWindow.publish(session('One move'));
    await tick();
    await tick();

    // One message out to the hub, one message back for the windows, and no
    // echo storm: a project that arrived from elsewhere is never sent again.
    expect(bus.posted() - before).toBe(2);
    expect(applyingWhileHandling).toEqual([true]);
    expect(applied).toEqual(['One move']);
  });

  it('passes a console edit on to every other console window exactly once', async () => {
    const bus = createBus();
    const first: string[] = [];
    const second: string[] = [];

    const studio = new SessionLink({
      channel: bus.channel(),
      role: 'host',
      snapshot: () => session('Studio'),
      debounceMs: 0,
    });
    const mixerWindow = new SessionLink({
      channel: bus.channel(),
      role: 'satellite',
      onSnapshot: (snapshot) => first.push(snapshot.project.name),
      debounceMs: 0,
    });
    const midiWindow = new SessionLink({
      channel: bus.channel(),
      role: 'satellite',
      onSnapshot: (snapshot) => second.push(snapshot.project.name),
      debounceMs: 0,
    });

    studio.start();
    mixerWindow.start();
    midiWindow.start();
    await tick();

    mixerWindow.publish(session('Mute on channel 4'));
    await tick();
    await tick();

    expect(first).toEqual(['Studio', 'Mute on channel 4']);
    expect(second).toEqual(['Studio', 'Mute on channel 4']);
  });

  it('sends the transport to the window with the sound card', async () => {
    const { consoleWindow, commands } = pair();
    await tick();

    consoleWindow.command({ type: 'transport', action: 'play' });
    consoleWindow.command({ type: 'transport', action: 'seek', beat: 12.5 });
    consoleWindow.command({ type: 'note', pitch: 60, velocity: 0.8, down: true });

    expect(commands).toEqual([
      { type: 'transport', action: 'play' },
      { type: 'transport', action: 'seek', beat: 12.5 },
      { type: 'note', pitch: 60, velocity: 0.8, down: true },
    ]);
  });

  it('never treats a console command as a transport command for another console', async () => {
    const { studio, commands } = pair();
    await tick();

    studio.command({ type: 'transport', action: 'stop' });
    expect(commands).toEqual([]);
  });

  it('streams the studio transport position and meters to a console', async () => {
    const { studio, live } = pair();
    await tick();

    studio.publishLive({ playing: true, positionBeat: 12, levels: { 'track:track-1': 0.4, master: 0.7 } });

    expect(live).toEqual([{ playing: true, positionBeat: 12, levels: { 'track:track-1': 0.4, master: 0.7 } }]);
  });

  it('ignores a console snapshot that is older than the one already applied', async () => {
    const bus = createBus();
    const applied: string[] = [];
    const studio = new SessionLink({
      channel: bus.channel(),
      role: 'host',
      onSnapshot: (snapshot) => applied.push(snapshot.project.name),
      debounceMs: 0,
    });
    studio.start();

    const wire = (revision: number, name: string): void =>
      bus.channel().post({
        id: SESSION_CHANNEL,
        kind: 'snapshot',
        from: 'console-window',
        target: 'host',
        revision,
        snapshot: session(name),
      });

    wire(5, 'Newest');
    wire(5, 'Repeated');
    wire(4, 'Stale');
    await tick();

    expect(applied).toEqual(['Newest']);
  });

  it('stops listening once the window closes', async () => {
    const { studio, receivedByConsole } = pair();
    await tick();

    studio.stop();
    studio.publish(session('After close'));
    await tick();

    expect(receivedByConsole.map((snapshot) => snapshot.project.name)).toEqual(['Studio']);
  });

  it('treats a malformed message as nothing at all', async () => {
    const bus = createBus();
    const applied: SessionSnapshot[] = [];
    const studio = new SessionLink({
      channel: bus.channel(),
      role: 'host',
      onSnapshot: (snapshot) => applied.push(snapshot),
      debounceMs: 0,
    });
    studio.start();

    const channel = bus.channel();
    channel.post(null);
    channel.post('not a message');
    channel.post({ id: 'another-app', kind: 'snapshot', from: 'x', revision: 99, snapshot: session('Nope') });
    channel.post({ id: SESSION_CHANNEL, kind: 'snapshot', from: 'x', target: 'host', revision: 99 });
    await tick();

    expect(applied).toEqual([]);
  });
});
