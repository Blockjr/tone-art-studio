/**
 * The link between the studio window and the console windows opened from it.
 *
 * A console window (Mixer, MIDI, Preview, Browser, Takes, Notes, Studio Rig) is
 * a real window with the same interface build inside it, which is what makes it
 * resizable, movable and placeable on a second monitor. The catch is that a
 * window is its own copy of the app: without a link it would show a second,
 * unrelated session, and moving a fader in it would move nothing. That is a
 * display, not a console.
 *
 * So one window owns the session — the studio window, which also owns the audio
 * device — and the consoles follow it:
 *
 *   - a console sends the project back to the studio window after every edit,
 *     and the studio window sends its project to the consoles, so a fader moved
 *     in either place moves in both;
 *   - the transport belongs to the window with the sound card, so a console's
 *     play button is a command to the studio window rather than a second,
 *     silent playback;
 *   - the studio window streams its transport position and meter levels, so a
 *     detached console shows the same playhead and the same meters.
 *
 * Everything travels as plain JSON through a channel, which is why the channel
 * is an interface here: the desktop app uses BroadcastChannel, and the tests use
 * a bus that keeps several links in one process.
 */

import type { Project } from './types';

export const SESSION_CHANNEL = 'tone-art-session';

/** The window that owns the audio device and the session it is playing. */
export type SessionRole = 'host' | 'satellite';

export interface SessionView {
  /** pixels per beat */
  zoom: number;
  snap: number;
  selectedTrackId: string;
  selectedClipId: string | null;
}

export interface SessionSnapshot {
  project: Project;
  view: SessionView;
}

/** What the studio window streams while it is rolling. */
export interface LiveState {
  playing: boolean;
  positionBeat: number;
  /** peak 0..1 by meter key: `track:<id>`, `return:<index>`, `master` */
  levels: Record<string, number>;
}

/**
 * A console asking the studio window to do something only it can do: roll the
 * transport, or sound a note through the instrument that is loaded there.
 */
export type ConsoleCommand =
  | { type: 'transport'; action: 'play' | 'pause' | 'stop' | 'seek'; beat?: number }
  | { type: 'note'; pitch: number; velocity: number; down: boolean };

/** A JSON message bus. BroadcastChannel in the app; a list of listeners in tests. */
export interface SyncChannel {
  post(message: unknown): void;
  subscribe(listener: (message: unknown) => void): () => void;
  close(): void;
}

type WireMessage =
  | { id: string; kind: 'snapshot'; from: string; target: Target; to?: string; revision: number; snapshot: SessionSnapshot }
  | { id: string; kind: 'hello'; from: string }
  | { id: string; kind: 'command'; from: string; target: Target; command: ConsoleCommand }
  | { id: string; kind: 'live'; from: string; target: Target; live: LiveState };

/**
 * Who a message is for. The studio window is the hub of the session: a console
 * sends it edits and commands, and it sends every window the session and its
 * transport. Naming the direction is what keeps several open consoles from
 * relaying one change around in a circle: an edit travels out to the hub once,
 * and comes back from the hub once, to every console including the one that
 * made it.
 */
type Target = 'host' | 'consoles';

/** `Omit` over a union keeps only the shared keys, which a message is not. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

let counter = 0;

/** Distinguishes this window's messages from the other window's. */
function sessionId(role: SessionRole): string {
  counter += 1;
  return `${role}-${Date.now().toString(36)}-${counter}`;
}

const DEFAULT_DEBOUNCE = 40;

export interface SessionLinkOptions {
  channel: SyncChannel;
  role: SessionRole;
  /** A newer session arrived from the other window. */
  onSnapshot?: (snapshot: SessionSnapshot) => void;
  /** The studio window: a console asked for something. */
  onCommand?: (command: ConsoleCommand) => void;
  /** A console: the studio window's transport and meters. */
  onLive?: (live: LiveState) => void;
  /** The current session, so a console that opens later gets it immediately. */
  snapshot?: () => SessionSnapshot | null;
  /** Coalescing window for outgoing projects. A drag sends one, not sixty. */
  debounceMs?: number;
}

export class SessionLink {
  readonly role: SessionRole;
  private id: string;
  private channel: SyncChannel;
  private options: SessionLinkOptions;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: SessionSnapshot | null = null;
  /** This window's own message counter. */
  private revision = 0;
  /** Highest revision seen from each window, so nothing is applied out of order. */
  private seen = new Map<string, number>();
  private applyingRemote = false;
  private stopped = false;

