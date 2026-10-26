'use strict';

/**
 * The only bridge between the interface and the desktop shell.
 *
 * It exposes a deliberately small surface: move a floating panel into its own
 * window, and read what the shell knows about the machine. Nothing here gives
 * the page file-system or process access, and the interface works without it
 * (in a browser `window.tas` is simply absent).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tas', {
  /** Opens one floating panel as its own window, for a second screen. */
  openPanel: (panel) => ipcRenderer.invoke('tas:open-panel', String(panel)),
  /** 'desktop' in the app, absent in a browser. */
  platform: 'desktop',
  version: process.env.npm_package_version || '',
});
