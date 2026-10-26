'use strict';

/**
 * Serves the built interface to the app's own window.
 *
 * The window is pointed at a loopback HTTP origin rather than a file:// path:
 * ES modules, AudioWorklet, fetch and service workers all behave there exactly
 * as they do in a browser, which is how the interface is tested. A file://
 * document silently refuses the module script the whole app sits behind, and
 * that is one way a desktop shell ends up showing a blank window.
 */

const { createServer } = require('node:http');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
};

/**
 * Maps a request path onto a file inside `root`, or null.
 *
 * Everything is resolved and then checked to still sit under `root`, so a
 * request such as `/../../secret` cannot read outside the installed interface.
 */
async function resolveFile(root, requestPath) {
  let decoded;

  try {
    decoded = decodeURIComponent((requestPath || '/').split('#')[0].split('?')[0]);
  } catch {
    return null;
  }

  const relative = path.normalize(decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, ''));
  const file = path.resolve(root, relative);

  if (file !== root && !file.startsWith(root + path.sep)) return null;

  try {
    const info = await stat(file);

    if (info.isDirectory()) {
      const index = path.join(file, 'index.html');
      const indexInfo = await stat(index);
      return indexInfo.isFile() ? index : null;
    }

    return info.isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * Starts the server on an unused loopback port and resolves with its origin.
 *
 * Port 0 lets the operating system pick a free port, so two copies of the app
 * (or another program already holding the port) never collide; the window is
 * only created once the port is known.
 */
function startUiServer(root) {
  const server = createServer(async (request, response) => {
    const file = await resolveFile(root, request.url);

    if (file === null) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    try {
      const body = await readFile(file);

      response.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // The port changes on every launch, so nothing may be cached across runs.
        'cache-control': 'no-cache',
        'content-length': body.length,
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Could not read ' + path.basename(file) + ': ' + error.message);
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);

    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startUiServer, resolveFile, MIME };
