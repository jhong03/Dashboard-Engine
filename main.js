'use strict';

// Electron main process. Stage 1: just a window shell — the synthesis
// pipeline lives in lib/ and is exercised by `npm run smoke`. IPC handlers
// that bridge the renderer to the pipeline arrive with the UI (Stage 4);
// per CLAUDE.md every one of them must validate its input.

const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1100, // design floor — layout must never break under 1100px
    backgroundColor: '#04080F',
    webPreferences: {
      // Non-negotiable (CLAUDE.md): the renderer never touches Node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    // macOS convention: re-create the window on dock click.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS convention: app stays alive without windows.
  if (process.platform !== 'darwin') app.quit();
});
