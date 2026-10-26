/**
 * Pure helpers behind the file explorer.
 *
 * Everything here is DOM-free except the File objects themselves, so the
 * listing, sorting and drag-payload rules can be tested without a browser.
 */

export const AUDIO_EXTENSIONS = [
  'wav',
  'wave',
  'mp3',
  'flac',
  'aif',
  'aiff',
  'aifc',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'aac',
  'webm',
  'caf',
] as const;

const AUDIO_SET = new Set<string>(AUDIO_EXTENSIONS);

export type EntryKind = 'directory' | 'audio' | 'file';

export interface BrowseEntry {
  name: string;
  /** path relative to the opened folder, '/' separated */
  path: string;
  kind: EntryKind;
  size: number;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isAudioName(name: string): boolean {
  return AUDIO_SET.has(extensionOf(name));
}

/** Folders first, then names in the order a person would read them. */
export function sortEntries<T extends { name: string; kind: EntryKind }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const aFolder = a.kind === 'directory';
    const bFolder = b.kind === 'directory';
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

export function filterEntries<T extends { name: string }>(entries: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

export function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function parentPath(path: string): string {
  const parts = pathSegments(path);
  parts.pop();
  return parts.join('/');
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Durations in the explorer read like a transport clock, not a decimal. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const rounded = Math.round(seconds * 10) / 10;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded - minutes * 60;
  return minutes > 0 ? `${minutes}:${rest.toFixed(1).padStart(4, '0')}` : `${rest.toFixed(1)}s`;
}

/** A file with the folder path it sits under, as drag and drop reports it. */
export interface NamedFile {
  file: File;
  path: string;
}

export type DirectoryListing = {
  directories: string[];
  files: NamedFile[];
};

/**
 * Lists one folder of a set of named files.
 *
 * A folder picker hands over a flat list where each file carries its relative
 * path, so the tree is rebuilt on demand instead of copying it up front: a
 * 5 000-file sample library stays one array and costs nothing per navigation.
 */
export function listingFromFiles(files: NamedFile[], path = ''): DirectoryListing {
  const prefix = path ? `${path}/` : '';
  const directories = new Set<string>();
  const entries: NamedFile[] = [];

  for (const entry of files) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) entries.push(entry);
    else directories.add(rest.slice(0, slash));
  }

  entries.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' }));

  return {
    directories: [...directories].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    ),
    files: entries,
  };
}

/** Reads the relative path a directory input puts on each file. */
export function namedFilesFromInput(files: ArrayLike<File>): NamedFile[] {
  const out: NamedFile[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    out.push({ file, path: relative && relative.length > 0 ? relative : file.name });
  }
  return out;
}

// ---------------------------------------------------------------- drag payloads

export const FILE_DRAG_MIME = 'application/x-toneart-drag';

/**
 * What a drag started in the explorer is carrying. Files cannot be put in a
 * DataTransfer outside the drop event, so the drag carries a short token and
 * the payload waits here until the drop claims it.
 */
export type DragPayload =
  | { kind: 'file'; file: File; name: string }
  | { kind: 'asset'; assetId: string; name: string };

const payloads = new Map<string, DragPayload>();
let sequence = 0;

export function beginDrag(payload: DragPayload): string {
  const token = `toneart-${Date.now().toString(36)}-${(sequence += 1).toString(36)}`;
  payloads.set(token, payload);
  // A drag that is cancelled never reaches its drop, so keep the map bounded.
  while (payloads.size > 24) {
    const oldest = payloads.keys().next().value;
    if (oldest === undefined) break;
    payloads.delete(oldest);
  }
  return token;
}

export function takeDrag(token: string): DragPayload | null {
  const payload = payloads.get(token) ?? null;
  if (payload) payloads.delete(token);
  return payload;
}

export function pendingDrags(): number {
  return payloads.size;
}
