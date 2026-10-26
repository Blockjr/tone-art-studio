// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  ProjectFileError,
  clearAutosave,
  loadPreferences,
  loadRecentProjects,
  normalizeProjectName,
  parseProject,
  projectFileName,
  projectNameFromFile,
  readAutosave,
  rememberRecent,
  savePreferences,
  serializeProject,
  writeAutosave,
} from '../src/core/session';
import { blankProject, demoProject } from '../src/core/project';
import {
  decodeAudioAsset,
  encodeAudioAsset,
  encodeProjectAssets,
  encodedAssetBytes,
  formatBytes,
  projectAssetIds,
} from '../src/audio/assets';
import { FileMenu, StartScreen } from '../src/ui/files';
import { saveProjectDocument } from '../src/ui/fileio';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('project files', () => {
  it('round-trips a project through the document envelope', () => {
    const project = demoProject();
    project.name = 'Night Drive';
    const text = serializeProject(project);

    expect(text).toContain('"format": "hybrid-studio-project"');
    expect(text).toContain('"version": 1');

    const parsed = parseProject(text);
    expect(parsed.project.name).toBe('Night Drive');
    expect(parsed.project.tracks).toHaveLength(project.tracks.length);
    expect(parsed.project.clips).toHaveLength(project.clips.length);
    expect(parsed.project.markers.map((marker) => marker.name)).toEqual(['Intro', 'Verse', 'Chorus', 'Bridge']);
    expect(parsed.project.markers.map((marker) => marker.beat)).toEqual([0, 8, 16, 24]);
    expect(parsed.project.master.devices.length).toBe(project.master.devices.length);
    expect(parsed.legacy).toBe(false);
    expect(Number.isNaN(Date.parse(parsed.savedAt))).toBe(false);
  });

  it('accepts a bare project object from an older build', () => {
    const project = demoProject();
    const parsed = parseProject(JSON.stringify(project));
    expect(parsed.legacy).toBe(true);
    expect(parsed.project.tracks).toHaveLength(4);
  });

  it('adds an empty marker list to projects saved before locators existed', () => {
    const legacy = { ...demoProject() };
    delete (legacy as { markers?: unknown }).markers;

    const parsed = parseProject(JSON.stringify(legacy));
    expect(parsed.project.markers).toEqual([]);
  });

  it('carries an old reverb length from size into the decay knob', () => {
    const project = demoProject();
    const legacy = {
      ...project,
      master: {
        ...project.master,
        devices: [
          {
            id: 'legacy-reverb',
            type: 'reverb',
            enabled: true,
            collapsed: false,
            params: { size: 3.4, preDelay: 0.01, mix: 1 },
          },
        ],
      },
    };

    const parsed = parseProject(JSON.stringify(legacy));
    const device = parsed.project.master.devices[0];
    expect(device.params.decay).toBeCloseTo(3.4, 5);
    expect(device.params.size).toBeUndefined();
    expect(device.params.preDelay).toBe(0.01);
  });

  it('rejects files that are not projects', () => {
    expect(() => parseProject('{ not json')).toThrow(ProjectFileError);
    expect(() => parseProject('{"hello":"world"}')).toThrow(/not a Tone Art Studio project/);
    expect(() => parseProject('null')).toThrow(ProjectFileError);
  });

  it('builds safe file names and reads them back', () => {
    expect(normalizeProjectName('  My / Song  ')).toBe('My Song');
    expect(normalizeProjectName('   ')).toBe('Untitled');
    expect(projectFileName('Night Drive')).toBe('Night-Drive.hstudio');
    expect(projectNameFromFile('Night-Drive.hstudio')).toBe('Night Drive');
    expect(projectNameFromFile('no-extension')).toBe('no extension');
  });

  it('gives a new project four playable tracks and no clips', () => {
    const project = blankProject('Fresh', 96, 8);
    expect(project.name).toBe('Fresh');
    expect(project.bpm).toBe(96);
    expect(project.tracks).toHaveLength(4);
    expect(project.clips).toHaveLength(0);
    expect(project.length).toBe(32);
    expect(project.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2);
    expect(project.tracks.filter((t) => t.kind === 'midi')).toHaveLength(2);
  });

  it('writes into an existing file handle without asking again', async () => {
    let written = '';
    const handle = {
      name: 'Night-Drive.hstudio',
      createWritable: async () => ({
        write: async (blob: Blob) => {
          written = await blob.text();
        },
        close: async () => {},
      }),
      getFile: async () => new File([written], 'Night-Drive.hstudio'),
    };
    const picker = vi.fn(async () => handle);
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = picker;

    const first = await saveProjectDocument(serializeProject(demoProject()), 'Night Drive');
    expect(first?.name).toBe('Night Drive');
    expect(first?.fileName).toBe('Night-Drive.hstudio');
    expect(written).toContain('hybrid-studio-project');

    const second = await saveProjectDocument(serializeProject(demoProject()), 'Night Drive');
    expect(second).not.toBeNull();
    // The second save writes back to the same handle instead of re-prompting.
    expect(picker).toHaveBeenCalledTimes(1);

    await saveProjectDocument(serializeProject(demoProject()), 'Night Drive', { saveAs: true });
    expect(picker).toHaveBeenCalledTimes(2);

    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  it('remembers recent sessions, newest first and capped', () => {
    for (let i = 0; i < 9; i++) {
      rememberRecent({
        name: `Session ${i}`,
        savedAt: new Date(2026, 0, i + 1).toISOString(),
        bpm: 120,
        tracks: 4,
        data: serializeProject(demoProject()),
      });
    }

    const recents = loadRecentProjects();
    expect(recents).toHaveLength(6);
    expect(recents[0].name).toBe('Session 8');

    rememberRecent({
      name: 'Session 8',
      savedAt: new Date().toISOString(),
      bpm: 90,
      tracks: 3,
      data: '{}',
    });
    const refreshed = loadRecentProjects();
    expect(refreshed).toHaveLength(6);
    expect(refreshed[0].bpm).toBe(90);
    expect(refreshed.filter((entry) => entry.name === 'Session 8')).toHaveLength(1);
  });

  it('keeps preferences and the autosave snapshot in storage', () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);

    savePreferences({ showStartup: false, scanVst3OnStart: true, autosave: true, follow: 'center' });
    expect(loadPreferences()).toMatchObject({ showStartup: false, scanVst3OnStart: true, follow: 'center' });

    const project = demoProject();
    project.name = 'Autosaved';
    expect(writeAutosave(project)).toBe(true);

    const snapshot = readAutosave();
    expect(snapshot?.name).toBe('Autosaved');
    expect(snapshot ? parseProject(snapshot.data).project.tracks : []).toHaveLength(4);

    clearAutosave();
    expect(readAutosave()).toBeNull();
  });
});

