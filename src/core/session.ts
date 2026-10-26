import type { SerializedAsset } from '../audio/assets';
import { DEFAULT_METRONOME_SETTINGS, normalizeMetronomeSettings, type MetronomeSettings } from '../audio/metronome';
import { readLayout, type LayoutState } from './layout';
import { normalizeFollow, normalizeMarkers, type FollowMode } from './playhead';
import { normalizeTakes } from './takes';
import type { Project } from './types';

/**
 * The project file is plain JSON: a small, versioned envelope around the
 * project. Audio buffers are not embedded - imported audio lives in the
 * session only - so a document can always be read back, and unknown future
 * fields are preserved by validating only what we need.
 */
export const PROJECT_FORMAT = 'hybrid-studio-project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.hstudio';

export interface ProjectDocument {
  format: typeof PROJECT_FORMAT;
  version: number;
  name: string;
  savedAt: string;
  project: Project;
  /** imported audio used by the arrangement, embedded in the file */
  assets?: SerializedAsset[];
}

export interface ParsedProject {
  project: Project;
  savedAt: string;
  /** true when the file came from an older/raw format */
  legacy: boolean;
  assets: SerializedAsset[];
}

export class ProjectFileError extends Error {}

/** Strips characters that a file system will not accept in a name. */
export function normalizeProjectName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 64) || 'Untitled';
}

export function projectFileName(name: string): string {
  const base = normalizeProjectName(name).replace(/\s/g, '-');
  return `${base}${PROJECT_EXTENSION}`;
}

/** Drops the extension and the dashes a previous save may have added. */
export function projectNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return normalizeProjectName(base);
}

export interface SerializeOptions {
  savedAt?: Date;
  /** embedded audio; omitted for browser snapshots that have a size limit */
  assets?: SerializedAsset[];
}

export function serializeProject(project: Project, options: SerializeOptions = {}): string {
  const savedAt = options.savedAt ?? new Date();
  const document: ProjectDocument = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: normalizeProjectName(project.name),
    savedAt: savedAt.toISOString(),
    project,
  };
  if (options.assets && options.assets.length > 0) document.assets = options.assets;
  return JSON.stringify(document, null, 2);
}

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Project>;
  return (
    Array.isArray(candidate.tracks) &&
    Array.isArray(candidate.clips) &&
    typeof candidate.bpm === 'number' &&
    typeof candidate.name === 'string' &&
    !!candidate.master &&
    Array.isArray(candidate.returns)
  );
}

/** Fills fields that older project files did not carry yet. */
function normalizeLoadedProject(project: Project): Project {
  project.markers = normalizeMarkers(project.markers, project.length);
  project.takes = normalizeTakes(project.takes, project.tracks);
  migrateDevices(project);
  return project;
}

/**
 * Older sessions stored a reverb length in seconds under `size`. The reverb now
 * has a real RT60 decay knob plus a separate space control, so carry the old
 * value across instead of silently resetting every saved tail to the default.
 */
function migrateDevices(project: Project): void {
  const devices = [
    ...project.tracks.flatMap((track) => track.devices ?? []),
    ...(project.master.devices ?? []),
    ...project.returns.flatMap((bus) => bus.devices ?? []),
  ];
  for (const device of devices) {
    if (device.type !== 'reverb' || !device.params) continue;
    const legacy = device.params.size;
    if (device.params.decay === undefined && typeof legacy === 'number' && Number.isFinite(legacy)) {
      device.params.decay = Math.max(0.4, Math.min(12, legacy));
    }
    delete device.params.size;
  }
}

/**
 * Reads a saved project. Accepts the current envelope, an envelope from a
 * future version (as long as it still holds a project) and a bare project
 * object, so nothing a user saved becomes unreadable.
 */
export function parseProject(text: string): ParsedProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFileError('That file is not valid JSON.');
  }

  if (!raw || typeof raw !== 'object') throw new ProjectFileError('That file does not contain a project.');

  const envelope = raw as Partial<ProjectDocument> & { project?: unknown; savedAt?: string };

  if (isProject(envelope.project)) {
    const project = normalizeLoadedProject(envelope.project);
    if (envelope.name) project.name = normalizeProjectName(envelope.name);
    return {
      project,
      savedAt: typeof envelope.savedAt === 'string' ? envelope.savedAt : new Date().toISOString(),
      legacy: envelope.format !== PROJECT_FORMAT,
      assets: readAssets(envelope.assets),
    };
  }

  if (isProject(raw)) {
    return { project: normalizeLoadedProject(raw), savedAt: new Date().toISOString(), legacy: true, assets: [] };
  }

  throw new ProjectFileError('That file is not a Tone Art Studio project.');
}

