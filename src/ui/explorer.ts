/**
 * Sample and file explorer.
 *
 * Where the platform allows it the explorer opens a real folder through the
 * File System Access API, keeps the handle and comes back to the same library
 * next session; the handle is asked for read permission again on use. Browsers
 * without that API still get the directory input and dropping files or folders
 * from the desktop, so the panel is never dead.
 *
 * Rows are drag sources. The drag carries a token (see core/filebrowse) and the
 * arrangement claims it on drop, which is what lets a row become a clip at the
 * exact beat and lane it was dropped on.
 */

import {
  beginDrag,
  FILE_DRAG_MIME,
  filterEntries,
  formatDuration,
  formatSize,
  isAudioName,
  joinPath,
  listingFromFiles,
  parentPath,
  pathSegments,
  sortEntries,
  takeDrag,
  type BrowseEntry,
  type NamedFile,
} from '../core/filebrowse';
import { el } from './controls';
import { filesFromDrop } from './dropfiles';

export interface ExplorerAsset {
  id: string;
  name: string;
  duration: number;
}

export interface FileExplorerOptions {
  onAuditionFile: (file: File) => void;
  onInsertFile: (file: File) => void;
  onAuditionAsset: (assetId: string) => void;
  onInsertAsset: (assetId: string) => void;
  /** brings every audio file in the open folder into the session at once */
  onImportAll?: (files: File[]) => void | Promise<void>;
  assets: () => ExplorerAsset[];
  notify: (message: string) => void;
}

type Source =
  | { kind: 'handle'; name: string; handle: FileSystemDirectoryHandle }
  | { kind: 'list'; name: string; files: NamedFile[] };

interface Row extends BrowseEntry {
  file?: File;
  handle?: FileSystemFileHandle;
  directory?: FileSystemDirectoryHandle;
  element?: HTMLElement;
}