describe('embedded audio', () => {
  const frames = 2048;

  const makeAsset = () => {
    const data = new Float32Array(frames);
    for (let i = 0; i < frames; i++) data[i] = Math.sin((i / frames) * Math.PI * 6) * 0.5;
    const buffer = {
      numberOfChannels: 1,
      length: frames,
      sampleRate: 48000,
      duration: frames / 48000,
      getChannelData: () => data,
    } as unknown as AudioBuffer;
    return {
      id: 'asset-demo',
      name: 'loop.wav',
      buffer,
      duration: frames / 48000,
      peaks: [0.5, -0.5],
    };
  };

  const makeContext = () => ({
    createBuffer(channels: number, length: number, sampleRate: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (channel: number) => data[channel],
      } as unknown as AudioBuffer;
    },
  });

  it('round-trips samples through the encoded asset', () => {
    const asset = makeAsset();
    const encoded = encodeAudioAsset(asset);
    expect(encoded.channels).toBe(1);
    expect(encoded.sampleRate).toBe(48000);
    expect(encoded.data.length).toBeGreaterThan(100);

    const decoded = decodeAudioAsset(encoded, makeContext());
    expect(decoded.name).toBe('loop.wav');
    expect(decoded.buffer.length).toBe(frames);

    const original = asset.buffer.getChannelData(0);
    const restored = decoded.buffer.getChannelData(0);
    let worst = 0;
    for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(original[i] - restored[i]));
    // 16-bit quantisation: under one least-significant bit of error.
    expect(worst).toBeLessThan(1 / 32000);
  });

  it('embeds only the assets the arrangement uses', () => {
    const asset = makeAsset();
    const project = demoProject();
    project.clips[0].assetId = asset.id;
    project.clips[0].kind = 'audio';

    const spare = { ...makeAsset(), id: 'asset-unused' };
    const assets = new Map([
      [asset.id, asset],
      [spare.id, spare],
    ]);

    expect(projectAssetIds(project)).toEqual([asset.id]);
    const embedded = encodeProjectAssets(project, assets);
    expect(embedded).toHaveLength(1);
    expect(embedded[0].id).toBe(asset.id);

    const text = serializeProject(project, { assets: embedded });
    const parsed = parseProject(text);
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets[0].name).toBe('loop.wav');
    expect(parsed.project.clips[0].assetId).toBe(asset.id);

    const decoded = decodeAudioAsset(parsed.assets[0], makeContext());
    expect(decoded.peaks).toEqual([0.5, -0.5]);
    expect(encodedAssetBytes(embedded)).toBeGreaterThan(1000);
    expect(formatBytes(2048)).toBe('2 kB');
  });

  it('writes no assets block for a MIDI-only project', () => {
    const text = serializeProject(demoProject(), { assets: [] });
    expect(text).not.toContain('"assets"');
    expect(parseProject(text).assets).toEqual([]);
  });

  it('ignores malformed embedded audio instead of failing the file', () => {
    const project = demoProject();
    const text = JSON.stringify({
      format: 'hybrid-studio-project',
      version: 1,
      name: 'Test',
      savedAt: new Date().toISOString(),
      project,
      assets: [{ id: 'broken' }, { id: 'ok', name: 'a.wav', data: 'AAAA', sampleRate: 48000, channels: 1 }],
    });

    const parsed = parseProject(text);
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets[0].id).toBe('ok');
  });
});

