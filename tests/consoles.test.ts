// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_SUFFIX,
  ConsolesMenu,
  canDetach,
  consoleRegistration,
  detachButton,
  detachedConsoleId,
  hostDetachedConsole,
  openConsoleWindow,
  registerConsole,
  registeredConsoles,
  type ConsoleId,
} from '../src/ui/consoles';

/**
 * A console window is the same interface with `?panel=<id>`, so the module is
 * tested on its own with the URL the desktop shell would have opened it with.
 */
function openWith(search: string): void {
  window.history.replaceState({}, '', search === '' ? '/' : `/${search}`);
}

function consoleElement(tag = 'section'): HTMLElement {
  return document.createElement(tag);
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  delete document.body.dataset.console;
  document.title = 'Tone Art Studio';
  delete (window as unknown as { tas?: unknown }).tas;
  openWith('');
});

describe('console windows', () => {
  it('knows every console it can host, and what each one is for', () => {
    const ids: ConsoleId[] = ['mixer', 'midi', 'rig', 'preview', 'browser', 'takes', 'notes', 'rack'];
    for (const id of ids) {
      registerConsole({ id, title: id, detail: `${id} console`, element: consoleElement(), open: () => {} });
    }

    expect(registeredConsoles().map((entry) => entry.id)).toEqual(ids);
    expect(consoleRegistration('midi')?.detail).toBe('midi console');
    // An unknown name is not a console: the window stays the studio.
    expect(consoleRegistration('nonsense')).toBeNull();
  });

  it('reads the console it was opened for out of the window address', () => {
    registerConsole({ id: 'mixer', title: 'Mixer', detail: '', element: consoleElement(), open: () => {} });

    openWith('?panel=mixer');
    expect(detachedConsoleId()).toBe('mixer');

    openWith('?panel=not-a-console');
    expect(detachedConsoleId()).toBeNull();

    openWith('');
    expect(detachedConsoleId()).toBeNull();
  });

  it('moves the console into the window and shows only it', () => {
    let opened = 0;
    const element = consoleElement();
    document.body.append(element);
    registerConsole({ id: 'notes', title: 'Notes', detail: '', element, open: () => (opened += 1) });

    openWith('?panel=notes');
    expect(hostDetachedConsole()).toBe(true);

    const host = document.getElementById('console-host');
    expect(host).not.toBeNull();
    expect(host?.contains(element)).toBe(true);
    expect(host?.dataset.console).toBe('notes');
    expect(document.body.classList.contains('is-detached')).toBe(true);
    expect(document.body.dataset.console).toBe('notes');
    expect(document.title).toBe(`Notes — ${CONSOLE_SUFFIX}`);
    // The console is told to show itself: a notes window has to open its editor.
    expect(opened).toBe(1);
  });

  it('never moves a console into the studio window itself', () => {
    const element = consoleElement();
    document.body.append(element);
    registerConsole({ id: 'mixer', title: 'Mixer', detail: '', element, open: () => {} });

    expect(hostDetachedConsole()).toBe(false);
    expect(document.getElementById('console-host')).toBeNull();
    expect(document.body.classList.contains('is-detached')).toBe(false);
    // The console stays exactly where the layout put it.
    expect(element.parentElement).toBe(document.body);
  });

  it('asks the desktop shell for a second window, and does nothing in a browser', async () => {
    const openPanel = vi.fn();
    registerConsole({ id: 'mixer', title: 'Mixer', detail: '', element: consoleElement(), open: () => {} });

    // A plain browser has no second window to open.
    expect(canDetach()).toBe(false);
    expect(openConsoleWindow('mixer')).toBe(false);
    expect(detachButton('mixer')).toBeNull();

    (window as unknown as { tas: { openPanel: unknown } }).tas = { openPanel };
    expect(canDetach()).toBe(true);
    expect(openConsoleWindow('mixer')).toBe(true);
    expect(openPanel).toHaveBeenCalledWith('mixer');

    // The ⧉ button on a console header does the same thing.
    const button = detachButton('mixer');
    expect(button).not.toBeNull();
    expect(button?.title).toContain('own window');
    button?.click();
    expect(openPanel).toHaveBeenCalledTimes(2);
  });

  it('lists the consoles in a menu and reports the chosen one', () => {
    const chosen: string[] = [];
    registerConsole({ id: 'mixer', title: 'Mixer', detail: 'Faders and pans', element: consoleElement(), open: () => {} });
    registerConsole({ id: 'midi', title: 'MIDI', detail: 'Controllers', element: consoleElement(), open: () => {} });

    const menu = new ConsolesMenu((id) => chosen.push(id));
    menu.show();

    // One entry per console the app registered, each naming what it is for.
    const items = [...document.querySelectorAll<HTMLElement>('.consoles-menu .file-menu-item')];
    expect(items).toHaveLength(registeredConsoles().length);

    const midi = items.find((item) => item.textContent?.includes('Controllers'));
    expect(midi).toBeDefined();
    midi?.click();

    expect(chosen).toEqual(['midi']);
    expect(menu.isOpen).toBe(false);
  });
});
