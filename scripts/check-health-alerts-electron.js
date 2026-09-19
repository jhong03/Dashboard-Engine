// Silent real-Web-Audio check; no TTS download or personal profile required.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'de-audio-check-')));
app.whenReady().then(async () => {
  let win;
  try {
    win = new BrowserWindow({ show: false, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    } });
    await win.loadURL('data:text/html,<title>Silent voice queue check</title>');
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../src/health-alert-queue.js'), 'utf8'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const player = AegisHealthAlerts.createPlayer();
      const order = [], starts = [], ends = [], completed = [];
      let active = 0, maxActive = 0;
      const queue = AegisHealthAlerts.createQueue({ cooldownMs: 50,
        request: async ({ metric }) => { order.push(metric); return { ok: true, pcm: new Uint8Array(8820), sampleRate: 22050 }; },
        play: async (pcm, rate) => {
          starts.push(performance.now()); maxActive = Math.max(maxActive, ++active);
          const played = await player.play(pcm, rate);
          --active; ends.push(performance.now()); completed.push(played);
          if (!played) throw new Error('Real AudioContext did not finish playback');
          return true;
        }, stop: player.stop,
      });
      for (const metric of ['CPU', 'MEM', 'DISK']) queue.enqueue({ metric, severity: 1, value: 95 });
      await queue.idle();
      return { order, starts, ends, completed, maxActive };
    })()`);
    const assert = require('assert/strict');
    assert.deepEqual(result.order, ['CPU', 'MEM', 'DISK']);
    assert.equal(result.maxActive, 1);
    assert.equal(result.ends.length, 3);
    assert.deepEqual(result.completed, [true, true, true]);
    for (let i = 0; i < 3; i++) {
      assert.ok(result.ends[i] - result.starts[i] >= 150, 'waited for audible duration, not just source.start()');
      if (i) assert.ok(result.starts[i] - result.ends[i - 1] >= 45, 'cooldown follows playback end');
    }
    console.log('PASS: real Electron AudioContext, three FIFO clips, max simultaneous playback=1');
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error.stack); app.exit(1); }
});
setTimeout(() => { console.error('Audio regression check timed out'); app.exit(1); }, 15000);
