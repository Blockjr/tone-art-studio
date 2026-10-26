/**
 * Web MIDI input: controllers and keyboards into the studio.
 *
 * Two sources feed the same stream:
 *
 *  - a real MIDI port, through the Web MIDI API (`navigator.requestMIDIAccess`),
 *    which Chromium — and therefore the desktop build — implements natively;
 *  - the computer keyboard, mapped the way Ableton maps it (A–L are the white
 *    keys from C, W/E/T/Y/U the black ones, Z/X shift octave, C/V velocity).
 *
 * The class owns no audio and no DOM: it reports notes and controllers through
 * callbacks, so the same stream can drive an instrument, the piano roll or a
 * remote-controlled fader without this module knowing which.
 */

export interface MidiPortInfo {
  id: string;
  name: string;
  manufacturer: string;
  /** 'input' ports deliver notes; 'output' ports drive hardware */
  direction: 'input' | 'output';
  connected: boolean;
  /** notes and controllers go to the selected track */
  track: boolean;
  /** controllers drive mapped studio controls */
  remote: boolean;
}

export interface MidiLearnEvent {
  channel: number;
  controller: number;
  value: number;
}

export interface MidiHandlers {
  onNoteOn?: (pitch: number, velocity: number, channel: number) => void;
  onNoteOff?: (pitch: number, channel: number) => void;
  onControl?: (event: MidiLearnEvent) => void;
  onPitchBend?: (value: number, channel: number) => void;
  onPorts?: (ports: MidiPortInfo[]) => void;
  onStatus?: (status: MidiStatus) => void;
}

export interface MidiStatus {
  /** 'idle' before start, 'ready' when ports were read, 'unsupported', 'denied' */
  state: 'idle' | 'ready' | 'unsupported' | 'denied' | 'error';
  message: string;
  /** last message received, for the activity readout */
  activity?: string;
  /** inputs that are currently enabled for Track */
  activeInputs: number;
}

/** The computer keyboard, laid out like Ableton's: a row of white and black keys. */
export const KEYBOARD_NOTES: Record<string, number> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
  ';': 16,
  "'": 17,
};

/** Keys that are commands rather than notes, so they can be documented once. */
export const KEYBOARD_COMMANDS: Record<string, string> = {
  z: 'Octave down',
  x: 'Octave up',
  c: 'Velocity down',
  v: 'Velocity up',
};

/**
 * Pitch for a keyboard key, or null when the key is not a note key.
 * `octave` is the octave of the A key, in the MIDI sense (C4 = 60).
 */
export function keyToPitch(key: string, octave: number, transpose = 0): number | null {
  const offset = KEYBOARD_NOTES[key.toLowerCase()];
  if (offset === undefined) return null;
  const pitch = (octave + 1) * 12 + offset + transpose;
  return pitch < 0 || pitch > 127 ? null : pitch;
}

/** A MIDI message, already decoded. Exported so the parsing is testable. */
export interface DecodedMessage {
  kind: 'noteOn' | 'noteOff' | 'control' | 'pitchBend' | 'other';
  channel: number;
  pitch?: number;
  velocity?: number;
  controller?: number;
  value?: number;
  bend?: number;
}

/**
 * Decodes one MIDI message.
 *
 * A Note On with velocity 0 is a Note Off — most controllers send release that
 * way, and treating it as a note would leave the key stuck down.
 */
export function decodeMidiMessage(data: ArrayLike<number>): DecodedMessage | null {
  if (!data || data.length < 1) return null;
  const status = data[0];
  const kind = status & 0xf0;
  const channel = (status & 0x0f) + 1;

  if (status >= 0xf0) return { kind: 'other', channel };

  switch (kind) {
    case 0x90: {
      const pitch = data[1] ?? 0;
      const velocity = data[2] ?? 0;
      if (velocity === 0) return { kind: 'noteOff', channel, pitch, velocity: 0 };
      return { kind: 'noteOn', channel, pitch, velocity };
    }
    case 0x80:
      return { kind: 'noteOff', channel, pitch: data[1] ?? 0, velocity: data[2] ?? 0 };
    case 0xb0:
      return { kind: 'control', channel, controller: data[1] ?? 0, value: data[2] ?? 0 };
    case 0xe0: {
      // 14-bit bend, centred at 8192.
      const value = ((data[2] ?? 0) << 7) | (data[1] ?? 0);
      return { kind: 'pitchBend', channel, bend: (value - 8192) / 8192 };
    }
    default:
      return { kind: 'other', channel };
  }
}

