import type { Preferences, RecentProject } from '../core/session';
import { el } from './controls';

export interface FileMenuActions {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: () => void;
  onStartScreen: () => void;
}

interface MenuEntry {
  label: string;
  shortcut?: string;
  run?: () => void;
  separator?: boolean;
}

/**
 * The project menu, dropped from the top bar. Items mirror the keyboard
 * shortcuts so the menu doubles as the shortcut reference.
 */
export class FileMenu {
  readonly element: HTMLButtonElement;
  private menu: HTMLElement;
  private actions: FileMenuActions;
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
  private onResize = (): void => this.close();

  constructor(actions: FileMenuActions) {
    this.actions = actions;

    this.element = el('button', 'tbtn tbtn-sm', 'File ▾');
    this.element.id = 'btn-file';
    this.element.title = 'New, open and save projects';
    this.element.setAttribute('aria-haspopup', 'menu');
    this.element.setAttribute('aria-expanded', 'false');
    this.element.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggle();
    });

    this.menu = el('div', 'file-menu');
    this.menu.setAttribute('role', 'menu');
    this.build();
    document.body.appendChild(this.menu);
  }

  private build(): void {
    const entries: MenuEntry[] = [
      { label: 'New project…', shortcut: 'Ctrl N', run: this.actions.onNew },
      { label: 'Open project…', shortcut: 'Ctrl O', run: this.actions.onOpen },
      { label: '', separator: true },
      { label: 'Save', shortcut: 'Ctrl S', run: this.actions.onSave },
      { label: 'Save as…', shortcut: 'Ctrl ⇧ S', run: this.actions.onSaveAs },
      { label: 'Export WAV mixdown…', shortcut: '', run: this.actions.onExport },
      { label: '', separator: true },
      { label: 'Start screen', shortcut: '', run: this.actions.onStartScreen },
    ];

    this.menu.replaceChildren();
    for (const entry of entries) {
      if (entry.separator) {
        this.menu.appendChild(el('div', 'file-menu-sep'));
        continue;
      }
      const item = el('button', 'file-menu-item');
      item.setAttribute('role', 'menuitem');
      item.append(el('span', 'file-menu-label', entry.label));
      if (entry.shortcut) item.append(el('span', 'file-menu-key', entry.shortcut));
      item.addEventListener('click', () => {
        this.close();
        entry.run?.();
      });
      this.menu.appendChild(item);
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  private toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    const rect = this.element.getBoundingClientRect();
    this.menu.classList.add('is-open');
    this.open = true;
    this.element.setAttribute('aria-expanded', 'true');

    const width = this.menu.offsetWidth || 240;
    const height = this.menu.offsetHeight || 240;
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
    const top = Math.min(rect.bottom + 6, window.innerHeight - height - 6);
    this.menu.style.left = `${Math.round(left)}px`;
    this.menu.style.top = `${Math.round(Math.max(6, top))}px`;

    document.addEventListener('pointerdown', this.onDocPointer, true);
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.menu.classList.remove('is-open');
    this.element.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onDocPointer, true);
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
  }
}

export interface NewProjectOptions {
  name: string;
  bpm: number;
  bars: number;
}

export interface StartScreenOptions {
  preferences: Preferences;
  recents: RecentProject[];
  /** true inside the desktop build, where VST3 scanning exists */
  nativeHost: boolean;
  /** name of the autosaved session, when one can be resumed */
  resumeName: string | null;
  onCreate: (options: NewProjectOptions) => void;
  onDemo: () => void;
  onOpen: () => void;
  onResume: () => void;
  onRecent: (id: string) => void;
  onPreferences: (preferences: Preferences) => void;
  onDismiss: () => void;
}

