'use strict';

/**
 * Starts the desktop main process with a stand-in `electron` module and checks
 * that it does what the shell must do before it ever draws a window:
 *
 *   - serve the built interface over loopback and hand that URL to the window
 *   - wait for the first frame before showing it
 *   - keep the window on the app's own origin
 *
 * Chromium itself is not involved here, so this runs anywhere Node runs:
 *
 *     node desktop/smoke-test.cjs
 */

const Module = require('node:module');
const path = require('node:path');
const assert = require('node:assert');

const calls = { loadedUrl: null, shown: false, menu: false };

const FAKE_DISPLAY = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

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
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.handlers = {};
    FakeBrowserWindow.instances.push(this);
  }

  static instances = [];

  static getAllWindows() { return FakeBrowserWindow.instances; }

  once(event, handler) { this.handlers[event] = handler; }

  on(event, handler) { this.handlers[event] = handler; }

  async loadURL(url) {
    calls.loadedUrl = url;
    const response = await fetch(url);
    assert.strictEqual(response.status, 200, 'the interface origin must answer');
    const html = await response.text();
    assert.ok(html.includes('id="app"'), 'the served page must be the application');
    // The window is only shown after the page is in hand, never before.
    assert.strictEqual(calls.shown, false, 'the window must not show before loading');
    if (this.handlers['ready-to-show']) this.handlers['ready-to-show']();
  }

  show() { calls.shown = true; }

  isMinimized() { return false; }

  restore() {}

  focus() {}
}

const fakeElectron = {
  app: {
    isReady: () => true,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    getPath: () => path.join(require('node:os').tmpdir(), 'tone-art-smoke'),
  },
  // The shell registers the panel IPC channel as it loads. Without ipcMain the
  // main process throws before any window exists, which is exactly the failure
  // this test exists to catch.
  ipcMain: {
    handlers: {},
    handle(channel, handler) { this.handlers[channel] = handler; },
  },
  // One 1920x1080 display: the shell reads its work area to size the window and
  // asks for the window's own display when it opens a floating panel.
  screen: {
    getPrimaryDisplay: () => FAKE_DISPLAY,
    getDisplayMatching: () => FAKE_DISPLAY,
    getAllDisplays: () => [FAKE_DISPLAY],
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

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return load.apply(this, arguments);
};

require('./main.cjs');

setTimeout(() => {
  assert.ok(calls.loadedUrl, 'the window was never given a URL');
  assert.match(calls.loadedUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'the window must load the loopback origin');
  assert.ok(calls.shown, 'the window was never shown');
  assert.ok(calls.menu, 'the menu was never built');
  assert.strictEqual(FakeBrowserWindow.instances.length, 1, 'exactly one window is created');

  const window = FakeBrowserWindow.instances[0];
  assert.strictEqual(window.options.webPreferences.nodeIntegration, false, 'the page must not get Node');
  assert.strictEqual(window.options.webPreferences.contextIsolation, true, 'the page must be isolated');
  assert.strictEqual(window.options.backgroundColor, '#08090c', 'the first frame must be dark, not white');

  console.log('desktop shell smoke test passed');
  console.log('  window loaded :', calls.loadedUrl);
  console.log('  shown after load, one window, menu built, page isolated');
  process.exit(0);
}, 1500);
