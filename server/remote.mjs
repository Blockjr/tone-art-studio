#!/usr/bin/env node
/**
 * Tone Art Studio remote bridge.
 *
 * Serves the tablet controller from ../remote and relays session snapshots from
 * the desktop app to tablets, plus control commands back to the desktop.
 *
 *   npm run remote                       # http://localhost:8787 and the LAN IPs
 *   REMOTE_PORT=9000 npm run remote
 *   REMOTE_TOKEN=secret npm run remote   # required when exposed to the internet
 *   REMOTE_TLS_CERT=cert.pem REMOTE_TLS_KEY=key.pem npm run remote
 *   REMOTE_PUBLIC_URL=https://studio.example.com npm run remote
 *
 * The bridge works without any internet connection: both devices only need to
 * reach each other. For access from another network, forward the port or put a
 * tunnel in front of it and set REMOTE_TOKEN so the LAN is not opened up.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const remoteDir = path.join(here, '..', 'remote');
const publicDir = path.join(here, '..', 'public');
const port = Number(process.env.REMOTE_PORT ?? 8787);
const host = process.env.REMOTE_HOST ?? '0.0.0.0';
const token = (process.env.REMOTE_TOKEN ?? '').trim();
const publicUrl = (process.env.REMOTE_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
const tlsCert = process.env.REMOTE_TLS_CERT;
const tlsKey = process.env.REMOTE_TLS_KEY;

if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
  console.error('Set both REMOTE_TLS_CERT and REMOTE_TLS_KEY, or neither.');
  process.exit(1);
}
if (publicUrl && !token) {
  console.error(
    'REMOTE_PUBLIC_URL is set but REMOTE_TOKEN is empty. Refusing to expose the bridge\n' +
      'without an access token: set REMOTE_TOKEN to a long random value and use the same\n' +
      'token on the tablet.',
  );
  process.exit(1);
}

const secure = Boolean(tlsCert && tlsKey);

/** shell files reload from the network; icons are content-stable */
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8', remoteDir, 'shell']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8', remoteDir, 'shell']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8', remoteDir, 'shell']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8', remoteDir, 'shell']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8', remoteDir, 'shell']],
  ['/service-worker.js', ['service-worker.js', 'text/javascript; charset=utf-8', remoteDir, 'worker']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png', publicDir, 'asset']],
  ['/icon-192.png', ['icon-192.png', 'image/png', publicDir, 'asset']],
  ['/icon-512.png', ['icon-512.png', 'image/png', publicDir, 'asset']],
  ['/logo.svg', ['logo.svg', 'image/svg+xml', publicDir, 'asset']],
]);

function lanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function baseUrls(actualPort) {
  const scheme = secure ? 'https' : 'http';
  const lan = lanAddresses().map((address) => `${scheme}://${address}:${actualPort}`);
  return {
    local: `${scheme}://localhost:${actualPort}`,
    lan,
    public: publicUrl || null,
  };
}

function info(actualPort, counts = { clients: 0, desktops: 0 }) {
  return {
    app: 'toneart-remote',
    version: 2,
    port: actualPort,
    secure,
    tokenRequired: Boolean(token),
    publicUrl: publicUrl || null,
    urls: baseUrls(actualPort),
    clients: counts.clients,
    desktops: counts.desktops,
  };
}

function counts() {
  return {
    clients: clients.size,
    desktops: [...clients].filter((client) => client.role === 'desktop').length,
  };
}

/**
 * A browser page from another site must not be able to open a socket and drive
 * the studio. Same-host origins (the tablet page, the local desktop app) and
 * REMOTE_ORIGIN entries are allowed; native clients without an Origin header
 * (scripts, tests) are allowed too, because they already need the token.
 */
function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const hostHeader = String(request.headers.host ?? '').split(':')[0].toLowerCase();
  const allowed = new Set([hostHeader, 'localhost', '127.0.0.1', '[::1]', '::1']);
  if (publicUrl) {
    try {
      allowed.add(new URL(publicUrl).hostname.toLowerCase());
    } catch {
      /* a malformed public URL is reported elsewhere */
    }
  }
  for (const entry of (process.env.REMOTE_ORIGIN ?? '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    try {
      allowed.add(new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase());
    } catch {
      /* ignore a malformed entry */
    }
  }
  return allowed.has(parsed.hostname.toLowerCase());
}

/** Constant-time token check, so a LAN scan cannot guess it byte by byte. */
function tokenMatches(value) {
  if (!token) return true;
  const given = Buffer.from(String(value ?? ''), 'utf8');
  const wanted = Buffer.from(token, 'utf8');
  if (given.length !== wanted.length) return false;
  return timingSafeEqual(given, wanted);
}

function describeAsset(request) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  return { url, asset: assets.get(url.pathname) };
}