/** Keeps well-formed embedded audio and ignores anything else in the file. */
function readAssets(value: unknown): SerializedAsset[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is SerializedAsset => {
    if (!entry || typeof entry !== 'object') return false;
    const asset = entry as Partial<SerializedAsset>;
    return (
      typeof asset.id === 'string' &&
      typeof asset.name === 'string' &&
      typeof asset.data === 'string' &&
      asset.data.length > 0 &&
      typeof asset.sampleRate === 'number' &&
      typeof asset.channels === 'number'
    );
  });
}

// ------------------------------------------------------------------ storage

const KEYS = {
  prefs: 'hybrid.prefs',
  recent: 'hybrid.recent',
  autosave: 'hybrid.autosave',
} as const;

function storage(): Storage | null {
  try {
    const probe = '__hybrid_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota or private-mode failure: the session still works, it just cannot
    // remember itself. Never let storage break saving.
    return false;
  }
}

export interface Preferences {
  /** show the project start screen on launch */
  showStartup: boolean;
  /** ask the native host to scan the VST3 folders once at launch */
  scanVst3OnStart: boolean;
  /** input device used by the recording engine */
  recordDeviceId?: string;
  /** monitor the input while recording */
  monitorInput?: boolean;
  /** keep a session snapshot in this browser so a reload never loses work */
  autosave: boolean;
  /** workspace panel sizes, so a second monitor keeps its arrangement */
  layout?: LayoutState;
  /** how the arrangement scrolls while the transport rolls */
  follow: FollowMode;
  /** click, count-in and metronome sound settings */
  metronome?: MetronomeSettings;
}

export const DEFAULT_PREFERENCES: Preferences = {
  showStartup: true,
  scanVst3OnStart: false,
  recordDeviceId: '',
  monitorInput: false,
  autosave: true,
  follow: 'page',
  metronome: { ...DEFAULT_METRONOME_SETTINGS },
};

export function loadPreferences(): Preferences {
  const stored = readJson<Partial<Preferences>>(KEYS.prefs);
  const merged = { ...DEFAULT_PREFERENCES, ...(stored ?? {}) };
  const layout = readLayout(merged.layout);
  if (layout) merged.layout = layout;
  else delete merged.layout;
  merged.follow = normalizeFollow(merged.follow);
  merged.metronome = normalizeMetronomeSettings(merged.metronome);
  return merged;
}

export function savePreferences(preferences: Preferences): void {
  writeJson(KEYS.prefs, preferences);
}

export interface RecentProject {
  id: string;
  name: string;
  savedAt: string;
  bpm: number;
  tracks: number;
  /** the saved document, so a recent entry can be reopened without the file */
  data: string;
}

const RECENT_LIMIT = 6;

export function loadRecentProjects(): RecentProject[] {
  const stored = readJson<RecentProject[]>(KEYS.recent);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.data === 'string')
    .slice(0, RECENT_LIMIT);
}

/** Adds or refreshes a recent entry, newest first, and trims the list. */
export function rememberRecent(entry: Omit<RecentProject, 'id'> & { id?: string }): RecentProject[] {
  const id = entry.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const next: RecentProject = { ...entry, id };
  const existing = loadRecentProjects().filter((item) => item.name !== next.name && item.id !== id);
  const list = [next, ...existing].slice(0, RECENT_LIMIT);
  writeJson(KEYS.recent, list);
  return list;
}

export function forgetRecent(id: string): RecentProject[] {
  const list = loadRecentProjects().filter((item) => item.id !== id);
  writeJson(KEYS.recent, list);
  return list;
}

export interface AutosaveSnapshot {
  name: string;
  savedAt: string;
  data: string;
}

export function writeAutosave(project: Project, savedAt = new Date()): boolean {
  return writeJson(KEYS.autosave, {
    name: normalizeProjectName(project.name),
    savedAt: savedAt.toISOString(),
    data: serializeProject(project, { savedAt }),
  } satisfies AutosaveSnapshot);
}

export function readAutosave(): AutosaveSnapshot | null {
  const stored = readJson<AutosaveSnapshot>(KEYS.autosave);
  if (!stored || typeof stored.data !== 'string') return null;
  return stored;
}

export function clearAutosave(): void {
  try {
    storage()?.removeItem(KEYS.autosave);
  } catch {
    // ignore
  }
}
