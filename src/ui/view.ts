import { LAYOUT_PRESETS, type LayoutPreset } from '../core/layout';
import { el } from './controls';

export interface ViewMenuActions {
  onPreset: (preset: LayoutPreset) => void;
  onFit: () => void;
  onReset: () => void;
  onFullscreen: () => void;
}

interface ViewEntry {
  label: string;
  shortcut?: string;
  detail?: string;
  run?: () => void;
  separator?: boolean;
}

/**
 * The View menu: one-click workspace layouts, fit-to-window and fullscreen.
 * It mirrors the resizable panels rather than replacing them — dragging a
 * splitter still works, this is the fast path between common arrangements.
 */
export class ViewMenu {
  readonly element: HTMLButtonElement;
  private menu: HTMLElement;
  private open = false;
  private actions: ViewMenuActions;

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

  constructor(actions: ViewMenuActions) {
    this.actions = actions;

    this.element = el('button', 'tbtn tbtn-sm', 'View ▾');
    this.element.id = 'btn-view';
    this.element.title = 'Workspace layouts, fit to window and fullscreen';
    this.element.setAttribute('aria-haspopup', 'menu');
    this.element.setAttribute('aria-expanded', 'false');
    this.element.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.open) this.close();
      else this.show();
    });

    this.menu = el('div', 'file-menu view-menu');
    this.menu.setAttribute('role', 'menu');
    this.build();
    document.body.appendChild(this.menu);
  }

  private build(): void {
    const entries: ViewEntry[] = [
      ...LAYOUT_PRESETS.map<ViewEntry>((preset) => ({
        label: preset.label,
        detail: preset.detail,
        run: () => this.actions.onPreset(preset.id),
      })),
      { label: '', separator: true },
      { label: 'Fit to window', shortcut: '', run: () => this.actions.onFit() },
      { label: 'Reset panels', shortcut: '', run: () => this.actions.onReset() },
      { label: '', separator: true },
      { label: 'Fullscreen', shortcut: 'Ctrl ⇧ F', run: () => this.actions.onFullscreen() },
    ];

    this.menu.replaceChildren();
    for (const entry of entries) {
      if (entry.separator) {
        this.menu.appendChild(el('div', 'file-menu-sep'));
        continue;
      }
      const item = el('button', 'file-menu-item');
      item.setAttribute('role', 'menuitem');
      const text = el('span', 'file-menu-text');
      text.append(el('span', 'file-menu-label', entry.label));
      if (entry.detail) text.append(el('span', 'file-menu-detail', entry.detail));
      item.appendChild(text);
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

  show(): void {
    const rect = this.element.getBoundingClientRect();
    this.menu.classList.add('is-open');
    this.open = true;
    this.element.setAttribute('aria-expanded', 'true');

    const width = this.menu.offsetWidth || 280;
    const height = this.menu.offsetHeight || 340;
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
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
}
