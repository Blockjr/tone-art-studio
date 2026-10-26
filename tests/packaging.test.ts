/**
 * Release packaging checks.
 *
 * Nothing else in the gate looks at a workflow, and the packaging job had
 * already drifted twice in ways a green tick could not show:
 *
 *   - ToneArtStudio-ALL.zip was left holding an earlier build than the
 *     installers sitting beside it on the same release page, because the job
 *     only ran when somebody dispatched it by hand;
 *   - a second sums file went on listing installers that a later build had
 *     replaced, so it named hashes that were no longer on the release.
 *
 * These assert the shape that makes those impossible, not the wording around it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const pack = read('.github/workflows/package-downloads.yml');
const windows = read('.github/workflows/native-windows.yml');

describe('release packaging', () => {
  it('packs the release by itself when the installers are published', () => {
    // Waiting to be dispatched by hand is how the bundles came to lag the very
    // release they describe.
    expect(pack).toContain('workflow_run:');
    expect(pack).toContain('native-windows');
    expect(pack).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  it('packs from the commit that produced the installers, not from wherever main is', () => {
    expect(pack).toContain('ref: ${{ github.event.workflow_run.head_sha || github.sha }}');
  });

  it('hashes every download into the one sums file the release publishes', () => {
    expect(pack).toContain('sha256sum "$APP" "$HOST"');
    expect(pack).toContain('sha256sum *.zip');
    expect(pack).toContain('build/out/SHA256SUMS.txt');
    // The second sums file listed installers that were replaced afterwards, so
    // it pointed at hashes that were no longer on the release.
    expect(pack).not.toMatch(/upload[^\n]*build\/out\/SHA256\.txt/);
    expect(pack).toContain('delete-asset "$TAG" SHA256.txt');
  });

  it('puts all five parts into the single "everything" zip', () => {
    const all = /zip -q -0 ToneArtStudio-ALL\.zip([\s\S]*?)\)/.exec(pack);
    expect(all, 'ToneArtStudio-ALL.zip is not built').not.toBeNull();
    for (const part of [
      '1-App-Installer',
      '2-Desktop-and-Remote-Kit',
      '3-Source-Code',
      '4-Web-Build',
      '5-Engine-ASIO-Driver',
    ]) {
      expect(all?.[1], part).toContain(`ToneArtStudio-${part}.zip`);
    }
  });

  it('builds on the Node version package.json requires', () => {
    const manifest = JSON.parse(read('package.json')) as { engines: { node: string } };
    expect(manifest.engines.node).toBe('>=22.12.0');
    for (const [name, text] of [
      ['package-downloads', pack],
      ['native-windows', windows],
    ] as const) {
      const pin = /node-version: "(.+)"/.exec(text)?.[1];
      expect(pin, `${name} sets no node-version`).toBeDefined();
      expect(Number(pin), name).toBeGreaterThanOrEqual(22);
    }
  });
});
