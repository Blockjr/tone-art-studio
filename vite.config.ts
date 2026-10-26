import { defineConfig } from 'vite';

const previewHost = 'pv-627b01a47f85-7a81c619-de3d-4e0d-9902-777f5f1581a7.style.dev';

export default defineConfig({
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
