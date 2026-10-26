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
    target: 'es2022',
  },
});
