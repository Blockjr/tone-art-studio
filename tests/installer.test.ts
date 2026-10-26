/**
 * Packaging checks.
 *
 * The Windows installer and the executable icon are compiled on Windows and on
 * CI, never in this workspace, so these tests guard the pieces that can go
 * wrong silently: a path the installer points at that no longer exists, an icon
 * at the wrong size, a wizard bitmap in the wrong format, or a CMake icon step
 * that stopped being wired to a real file.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ISS = readFileSync(join(ROOT, 'installer/ToneArtStudio.iss'), 'utf8');
const CMake = readFileSync(join(ROOT, 'native/CMakeLists.txt'), 'utf8');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };

/** Reads width/height from a PNG IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Reads width/height from a BITMAPINFOHEADER (negative height = top-down). */
function bmpSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 2).toString('ascii')).toBe('BM');
  expect(bytes.subarray(14, 18).readUInt32LE()).toBe(40); // BITMAPINFOHEADER
  return { width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) };
}

/** Every resolution stored in a Windows .ico. */
function icoSizes(path: string): number[] {
  const bytes = readFileSync(path);
  expect(bytes.readUInt16LE(0)).toBe(0); // reserved
  expect(bytes.readUInt16LE(2)).toBe(1); // 1 = icon
  const count = bytes.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    sizes.push(bytes[entry] === 0 ? 256 : bytes[entry]);
  }
  return sizes;
}

/** Expands the `{#BrandDir}` / `..\` paths the installer definition uses. */
function issPath(value: string): string {
  return resolve(
    join(ROOT, 'installer'),
    value.replace('{#BrandDir}', '..\\assets\\brand').replaceAll('\\', '/'),
  );
}

function issValue(key: string): string {
  const line = ISS.split('\n').find((l) => l.trimStart().startsWith(`${key}=`));
  expect(line, `${key}= is missing from the installer script`).toBeDefined();
  return (line as string).trim().slice(key.length + 1).trim();
}

function issDefine(name: string): string {
  const match = new RegExp(`#define ${name} "([^"]+)"`).exec(ISS);
  expect(match, `#define ${name} is missing`).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

describe('product name', () => {
  it('is the same in the app, the host and the installer', () => {
    // JUCE names the executable after PRODUCT_NAME, and the installer looks for
    // that name, so the two have to be written from one source of truth.
    const product = /PRODUCT_NAME "([^"]+)"/.exec(CMake)?.[1];
    expect(product).toBe('Tone Art Studio');
    expect(issDefine('MyAppName')).toBe(product);
    expect(issDefine('MyAppExeName')).toBe(`${product}.exe`);

    const mainCpp = readFileSync(join(ROOT, 'native/Source/Main.cpp'), 'utf8');
    expect(mainCpp).toContain(`return "${product}";`);
  });

  it('reaches every place a user reads it', () => {
    expect(html).toContain('<title>Tone Art Studio');
    expect(html).toContain('<span class="brand-name">Tone Art</span>');
    expect(html).toContain('<em>Studio v0.1</em>');
    expect(html).toContain('<span class="mixer-brand">Tone Art</span>');

    const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
    expect(main).toContain('— Tone Art Studio');

    const start = readFileSync(join(ROOT, 'src/ui/files.ts'), 'utf8');
    expect(start).toContain("el('strong', '', 'Tone Art Studio')");

    expect(issDefine('MyAppName')).toBe('Tone Art Studio');
    expect(issValue('AppName')).toBe('{#MyAppName}');
    expect(issValue('DefaultDirName')).toBe('{autopf}\\{#MyAppName}');
  });

  it('left no old name in the interface', () => {
    for (const file of ['index.html', 'src/ui/files.ts', 'src/ui/native.ts', 'src/ui/fileio.ts', 'src/main.ts']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, file).not.toContain('Meridian');
      expect(text, file).not.toContain('Hybrid Studio');
      expect(text, file).not.toContain('My Studio');
    }
    expect(ISS).not.toContain('Meridian');
    expect(ISS).not.toContain('Hybrid Studio');
    expect(ISS).not.toContain('My Studio');
  });
});