type PermissiveHandle = FileSystemHandle & {
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

async function ensureRead(handle: FileSystemHandle): Promise<boolean> {
  const permissive = handle as PermissiveHandle;
  if (!permissive.queryPermission) return true;
  try {
    if ((await permissive.queryPermission({ mode: 'read' })) === 'granted') return true;
    if (!permissive.requestPermission) return false;
    return (await permissive.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ saved folders

const DB_NAME = 'toneart-explorer';
const DB_STORE = 'folders';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'name' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function savedFolders(): Promise<FileSystemDirectoryHandle[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
    request.onsuccess = () => {
      const handles = (request.result as Array<{ name: string; handle: FileSystemDirectoryHandle }>)
        .map((entry) => entry.handle)
        .filter((handle): handle is FileSystemDirectoryHandle => Boolean(handle?.kind === 'directory'));
      db.close();
      resolve(handles);
    };
    request.onerror = () => {
      db.close();
      resolve([]);
    };
  });
}

async function rememberFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put({ name: handle.name, handle });
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- explorer

export class FileExplorer {
  private options: FileExplorerOptions;
  private root: HTMLElement;
  private crumbs: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  private search: HTMLInputElement;
  private pinned: HTMLElement;
  private pool: HTMLElement;
  private upButton: HTMLButtonElement;
  private openButton: HTMLButtonElement;
  private folderInput: HTMLInputElement;

  private source: Source | null = null;
  private path = '';
  private rows: Row[] = [];
  private importAllButton!: HTMLButtonElement;
  private query = '';
  private audioOnly = true;
  private folders: FileSystemDirectoryHandle[] = [];
  private durations = new Map<string, number>();
  private loadToken = 0;

  constructor(options: FileExplorerOptions) {
    this.options = options;

    this.root = el('div', 'explorer');

    // toolbar ---------------------------------------------------------------
    const bar = el('div', 'explorer-bar');

    this.openButton = el('button', 'explorer-btn explorer-btn-open', 'Open folder…');
    this.openButton.title = 'Open a sample folder — it is remembered for next time';
    this.openButton.addEventListener('click', () => void this.pickFolder());

    this.upButton = el('button', 'explorer-btn', '↑');
    this.upButton.title = 'Up one folder';
    this.upButton.addEventListener('click', () => this.goUp());

    const refresh = el('button', 'explorer-btn', '⟳');
    refresh.title = 'Refresh this folder';
    refresh.addEventListener('click', () => void this.render());

    // Bulk import: an opened sample pack is dozens of files, and placing them
    // one at a time is the wrong kind of work. This takes the whole folder.
    this.importAllButton = el('button', 'explorer-btn explorer-btn-import', 'Import all');
    this.importAllButton.title = 'Import every audio file in this folder into the session, laid end to end';
    this.importAllButton.disabled = true;
    this.importAllButton.addEventListener('click', () => void this.importAll());

    bar.append(this.openButton, this.upButton, refresh, this.importAllButton);

    this.crumbs = el('div', 'explorer-crumbs');

    // search ----------------------------------------------------------------
    const searchRow = el('div', 'explorer-search');
    this.search = el('input', 'explorer-search-input') as HTMLInputElement;
    this.search.type = 'search';
    this.search.placeholder = 'Filter this folder';
    this.search.spellcheck = false;
    this.search.setAttribute('aria-label', 'Filter files');
    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.renderRows();
    });

    const audioOnlyLabel = el('label', 'explorer-toggle');
    const audioOnly = el('input') as HTMLInputElement;
    audioOnly.type = 'checkbox';
    audioOnly.checked = this.audioOnly;
    audioOnly.setAttribute('aria-label', 'Show audio files only');
    audioOnly.addEventListener('change', () => {
      this.audioOnly = audioOnly.checked;
      this.renderRows();
    });
    audioOnlyLabel.append(audioOnly, el('span', '', 'Audio only'));
    searchRow.append(this.search, audioOnlyLabel);

    this.pinned = el('div', 'explorer-pinned');

    this.list = el('div', 'explorer-list');
    this.list.id = 'explorer-list';
    this.status = el('div', 'explorer-status', 'Open a folder, or drag one in from your desktop.');

    // session audio ---------------------------------------------------------
    const poolHead = el('div', 'section-title');
    poolHead.append(el('span', '', 'Session audio'), el('span', '', 'drag to a track'));
    this.pool = el('div', 'explorer-pool');

    const hint = el(
      'p',
      'explorer-hint',
      'Drag a file onto a track to place it at that beat. Double-click inserts at the playhead.',
    );

    this.folderInput = el('input') as HTMLInputElement;
    this.folderInput.type = 'file';
    this.folderInput.hidden = true;
    this.folderInput.multiple = true;
    this.folderInput.id = 'explorer-folder-input';
    this.folderInput.setAttribute('webkitdirectory', '');
    this.folderInput.setAttribute('directory', '');
    this.folderInput.addEventListener('change', () => {
      const files = this.folderInput.files;
      if (files && files.length > 0) {
        const named: NamedFile[] = [];
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
          named.push({ file, path: relative && relative.length > 0 ? relative : file.name });
        }
        const rootName = pathSegments(named[0]?.path ?? '')[0] ?? 'Samples';
        this.useList(rootName, named);
      }
      this.folderInput.value = '';
    });

    this.root.append(
      bar,
      this.crumbs,
      searchRow,
      this.pinned,
      this.list,
      this.status,
      poolHead,
      this.pool,
      hint,
      this.folderInput,
    );

    this.bindDrop();
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    this.renderCrumbs();
    this.renderPool();
    this.renderRows();
    this.upButton.disabled = true;
    void this.loadSaved();
  }

  /** Session audio changes whenever an import or a take lands. */
  refresh(): void {
    this.renderPool();
  }

  toggle(): boolean {
    return this.root.classList.toggle('is-open');
  }

  // ------------------------------------------------------------- navigation

  private async loadSaved(): Promise<void> {
    this.folders = await savedFolders();
    this.renderPinned();
  }

  private async pickFolder(): Promise<void> {
    const picker = (window as unknown as { showDirectoryPicker?: (options?: unknown) => Promise<FileSystemDirectoryHandle> })
      .showDirectoryPicker;
    if (typeof picker !== 'function') {
      this.folderInput.click();
      return;
    }

    try {
      const handle = await picker.call(window, { mode: 'read', id: 'toneart-samples' });
      await this.openHandle(handle);
    } catch (error) {
      // Aborting the picker is not an error worth a toast.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.options.notify('That folder could not be opened');
    }
  }

  private async openHandle(handle: FileSystemDirectoryHandle, remember = true): Promise<void> {
    const allowed = await ensureRead(handle);
    if (!allowed) {
      this.options.notify('Folder access was not granted');
      return;
    }

    this.source = { kind: 'handle', name: handle.name, handle };
    this.path = '';
    if (remember) {
      // Remembering the folder is a convenience: a storage failure must never
      // stop the folder from opening.
      try {
        await rememberFolder(handle);
        this.folders = await savedFolders();
        this.renderPinned();
      } catch {
        // Ignore: the explorer still works for this session.
      }
    }
    await this.render();
  }

  private openSaved(handle: FileSystemDirectoryHandle): void {
    void this.openHandle(handle, false);
  }

  private useList(name: string, files: NamedFile[]): void {
    this.source = { kind: 'list', name, files };
    this.path = '';
    this.audioOnly = true;
    void this.render();
    const audio = files.filter((entry) => isAudioName(entry.file.name)).length;
    this.options.notify(`${name}: ${audio} audio file${audio === 1 ? '' : 's'}`);
  }

  private goUp(): void {
    if (!this.path) return;
    this.path = parentPath(this.path);
    void this.render();
  }

  private goTo(path: string): void {
    this.path = path;
    void this.render();
  }

  // ---------------------------------------------------------------- render

  private async listPath(): Promise<Row[]> {
    const source = this.source;
    if (!source) return [];

    if (source.kind === 'list') {
      const listing = listingFromFiles(source.files, this.path);
      const rows: Row[] = listing.directories.map((name) => ({
        name,
        path: joinPath(this.path, name),
        kind: 'directory' as const,
        size: 0,
      }));
      for (const entry of listing.files) {
        rows.push({
          name: entry.file.name,
          path: entry.path,
          kind: isAudioName(entry.file.name) ? 'audio' : 'file',
          size: entry.file.size,
          file: entry.file,
        });
      }
      return rows;
    }

    let directory = source.handle;
    try {
      for (const segment of pathSegments(this.path)) directory = await directory.getDirectoryHandle(segment);
    } catch {
      this.options.notify('That folder is no longer available');
      this.path = '';
      return [];
    }

    const rows: Row[] = [];
    const entries = (directory as FileSystemDirectoryHandle & {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries;

    if (entries) {
      for await (const [name, child] of entries.call(directory)) {
        if (child.kind === 'directory') {
          rows.push({
            name,
            path: joinPath(this.path, name),
            kind: 'directory',
            size: 0,
            directory: child as FileSystemDirectoryHandle,
          });
        } else {
          rows.push({
            name,
            path: joinPath(this.path, name),
            kind: isAudioName(name) ? 'audio' : 'file',
            size: 0,
            handle: child as FileSystemFileHandle,
          });
        }
      }
    } else {
      for await (const child of directory.values()) {
        const name = child.name;
        if (child.kind === 'directory') {
          rows.push({
            name,
            path: joinPath(this.path, name),
            kind: 'directory',
            size: 0,
            directory: child as FileSystemDirectoryHandle,
          });
        } else {
          rows.push({
            name,
            path: joinPath(this.path, name),
            kind: isAudioName(name) ? 'audio' : 'file',
            size: 0,
            handle: child as FileSystemFileHandle,
          });
        }
      }
    }

    return rows;
  }

  private async render(): Promise<void> {
    const token = (this.loadToken += 1);
    this.renderCrumbs();
    this.renderPool();

    this.list.replaceChildren();
    if (!this.source) {
      this.status.textContent = 'Open a folder, or drag one in from your desktop.';
      this.status.hidden = false;
      return;
    }

    this.status.hidden = false;
    this.status.textContent = 'Reading folder…';

    const rows = await this.listPath();
    if (token !== this.loadToken) return;

    this.rows = rows;
    if (this.path) this.upButton.disabled = false;
    else this.upButton.disabled = true;

    this.renderRows();
  }

  private renderRows(): void {
    this.list.replaceChildren();
    if (!this.source) {
      this.importAllButton.disabled = true;
      return;
    }

    const visible = sortEntries(
      filterEntries(this.rows, this.query).filter(
        (row) => row.kind === 'directory' || !this.audioOnly || row.kind === 'audio',
      ),
    );

    if (visible.length === 0) {
      this.status.textContent = this.query
        ? `Nothing matches “${this.query}” here.`
        : this.audioOnly
          ? 'No folders or audio files in this folder.'
          : 'This folder is empty.';
      this.status.hidden = false;
      return;
    }

    this.status.hidden = true;
    this.importAllButton.disabled = !visible.some((row) => row.kind === 'audio');
    for (const row of visible) this.list.appendChild(this.rowElement(row));
  }

  /** Every audio file in the listed folder, read into File objects. */
  private async audioFilesHere(): Promise<File[]> {
    const files: File[] = [];
    for (const row of this.rows) {
      if (row.kind !== 'audio') continue;
      if (row.file) {
        files.push(row.file);
        continue;
      }
      if (row.handle) {
        try {
          files.push(await row.handle.getFile());
        } catch {
          // A file removed or made unreadable since the listing is skipped.
        }
      }
    }
    return files;
  }

  /** Imports the whole open folder in one action. */
  private async importAll(): Promise<void> {
    const files = await this.audioFilesHere();
    if (files.length === 0) {
      this.options.notify('No audio files in this folder to import');
      return;
    }
    await this.options.onImportAll?.(files);
  }

  private renderCrumbs(): void {
    this.crumbs.replaceChildren();

    if (!this.source) {
      this.crumbs.append(el('span', 'explorer-crumb is-current', 'No folder open'));
      return;
    }

    const rootButton = el('button', 'explorer-crumb', this.source.name);
    rootButton.type = 'button';
    rootButton.title = 'Back to the top of this folder';
    rootButton.addEventListener('click', () => this.goTo(''));
    this.crumbs.appendChild(rootButton);

    let walked = '';
    for (const segment of pathSegments(this.path)) {
      walked = joinPath(walked, segment);
      const target = walked;
      this.crumbs.append(el('span', 'explorer-sep', '/'));
      const button = el('button', 'explorer-crumb', segment);
      button.type = 'button';
      button.addEventListener('click', () => this.goTo(target));
      this.crumbs.appendChild(button);
    }
  }

  private renderPinned(): void {
    this.pinned.replaceChildren();
    if (this.folders.length === 0) {
      this.pinned.hidden = true;
      return;
    }

    this.pinned.hidden = false;
    for (const handle of this.folders) {
      const chip = el('button', 'explorer-chip', handle.name);
      chip.type = 'button';
      chip.title = `Open ${handle.name}`;
      chip.addEventListener('click', () => this.openSaved(handle));
      this.pinned.appendChild(chip);
    }
  }

  private renderPool(): void {
    this.pool.replaceChildren();
    const assets = [...this.options.assets()].sort((a, b) => a.name.localeCompare(b.name));
    if (assets.length === 0) {
      this.pool.append(el('div', 'explorer-empty', 'Imported and recorded audio lands here.'));
      return;
    }

    for (const asset of assets) {
      const row = el('div', 'explorer-row is-audio is-pool');
      row.draggable = true;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `${asset.name}, session audio`);
      row.dataset.assetId = asset.id;
      row.title = `${asset.name} — drag to a track, double-click to insert at the playhead`;

      const icon = el('span', 'explorer-icon', '♪');
      const name = el('span', 'explorer-name', asset.name);
      const meta = el('span', 'explorer-meta', formatDuration(asset.duration));

      const audition = el('button', 'explorer-row-action', '▶');
      audition.type = 'button';
      audition.title = 'Audition in the preview';
      audition.addEventListener('click', (event) => {
        event.stopPropagation();
        this.options.onAuditionAsset(asset.id);
      });

      row.append(icon, name, meta, audition);
      row.addEventListener('dblclick', () => this.options.onInsertAsset(asset.id));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') this.options.onInsertAsset(asset.id);
      });
      row.addEventListener('dragstart', (event) => {
        const token = beginDrag({ kind: 'asset', assetId: asset.id, name: asset.name });
        event.dataTransfer?.setData('application/x-toneart-drag', token);
        event.dataTransfer?.setData('text/plain', asset.name);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('is-dragging'));

      this.pool.appendChild(row);
    }
  }

  private rowElement(row: Row): HTMLElement {
    const item = el('div', `explorer-row is-${row.kind}`);
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', row.kind === 'directory' ? `${row.name}, folder` : `${row.name}, ${row.kind} file`);
    item.dataset.path = row.path;
    row.element = item;

    const icon = el('span', 'explorer-icon', row.kind === 'directory' ? '▸' : row.kind === 'audio' ? '♪' : '·');
    const name = el('span', 'explorer-name', row.name);
    const meta = el('span', 'explorer-meta', row.kind === 'directory' ? '' : formatSize(row.size));
    item.append(icon, name, meta);

    if (row.kind === 'directory') {
      item.title = `${row.name} — open folder`;
      item.addEventListener('click', () => this.goTo(row.path));
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === 'ArrowRight') this.goTo(row.path);
      });
      return item;
    }

    if (row.kind === 'audio') {
      item.draggable = Boolean(row.file);
      item.title = `${row.name} — drag to a track, double-click to insert at the playhead`;

      const audition = el('button', 'explorer-row-action', '▶');
      audition.type = 'button';
      audition.title = 'Audition in the preview';
      audition.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.withFile(row, (file) => this.options.onAuditionFile(file));
      });
      item.appendChild(audition);

      item.addEventListener('dblclick', () => {
        void this.withFile(row, (file) => this.options.onInsertFile(file));
      });
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void this.withFile(row, (file) => this.options.onInsertFile(file));
      });
      item.addEventListener('dragstart', (event) => {
        if (!row.file) {
          event.preventDefault();
          return;
        }
        const token = beginDrag({ kind: 'file', file: row.file, name: row.name });
        event.dataTransfer?.setData('application/x-toneart-drag', token);
        event.dataTransfer?.setData('text/plain', row.name);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        item.classList.add('is-dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('is-dragging'));

      void this.hydrate(row, meta);
      return item;
    }

    item.classList.add('is-muted');
    item.title = `${row.name} — not audio`;
    return item;
  }

  /** Fills in size and duration, and makes a handle-backed row draggable. */
  private async hydrate(row: Row, meta: HTMLElement): Promise<void> {
    if (!row.file && row.handle) {
      try {
        row.file = await row.handle.getFile();
      } catch {
        return;
      }
    }
    if (!row.file) return;

    row.size = row.file.size;
    if (row.element) row.element.draggable = true;

    const seconds = await this.durationOf(row.file);
    const parts = [formatDuration(seconds), formatSize(row.file.size)].filter(Boolean);
    meta.textContent = parts.join(' · ');
  }

  private durationOf(file: File): Promise<number> {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    const cached = this.durations.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    // Tests and very old browsers do not implement object URLs.
    if (typeof URL.createObjectURL !== 'function') return Promise.resolve(0);

    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement('audio');
      audio.preload = 'metadata';

      const done = (value: number): void => {
        URL.revokeObjectURL(url);
        audio.removeAttribute('src');
        this.durations.set(key, value);
        resolve(value);
      };

      audio.addEventListener('loadedmetadata', () => done(Number.isFinite(audio.duration) ? audio.duration : 0));
      audio.addEventListener('error', () => done(0));
      audio.src = url;
    });
  }

  private async withFile(row: Row, use: (file: File) => void): Promise<void> {
    if (!row.file && row.handle) {
      try {
        row.file = await row.handle.getFile();
      } catch {
        this.options.notify('That file could not be read');
        return;
      }
    }
    if (row.file) use(row.file);
  }

  // ------------------------------------------------------------------ drops

  private bindDrop(): void {
    this.root.addEventListener('dragover', (event) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      this.root.classList.add('is-drop');
    });

    const clear = (): void => this.root.classList.remove('is-drop');
    this.root.addEventListener('dragleave', (event) => {
      if (event.target === this.root) clear();
    });
    this.root.addEventListener('dragend', clear);

    this.root.addEventListener('drop', (event) => {
      const transfer = event.dataTransfer;
      if (!transfer) return;
      event.preventDefault();
      clear();

      // A row dragged back onto the explorer is a cancelled drag, not an import.
      if (Array.from(transfer.types).includes(FILE_DRAG_MIME)) {
        const token = transfer.getData(FILE_DRAG_MIME);
        if (token) takeDrag(token);
        return;
      }

      void this.useDrop(transfer);
    });
  }

  private async useDrop(transfer: DataTransfer): Promise<void> {
    const files = await filesFromDrop(transfer);
    if (files.length === 0) {
      this.options.notify('Nothing playable was dropped');
      return;
    }
    const audio = files.filter((entry) => isAudioName(entry.file.name));
    if (audio.length === 0) {
      this.options.notify('No audio files in that drop');
      return;
    }
    const rootName = files[0]?.path.includes('/') ? pathSegments(files[0].path)[0] : 'Dropped audio';
    this.useList(rootName, files);
  }
}
