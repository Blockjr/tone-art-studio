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
let remoteBridge = null;
let quitting = false;
/** Console windows opened from the studio, keyed by console name. */
const panelWindows = new Map();

/**
 * Every console that can have a window of its own.
 *
 * The key is the id the interface reads from `?panel=<id>` (src/ui/consoles.ts
 * is the other end of this list — a console added there is added here). The
 * width and height are what its window opens at the first time; after that the
 * size and position the user chose are remembered and reused.
 */
const PANELS = {
  mixer: { title: 'Mixer', width: 1180, height: 580 },
  notes: { title: 'Notes', width: 1080, height: 700 },
  preview: { title: 'Audio Preview', width: 980, height: 440 },
  takes: { title: 'Takes', width: 420, height: 840 },
  midi: { title: 'MIDI', width: 420, height: 860 },
  rig: { title: 'Studio Rig', width: 420, height: 900 },
  browser: { title: 'Browser', width: 420, height: 840 },
  rack: { title: 'Device Rack', width: 420, height: 840 },
};

/** Where window size and position are remembered between launches. */
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** A remembered rectangle is only worth reusing if it is still on a screen. */
function onSomeDisplay(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return false;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(area.x + area.width, bounds.x + bounds.width) - Math.max(area.x, bounds.x);
    const overlapY = Math.min(area.y + area.height, bounds.y + bounds.height) - Math.max(area.y, bounds.y);
    return overlapX >= 120 && overlapY >= 80;
  });
}

/**
 * The remembered rectangles for the studio window and every console window.
 *
 * Read once and kept in memory: several windows write to this file as they are
 * moved, and a read-modify-write race between them would lose one of the two
 * positions. It is deliberately resilient — a settings folder that cannot be
 * written must never stop the app from opening or closing.
 */
let windowState = { main: null, panels: {} };

function readWindowState() {
  try {
    const raw = fs.readFileSync(windowStatePath(), 'utf8');
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object') return { main: null, panels: {} };
    // Builds before console windows wrote the studio rectangle on its own.
    if (Number.isFinite(state.width) && Number.isFinite(state.height)) {
      return { main: state, panels: {} };
    }
    return {
      main: onSomeDisplay(state.main) ? state.main : null,
      panels: state.panels && typeof state.panels === 'object' ? state.panels : {},
    };
  } catch {
    // First launch, or the file was cleared: the defaults are fine.
    return { main: null, panels: {} };
  }
}

function writeWindowState() {
  try {
    fs.writeFileSync(windowStatePath(), JSON.stringify(windowState));
  } catch {
    // A read-only settings folder must not stop the app from closing.
  }
}

/**
 * Remembers a window rectangle, but only while it is a normal window: a
 * maximised or full-screen window would otherwise be remembered as a
 * screen-sized box, and a minimised one as the dot it is parked in.
 */
function rememberBounds(key, window, panel = null) {
  if (!window || window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return;
  const bounds = window.getBounds();
  if (panel) windowState.panels[panel] = bounds;
  else windowState.main = bounds;
  writeWindowState();
}

/** Where a console opens when it has no remembered place: beside the studio. */
function defaultPanelBounds(spec) {
  const display = currentDisplay(mainWindow);
  const area = display.workArea;
  const width = Math.max(320, Math.min(spec.width, area.width));
  const height = Math.max(260, Math.min(spec.height, area.height));

  const studio = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : area;
  // Stepped per open console, so three of them do not land exactly on top of
  // each other in the same corner.
  const step = panelWindows.size * 28;
  const x = Math.min(Math.max(area.x + 12 + step, area.x), area.x + area.width - 200);
  const y = Math.min(studio.y + 60 + step, area.y + area.height - 160);
  return { x, y, width, height };
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

  // Never interrupt a window that is closing. A dialog raised while the app is
  // shutting down keeps it alive until someone dismisses it, which is the
  // difference between "it closes" and "it will not close".
  if (app.isReady() && !quitting) {
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
    remoteBridge = await import(pathToFileURL(path.join(root, 'server', 'remote.mjs')).href);
    console.log('tablet bridge listening on port ' + process.env.REMOTE_PORT);
  } catch (error) {
    console.error('tablet bridge did not start: ' + (error && error.message));
  }
}

/**
 * Quits the app in one movement: consoles, then the studio, then the bridge.
 *
 * The bridge is started inside this process and holds a listening socket and a
 * WebSocket per tablet. Left alone it keeps the process alive after the last
 * window has gone, so closing the app appears to do nothing at all.
 */
function beginQuit() {
  if (quitting) return;
  quitting = true;
  closeAllPanels();

  if (remoteBridge && typeof remoteBridge.stopRemoteBridge === 'function') {
    remoteBridge.stopRemoteBridge().catch(() => {});
  }

  app.quit();
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Quit Tone Art Studio',
          accelerator: 'CmdOrCtrl+Q',
          click: () => beginQuit(),
        },
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
      label: 'Consoles',
      submenu: [
        ...Object.entries(PANELS).map(([id, spec]) => ({
          label: `Open ${spec.title}`,
          click: () => void openPanelWindow(id),
        })),
        { type: 'separator' },
        { label: 'Close all console windows', click: () => closeAllPanels() },
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
          // Multi-monitor work: move the window you are working in — studio or
          // console — to the next screen without dragging it across a boundary.
          label: 'Move this window to the next display',
          click: () => {
            const target = BrowserWindow.getFocusedWindow() || mainWindow;
            if (!moveToNextDisplay(target)) explainsOneDisplay('One display');
          },
        },
        { type: 'separator' },
        ...Object.entries(PANELS).map(([id, spec]) => ({
          label: `${spec.title} in its own window`,
          click: () => void openPanelWindow(id),
        })),
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
  const spec = PANELS[name];
  if (!spec) return false;

  const existing = panelWindows.get(name);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return true;
  }

  // The place the user left it, when that screen is still connected; otherwise
  // beside the studio window rather than where a monitor used to be.
  const remembered = windowState.panels[name];
  const bounds = onSomeDisplay(remembered) ? remembered : defaultPanelBounds(spec);

  const window = new BrowserWindow({
    ...bounds,
    // Small enough for a phone-sized second screen, tall enough for a fader.
    minWidth: 320,
    minHeight: 260,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    backgroundColor: '#08090c',
    title: `${spec.title} — Tone Art Studio`,
    // The console is the whole window: it carries its own controls, so it needs
    // no menu bar of its own. Alt still brings the app menu up.
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
    reportFailure('The console window could not open', String(error && error.message ? error.message : error));
  });

  // Each console keeps its own size and place, including on another screen.
  window.on('resized', () => rememberBounds('panel', window, name));
  window.on('moved', () => rememberBounds('panel', window, name));
  window.on('close', () => rememberBounds('panel', window, name));
  window.on('closed', () => panelWindows.delete(name));
  panelWindows.set(name, window);
  return true;
}

