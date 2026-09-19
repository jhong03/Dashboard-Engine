// Run with Electron on Windows. Uses a temporary profile and disposable window;
// never opens the real application or reads its user settings.
const { app, BrowserWindow, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'de-attach-check-'));
app.setPath('userData', profile);
const helper = path.join(__dirname, 'desktop-attach.ps1');
const fullscreenHelper = path.join(__dirname, 'fullscreen-watch.ps1');
function call(script, hwnd, args = []) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, hwnd, ...args], { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      const result = { code: error ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim() };
      console.log(JSON.stringify(result));
      resolve(result);
    });
  });
}
let win;
// Keep the process alive to check the destroyed-handle case.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    const display = screen.getPrimaryDisplay();
    const monitors = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
    const monitor = String(monitors.findIndex((d) => d.id === display.id));
    win = new BrowserWindow({ ...display.bounds, show: false, frame: false,
      focusable: true, skipTaskbar: true, resizable: false, movable: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadURL('data:text/html,<body>Dashboard attachment regression check</body>');
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE().toString();
    win.setBounds(display.bounds);
    await call(helper, hwnd, ['-Inspect']);
    const fullscreenState = () => call(fullscreenHelper, '-CheckWindow', [hwnd, '-Monitor', monitor]);
    assert.equal((await fullscreenState()).stdout, 'FULLSCREEN', 'ordinary fullscreen apps still pause the dashboard');
    assert.notEqual((await call(helper, hwnd, ['-Verify'])).code, 0, 'unattached popup must fail verification');
    if (process.env.DE_ATTACH_OLD_HELPER) {
      const old = await call(process.env.DE_ATTACH_OLD_HELPER, hwnd);
      const state = await call(helper, hwnd, ['-Inspect']);
      assert.notEqual(old.code, 0, 'old helper must reproduce the reported failure');
      assert.match(state.stdout, /class=(Progman|WorkerW)/, 'old helper actually attached the window');
      assert.match(state.stdout, /getParent=0 /, 'GetParent incorrectly reports no parent');
      console.log('REPRODUCED: old helper returns failure after successfully attaching popup');
    }
    assert.equal((await call(helper, hwnd, [monitor])).code, 0, 'attachment succeeds');
    assert.equal((await call(helper, hwnd, [monitor])).code, 0, 'reattachment is idempotent');
    assert.equal((await fullscreenState()).stdout, 'NORMAL', 'attached popup must not pause itself when focused');
    win.showInactive();
    assert.equal((await call(helper, hwnd, ['-Verify'])).code, 0, 'visible popup remains attached');
    win.hide();
    assert.match((await call(helper, hwnd, ['-Verify'])).stdout, /verify-failed child-hidden/);
    win.destroy();
    assert.match((await call(helper, hwnd, ['-Verify'])).stdout, /verify-failed invalid-window/);
    console.log('PASS: desktop attachment regression checks');
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});