function formatSaved(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The launch screen: start a new project, reopen a recent one, resume the
 * autosaved session, or jump straight into the last state. The VST3 scan
 * preference lives here because that is where a session begins.
 */
export class StartScreen {
  readonly element: HTMLElement;
  private options: StartScreenOptions;
  private nameInput: HTMLInputElement;
  private bpmInput: HTMLInputElement;
  private barsInput: HTMLInputElement;
  private recentList: HTMLElement;
  private resumeButton: HTMLButtonElement;
  private onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.dismiss();
  };

  constructor(options: StartScreenOptions) {
    this.options = options;

    this.element = el('div', 'start-screen');
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Start a session in Tone Art Studio');

    const card = el('div', 'start-card');

    // header
    const head = el('div', 'start-head');
    const mark = el('span', 'start-mark');
    const markImage = document.createElement('img');
    markImage.src = '/logo.svg';
    markImage.alt = '';
    markImage.width = 34;
    markImage.height = 34;
    mark.append(markImage);
    const titles = el('div', 'start-titles');
    titles.append(
      el('strong', '', 'Tone Art Studio'),
      el('span', '', 'Start a session'),
    );
    const closeButton = el('button', 'start-close', '✕');
    closeButton.title = 'Enter the studio with the current session';
    closeButton.addEventListener('click', () => this.dismiss());
    head.append(mark, titles, closeButton);

    const body = el('div', 'start-body');

    // new project
    const createColumn = el('section', 'start-column');
    createColumn.append(el('div', 'section-title', 'New project'));

    this.nameInput = el('input', 'start-input') as HTMLInputElement;
    this.nameInput.type = 'text';
    this.nameInput.value = 'Untitled';
    this.nameInput.spellcheck = false;
    this.nameInput.maxLength = 64;
    this.nameInput.setAttribute('aria-label', 'Project name');

    this.bpmInput = el('input', 'start-input start-input-num') as HTMLInputElement;
    this.bpmInput.type = 'number';
    this.bpmInput.min = '40';
    this.bpmInput.max = '260';
    this.bpmInput.value = '120';
    this.bpmInput.setAttribute('aria-label', 'Tempo');

    this.barsInput = el('input', 'start-input start-input-num') as HTMLInputElement;
    this.barsInput.type = 'number';
    this.barsInput.min = '1';
    this.barsInput.max = '256';
    this.barsInput.step = '1';
    this.barsInput.value = '32';
    this.barsInput.setAttribute('aria-label', 'Length in bars');

    const numbers = el('div', 'start-row');
    numbers.append(this.field('Tempo', this.bpmInput), this.field('Bars', this.barsInput));
    createColumn.append(this.field('Name', this.nameInput), numbers);

    const createButton = el('button', 'start-primary', 'Create project');
    createButton.id = 'start-create';
    createButton.addEventListener('click', () => this.create());
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.create();
    });

    createColumn.appendChild(createButton);

    const secondary = el('div', 'start-secondary');
    const demoButton = el('button', 'start-ghost', 'Load demo session');
    demoButton.id = 'start-demo';
    demoButton.addEventListener('click', () => {
      this.close();
      this.options.onDemo();
    });
    const openButton = el('button', 'start-ghost', 'Open project…');
    openButton.id = 'start-open';
    openButton.addEventListener('click', () => {
      this.close();
      this.options.onOpen();
    });
    secondary.append(demoButton, openButton);
    createColumn.appendChild(secondary);

    // recent projects
    const recentColumn = el('section', 'start-column');
    recentColumn.append(el('div', 'section-title', 'Recent sessions'));

    this.resumeButton = el('button', 'start-resume');
    this.recentList = el('div', 'start-recents');
    recentColumn.append(this.resumeButton, this.recentList);
    this.renderResume();
    this.renderRecents();

    body.append(createColumn, recentColumn);

    // footer preferences
    const foot = el('div', 'start-foot');

    const startupPref = this.pref('Show this screen when Tone Art Studio starts', options.preferences.showStartup, (checked) => {
      this.update({ showStartup: checked });
    });
    startupPref.querySelector('input')?.setAttribute('id', 'pref-startup');

    const scanPref = this.pref('Scan VST3 folders at startup', options.preferences.scanVst3OnStart, (checked) => {
      this.update({ scanVst3OnStart: checked });
    });
    scanPref.querySelector('input')?.setAttribute('id', 'pref-scan-vst3');
    const scanInput = scanPref.querySelector('input') as HTMLInputElement;
    scanInput.disabled = !options.nativeHost;
    if (!options.nativeHost) {
      scanPref.title = 'VST3 scanning needs the Windows desktop build';
      scanPref.classList.add('is-disabled');
      scanPref.append(el('span', 'start-pref-note', 'desktop build only'));
    }

    const enter = el('button', 'start-enter', 'Enter studio');
    enter.id = 'start-enter';
    enter.addEventListener('click', () => this.dismiss());

    const prefs = el('div', 'start-prefs');
    prefs.append(startupPref, scanPref);
    foot.append(prefs, enter);
    card.append(head, body, foot);

    this.element.appendChild(card);
  }

  private field(label: string, input: HTMLInputElement): HTMLElement {
    const wrap = el('label', 'start-field');
    wrap.append(el('span', 'start-label', label), input);
    return wrap;
  }

  private pref(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
    const wrap = el('label', 'start-pref');
    const input = el('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, el('span', '', label));
    return wrap;
  }

  private update(patch: Partial<Preferences>): void {
    this.options.preferences = { ...this.options.preferences, ...patch };
    this.options.onPreferences(this.options.preferences);
  }

  private create(): void {
    const name = this.nameInput.value.trim() || 'Untitled';
    const bpm = Math.min(260, Math.max(40, Number(this.bpmInput.value) || 120));
    const bars = Math.min(256, Math.max(1, Math.round(Number(this.barsInput.value) || 32)));
    this.close();
    this.options.onCreate({ name, bpm, bars });
  }

  private renderRecents(): void {
    this.recentList.replaceChildren();

    if (this.options.recents.length === 0 && !this.options.resumeName) {
      this.recentList.appendChild(
        el('div', 'start-empty', 'Nothing here yet — your saved sessions will be listed.'),
      );
      return;
    }

    for (const recent of this.options.recents) {
      const item = el('button', 'start-recent');
      item.dataset.recentId = recent.id;
      const label = el('div', 'start-recent-name');
      label.append(el('strong', '', recent.name));
      label.append(
        el('span', '', `${recent.tracks} tracks · ${recent.bpm} BPM · ${formatSaved(recent.savedAt)}`),
      );
      item.appendChild(label);
      item.addEventListener('click', () => {
        this.close();
        this.options.onRecent(recent.id);
      });
      this.recentList.appendChild(item);
    }
  }

  setRecents(recents: RecentProject[], resumeName: string | null): void {
    this.options.recents = recents;
    this.options.resumeName = resumeName;
    this.renderResume();
    this.renderRecents();
  }

  private renderResume(): void {
    this.resumeButton.remove();
    const name = this.options.resumeName;
    if (!name) return;

    this.resumeButton = el('button', 'start-resume');
    this.resumeButton.id = 'start-resume';
    this.resumeButton.append(
      el('strong', '', `Resume “${name}”`),
      el('span', '', 'the session autosaved in this browser'),
    );
    this.resumeButton.addEventListener('click', () => {
      this.close();
      this.options.onResume();
    });
    this.recentList.before(this.resumeButton);
  }

  get isOpen(): boolean {
    return this.element.classList.contains('is-open');
  }

  open(): void {
    document.body.appendChild(this.element);
    this.element.classList.add('is-open');
    document.addEventListener('keydown', this.onKey, true);
    this.nameInput.focus();
    this.nameInput.select();
  }

  close(): void {
    this.element.classList.remove('is-open');
    this.element.remove();
    document.removeEventListener('keydown', this.onKey, true);
  }

  private dismiss(): void {
    this.close();
    this.options.onDismiss();
  }
}