/** CC 64 is the sustain pedal; held notes keep sounding while it is down. */
export const SUSTAIN_CONTROLLER = 64;

/**
 * The Web MIDI types are not part of TypeScript's DOM library, so the small
 * surface this module uses is declared here instead of pulling in a package.
 */
interface MidiPortLike {
  id: string;
  name: string | null;
  manufacturer: string | null;
  state: string;
  onmidimessage: ((event: { data: ArrayLike<number> }) => void) | null;
  open: () => Promise<MidiPortLike>;
}

interface MidiAccessLike {
  inputs: Map<string, MidiPortLike>;
  outputs: Map<string, MidiPortLike>;
  onstatechange: (() => void) | null;
}

interface MidiMessageEventLike {
  data?: ArrayLike<number>;
}

export class MidiInput {
  private handlers: MidiHandlers;
  private access: MidiAccessLike | null = null;
  private ports: MidiPortInfo[] = [];
  private byId = new Map<string, MidiPortLike>();
  private held = new Set<number>();
  private sustained = new Set<number>();
  private sustainDown = false;
  private keyboardPitch = new Map<string, number>();
  private status: MidiStatus = { state: 'idle', message: 'MIDI not started', activeInputs: 0 };
  private onPortStateChanged = (): void => this.refreshPorts();

  constructor(handlers: MidiHandlers = {}) {
    this.handlers = handlers;
  }

  get state(): MidiStatus {
    return this.status;
  }

  get portList(): MidiPortInfo[] {
    return this.ports;
  }

  /**
   * Opens MIDI. A denied permission or a browser without Web MIDI is a normal
   * outcome here — the computer keyboard still plays — so nothing throws.
   */
  async start(): Promise<MidiStatus> {
    if (this.access) return this.status;

    const nav = navigator as unknown as {
      requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MidiAccessLike>;
    };
    if (typeof nav.requestMIDIAccess !== 'function') {
      return this.setStatus('unsupported', 'This browser has no Web MIDI. The computer keyboard still plays.');
    }

    try {
      this.access = await nav.requestMIDIAccess({ sysex: false });
    } catch {
      return this.setStatus('denied', 'MIDI access was refused. Allow it in the browser, or use the computer keyboard.');
    }

    this.access.onstatechange = this.onPortStateChanged;
    this.refreshPorts();
    return this.status;
  }

  stop(): void {
    for (const port of this.byId.values()) port.onmidimessage = null;
    if (this.access) this.access.onstatechange = null;
    this.access = null;
    this.byId.clear();
    this.ports = [];
    this.releaseAll();
    this.setStatus('idle', 'MIDI stopped');
    this.handlers.onPorts?.([]);
  }

  /** Turns one port's Track or Remote switch on or off, then re-reads ports. */
  setPortMode(id: string, mode: 'track' | 'remote', on: boolean): void {
    const port = this.ports.find((entry) => entry.id === id);
    if (!port) return;
    port[mode] = on;
    const raw = this.byId.get(id);
    if (raw) {
      try {
        if (on && raw.state === 'disconnected') void raw.open();
        raw.onmidimessage = mode === 'track' || mode === 'remote' ? (event) => this.receive(event) : null;
      } catch {
        // A port that cannot open simply stays dark.
      }
    }

    // Any bound port listens; filtering happens per message against the posts.
    this.syncListeners();
    this.status = {
      ...this.status,
      activeInputs: this.ports.filter((entry) => entry.track).length,
    };
    this.handlers.onPorts?.([...this.ports]);
    this.handlers.onStatus?.(this.status);
  }

  /** Sends a note to the instrument, and remembers it so it can be released. */
  noteOn(pitch: number, velocity = 0.8, channel = 1): void {
    this.held.add(pitch);
    this.handlers.onNoteOn?.(pitch, velocity, channel);
  }

  noteOff(pitch: number, channel = 1): void {
    this.held.delete(pitch);
    if (this.sustainDown) {
      this.sustained.add(pitch);
      return;
    }
    this.handlers.onNoteOff?.(pitch, channel);
  }

  /** Releases everything, e.g. when the window loses focus mid-chord. */
  releaseAll(): void {
    for (const pitch of [...this.held, ...this.sustained]) this.handlers.onNoteOff?.(pitch, 1);
    this.held.clear();
    this.sustained.clear();
    this.sustainDown = false;
    this.keyboardPitch.clear();
  }

