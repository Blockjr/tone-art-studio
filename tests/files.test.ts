// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  beginDrag,
  extensionOf,
  filterEntries,
  formatDuration,
  formatSize,
  isAudioName,
  joinPath,
  listingFromFiles,
  namedFilesFromInput,
  parentPath,
  pathSegments,
  pendingDrags,
  sortEntries,
  takeDrag,
  type NamedFile,
} from '../src/core/filebrowse';

const named = (path: string): NamedFile => ({ file: new File([new Uint8Array(8)], path.split('/').pop()!), path });

describe('audio detection', () => {
  it('recognises the formats the decoder accepts, whatever the case', () => {
    for (const name of ['kick.wav', 'MX_LOOP.MP3', 'vocal.aiff', 'take.flac', 'stem.ogg', 'clip.m4a']) {
      expect(isAudioName(name), name).toBe(true);
    }
    for (const name of ['notes.txt', 'session.hstudio', 'cover.jpg', 'no-extension', '.wav']) {
      expect(isAudioName(name), name).toBe(false);
    }
  });

  it('reads the extension after the last dot', () => {
    expect(extensionOf('mix.final.WAV')).toBe('wav');
    expect(extensionOf('no-dot')).toBe('');
  });
});

describe('folder listings', () => {
  const files = [
    named('Samples/Kicks/kick 2.wav'),
    named('Samples/Kicks/kick 10.wav'),
    named('Samples/Snares/snare.wav'),
    named('Samples/readme.txt'),
    named('Samples/bass loop 1.mp3'),
  ];

  it('starts at the folder that was opened, not its contents', () => {
    const listing = listingFromFiles(files, '');
    expect(listing.directories).toEqual(['Samples']);
    expect(listing.files).toEqual([]);
  });

  it('splits one folder into its folders and files', () => {
    const listing = listingFromFiles(files, 'Samples');
    expect(listing.directories).toEqual(['Kicks', 'Snares']);
    expect(listing.files.map((entry) => entry.file.name)).toEqual(['bass loop 1.mp3', 'readme.txt']);
  });

  it('lists a nested folder and leaves the rest out', () => {
    const listing = listingFromFiles(files, 'Samples/Kicks');
    expect(listing.directories).toEqual([]);
    // Numeric-aware: kick 2 before kick 10, the way a person numbers takes.
    expect(listing.files.map((entry) => entry.file.name)).toEqual(['kick 2.wav', 'kick 10.wav']);
  });

  it('returns nothing for a path that is not there', () => {
    expect(listingFromFiles(files, 'Samples/Pads')).toEqual({ directories: [], files: [] });
  });

  it('puts folders first and sorts names the way a person reads them', () => {
    const entries = [
      { name: 'Kick 10.wav', kind: 'audio' as const },
      { name: 'Snares', kind: 'directory' as const },
      { name: 'Kick 2.wav', kind: 'audio' as const },
      { name: 'Ambience', kind: 'directory' as const },
    ];
    expect(sortEntries(entries).map((entry) => entry.name)).toEqual([
      'Ambience',
      'Snares',
      'Kick 2.wav',
      'Kick 10.wav',
    ]);
  });

  it('filters without caring about case', () => {
    const entries = [{ name: 'Kick 1.wav' }, { name: 'Snare.wav' }];
    expect(filterEntries(entries, 'kIcK').map((entry) => entry.name)).toEqual(['Kick 1.wav']);
    expect(filterEntries(entries, '  ')).toHaveLength(2);
  });

  it('keeps paths relative and tidy', () => {
    expect(joinPath('Samples', 'Kicks')).toBe('Samples/Kicks');
    expect(joinPath('', 'Kicks')).toBe('Kicks');
    expect(parentPath('Samples/Kicks/kick.wav')).toBe('Samples/Kicks');
    expect(parentPath('kick.wav')).toBe('');
    expect(pathSegments('/Samples//Kicks/')).toEqual(['Samples', 'Kicks']);
  });

  it('takes the relative path a directory input gives each file', () => {
    const file = new File([new Uint8Array(4)], 'kick.wav');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Samples/Kicks/kick.wav' });
    const loose = new File([new Uint8Array(4)], 'loose.wav');

    expect(namedFilesFromInput([file, loose])).toEqual([
      { file, path: 'Samples/Kicks/kick.wav' },
      { file: loose, path: 'loose.wav' },
    ]);
  });
});

describe('readable sizes and times', () => {
  it('formats byte counts like a file manager', () => {
    expect(formatSize(0)).toBe('');
    expect(formatSize(900)).toBe('900 B');
    expect(formatSize(2048)).toBe('2.0 kB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatSize(42 * 1024 * 1024)).toBe('42 MB');
  });

  it('formats durations as a clock until a minute, then minutes and tenths', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(3.42)).toBe('3.4s');
    expect(formatDuration(9.94)).toBe('9.9s');
    expect(formatDuration(61.25)).toBe('1:01.3');
  });
});

describe('drag payloads', () => {
  it('hands a token back exactly once', () => {
    const file = new File([new Uint8Array(2)], 'kick.wav');
    const token = beginDrag({ kind: 'file', file, name: 'kick.wav' });
    expect(takeDrag(token)?.kind).toBe('file');
    expect(takeDrag(token)).toBeNull();
  });

  it('carries a session asset without holding audio in the drag', () => {
    const token = beginDrag({ kind: 'asset', assetId: 'asset-1', name: 'Take 1' });
    expect(takeDrag(token)).toEqual({ kind: 'asset', assetId: 'asset-1', name: 'Take 1' });
  });

  it('stays bounded when drags are started and never dropped', () => {
    const before = pendingDrags();
    for (let index = 0; index < 60; index++) beginDrag({ kind: 'asset', assetId: `a-${index}`, name: `A${index}` });
    expect(pendingDrags()).toBeLessThanOrEqual(24);
    expect(pendingDrags()).toBeGreaterThan(before);
  });
});