/** Closes every console window; the studio window stays where it is. */
function closeAllPanels() {
  for (const [name, window] of [...panelWindows]) {
    if (!window.isDestroyed()) {
      rememberBounds('panel', window, name);
      window.close();
    }
  }
  panelWindows.clear();
}

/**
 * Moves a window to the next display, and returns false when there is only one.
 *
 * Dragging a window across a display boundary is fiddly and easy to get wrong
 * on mixed-DPI setups, so the common "put the mixer on the other monitor" is
 * also a command. It acts on whichever window has focus, which is what makes it
 * work for a console window as well as for the studio.
 */
function moveToNextDisplay(target) {
  if (!target || target.isDestroyed()) return false;
  const displays = screen.getAllDisplays();
  if (displays.length < 2) return false;

  const current = screen.getDisplayMatching(target.getBounds());
  const index = displays.findIndex((display) => display.id === current.id);
  const next = displays[(index + 1) % displays.length];
  const bounds = target.getBounds();

  target.setBounds({
    x: next.workArea.x + Math.round((next.workArea.width - bounds.width) / 2),
    y: next.workArea.y + Math.round((next.workArea.height - bounds.height) / 2),
    width: bounds.width,
    height: bounds.height,
  });
  target.focus();
  return true;
}

function explainsOneDisplay(title) {
  dialog.showMessageBox({
    type: 'info',
    title,
    message: 'Only one display is connected',
    detail: 'Connect a second monitor or a tablet in extended mode, then try again.',
    buttons: ['OK'],
    noLink: true,
  }).catch(() => {});
}

async function createWindow() {
  uiServer = await startUiServer(uiDirectory);

  // Remembered bounds, but never smaller than the layout can use and never
  // off-screen: a saved position on a monitor that is no longer connected
  // would otherwise open the window where it cannot be seen.
  windowState = readWindowState();
  const saved = windowState.main;
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
  mainWindow.on('resized', () => rememberBounds('main', mainWindow));
  mainWindow.on('moved', () => rememberBounds('main', mainWindow));

  // Closing the studio closes the consoles with it. Without this the app stays
  // alive with a mixer window still on screen and no studio to go back to,
  // which reads as "the program will not close".
  mainWindow.on('close', () => {
    rememberBounds('main', mainWindow);
    closeAllPanels();
  });

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

  // The interface asks for a console window through the preload bridge.
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
    beginQuit();
  });

  app.on('before-quit', () => {
    quitting = true;
    closeAllPanels();
    if (uiServer) uiServer.close().catch(() => {});
    if (remoteBridge && typeof remoteBridge.stopRemoteBridge === 'function') {
      remoteBridge.stopRemoteBridge().catch(() => {});
    }
  });

  // Last resort, and the reason closing always finishes: if something holds the
  // process open — a socket that will not close, a stuck driver — end it rather
  // than leave a window that will not go away. Everything the app owns has been
  // written to disk by this point, and the unref means a process that exits on
  // its own is never delayed by this timer.
  app.on('will-quit', () => {
    setTimeout(() => {
      console.error('Tone Art Studio did not exit in time; ending the process.');
      app.exit(0);
    }, 2000).unref?.();
  });
}
