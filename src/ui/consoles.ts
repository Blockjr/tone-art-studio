/**
 * Console windows.
 *
 * Every part of the studio that is worked in for a while — the mixer, the MIDI
 * panel, the browser, the rack, the preview, the takes list and the note
 * editor — can be lifted into a window of its own. That is what makes a second
 * monitor or a tablet-sized screen useful: the console is resized, moved and
 * placed where the work is, and closed again when it is not needed.
 *
 * A console window is the same interface, opened with `?panel=<id>`, with one
 * console moved into it. Two things follow from that and both matter:
 *
 *   - because it is the same code, every control in it is the real control, not
 *     a picture of one. The session itself is shared between the windows by
 *     src/core/sync.ts, so a fader moved in a detached mixer moves in the
 *     studio window too;
 *   - because it is one console per window, there is nothing to overlap. The
 *     studio's own floating panels are one-at-a-time for exactly that reason;
 *     this is where several of them live at once, without covering each other.
 *
 * `hostDetachedConsole` does the moving. Listeners go with a moved node, so
 * dragging a control still works after its console has changed window.
 */

import { el } from './controls';

export type ConsoleId = 'mixer' | 'midi' | 'rig' | 'preview' | 'browser' | 'takes' | 'notes' | 'rack';

export interface ConsoleRegistration {
  id: ConsoleId;
  /** Window title, and the label in the Consoles menu. */
  title: string;
  /** What it is for, shown in the menu. */
  detail: string;
  /** The element that becomes the whole window. */
  element: HTMLElement;
  /** Brings the console on screen when its window opens. */
  open: () => void;
}

/** The tab title a console window carries. */
export const CONSOLE_SUFFIX = 'Tone Art Studio';

const registry = new Map<ConsoleId, ConsoleRegistration>();

export function registerConsole(registration: ConsoleRegistration): void {
  registry.set(registration.id, registration);
}

export function consoleRegistration(id: string | null): ConsoleRegistration | null {
  if (!id) return null;
  return registry.get(id as ConsoleId) ?? null;
}

export function registeredConsoles(): ConsoleRegistration[] {
  return [...registry.values()];
}

/** The console this window is showing, or null when it is the studio window. */
export function detachedConsoleId(): ConsoleId | null {
  const name = new URLSearchParams(window.location.search).get('panel');
  return name && registry.has(name as ConsoleId) ? (name as ConsoleId) : null;
}

/** True when the desktop shell is there to open a second window. */
export function canDetach(): boolean {
  const host = (window as unknown as { tas?: { openPanel?: (panel: string) => unknown } }).tas;
  return typeof host?.openPanel === 'function';
}

/**
 * Opens one console in its own window. In a plain browser there is no second
 * window to open, so the caller decides what that means (the menu brings the
 * docked one forward instead).
 */
export function openConsoleWindow(id: ConsoleId): boolean {
  const host = (window as unknown as { tas?: { openPanel?: (panel: string) => unknown } }).tas;
  if (typeof host?.openPanel !== 'function') return false;
  void host.openPanel(id);
  return true;
}

/**
 * Moves this window's console into the window itself and shows it.
 *
 * Called once at start-up in a console window, after the consoles have been
 * registered. Returns false in the studio window, where nothing is detached.
 */
export function hostDetachedConsole(): boolean {
  const id = detachedConsoleId();
  const registration = id ? registry.get(id) : undefined;
  if (!registration) return false;

  const host = el('div', 'console-host');
  host.id = 'console-host';
  host.dataset.console = registration.id;
  document.body.append(host);
  host.append(registration.element);

  document.body.classList.add('is-detached');
  document.body.dataset.console = registration.id;
  document.title = `${registration.title} — ${CONSOLE_SUFFIX}`;

  registration.open();
  return true;
}

/** The ⧉ button for a console header: opens it in its own window. */
export function detachButton(id: ConsoleId): HTMLButtonElement | null {
  const registration = registry.get(id);
  if (!registration || !canDetach()) return null;

  const button = el('button', 'tbtn tbtn-sm console-detach', '⧉');
  button.title = `Open ${registration.title} in its own window — resize it, move it to another screen, close it when you are done`;
  button.setAttribute('aria-label', `Open ${registration.title} in its own window`);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    openConsoleWindow(id);
  });
  return button;
}

/**
 * The desktop shell's Window menu already lists the consoles; this is the same
 * list inside the studio, so a console can be sent to its own window without
 * leaving the app, and so the browser build explains where the windows went.
 */
export class ConsolesMenu {
  readonly element: HTMLButtonElement;
  private menu: HTMLElement;
  private open = false;

  private onDocPointer = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (!target) return;
    if (this.menu.contains(target) || this.element.contains(target)) return;
    this.close();
  };

  private onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close();
  };

  constructor(private readonly onOpen: (id: ConsoleId) => void) {
    this.element = el('button', 'tbtn tbtn-sm', 'Consoles ▾');
    this.element.id = 'btn-consoles';
    this.element.title = 'Open a console in its own window, for a second screen';
    this.element.setAttribute('aria-haspopup', 'menu');
    this.element.setAttribute('aria-expanded', 'false');
    this.element.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.open) this.close();
      else this.show();
    });

    this.menu = el('div', 'file-menu consoles-menu');
    this.menu.setAttribute('role', 'menu');
    document.body.appendChild(this.menu);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    const entries = registeredConsoles();
    this.menu.replaceChildren();

    const heading = el('div', 'file-menu-heading', canDetach() ? 'Open in its own window' : 'Console windows need the desktop app');
    this.menu.appendChild(heading);

    for (const console_ of entries) {
      const item = el('button', 'file-menu-item');
      item.setAttribute('role', 'menuitem');
      const text = el('span', 'file-menu-text');
      text.append(el('span', 'file-menu-label', console_.title));
      text.append(el('span', 'file-menu-detail', console_.detail));
      item.appendChild(text);
      item.append(el('span', 'file-menu-key', '⧉'));
      item.addEventListener('click', () => {
        this.close();
        this.onOpen(console_.id);
      });
      this.menu.appendChild(item);
    }

    const rect = this.element.getBoundingClientRect();
    this.menu.classList.add('is-open');
    this.open = true;
    this.element.setAttribute('aria-expanded', 'true');

    const width = this.menu.offsetWidth || 300;
    const height = this.menu.offsetHeight || 360;
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
    const top = Math.min(rect.bottom + 6, Math.max(6, window.innerHeight - height - 6));
    this.menu.style.left = `${Math.round(left)}px`;
    this.menu.style.top = `${Math.round(top)}px`;

    document.addEventListener('pointerdown', this.onDocPointer, true);
    document.addEventListener('keydown', this.onKey, true);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.menu.classList.remove('is-open');
    this.element.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onDocPointer, true);
    document.removeEventListener('keydown', this.onKey, true);
  }
}
