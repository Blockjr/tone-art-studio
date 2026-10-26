import {
  CLICK_SOUNDS,
  COUNT_IN_OPTIONS,
  countInLabel,
  type ClickLevel,
  type MetronomeSettings,
} from '../audio/metronome';
import { el } from './controls';

export interface MetronomeMenuActions {
  get(): MetronomeSettings;
  update(patch: Partial<MetronomeSettings>): void;
  test(level: ClickLevel): void;
}

/**
 * The small settings sheet behind the transport's metronome caret. It keeps
 * the main transport to one toggle each for click and count-in, while still
 * exposing the controls a real click track needs: level, accent, sound,
 * subdivision and count-in length.
 */
export class MetronomeMenu {
  readonly element: HTMLButtonElement;
  private menu: HTMLElement;
  private actions: MetronomeMenuActions;
  private open = false;

  private enabled!: HTMLInputElement;
  private sound!: HTMLSelectElement;
  private volume!: HTMLInputElement;
  private volumeValue!: HTMLElement;
  private accent!: HTMLInputElement;
  private subdivision!: HTMLSelectElement;
  private countIn!: HTMLInputElement;
  private countInBars!: HTMLSelectElement;

  private onDocPointer = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (!target) return;
    if (this.menu.contains(target) || this.element.contains(target)) return;
    const metro = document.getElementById('btn-metro');
    if (metro?.contains(target)) return;
    this.close();
  };
  private onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close();
  };
  private onResize = (): void => this.close();

  constructor(actions: MetronomeMenuActions) {
    this.actions = actions;
    const button = document.getElementById('btn-metro-menu');
    if (!button) throw new Error('Missing #btn-metro-menu');
    this.element = button as HTMLButtonElement;
    this.element.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggle();
    });

    this.menu = el('div', 'file-menu metronome-menu');
    this.menu.id = 'metronome-menu';
    this.menu.setAttribute('role', 'dialog');
    this.menu.setAttribute('aria-label', 'Metronome settings');
    this.build();
    document.body.appendChild(this.menu);

    // Right-clicking the metronome itself opens the same sheet, the gesture
    // most DAWs use for their click settings.
    document.getElementById('btn-metro')?.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.show();
    });
  }

  private build(): void {
    this.menu.replaceChildren();

    const head = el('div', 'metronome-head');
    head.append(el('strong', '', 'Metronome'), el('span', 'metronome-hint', 'click & count-in'));
    const close = el('button', 'tbtn tbtn-sm', '✕');
    close.title = 'Close metronome settings';
    close.addEventListener('click', () => this.close());
    head.appendChild(close);
    this.menu.appendChild(head);

    this.enabled = this.checkbox('metro-enabled', 'Click during playback');
    this.menu.appendChild(this.row('Click', this.enabled));

    const soundRow = el('label', 'metronome-field');
    soundRow.append(el('span', 'metronome-label', 'Sound'));
    this.sound = el('select', 'metronome-select') as HTMLSelectElement;
    this.sound.id = 'metro-sound';
    for (const entry of CLICK_SOUNDS) {
      const option = el('option') as HTMLOptionElement;
      option.value = entry.id;
      option.textContent = entry.label;
      option.title = entry.detail;
      this.sound.appendChild(option);
    }
    this.sound.addEventListener('change', () => {
      this.actions.update({ sound: this.sound.value as MetronomeSettings['sound'] });
    });
    soundRow.appendChild(this.sound);
    this.menu.appendChild(soundRow);

    const volumeRow = el('div', 'metronome-field');
    const volumeLabel = el('div', 'metronome-label');
    volumeLabel.append(el('span', '', 'Volume'), (this.volumeValue = el('span', 'metronome-value', '55%')));
    this.volume = el('input', 'metronome-range') as HTMLInputElement;
    this.volume.id = 'metro-volume';
    this.volume.type = 'range';
    this.volume.min = '0';
    this.volume.max = '100';
    this.volume.step = '1';
    this.volume.addEventListener('input', () => {
      const value = Number(this.volume.value) / 100;
      this.volumeValue.textContent = `${this.volume.value}%`;
      this.actions.update({ volume: value });
    });
    volumeRow.append(volumeLabel, this.volume);
    this.menu.appendChild(volumeRow);

    this.accent = this.checkbox('metro-accent', 'Accent beat one');
    this.menu.appendChild(this.row('Accent', this.accent));

    const subdivisionRow = el('label', 'metronome-field');
    subdivisionRow.append(el('span', 'metronome-label', 'Subdivision'));
    this.subdivision = el('select', 'metronome-select') as HTMLSelectElement;
    this.subdivision.id = 'metro-subdivision';
    for (const [value, label] of [
      ['1', 'Quarter notes'],
      ['2', 'Eighth notes'],
      ['4', 'Sixteenth notes'],
    ]) {
      const option = el('option') as HTMLOptionElement;
      option.value = value;
      option.textContent = label;
      this.subdivision.appendChild(option);
    }
    this.subdivision.addEventListener('change', () => {
      const value = Number(this.subdivision.value);
      this.actions.update({ subdivision: value === 2 || value === 4 ? value : 1 });
    });
    subdivisionRow.appendChild(this.subdivision);
    this.menu.appendChild(subdivisionRow);

    this.menu.appendChild(el('div', 'file-menu-sep'));

    const countHead = el('div', 'metronome-section');
    countHead.append(el('strong', '', 'Count-in'), el('span', 'metronome-hint', 'before playback'));
    this.menu.appendChild(countHead);

    this.countIn = this.checkbox('metro-countin', 'Count in before playing');
    this.menu.appendChild(this.row('Count-in', this.countIn));

    const barsRow = el('label', 'metronome-field');
    barsRow.append(el('span', 'metronome-label', 'Length'));
    this.countInBars = el('select', 'metronome-select') as HTMLSelectElement;
    this.countInBars.id = 'metro-countin-bars';
    for (const entry of COUNT_IN_OPTIONS) {
      const option = el('option') as HTMLOptionElement;
      option.value = String(entry.id);
      option.textContent = entry.label;
      this.countInBars.appendChild(option);
    }
    this.countInBars.addEventListener('change', () => {
      const value = Number(this.countInBars.value);
      this.actions.update({ countInBars: value === 2 || value === 4 ? value : 1 });
    });
    barsRow.appendChild(this.countInBars);
    this.menu.appendChild(barsRow);

    const hint = el(
      'p',
      'metronome-note',
      'Count-in clicks play before the transport rolls, even when the click is off. The transport button shows the count.',
    );
    this.menu.appendChild(hint);

    const test = el('button', 'tbtn tbtn-sm metronome-test', 'Test click');
    test.id = 'metro-test';
    test.title = 'Hear the accent click with the current sound and level';
    test.addEventListener('click', () => this.actions.test('accent'));
    this.menu.appendChild(test);

    this.refresh();
  }

  private checkbox(id: string, label: string): HTMLInputElement {
    const input = el('input', 'metronome-check') as HTMLInputElement;
    input.id = id;
    input.type = 'checkbox';
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      const patch: Partial<MetronomeSettings> =
        input === this.enabled ? { enabled: input.checked } : { countIn: input.checked };
      this.actions.update(patch);
      if (input === this.countIn) this.countInBars.disabled = !input.checked;
    });
    return input;
  }

  private row(label: string, control: HTMLElement): HTMLElement {
    const row = el('div', 'metronome-row');
    const text = el('label', 'metronome-label', label);
    if (control.id) text.setAttribute('for', control.id);
    row.append(text, control);
    return row;
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    this.refresh();
    const rect = this.element.getBoundingClientRect();
    this.menu.classList.add('is-open');
    this.open = true;
    this.element.setAttribute('aria-expanded', 'true');

    const width = this.menu.offsetWidth || 300;
    const height = this.menu.offsetHeight || 430;
    const left = Math.max(6, Math.min(rect.left - 60, window.innerWidth - width - 6));
    const top = Math.min(rect.bottom + 6, Math.max(6, window.innerHeight - height - 6));
    this.menu.style.left = `${Math.round(left)}px`;
    this.menu.style.top = `${Math.round(top)}px`;

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

  /** Call after a shortcut changes the settings while the sheet is open. */
  refresh(): void {
    const settings = this.actions.get();
    this.enabled.checked = settings.enabled;
    this.sound.value = settings.sound;
    this.volume.value = String(Math.round(settings.volume * 100));
    this.volumeValue.textContent = `${this.volume.value}%`;
    this.accent.checked = settings.accent;
    this.subdivision.value = String(settings.subdivision);
    this.countIn.checked = settings.countIn;
    this.countInBars.value = String(settings.countInBars);
    this.countInBars.disabled = !settings.countIn;
    this.menu.dataset.countIn = countInLabel(settings);
  }
}