describe('installer definition', () => {
  it('carries its own version fallback that matches package.json', () => {
    const fallback = /#define MyAppVersion "([^"]+)"/.exec(ISS)?.[1];
    expect(fallback).toBe(pkg.version);
  });

  it('names the setup file after the version', () => {
    expect(issValue('OutputBaseFilename')).toBe('ToneArtStudioHostSetup-{#MyAppVersion}');
    // A stable AppId is what lets an upgrade replace the previous install.
    // Inno escapes a literal opening brace by doubling it, so the value below
    // expands to {7E0B2B5A-...}.
    expect(issValue('AppId')).toBe('{#MyAppId}');
    expect(/#define MyAppId "\{\{[0-9A-F-]{36}\}"/.test(ISS)).toBe(true);
  });

  it('points at branding files that exist', () => {
    for (const key of ['SetupIconFile', 'WizardImageFile', 'WizardSmallImageFile']) {
      const path = issPath(issValue(key));
      expect(existsSync(path), `${key} -> ${path}`).toBe(true);
    }
  });

  it('uses Inno Setup wizard bitmaps at the sizes it expects', () => {
    expect(bmpSize(issPath(issValue('WizardImageFile')))).toEqual({ width: 164, height: 314 });
    expect(bmpSize(issPath(issValue('WizardSmallImageFile')))).toEqual({ width: 58, height: 58 });
    // 24-bit or 32-bit, uncompressed: what ISCC accepts for wizard art.
    const large = readFileSync(issPath(issValue('WizardImageFile')));
    expect(large.readUInt16LE(28)).toBeLessThanOrEqual(32);
    expect(large.readUInt32LE(30)).toBe(0);
  });

  it('installs the executable, the UI folder and the driver', () => {
    expect(ISS).toContain('Source: "{#BuildDir}\\{#MyAppExeName}"');
    expect(ISS).toContain('Source: "{#BuildDir}\\ui\\*"');
    expect(ISS).toContain('HybridVirtualAsio.dll');
    expect(ISS).toContain('install-virtual-asio.ps1');
    // The bundled VST3 is taken from whatever target CMake actually builds.
    const pluginTarget = /juce_add_plugin\((\w+)/.exec(CMake)?.[1];
    expect(pluginTarget).toBeDefined();
    expect(ISS).toContain(`${pluginTarget}_artefacts`);
    // The driver is registered on install and removed on uninstall.
    expect(ISS).toContain('[UninstallRun]');
    expect(ISS).toContain('-Uninstall');
  });

  it('ships a build script that finds ISCC and fails loudly', () => {
    const script = readFileSync(join(ROOT, 'installer/build-installer.ps1'), 'utf8');
    expect(script).toContain('Inno Setup 6');
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('Tone Art Studio.exe');
    expect(script).toContain('ToneArtStudioSetup-$version.exe');
  });
});

describe('application icon', () => {
  it('is a single multi-resolution .ico covering the Windows sizes', () => {
    const sizes = icoSizes(join(ROOT, 'assets/brand/tone-art.ico'));
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it('feeds a PNG JUCE can load to ICON_BIG', () => {
    // juceaide reads ICON_BIG through juce::Drawable, which cannot open an .ico.
    expect(CMake).toContain('ICON_BIG');
    const png = /set\(HYBRID_ICON_PNG "([^"]+)"\)/.exec(CMake)?.[1];
    expect(png).toBeDefined();
    const path = (png as string).replace('${CMAKE_CURRENT_SOURCE_DIR}', join(ROOT, 'native'));
    expect(existsSync(path)).toBe(true);
    expect(pngSize(path)).toEqual({ width: 1024, height: 1024 });
  });

  it('enables the C language JUCE 9 requires', () => {
    // The version expression is deliberately not pinned to a literal here: it
    // used to read VERSION 0.1.0 while the product shipped 0.5.x, and it now
    // comes from package.json through ${HYBRID_VERSION}. What JUCE 9 needs is
    // the C language, whatever the version looks like.
    expect(CMake).toMatch(/project\(HybridStudio VERSION \S+ LANGUAGES C CXX\)/);
  });

  it('takes the host version from package.json instead of typing it in', () => {
    expect(CMake).toContain('file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../package.json"');
    expect(CMake).toContain('project(HybridStudio VERSION ${HYBRID_VERSION}');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('web icons', () => {
  it('ships a logo and favicons at the sizes browsers ask for', () => {
    expect(pngSize(join(ROOT, 'public/favicon-16.png'))).toEqual({ width: 16, height: 16 });
    expect(pngSize(join(ROOT, 'public/favicon-32.png'))).toEqual({ width: 32, height: 32 });
    expect(pngSize(join(ROOT, 'public/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
    expect(pngSize(join(ROOT, 'public/icon-512.png'))).toEqual({ width: 512, height: 512 });
    const svg = readFileSync(join(ROOT, 'public/logo.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).toContain('aria-label="Tone Art Studio"');
  });

  it('links every icon it ships', () => {
    for (const href of ['/logo.svg', '/favicon-32.png', '/favicon-16.png', '/apple-touch-icon.png']) {
      expect(html).toContain(`href="${href}"`);
      expect(existsSync(join(ROOT, 'public', href.slice(1))), href).toBe(true);
    }
  });

  it('shows the same mark in the top bar and the start screen', () => {
    expect(html).toContain('<img src="/logo.svg"');
    const start = readFileSync(join(ROOT, 'src/ui/files.ts'), 'utf8');
    expect(start).toContain("markImage.src = '/logo.svg'");
  });
});