async function handleRequest(request, response) {
  const { url, asset } = describeAsset(request);

  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };

  if (url.pathname === '/healthz') {
    const now = counts();
    response.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, ...now, uptime: Math.round(process.uptime()) }));
    return;
  }

  if (url.pathname === '/info') {
    // Addresses are only useful to someone who already has the token; a public
    // scan should not learn the studio's LAN layout.
    if (!tokenMatches(url.searchParams.get('token'))) {
      response.writeHead(401, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'token required' }));
      return;
    }
    response.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(info(serverPort, counts())));
    return;
  }

  if (!asset) {
    response.writeHead(404, { ...headers, 'content-type': 'text/plain' });
    response.end('Not found');
    return;
  }

  try {
    const [file, type, dir, kind] = asset;
    const body = await readFile(path.join(dir, file));
    const cache =
      kind === 'worker'
        ? 'no-cache'
        : kind === 'shell'
          ? 'no-cache, must-revalidate'
          : 'public, max-age=86400';
    const extra =
      kind === 'worker'
        ? { 'service-worker-allowed': '/' }
        : kind === 'shell'
          ? {
              'content-security-policy':
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:",
            }
          : {};
    response.writeHead(200, { ...headers, ...extra, 'content-type': type, 'cache-control': cache });
    response.end(body);
  } catch {
    response.writeHead(500, { ...headers, 'content-type': 'text/plain' });
    response.end('Missing controller file');
  }
}

let tlsOptions = null;
if (secure) {
  try {
    tlsOptions = { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) };
  } catch (error) {
    console.error('Could not read REMOTE_TLS_CERT / REMOTE_TLS_KEY:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

const server = tlsOptions
  ? createHttpsServer(tlsOptions, (req, res) => {
      void handleRequest(req, res);
    })
  : createHttpServer((req, res) => {
      void handleRequest(req, res);
    });

let serverPort = port;

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(
      `Port ${port} is already in use. Run another bridge or set REMOTE_PORT to a free port.`,
    );
  } else {
    console.error('Bridge failed to start:', error);
  }
  process.exit(1);
});

/** @type {Set<{socket: WebSocket, role: 'desktop'|'tablet', alive: boolean}>} */
const clients = new Set();
let lastState = null;

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(payload, role) {
  for (const client of clients) {
    if (!role || client.role === role) send(client.socket, payload);
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/ws', 'http://localhost');

  if (!originAllowed(request)) {
    send(socket, { type: 'unauthorized', reason: 'origin not allowed' });
    socket.close(4403, 'origin not allowed');
    return;
  }

  if (!tokenMatches(url.searchParams.get('token'))) {
    send(socket, { type: 'unauthorized', reason: 'token required' });
    socket.close(4401, 'token required');
    return;
  }

  const role = url.searchParams.get('role') === 'desktop' ? 'desktop' : 'tablet';
  const client = { socket, role, alive: true };
  clients.add(client);

  send(socket, { type: 'hello', role, clients: clients.size, desktopOnline: counts().desktops > 0 });
  if (role === 'tablet') {
    send(socket, { type: 'desktop', online: counts().desktops > 0 });
    if (lastState) send(socket, lastState);
  } else {
    broadcast({ type: 'desktop', online: true }, 'tablet');
  }

  socket.on('pong', () => {
    client.alive = true;
  });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'state' && role === 'desktop') {
      lastState = message;
      broadcast(message, 'tablet');
    } else if (message.type === 'command' && role === 'tablet') {
      broadcast(message, 'desktop');
    } else if (message.type === 'ping') {
      // Echo the client's timestamp so it can measure round-trip latency.
      send(socket, { type: 'pong', at: typeof message.at === 'number' ? message.at : Date.now() });
    }
  });

  socket.on('close', () => {
    clients.delete(client);
    if (role === 'desktop') {
      broadcast({ type: 'desktop', online: counts().desktops > 0 }, 'tablet');
    }
  });
});

/** A tablet that sleeps or loses Wi-Fi is dropped instead of lingering online. */
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.socket.terminate();
      clients.delete(client);
      continue;
    }
    client.alive = false;
    try {
      client.socket.ping();
    } catch {
      /* the close handler will tidy up */
    }
  }
}, 30000);
heartbeat.unref?.();

server.listen(port, host, () => {
  const address = server.address();
  serverPort = typeof address === 'object' && address ? address.port : port;
  const urls = baseUrls(serverPort);
  const protocol = secure ? 'wss' : 'ws';

  console.log('Tone Art Studio remote bridge');
  console.log(`  desktop bridge: ${protocol}://localhost:${serverPort}/ws`);
  console.log(`  tablet page:    ${urls.local}`);
  for (const address of urls.lan) console.log(`  on your Wi-Fi:  ${address}`);
  if (urls.public) console.log(`  on the internet: ${urls.public}`);
  if (token) console.log('  access token:   required (use the same token on the tablet)');
  if (publicUrl && !secure) {
    console.log('  TLS:            terminated by your tunnel or proxy in front of this port');
  } else if (secure) {
    console.log('  TLS:            certificate loaded, service worker install is available');
  }
  console.log('Keep this running, connect the app through the Remote panel, then open the tablet page.');
  if (!token) {
    console.log('On a shared network, set REMOTE_TOKEN before opening the port to the internet.');
  }
});

function shutdown() {
  clearInterval(heartbeat);
  for (const client of clients) client.socket.close(1001, 'bridge stopping');
  wss.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
