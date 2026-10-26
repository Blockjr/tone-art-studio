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

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { startUiServer } = require('./ui-server.cjs');

const root = path.join(__dirname, '..');
const uiDirectory = path.join(root, 'dist');
const REMOTE_PORT = 8787;

let uiServer = null;
let mainWindow = null;
let remoteBridgeStarted = false;
/** Wings opened with "Open panel in a window", keyed by panel name. */
const panelWindows = new Map();

/** Where window size and position are remembered between launches. */
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const raw = fs.readFileSync(windowStatePath(), 'utf8');
    const state = JSON.parse(raw);
    if (state && Number.isFinite(state.width) && Number.isFinite(state.height)) return state;
  } catch {
    // First launch, or the file was cleared: the defaults are fine.
  }
  return null;
}

/**
 * Saves the window rectangle, but only while it is a normal window: a maximised
 * or full-screen window would otherwise be remembered as a screen-sized box.
 */
function saveWindowState(window) {
  if (!window || window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return;
  try {
    const bounds = window.getBounds();
    fs.writeFileSync(windowStatePath(), JSON.stringify(bounds));
  } catch {
    // A read-only settings folder must not stop the app from closing.
  }
}

/** The display the main window is on, so a panel opens beside it. */
function currentDisplay(window) {
  if (!window) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(window.getBounds());
}

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
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          // Multi-monitor work: move this window to the next screen without
          // dragging it through a display boundary.
          label: 'Move to next display',
          click: () => {
            if (!mainWindow) return;
            const displays = screen.getAllDisplays();
            if (displays.length < 2) {
              dialog.showMessageBox({
                type: 'info',
                title: 'One display',
                message: 'Only one display is connected',
                detail: 'Connect a second monitor or tablet in extended mode, then try again.',
                buttons: ['OK'],
                noLink: true,
              }).catch(() => {});
              return;
            }
            const current = screen.getDisplayMatching(mainWindow.getBounds());
            const index = displays.findIndex((display) => display.id === current.id);
            const next = displays[(index + 1) % displays.length];
            const bounds = mainWindow.getBounds();
            mainWindow.setBounds({
              x: next.workArea.x + Math.round((next.workArea.width - bounds.width) / 2),
              y: next.workArea.y + Math.round((next.workArea.height - bounds.height) / 2),
              width: bounds.width,
              height: bounds.height,
            });
          },
        },
        {
          label: 'MIDI panel in its own window',
          click: () => void openPanelWindow('midi'),
        },
        {
          label: 'Studio Rig in its own window',
          click: () => void openPanelWindow('rig'),
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

/**
 * Opens one floating panel (MIDI, Studio Rig) as its own window.
 *
 * The same interface is loaded with `?panel=<name>`; the page hides the app
 * chrome in that mode and shows only the panel. That keeps one build and one
 * source of truth instead of a second, thinner window UI to maintain.
 */
async function openPanelWindow(panel) {
  if (!uiServer) return false;
  const name = String(panel || '').replace(/[^a-z0-9-]/gi, '');
  if (!name) return false;

  const existing = panelWindows.get(name);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return true;
  }

  const display = currentDisplay(mainWindow);
  const area = display.workArea;

  const window = new BrowserWindow({
    width: Math.min(460, Math.round(area.width * 0.4)),
    height: Math.min(900, area.height),
    minWidth: 320,
    minHeight: 420,
    x: Math.min(area.x + area.width - 480, area.x + area.width - 460),
    y: Math.min(area.y + 40, area.y + area.height - 400),
    resizable: true,
    maximizable: true,
    backgroundColor: '#08090c',
    title: name === 'midi' ? 'Tone Art Studio — MIDI' : 'Tone Art Studio — Studio Rig',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  window.loadURL(`${uiServer.url}?panel=${name}`).catch((error) => {
    reportFailure('The panel window could not open', String(error && error.message ? error.message : error));
  });

  window.on('closed', () => panelWindows.delete(name));
  panelWindows.set(name, window);
  return true;
}

async function createWindow() {
  uiServer = await startUiServer(uiDirectory);

  // Remembered bounds, but never smaller than the layout can use and never
  // off-screen: a saved position on a monitor that is no longer connected
  // would otherwise open the window where it cannot be seen.
  const saved = readWindowState();
  const area = screen.getPrimaryDisplay().workArea;
  const width = saved ? Math.max(960, Math.min(saved.width, area.width)) : Math.min(1500, area.width);
  const height = saved ? Math.max(600, Math.min(saved.height, area.height)) : Math.min(950, area.height);
  const x = saved && Number.isFinite(saved.x) ? Math.min(Math.max(saved.x, area.x), area.x + area.width - 200) : undefined;
  const y = saved && Number.isFinite(saved.y) ? Math.min(Math.max(saved.y, area.y), area.y + area.height - 150) : undefined;

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 960,
    minHeight: 600,
    // Explicit: a music app is worked in at several sizes, and the layout is
    // built for it. Nothing in this shell should pin the window.
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    // Dark from the first frame: a white flash before the interface paints is
    // why a slow start is so often reported as a blank window.
    backgroundColor: '#08090c',
    show: false,
    title: 'Tone Art Studio',
    autoHideMenuBar: false,
    webPreferences: {
      // The interface is a web app; it needs no access to Node.
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keep the size the user chose for the next launch.
  mainWindow.on('resized', () => saveWindowState(mainWindow));
  mainWindow.on('moved', () => saveWindowState(mainWindow));
  mainWindow.on('close', () => saveWindowState(mainWindow));

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

  // Clear any service worker and cache storage this origin accumulated. An
  // earlier build registered one, and a worker answering from its cache can
  // outlive an update and serve an old page whose script no longer exists —
  // the interface paints but every control in it is dead. The desktop app has
  // its own installer, so it needs no offline cache at all.
  try {
    await mainWindow.webContents.session.clearStorageData({
      storages: ['serviceworkers', 'cachestorage'],
    });
  } catch (error) {
    console.error('could not clear the old offline cache: ' + (error && error.message));
  }

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

  // The interface asks for a panel window through the preload bridge.
  ipcMain.handle('tas:open-panel', (_event, panel) => openPanelWindow(panel));

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
