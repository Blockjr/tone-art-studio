'use strict';

/**
 * Starts the desktop main process with a stand-in `electron` module and checks
 * that it does what the shell must do before it ever draws a window:
 *
 *   - serve the built interface over loopback and hand that URL to the window
 *   - wait for the first frame before showing it
 *   - keep the window on the app's own origin
 *   - open a console in its own resizable window, and remember where it was
 *   - close the consoles when the studio closes, and quit when the last window
 *     is gone
 *
 * Chromium itself is not involved here, so this runs anywhere Node runs:
 *
 *     node desktop/smoke-test.cjs
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const calls = { loadedUrl: null, shown: false, menu: false, quit: 0, opened: [] };

const FAKE_DISPLAY = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const SECOND_DISPLAY = { id: 2, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };
let displays = [FAKE_DISPLAY];

class FakeWebContents {
  constructor() {
    this.handlers = {};
    this.windowOpenHandler = null;
    // The shell clears the offline cache before the first load. It has to be
    // here: without it the shell logs a failure on every launch, and a test
    // that only ever sees the fallback path cannot tell that apart from a
    // broken build.
    this.session = {
      cleared: 0,
      clearStorageData() { this.cleared += 1; return Promise.resolve(); },
    };
  }

  on(event, handler) { this.handlers[event] = handler; }

  once(event, handler) { this.handlers[event] = handler; }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
}

class FakeBrowserWindow {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 800,
      height: options.height ?? 600,
    };
    this.webContents = new FakeWebContents();
    this.handlers = {};
    this.destroyed = false;
    FakeBrowserWindow.instances.push(this);
  }

  static getAllWindows() { return FakeBrowserWindow.instances.filter((window) => !window.destroyed); }

  once(event, handler) { this.handlers[event] = handler; }

  on(event, handler) { this.handlers[event] = handler; }

  emit(event, ...args) {
    if (this.handlers[event]) this.handlers[event](...args);
  }

  async loadURL(url) {
    calls.loadedUrl = url;
    calls.opened.push(url);
    const response = await fetch(url);
    assert.strictEqual(response.status, 200, 'the interface origin must answer');
    const html = await response.text();
    assert.ok(html.includes('id="app"'), 'the served page must be the application');
    // The window is only shown after the page is in hand, never before.
    if (this.options.show === false) {
      assert.strictEqual(calls.shown, false, 'the window must not show before loading');
      if (this.handlers['ready-to-show']) this.handlers['ready-to-show']();
    }
  }

  show() { calls.shown = true; }

  isDestroyed() { return this.destroyed; }

  isMinimized() { return false; }

  isMaximized() { return false; }

  isFullScreen() { return false; }

  getBounds() { return { ...this.bounds }; }

  setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }

  restore() {}

  focus() {}

  close() {
    this.emit('close');
    this.destroyed = true;
    this.emit('closed');
    FakeBrowserWindow.instances = FakeBrowserWindow.instances.filter((window) => window !== this);
    // Electron reports this once nothing is left open.
    if (FakeBrowserWindow.instances.length === 0) appHandlers['window-all-closed']?.();
  }
}

const appHandlers = {};

const fakeElectron = {
  app: {
    isReady: () => true,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (event, handler) => { appHandlers[event] = handler; },
    quit: () => { calls.quit += 1; },
    exit: () => {},
    getPath: () => path.join(os.tmpdir(), 'tone-art-smoke'),
  },
  // The shell registers the panel IPC channel as it loads. Without ipcMain the
  // main process throws before any window exists, which is exactly the failure
  // this test exists to catch.
  ipcMain: {
    handlers: {},
    handle(channel, handler) { this.handlers[channel] = handler; },
  },
  // Two displays, so "move this window to the next display" has somewhere to go.
  screen: {
    getPrimaryDisplay: () => FAKE_DISPLAY,
    getDisplayMatching: () => displays[0],
    getAllDisplays: () => displays,
  },
  BrowserWindow: FakeBrowserWindow,
  Menu: {
    buildFromTemplate: () => {
      calls.menu = true;
      return [];
    },
    setApplicationMenu: () => {},
  },
  dialog: {
    showMessageBox: async () => ({ response: 1 }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
  },
};

// Electron creates the settings folder before the app sees it; the shell writes
// its window rectangles there, so the stand-in has to exist too.
fs.mkdirSync(path.join(os.tmpdir(), 'tone-art-smoke'), { recursive: true });

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return load.apply(this, arguments);
};

require('./main.cjs');

async function main() {
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(calls.loadedUrl, 'the window was never given a URL');
  assert.match(calls.loadedUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'the window must load the loopback origin');
  assert.ok(calls.shown, 'the window was never shown');
  assert.ok(calls.menu, 'the menu was never built');
  assert.strictEqual(FakeBrowserWindow.instances.length, 1, 'exactly one window is created');

  const studio = FakeBrowserWindow.instances[0];
  assert.strictEqual(studio.options.webPreferences.nodeIntegration, false, 'the page must not get Node');
  assert.strictEqual(studio.options.webPreferences.contextIsolation, true, 'the page must be isolated');
  assert.strictEqual(studio.options.backgroundColor, '#08090c', 'the first frame must be dark, not white');
  assert.strictEqual(studio.options.resizable, true, 'the studio window must be resizable');

  // ------------------------------------------------------- console windows
  // Two screens from here on: a console's remembered place is only reused when
  // the display it was on is still connected, which is the next thing checked.
  displays = [FAKE_DISPLAY, SECOND_DISPLAY];

  const openPanel = fakeElectron.ipcMain.handlers['tas:open-panel'];
  assert.ok(openPanel, 'the interface must be able to ask for a console window');

  assert.strictEqual(await openPanel(null, 'mixer'), true, 'the mixer console must open');
  await new Promise((resolve) => setTimeout(resolve, 60));

  const mixer = FakeBrowserWindow.instances.find((window) => window !== studio);
  assert.ok(mixer, 'a console window must exist');
  assert.match(mixer.options.title, /^Mixer — Tone Art Studio$/, 'the console window is named for its console');
  assert.strictEqual(mixer.options.resizable, true, 'a console must be resizable on its own');
  assert.strictEqual(mixer.options.maximizable, true, 'a console must be maximizable on its own');
  assert.strictEqual(mixer.options.minWidth, 320, 'a console must stay usable at a narrow width');
  assert.ok(calls.opened.some((url) => url.endsWith('?panel=mixer')), 'the console window loads its own console');

  // A console that is asked for twice is brought forward, not duplicated.
  await openPanel(null, 'mixer');
  assert.strictEqual(
    FakeBrowserWindow.instances.filter((window) => window !== studio).length,
    1,
    'the same console must not open twice',
  );

  // And a second console is a second window.
  await openPanel(null, 'midi');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(FakeBrowserWindow.instances.length, 3, 'each console gets its own window');
  // A console nobody has asked for yet is not a window.
  assert.strictEqual(await openPanel(null, 'nonsense'), false, 'an unknown console must not open a window');

  // Where the user puts a console is where it comes back.
  mixer.setBounds({ x: 1920, y: 120, width: 900, height: 640 });
  mixer.emit('moved');
  mixer.emit('resized');
  mixer.close();
  await new Promise((resolve) => setTimeout(resolve, 40));

  await openPanel(null, 'mixer');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const reopened = FakeBrowserWindow.instances.find(
    (window) => window !== studio && /Mixer/.test(window.options.title),
  );
  assert.deepStrictEqual(
    { x: reopened.bounds.x, y: reopened.bounds.y, width: reopened.bounds.width, height: reopened.bounds.height },
    { x: 1920, y: 120, width: 900, height: 640 },
    'a console must reopen where it was left, including on another display',
  );

  const saved = JSON.parse(fs.readFileSync(path.join(fakeElectron.app.getPath(), 'window-state.json'), 'utf8'));
  assert.deepStrictEqual(
    saved.panels && saved.panels.mixer,
    { x: 1920, y: 120, width: 900, height: 640 },
    'the console rectangle must be remembered on disk, as the user left it',
  );

  // A place on a screen that is no longer connected is not a place to open a
  // window: it must land on the screen that is connected, not off the edge.
  displays = [FAKE_DISPLAY];
  reopened.setBounds({ x: 9000, y: 9000, width: 400, height: 300 });
  reopened.emit('moved');
  reopened.close();
  await new Promise((resolve) => setTimeout(resolve, 40));

  await openPanel(null, 'mixer');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const recovered = FakeBrowserWindow.instances.find(
    (window) => window !== studio && /Mixer/.test(window.options.title),
  );
  assert.ok(
    recovered.bounds.x >= 0 && recovered.bounds.x < 1920 && recovered.bounds.y < 1080,
    'a console remembered off-screen must open on the screen that is connected',
  );

  // ------------------------------------------------------------- closing
  // Closing the studio closes the consoles with it: an app that leaves a mixer
  // window on screen with no studio behind it looks like it will not close.
  assert.ok(FakeBrowserWindow.instances.length > 1, 'there must be consoles open for this to mean anything');
  studio.close();

  assert.strictEqual(
    FakeBrowserWindow.instances.length,
    0,
    'every console must close with the studio window',
  );
  assert.ok(calls.quit > 0, 'the app must quit once its last window has closed');

  // The bridge socket is released on the way out, so nothing holds the process.
  appHandlers['before-quit']?.();
  assert.ok(appHandlers['will-quit'], 'a last-resort exit must be registered');

  console.log('desktop shell smoke test passed');
  console.log('  studio window :', calls.loadedUrl);
  console.log('  shown after load, one window, menu built, page isolated');
  console.log('  consoles      : own window, resizable, remembered position, closed with the studio');
  process.exit(0);
}

main().catch((error) => {
  console.error('desktop shell smoke test FAILED');
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