describe('file menu', () => {
  it('lists the project commands and closes after one runs', () => {
    const actions = {
      onNew: vi.fn(),
      onOpen: vi.fn(),
      onSave: vi.fn(),
      onSaveAs: vi.fn(),
      onExport: vi.fn(),
      onStartScreen: vi.fn(),
    };
    const menu = new FileMenu(actions);

    expect(menu.element.textContent).toContain('File');
    expect(menu.isOpen).toBe(false);

    menu.show();
    expect(menu.isOpen).toBe(true);
    expect(menu.element.getAttribute('aria-expanded')).toBe('true');

    const items = [...document.querySelectorAll<HTMLButtonElement>('.file-menu-item')];
    const labels = items.map((item) => item.querySelector('.file-menu-label')?.textContent);
    expect(labels).toEqual([
      'New project…',
      'Open project…',
      'Save',
      'Save as…',
      'Export WAV mixdown…',
      'Start screen',
    ]);
    expect(items[2].textContent).toContain('Ctrl S');

    items[3].click();
    expect(actions.onSaveAs).toHaveBeenCalledOnce();
    expect(menu.isOpen).toBe(false);

    menu.show();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.isOpen).toBe(false);
  });
});

describe('start screen', () => {
  const build = (overrides: Partial<ConstructorParameters<typeof StartScreen>[0]> = {}) => {
    const calls = {
      onCreate: vi.fn(),
      onDemo: vi.fn(),
      onOpen: vi.fn(),
      onResume: vi.fn(),
      onRecent: vi.fn(),
      onPreferences: vi.fn(),
      onDismiss: vi.fn(),
    };

    const screen = new StartScreen({
      preferences: { ...DEFAULT_PREFERENCES, follow: 'page' },
      recents: [],
      nativeHost: false,
      resumeName: null,
      ...calls,
      ...overrides,
    });

    return { screen, calls };
  };

  it('creates a project with the filled-in name, tempo and length', () => {
    const { screen, calls } = build();
    screen.open();

    expect(screen.isOpen).toBe(true);
    const name = document.querySelector('.start-input') as HTMLInputElement;
    name.value = 'Neon Nights';
    const numbers = [...document.querySelectorAll<HTMLInputElement>('.start-input-num')];
    numbers[0].value = '92';
    numbers[1].value = '64';

    (document.getElementById('start-create') as HTMLButtonElement).click();

    expect(calls.onCreate).toHaveBeenCalledWith({ name: 'Neon Nights', bpm: 92, bars: 64 });
    expect(screen.isOpen).toBe(false);
    expect(document.querySelector('.start-screen')).toBeNull();
  });

  it('lists recent sessions and reopens one by id', () => {
    const { screen, calls } = build({
      recents: [
        {
          id: 'recent-a',
          name: 'Night Drive',
          savedAt: new Date().toISOString(),
          bpm: 124,
          tracks: 4,
          data: serializeProject(demoProject()),
        },
      ],
      resumeName: 'Autosaved take',
    });
    screen.open();

    const resume = document.getElementById('start-resume') as HTMLButtonElement;
    expect(resume.textContent).toContain('Autosaved take');

    const recent = document.querySelector('.start-recent') as HTMLButtonElement;
    expect(recent.textContent).toContain('Night Drive');
    expect(recent.textContent).toContain('4 tracks');
    recent.click();
    expect(calls.onRecent).toHaveBeenCalledWith('recent-a');
    expect(screen.isOpen).toBe(false);
  });

  it('records the startup preferences the user picks', () => {
    const { screen, calls } = build();
    screen.open();

    const startup = document.getElementById('pref-startup') as HTMLInputElement;
    expect(startup.checked).toBe(true);
    startup.checked = false;
    startup.dispatchEvent(new Event('change', { bubbles: true }));
    expect(calls.onPreferences).toHaveBeenCalledWith(expect.objectContaining({ showStartup: false }));

    const scan = document.getElementById('pref-scan-vst3') as HTMLInputElement;
    expect(scan.checked).toBe(false);
    expect(scan.disabled).toBe(true); // no native host in the browser build
  });

  it('offers VST3 scanning when the native host is present', () => {
    const { screen, calls } = build({ nativeHost: true });
    screen.open();

    const scan = document.getElementById('pref-scan-vst3') as HTMLInputElement;
    expect(scan.disabled).toBe(false);
    scan.checked = true;
    scan.dispatchEvent(new Event('change', { bubbles: true }));
    expect(calls.onPreferences).toHaveBeenCalledWith(expect.objectContaining({ scanVst3OnStart: true }));
  });

  it('enters the studio without changing the session', () => {
    const { screen, calls } = build();
    screen.open();

    (document.getElementById('start-enter') as HTMLButtonElement).click();
    expect(calls.onDismiss).toHaveBeenCalledOnce();
    expect(calls.onCreate).not.toHaveBeenCalled();
    expect(document.querySelector('.start-screen')).toBeNull();
  });
});
