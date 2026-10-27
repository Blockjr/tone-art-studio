import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Puts the version that was built into the interface's own label.
 *
 * That label is the first thing anyone looks at to tell whether they have the
 * new build, and it was typed into index.html by hand: the published program
 * introduced itself as v0.1 while the version around it was 0.6.0. The build
 * now writes the version from package.json over whatever the markup says, so
 * the number in the page cannot fall behind the number of the program.
 */
function appVersion() {
  return {
    name: 'app-version',
    transformIndexHtml(html: string) {
      return html.replace(/<em>Studio v[^<]*<\/em>/, `<em>Studio v${version as string}</em>`);
    },
  };
}

const previewHost = 'pv-627b01a47f85-de965689-a2ce-45d3-887c-53fedd5b2d2c.style.dev';

export default defineConfig({
  plugins: [appVersion()],
  test: {
    // Only the tree is the suite. `artifacts/` holds scratch copies of the whole
    // repository, built while assembling a patch, and the default pattern found
    // their tests too: the gate ran the suite twice, once against a tree that is
    // not the one being shipped, and took long enough to be cut off.
    exclude: [...configDefaults.exclude, 'artifacts/**'],
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: [previewHost],
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: [previewHost],
  },
  build: {
    // es2019 rather than es2022: the same bundle also runs inside the desktop
    // host's WebView2, which on an un-updated Windows machine can be an older
    // Chromium than the browser. Nothing in the app needs syntax newer than
    // this, and a lower target removes a whole class of "blank window" reports.
    target: 'es2019',
  },
});
