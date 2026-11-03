import test from 'node:test';
import assert from 'node:assert/strict';

import { createSoundChefWorker, classifyTab } from '../background/service-worker.js';
import { createFakeChrome, createFakeTimers } from './fake-chrome.js';

const PAGE = 1;
const SETTINGS = 2;
const NO_URL = 3;

function setup(options = {}) {
  const fake = createFakeChrome({
    tabs: {
      [PAGE]: { url: 'https://example.com/video', mutedInfo: { muted: false } },
      [SETTINGS]: { url: 'chrome://settings', mutedInfo: { muted: false } },
      [NO_URL]: { mutedInfo: { muted: false } }
    },
    ...options
  });
  const timers = createFakeTimers();
  const worker = createSoundChefWorker({ chromeApi: fake.chrome, timers });
  const send = (message) => worker.routeMessage({ target: 'sw', ...message });
  return { fake, timers, worker, send };
}

test('classifyTab treats a hidden URL as unknown, not restricted', () => {
  assert.deepEqual(classifyTab({ id: 1 }), { restricted: false, reason: '' });
  assert.equal(classifyTab(null).restricted, true);
  assert.equal(classifyTab({ url: 'chrome://flags' }).restricted, true);
  assert.equal(classifyTab({ url: 'https://example.com' }).restricted, false);
});

test('GET_STATE only reads and never captures', async () => {
  const { fake, send } = setup();
  const res = await send({ type: 'GET_STATE', tabId: PAGE });
  assert.deepEqual(res.state, { gain: 1, mono: false, balance: 0 });
  assert.equal(res.armed, false);
  assert.equal(res.restricted, false);
  assert.equal(fake.calls.getMediaStreamId, 0);
  assert.equal(fake.isDocumentOpen(), false);
});

test('GET_STATE explains restricted and unknown tabs', async () => {
  const { send } = setup();
  const settings = await send({ type: 'GET_STATE', tabId: SETTINGS });
  assert.equal(settings.restricted, true);
  assert.match(settings.reason, /Browser pages/);

  const hidden = await send({ type: 'GET_STATE', tabId: NO_URL });
  assert.equal(hidden.restricted, false);

  const gone = await send({ type: 'GET_STATE', tabId: 99 });
  assert.equal(gone.restricted, true);
  assert.match(gone.reason, /no longer available/);
});

test('a burst of SET_STATE arms once and lands the last value', async () => {
  const { fake, worker, send } = setup();
  const burst = [];
  for (let i = 1; i <= 20; i += 1) {
    burst.push(send({ type: 'SET_STATE', tabId: PAGE, patch: { gain: 1 + i * 0.1 } }));
  }
  const results = await Promise.all(burst);
  const last = results[results.length - 1];
  assert.equal(last.armed, true);
  assert.equal(last.state.gain, 3);
  assert.equal(fake.calls.getMediaStreamId, 1);
  assert.equal(fake.calls.offscreen.filter((t) => t === 'START').length, 1);
  assert.equal(fake.badges.get(PAGE), '300');
  assert.equal(worker.capture.inFlightCount(), 0);

  const meter = await send({ type: 'METER', tabId: PAGE });
  assert.equal(meter.ok, true);
});

test('SET_STATE clamps and returns the authoritative state', async () => {
  const { send } = setup();
  const res = await send({ type: 'SET_STATE', tabId: PAGE, patch: { gain: '3', balance: 4 } });
  assert.deepEqual(res.state, { gain: 1, mono: false, balance: 1 });
});

test('returning to default releases after the grace period', async () => {
  const { fake, timers, worker, send } = setup();
  await send({ type: 'SET_STATE', tabId: PAGE, patch: { mono: true } });
  assert.equal(fake.graphs.has(PAGE), true);

  await send({ type: 'SET_STATE', tabId: PAGE, patch: { mono: false } });
  assert.equal(worker.capture.pendingReleaseCount(), 1);
  assert.equal(fake.graphs.has(PAGE), true);

  timers.runAll();
  // Let the queued release run.
  await send({ type: 'GET_STATE', tabId: PAGE });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.graphs.has(PAGE), false);
  const after = await send({ type: 'GET_STATE', tabId: PAGE });
  assert.equal(after.armed, false);
});

test('RESET stops capture immediately', async () => {
  const { fake, send } = setup();
  await send({ type: 'SET_STATE', tabId: PAGE, patch: { gain: 2 } });
  const res = await send({ type: 'RESET', tabId: PAGE });
  assert.equal(res.armed, false);
  assert.deepEqual(res.state, { gain: 1, mono: false, balance: 0 });
  assert.equal(fake.graphs.has(PAGE), false);
  assert.equal(fake.badges.get(PAGE), '');
});

test('a failed arm is reported and briefly cached', async () => {
  const { fake, worker, send } = setup({ captureError: 'Extension has not been invoked for the current page.' });
  const first = await send({ type: 'SET_STATE', tabId: NO_URL, patch: { gain: 2 } });
  assert.equal(first.armed, false);
  const second = await send({ type: 'SET_STATE', tabId: NO_URL, patch: { gain: 2.5 } });
  assert.equal(second.armed, false);
  assert.equal(fake.calls.getMediaStreamId, 1);
  assert.equal(worker.capture.cachedFailureCount(), 1);

  const state = await send({ type: 'GET_STATE', tabId: NO_URL });
  assert.equal(state.restricted, false);
  assert.match(state.reason, /not been invoked/);
});

test('mute uses the tab mute and shows in the badge', async () => {
  const { fake, send } = setup();
  const res = await send({ type: 'SET_MUTED', tabId: PAGE, muted: true });
  assert.equal(res.muted, true);
  assert.equal(fake.badges.get(PAGE), 'off');
  assert.equal(fake.calls.getMediaStreamId, 0);
});

test('messages not addressed to the worker are ignored', () => {
  const { worker } = setup();
  assert.equal(worker.routeMessage({ target: 'offscreen', type: 'LIST' }), null);
  assert.equal(worker.onMessage({ target: 'offscreen', type: 'LIST' }, {}, () => {}), false);
});
