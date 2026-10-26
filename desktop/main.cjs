'use strict';

/**
 * Tone Art Studio, desktop shell.
 *
 * This is a normal installed Windows program: its own window, its own entry in
 * the Start menu and on the desktop, one uninstaller. It draws the interface
 * with the Chromium engine that ships inside the app, so it does not depend on
 * anything already being installed on the PC.
 *
 * The interface itself is the same build the browser version serves. It is
 * handed to the window over a loopback HTTP origin (see ui-server.cjs) because
 * the app is an ES-module bundle with an audio worklet: those load from an
 * http:// document exactly as in a browser and are refused from file://.
 */

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { startUiServer } = require('./ui-server.cjs');

const root = path.join(__dirname, '..');
const uiDirectory = path.join(root, 'dist');
const REMOTE_PORT = 8787;

let uiServer = null;
let mainWindow = null;
let remoteBridgeStarted = false;

/** Turns an unexpected failure into something the user can read and report. */
function reportFailure(title, detail) {
  const text = `${title}\n\n${detail}`;
  console.error(text);

  if (app.isReady()) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Tone Art Studio',
      message: title,
      detail,
      buttons: ['Close'],
      noLink: true,
    }).catch(() => {});
  }
}

/** The addresses a tablet on the same Wi-Fi can open. */
function tabletAddresses() {
  const addresses = [`http://localhost:${REMOTE_PORT}`];

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(`http://${entry.address}:${REMOTE_PORT}`);
      }
    }
  }

  return addresses;
}

/**
 * Starts the tablet bridge in this process, so the Remote panel works without
 * anyone starting a second program.
 *
 * server/remote.mjs is the same bridge `npm run remote` runs. It is loaded
 * lazily and its failure is never fatal: the studio is fully usable without a
 * tablet, so a port already in use must not stop the app from opening.
 */
async function startRemoteBridge() {
  if (remoteBridgeStarted) return;
  remoteBridgeStarted = true;

  process.env.REMOTE_HOST = process.env.REMOTE_HOST || '0.0.0.0';
  process.env.REMOTE_PORT = process.env.REMOTE_PORT || String(REMOTE_PORT);

  try {
    await import(pathToFileURL(path.join(root, 'server', 'remote.mjs')).href);
    console.log('tablet bridge listening on port ' + process.env.REMOTE_PORT);
  } catch (error) {
    console.error('tablet bridge did not start: ' + (error && error.message));
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tablet',
      submenu: [
        {
          label: 'Show tablet address…',
          click: () => {
            const addresses = tabletAddresses().join('\n');
            dialog.showMessageBox({
              type: 'info',
              title: 'Control this session from a tablet',
              message: 'Open this address on a tablet connected to the same Wi-Fi',
              detail:
                `${addresses}\n\n` +
                'In the studio, open the Remote panel and start sharing. Both devices ' +
                'only need to reach each other; nothing is uploaded anywhere.',
              buttons: ['OK'],
              noLink: true,
            }).catch(() => {});
          },
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Where is the log file?',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'Log file',
              message: 'This build keeps no log file',
              detail:
                `Run the app from a terminal to see its messages.\n\n` +
                `Interface files: ${uiDirectory}\n` +
                `Settings and cache: ${app.getPath('userData')}`,
              buttons: ['OK'],
              noLink: true,
            }).catch(() => {});
          },
        },
        {
          label: 'Open settings folder',
          click: () => { shell.openPath(app.getPath('userData')).catch(() => {}); },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  uiServer = await startUiServer(uiDirectory);

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 960,
    minHeight: 600,
    // Dark from the first frame: a white flash before the interface paints is
    // why a slow start is so often reported as a blank window.
    backgroundColor: '#08090c',
    show: false,
    title: 'Tone Art Studio',
    autoHideMenuBar: false,
    webPreferences: {
      // The interface is a web app; it needs no access to Node.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // A link to the outside world opens in the user's browser, never inside the
  // app, so the studio window cannot be navigated away from the interface.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!uiServer || !url.startsWith(uiServer.url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  // If the page cannot load at all, say so instead of leaving a blank window.
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // aborted, e.g. by a reload

    dialog.showMessageBox({
      type: 'error',
      title: 'Tone Art Studio could not start',
      message: 'The interface did not load.',
      detail:
        `${description} (${code})\n${url}\n\n` +
        `Interface files: ${uiDirectory}\n` +
        `Settings folder: ${app.getPath('userData')}\n\n` +
        'Send this text and it can be fixed.',
      buttons: ['Try again', 'Close'],
      defaultId: 0,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0 && mainWindow) mainWindow.loadURL(uiServer.url).catch(() => {});
    }).catch(() => {});
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  await mainWindow.loadURL(uiServer.url);
  await startRemoteBridge();
}

// One window per machine: a second launch focuses the studio that is already
// running instead of opening a second copy on the same project.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  process.on('uncaughtException', (error) => {
    reportFailure('Tone Art Studio stopped unexpectedly', error && error.stack ? error.stack : String(error));
  });

  process.on('unhandledRejection', (reason) => {
    reportFailure('Tone Art Studio hit an unexpected problem', reason && reason.stack ? reason.stack : String(reason));
  });

  app.whenReady().then(async () => {
    buildMenu();

    try {
      await createWindow();
    } catch (error) {
      reportFailure(
        'Tone Art Studio could not open its window',
        (error && error.stack ? error.stack : String(error)) +
          `\n\nInterface files: ${uiDirectory}`,
      );
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(() => {});
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (uiServer) uiServer.close().catch(() => {});
  });
}
