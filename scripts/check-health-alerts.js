'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueue, createPlayer } = require('../src/health-alert-queue');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const payload = (metric, severity = 1) => ({ metric, severity, value: 95 });
const clip = { ok: true, pcm: new Uint8Array([0, 0, 255, 127]), sampleRate: 22050 };

test('burst alerts stay FIFO through playback completion and the two-second cooldown', async () => {
  const events = [];
  let time = 0;
  const playing = [];
  const gaps = [];
  const queue = createQueue({
    now: () => time,
    request: async (item) => { events.push(item.metric); return clip; },
    play: () => { const gate = deferred(); playing.push(gate); return gate.promise; },
    wait: (ms) => { const gate = deferred(); gaps.push({ ms, gate }); return gate.promise; },
  });
  queue.enqueue(payload('CPU'));
  queue.enqueue(payload('DISK'));
  queue.enqueue(payload('MEM'));
  queue.enqueue(payload('CPU')); // duplicate while pending/current
  await tick();
  assert.deepEqual(events, ['CPU']);
  assert.equal(playing.length, 1);
  playing[0].resolve(true);
  await tick();
  assert.deepEqual(events, ['CPU']);
  assert.equal(gaps[0].ms, 2000);
  time += 2000;
  gaps[0].gate.resolve();
  await tick();
  assert.deepEqual(events, ['CPU', 'DISK']);
  playing[1].resolve(true);
  await tick();
  time += 2000;
  gaps[1].gate.resolve();
  await tick();
  assert.deepEqual(events, ['CPU', 'DISK', 'MEM']);
  playing[2].resolve(true);
  await queue.idle();
});

test('failed synthesis or playback cannot strand later alerts', async () => {
  const spoken = [];
  let attempts = 0;
  const queue = createQueue({ cooldownMs: 0,
    request: async (item) => { if (item.metric === 'CPU') throw new Error('engine failed'); return { ...clip, metric: item.metric }; },
    play: async () => { attempts++; if (attempts === 1) throw new Error('device failed'); spoken.push('finished'); },
  });
  queue.enqueue(payload('CPU'));
  queue.enqueue(payload('MEM'));
  queue.enqueue(payload('DISK'));
  await queue.idle();
  assert.equal(attempts, 2);
  assert.deepEqual(spoken, ['finished']);
});

test('recovered metrics are removed before synthesis and clears bypass the queue', async () => {
  const first = deferred();
  const requests = [];
  const queue = createQueue({ cooldownMs: 0,
    request: async (item) => { requests.push([item.metric, item.severity]); return item.severity ? clip : { ok: false }; },
    play: () => first.promise,
  });
  queue.enqueue(payload('CPU'));
  queue.enqueue(payload('DISK'));
  await tick();
  await queue.enqueue(payload('DISK', 0));
  assert.deepEqual(requests, [['CPU', 1], ['DISK', 0]]);
  first.resolve(true);
  await queue.idle();
  assert.deepEqual(requests, [['CPU', 1], ['DISK', 0]]);
});

test('a clear during synthesis discards obsolete audio and allows a later retrip', async () => {
  const synth = deferred();
  let synths = 0;
  let plays = 0;
  const queue = createQueue({ cooldownMs: 0,
    request: (item) => item.severity === 0 ? Promise.resolve({ ok: false }) : (++synths === 1 ? synth.promise : Promise.resolve(clip)),
    play: async () => { plays++; return true; },
  });
  queue.enqueue(payload('CPU'));
  await tick();
  await queue.enqueue(payload('CPU', 0));
  queue.enqueue(payload('CPU'));
  synth.resolve(clip);
  await queue.idle();
  assert.equal(synths, 2);
  assert.equal(plays, 1);
});

