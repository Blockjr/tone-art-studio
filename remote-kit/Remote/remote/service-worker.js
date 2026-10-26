/*
 * Tone Art Studio remote offline shell.
 *
 * The live session still needs a bridge: this worker only makes sure the app
 * itself opens instantly on a bad network and keeps working if the internet
 * drops. The studio and the tablet normally reach each other over Wi-Fi, so no
 * cloud connection is involved at any point.
 */
const VERSION = 'toneart-remote-v1';
// Keep the ?v= number on the scripts in index.html in step with this build.
const SHELL = [
  '/',
  '/index.html',
  '/app.js?v=5',
  '/style.css?v=5',
  '/manifest.webmanifest',
  '/logo.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // Individual failures (an icon missing on an older build) must not stop
      // the shell from being cached.
      await Promise.all(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

function isAsset(url) {
  return url.pathname === '/app.js' || url.pathname === '/style.css' || url.pathname.endsWith('.png') || url.pathname.endsWith('.svg');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Live endpoints must never be answered from a cache.
  if (url.pathname === '/ws' || url.pathname === '/info' || url.pathname === '/healthz') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(VERSION);
          cache.put('/', fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          const cached = (await caches.match('/')) ?? (await caches.match('/index.html'));
          return (
            cached ??
            new Response('<h1>Tone Art Studio Remote</h1><p>Open this page once while the bridge is reachable to cache it.</p>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
              status: 503,
            })
          );
        }
      })(),
    );
    return;
  }

  if (isAsset(url) || SHELL.some((entry) => entry.split('?')[0] === url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        const network = fetch(request)
          .then(async (response) => {
            if (response.ok) {
              const cache = await caches.open(VERSION);
              cache.put(request, response.clone()).catch(() => undefined);
            }
            return response;
          })
          .catch(() => null);
        return cached ?? (await network) ?? new Response('', { status: 504 });
      })(),
    );
  }
});

// Let the page tell an installed app to pick up a new build on the next launch.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});
