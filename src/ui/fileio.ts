import { downloadBlob } from '../audio/export';
import { projectFileName, projectNameFromFile } from '../core/session';

/**
 * Saving and opening project documents.
 *
 * Where the browser supports the File System Access API (Chromium, and the
 * desktop build's WebView2), Save writes back into the same file and Save As
 * asks for a new one. Everywhere else the document downloads as a file and
 * Open uses a file input, so the same buttons work in every browser.
 */

interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileHandleLike {
  name: string;
  createWritable(): Promise<WritableLike>;
  getFile(): Promise<File>;
}

interface PickerWindow {
  showSaveFilePicker?: (options?: unknown) => Promise<FileHandleLike>;
  showOpenFilePicker?: (options?: unknown) => Promise<FileHandleLike[]>;
}

const PICKER_TYPES = [
  {
    description: 'Tone Art Studio project',
    accept: { 'application/json': ['.hstudio', '.json'] },
  },
];

let currentHandle: FileHandleLike | null = null;

export interface SavedDocument {
  /** project name, derived from the file name */
  name: string;
  fileName: string;
  /** true when the document was written back to an existing file */
  inPlace: boolean;
}

export interface OpenedDocument {
  text: string;
  fileName: string;
  name: string;
}

function pickerWindow(): PickerWindow {
  return window as unknown as PickerWindow;
}

export function supportsFileSystemAccess(): boolean {
  const picker = pickerWindow();
  return typeof picker.showSaveFilePicker === 'function' && typeof picker.showOpenFilePicker === 'function';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError' || error.name === 'NotAllowedError'
    : (error as { name?: string } | null)?.name === 'AbortError';
}

export function resetProjectFileHandle(): void {
  currentHandle = null;
}

export async function saveProjectDocument(
  text: string,
  name: string,
  options: { saveAs?: boolean } = {},
): Promise<SavedDocument | null> {
  const picker = pickerWindow();

  if (typeof picker.showSaveFilePicker === 'function') {
    try {
      if (!currentHandle || options.saveAs) {
        currentHandle = await picker.showSaveFilePicker({
          suggestedName: projectFileName(name),
          types: PICKER_TYPES,
        });
      }

      const writable = await currentHandle.createWritable();
      await writable.write(new Blob([text], { type: 'application/json' }));
      await writable.close();

      return {
        name: projectNameFromFile(currentHandle.name),
        fileName: currentHandle.name,
        inPlace: !options.saveAs,
      };
    } catch (error) {
      if (isAbort(error)) return null;
      // A blocked picker (sandboxed frame, missing permission) still saves by
      // downloading the document rather than failing the command.
      currentHandle = null;
    }
  }

  const fileName = projectFileName(name);
  downloadBlob(new Blob([text], { type: 'application/json' }), fileName);
  return { name, fileName, inPlace: false };
}

export async function openProjectDocument(): Promise<OpenedDocument | null> {
  const picker = pickerWindow();

  if (typeof picker.showOpenFilePicker === 'function') {
    try {
      const [handle] = await picker.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      if (!handle) return null;
      const file = await handle.getFile();
      currentHandle = handle;
      return { text: await file.text(), fileName: file.name, name: projectNameFromFile(file.name) };
    } catch (error) {
      if (isAbort(error)) return null;
      // fall through to the file input
    }
  }

  return openWithInput();
}

function openWithInput(): Promise<OpenedDocument | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.hstudio,.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (value: OpenedDocument | null): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onWindowFocus);
      input.remove();
      resolve(value);
    };

    // A cancelled picker never fires change; regaining focus without files means
    // the user dismissed it.
    const onWindowFocus = (): void => {
      window.setTimeout(() => {
        if (!input.files || input.files.length === 0) finish(null);
      }, 600);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      void file.text().then((text) => finish({ text, fileName: file.name, name: projectNameFromFile(file.name) }));
    });

    window.addEventListener('focus', onWindowFocus);
    input.click();
  });
}