test('disable cancels current playback and backlog; re-enable only plays new alerts', async () => {
  const audio = deferred();
  const requests = [];
  let plays = 0;
  const queue = createQueue({ cooldownMs: 0,
    request: async (item) => { requests.push(item.metric); return clip; },
    play: () => ++plays === 1 ? audio.promise : Promise.resolve(true),
    stop: () => audio.resolve(false),
  });
  queue.enqueue(payload('CPU'));
  queue.enqueue(payload('MEM'));
  await tick();
  queue.setEnabled(false);
  queue.enqueue(payload('DISK'));
  queue.setEnabled(true);
  queue.enqueue(payload('BATTERY'));
  await queue.idle();
  assert.deepEqual(requests, ['CPU', 'BATTERY']);
  assert.equal(plays, 2);
});

test('disable during synthesis prevents a late clip from starting', async () => {
  const synth = deferred();
  let plays = 0;
  const queue = createQueue({ request: () => synth.promise, play: async () => { plays++; } });
  queue.enqueue(payload('CPU'));
  await tick();
  queue.setEnabled(false);
  synth.resolve(clip);
  await queue.idle();
  assert.equal(plays, 0);
});

function audioFixture() {
  const sources = [];
  const buffers = [];
  const context = { state: 'running', destination: {},
    createBuffer: () => ({ copyToChannel: (data) => buffers.push(Array.from(data)) }),
    createBufferSource: () => {
      const source = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    },
  };
  return { context, sources, buffers };
}

test('PCM playback waits for onended, including non-aligned PCM bytes', async () => {
  const fixture = audioFixture();
  const player = createPlayer(() => fixture.context);
  let finished = false;
  const pcm = new Uint8Array([99, 0, 0, 255, 127]).subarray(1);
  const completion = player.play(pcm, 22050).then((value) => { finished = true; return value; });
  await tick();
  assert.equal(finished, false);
  assert.deepEqual(fixture.buffers[0], [0, 32767 / 32768]);
  fixture.sources[0].onended();
  assert.equal(await completion, true);
});

test('stopping a suspended context prevents delayed playback after resume', async () => {
  const fixture = audioFixture();
  const resume = deferred();
  fixture.context.state = 'suspended';
  fixture.context.resume = () => resume.promise;
  const player = createPlayer(() => fixture.context);
  const completion = player.play(clip.pcm, 22050);
  player.stop();
  assert.equal(await completion, false);
  resume.resolve();
  await tick();
  assert.equal(fixture.sources.length, 0);
});

test('unavailable audio device settles instead of blocking the queue', async () => {
  const player = createPlayer(() => { throw new Error('no device'); });
  assert.equal(await player.play(clip.pcm, 22050), false);
});

// Execute the actual IPC handler with native/synthesis dependencies stubbed.
// This exercises clears/settings changes arriving while a cold synth is pending.
function mainHandlerFixture() {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const source = fs.readFileSync(path.join(__dirname, '../lib/ipc.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('aegis:health:alert',");
  const end = source.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start >= 0 && end > start);
  const synth = deferred();
  let handler;
  const context = { ipcMain: { handle: (_, fn) => { handler = fn; } },
    fail: (error) => ({ ok: false, error }), settings: { getHealthVoiceAlerts: () => true },
    userDir: '', llm: { isRunning: () => false }, healthAlertBy: {}, healthAlertVersions: {}, healthVoiceEpoch: 0,
    lastAssistantActivityAt: 0, ASSISTANT_QUIET_MS: 4000,
    composeHealthAlert: () => 'Test alert', assistantVoiceLang: () => 'en', synthSpeech: () => synth.promise,
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { handler, context, synth };
}

test('main does not re-arm a cleared metric with a late synthesis result', async () => {
  const { handler, context, synth } = mainHandlerFixture();
  const result = handler({}, payload('CPU'));
  await handler({}, payload('CPU', 0));
  synth.resolve(clip);
  assert.equal((await result).skipped, 'cancelled');
  assert.equal(context.healthAlertBy.CPU, undefined);
});

test('main discards synthesis from before a voice-alert setting change', async () => {
  const { handler, context, synth } = mainHandlerFixture();
  const result = handler({}, payload('DISK'));
  context.healthVoiceEpoch++;
  synth.resolve(clip);
  assert.equal((await result).skipped, 'cancelled');
  assert.equal(context.healthAlertBy.DISK, undefined);
});
