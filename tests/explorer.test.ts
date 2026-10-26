// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { FileExplorer } from '../src/ui/explorer';

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const wav = (name: string, size = 2048): File => new File([new Uint8Array(size)], name);

/** A stand-in for FileSystemDirectoryHandle with the parts the explorer uses. */
function directory(name: string, children: Record<string, unknown>): unknown {
  return {
    kind: 'directory',
    name,
    entries: async function* entries() {
      for (const [key, value] of Object.entries(children)) yield [key, value];
    },
    getDirectoryHandle: async (segment: string) => {
      const child = children[segment];
      if (!child) throw new Error(`missing folder ${segment}`);
      return child;
    },
  };
}

function file(name: string, handleFile: File): unknown {
  return {
    kind: 'file',
    name,
    getFile: async () => handleFile,
  };
}

function mountExplorer() {
  document.body.innerHTML = '';
  const onAuditionFile = vi.fn();
  const onInsertFile = vi.fn();
  const onAuditionAsset = vi.fn();
  const onInsertAsset = vi.fn();
  const notify = vi.fn();

  const explorer = new FileExplorer({
    onAuditionFile,
    onInsertFile,
    onAuditionAsset,
    onInsertAsset,
    assets: () => [{ id: 'asset-1', name: 'Take 1', duration: 4.2 }],
    notify,
  });

  const host = document.createElement('div');
  document.body.appendChild(host);
  explorer.mount(host);
  return { explorer, host, onAuditionFile, onInsertFile, onAuditionAsset, onInsertAsset, notify };
}

const rows = (selector = '.explorer-row'): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(`.explorer-list ${selector}`),
];

describe('file explorer', () => {
  it('opens a folder, walks into it and back out', async () => {
    const kick = wav('kick 1.wav');
    const library = directory('Library', {
      Kicks: directory('Kicks', { 'kick 1.wav': file('kick 1.wav', kick), 'kick 2.wav': file('kick 2.wav', wav('kick 2.wav')) }),
      Snares: directory('Snares', {}),
      'notes.txt': file('notes.txt', new File(['hi'], 'notes.txt')),
    });

    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => library;

    const { host } = mountExplorer();
    const open = [...host.querySelectorAll<HTMLButtonElement>('.explorer-btn')].find((button) =>
      button.textContent?.includes('Open folder'),
    );
    expect(open).toBeTruthy();
    open!.click();
    await settle();

    expect(host.querySelector('.explorer-crumb')?.textContent).toBe('Library');
    const folders = rows('.explorer-row.is-directory').map((row) => row.querySelector('.explorer-name')?.textContent);
    expect(folders).toEqual(['Kicks', 'Snares']);
    // Audio-only hides the text file, but it is still there behind the toggle.
    expect(rows('.explorer-row.is-audio')).toHaveLength(0);

    rows('.explorer-row.is-directory')[0].click();
    await settle();

    const names = rows('.explorer-row.is-audio').map((row) => row.querySelector('.explorer-name')?.textContent);
    expect(names).toEqual(['kick 1.wav', 'kick 2.wav']);
    expect(host.querySelectorAll('.explorer-crumb')).toHaveLength(2);

    // Up one level returns to the root of the folder.
    const up = host.querySelectorAll<HTMLButtonElement>('.explorer-btn')[1];
    up.click();
    await settle();
    expect(rows('.explorer-row.is-directory')).toHaveLength(2);
  });

  it('filters the current folder without losing the folder rows', async () => {
    const library = directory('Library', {
      Kicks: directory('Kicks', {}),
      'snare top.wav': file('snare top.wav', wav('snare top.wav')),
      'snare bottom.wav': file('snare bottom.wav', wav('snare bottom.wav')),
      'kick.wav': file('kick.wav', wav('kick.wav')),
    });
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => library;

    const { host } = mountExplorer();
    host.querySelector<HTMLButtonElement>('.explorer-btn')!.click();
    await settle();

    const search = host.querySelector<HTMLInputElement>('.explorer-search-input')!;
    search.value = 'sNaRe';
    search.dispatchEvent(new Event('input'));
    await settle(1);

    const names = rows().map((row) => row.querySelector('.explorer-name')?.textContent);
    expect(names).toEqual(['snare bottom.wav', 'snare top.wav']);

    search.value = '';
    search.dispatchEvent(new Event('input'));
    await settle(1);
    expect(rows('.explorer-row.is-directory')).toHaveLength(1);
    expect(rows('.explorer-row.is-audio')).toHaveLength(3);
  });

  it('auditions and inserts a file, and shows the session pool', async () => {
    const library = directory('Library', { 'kick.wav': file('kick.wav', wav('kick.wav')) });
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => library;

    const { host, onAuditionFile, onInsertFile, onAuditionAsset, onInsertAsset } = mountExplorer();
    host.querySelector<HTMLButtonElement>('.explorer-btn')!.click();
    await settle();

    const row = rows('.explorer-row.is-audio')[0];
    row.querySelector<HTMLButtonElement>('.explorer-row-action')!.click();
    await settle(2);
    expect(onAuditionFile).toHaveBeenCalledTimes(1);
    expect((onAuditionFile.mock.calls[0][0] as File).name).toBe('kick.wav');

    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle(2);
    expect(onInsertFile).toHaveBeenCalledTimes(1);

    const poolRow = document.querySelector<HTMLElement>('.explorer-pool .explorer-row')!;
    expect(poolRow.querySelector('.explorer-name')?.textContent).toBe('Take 1');

    poolRow.querySelector<HTMLButtonElement>('.explorer-row-action')!.click();
    expect(onAuditionAsset).toHaveBeenCalledWith('asset-1');

    poolRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onInsertAsset).toHaveBeenCalledWith('asset-1');
  });

  it('says when no folder is open instead of showing an empty list', () => {
    const { host } = mountExplorer();
    expect(host.querySelector('.explorer-status')?.textContent).toContain('Open a folder');
    expect(host.querySelector('.explorer-crumb')?.textContent).toBe('No folder open');
  });
});