  constructor(options: SessionLinkOptions) {
    this.options = options;
    this.role = options.role;
    this.channel = options.channel;
    this.id = sessionId(options.role);
  }

  /** True while a remote project is being applied, so it is not published back. */
  get applying(): boolean {
    return this.applyingRemote;
  }

  get isHost(): boolean {
    return this.role === 'host';
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.channel.subscribe((message) => this.receive(message));
    if (this.role === 'satellite') this.post({ kind: 'hello', from: this.id });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.channel.close();
  }

  /** Sends the session after a local edit. The newest state wins. */
  publish(snapshot: SessionSnapshot): void {
    if (this.stopped) return;
    this.pending = snapshot;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.pending;
      this.pending = null;
      if (next) this.sendSnapshot(next, this.role === 'host' ? 'consoles' : 'host');
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE);
  }

  /** Transport position and meters: sent as they are read, not coalesced. */
  publishLive(live: LiveState): void {
    if (this.stopped || this.role !== 'host') return;
    this.post({ kind: 'live', from: this.id, target: 'consoles', live });
  }

  /** A console asking the studio window to act on its behalf. */
  command(command: ConsoleCommand): void {
    if (this.stopped || this.role !== 'satellite') return;
    this.post({ kind: 'command', from: this.id, target: 'host', command });
  }

  private sendSnapshot(snapshot: SessionSnapshot, target: Target, to?: string): void {
    this.revision += 1;
    this.post({ kind: 'snapshot', from: this.id, target, to, revision: this.revision, snapshot });
  }

  private post(message: WithoutId<WireMessage>): void {
    this.channel.post({ id: SESSION_CHANNEL, ...message } satisfies WireMessage);
  }

  private receive(raw: unknown): void {
    if (this.stopped || !raw || typeof raw !== 'object') return;
    const message = raw as WireMessage;
    if (message.id !== SESSION_CHANNEL || message.from === this.id) return;

    // This window only reads what the other end of the link sends it: a console
    // follows the studio window, and the studio window follows its consoles.
    const wanted: Target = this.role === 'host' ? 'host' : 'consoles';

    if (message.kind === 'hello') {
      // A console that just opened is asking for the session it should show.
      if (this.role === 'host') {
        const snapshot = this.options.snapshot?.();
        // Answered to the window that asked, so three open consoles do not all
        // apply each other's copies of the same project.
        if (snapshot) this.sendSnapshot(snapshot, 'consoles', message.from);
      }
      return;
    }

    if (message.kind === 'snapshot') {
      if (message.target !== wanted) return;
      if (message.to && message.to !== this.id) return;
      if (!this.accept(message.from, message.revision)) return;
      const snapshot = message.snapshot;
      if (!snapshot || !snapshot.project) return;

      this.applyingRemote = true;
      try {
        this.options.onSnapshot?.(snapshot);
      } finally {
        this.applyingRemote = false;
      }

      // The studio window is the hub: what a console sent it is passed on, so
      // every console shows the same session, including the one that sent it.
      if (this.role === 'host') this.sendSnapshot(snapshot, 'consoles');
      return;
    }

    if (message.kind === 'command') {
      if (message.target === wanted && this.role === 'host') this.options.onCommand?.(message.command);
      return;
    }

    if (message.kind === 'live') {
      if (message.target === wanted && this.role === 'satellite') this.options.onLive?.(message.live);
    }
  }

  /** Strictly newer messages only: an echo of our own state is not an update. */
  private accept(from: string, revision: number): boolean {
    const highest = this.seen.get(from) ?? 0;
    if (revision <= highest) return false;
    this.seen.set(from, revision);
    return true;
  }
}

/**
 * The desktop app's channel. BroadcastChannel reaches every window of the same
 * origin in the app, which is exactly the set of windows that share a session.
 * It is also the only transport that works when the page is served over
 * loopback http, as the installed app serves it.
 */
export function broadcastChannel(name = SESSION_CHANNEL): SyncChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  const channel = new BroadcastChannel(name);
  return {
    post: (message) => {
      try {
        channel.postMessage(message);
      } catch {
        // A window that is closing can refuse the message; the session is
        // already gone with it.
      }
    },
    subscribe: (listener) => {
      const handler = (event: MessageEvent): void => listener(event.data);
      channel.addEventListener('message', handler);
      return () => channel.removeEventListener('message', handler);
    },
    close: () => {
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    },
  };
}