  /**
   * Feeds one computer-keyboard event. Returns true when the key was consumed,
   * so the caller can stop it from also triggering a transport shortcut.
   */
  handleKey(key: string, options: { down: boolean; repeat?: boolean; octave: number; velocity: number; transpose?: number }): boolean {
    const pitch = keyToPitch(key, options.octave, options.transpose ?? 0);
    if (pitch === null) return false;

    if (!options.down) {
      const held = this.keyboardPitch.get(key.toLowerCase());
      if (held === undefined) return true;
      this.keyboardPitch.delete(key.toLowerCase());
      this.noteOff(held);
      return true;
    }

    if (options.repeat) return true;
    // A key that is already down does not retrigger.
    if (this.keyboardPitch.has(key.toLowerCase())) return true;

    this.keyboardPitch.set(key.toLowerCase(), pitch);
    this.noteOn(pitch, options.velocity);
    this.handlers.onStatus?.({ ...this.status, activity: `key ${key.toUpperCase()} → ${pitch}` });
    return true;
  }

  /** Re-reads the port table and rebinds listeners. */
  refreshPorts(): void {
    if (!this.access) return;

    const previous = new Map(this.ports.map((port) => [port.id, port]));
    const next: MidiPortInfo[] = [];
    this.byId.clear();

    for (const raw of this.access.inputs.values()) {
      const old = previous.get(raw.id);
      next.push({
        id: raw.id,
        name: raw.name || 'MIDI input',
        manufacturer: raw.manufacturer || '',
        direction: 'input',
        connected: raw.state === 'connected',
        // A newly attached input is enabled for notes straight away; that is
        // what a player expects when they plug a keyboard in.
        track: old ? old.track : raw.state === 'connected',
        remote: old ? old.remote : false,
      });
      this.byId.set(raw.id, raw);
    }

    for (const raw of this.access.outputs.values()) {
      const old = previous.get(raw.id);
      next.push({
        id: raw.id,
        name: raw.name || 'MIDI output',
        manufacturer: raw.manufacturer || '',
        direction: 'output',
        connected: raw.state === 'connected',
        track: old ? old.track : false,
        remote: old ? old.remote : false,
      });
    }

    this.ports = next;
    this.syncListeners();

    const connected = next.filter((port) => port.direction === 'input' && port.connected).length;
    this.setStatus(
      'ready',
      connected === 0 ? 'No MIDI inputs found. Plug a controller in, or play the computer keyboard.' : `${connected} MIDI input${connected === 1 ? '' : 's'} ready`,
    );
    this.handlers.onPorts?.([...this.ports]);
  }

  private syncListeners(): void {
    for (const info of this.ports) {
      if (info.direction !== 'input') continue;
      const raw = this.byId.get(info.id);
      if (!raw) continue;
      const wanted = info.track || info.remote;
      raw.onmidimessage = wanted ? (event) => this.receive(event) : null;
    }
  }

  private receive(event: MidiMessageEventLike): void {
    const message = decodeMidiMessage(event.data ?? []);
    if (!message) return;

    switch (message.kind) {
      case 'noteOn': {
        const pitch = message.pitch ?? 0;
        this.held.add(pitch);
        this.handlers.onNoteOn?.(pitch, (message.velocity ?? 100) / 127, message.channel);
        this.handlers.onStatus?.({
          ...this.status,
          activity: `note ${pitch} · vel ${message.velocity ?? 0}`,
        });
        break;
      }
      case 'noteOff': {
        const pitch = message.pitch ?? 0;
        this.held.delete(pitch);
        if (this.sustainDown) this.sustained.add(pitch);
        else this.handlers.onNoteOff?.(pitch, message.channel);
        break;
      }
      case 'control': {
        if (message.controller === SUSTAIN_CONTROLLER) {
          const down = (message.value ?? 0) >= 64;
          if (this.sustainDown && !down) {
            for (const pitch of this.sustained) this.handlers.onNoteOff?.(pitch, message.channel);
            this.sustained.clear();
          }
          this.sustainDown = down;
        }
        this.handlers.onControl?.({
          channel: message.channel,
          controller: message.controller ?? 0,
          value: message.value ?? 0,
        });
        this.handlers.onStatus?.({
          ...this.status,
          activity: `CC ${message.controller} = ${message.value}`,
        });
        break;
      }
      case 'pitchBend':
        this.handlers.onPitchBend?.(message.bend ?? 0, message.channel);
        break;
      default:
        break;
    }
  }

  private setStatus(state: MidiStatus['state'], message: string): MidiStatus {
    this.status = {
      ...this.status,
      state,
      message,
      activeInputs: this.ports.filter((port) => port.track).length,
    };
    this.handlers.onStatus?.(this.status);
    return this.status;
  }
}
