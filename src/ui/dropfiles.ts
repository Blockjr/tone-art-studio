/**
 * Reads what a drag and drop is carrying.
 *
 * The DataTransfer only exposes real File objects inside the drop event, and a
 * dropped folder arrives as a FileSystemEntry tree that has to be walked. Both
 * paths end up as named files so the explorer and the arrangement agree on
 * what a dropped item is.
 */

import { FILE_DRAG_MIME, joinPath, namedFilesFromInput, type NamedFile } from '../core/filebrowse';

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries((entries) => resolve(entries), (error) => reject(error));
  });
}

async function walkEntry(entry: FileSystemEntry, base: string, out: NamedFile[]): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File | null>((resolve) => {
      fileEntry.file((value) => resolve(value), () => resolve(null));
    });
    if (file) out.push({ file, path: joinPath(base, file.name) });
    return;
  }

  if (entry.isDirectory) {
    const directory = entry as FileSystemDirectoryEntry;
    const reader = directory.createReader();
    const folder = joinPath(base, directory.name);
    // readEntries returns at most 100 entries per call and must be drained.
    for (;;) {
      const batch = await readBatch(reader);
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, folder, out);
    }
  }
}

/** True when a drag is ours, or when it carries files from outside the app. */
export function hasFileDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  const types = Array.from(transfer.types ?? []);
  return types.includes(FILE_DRAG_MIME) || types.includes('Files');
}

/** Every file in a drop, with folder drops expanded in place. */
export async function filesFromDrop(transfer: DataTransfer): Promise<NamedFile[]> {
  const items = transfer.items ? Array.from(transfer.items) : [];
  const entries: FileSystemEntry[] = [];

  for (const item of items) {
    if (typeof item.webkitGetAsEntry !== 'function') continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }

  if (entries.length > 0) {
    const out: NamedFile[] = [];
    for (const entry of entries) await walkEntry(entry, '', out);
    if (out.length > 0) return out;
  }

  return namedFilesFromInput(transfer.files);
}
