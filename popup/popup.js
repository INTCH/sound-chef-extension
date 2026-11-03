/**
 * Sound Chef — popup.
 *
 * Talks only to the service worker (`TARGET.SW`); never touches `chrome.tabCapture`,
 * `chrome.storage` or the offscreen document directly. The service worker's response is
 * authoritative — every render comes from what it sends back, not from what the user
 * dragged a slider to.
 */

import { TARGET, MSG, MAX_GAIN, isDefaultState } from '../common/protocol.js';

const METER_POLL_MS = 100;
// Slower than the meter: a GET_STATE poll piggybacked on the same lifecycle so the
// controls notice a change the popup did not itself request — the service worker's
// RELEASE_DELAY_MS teardown after a drag back to default, a mute toggled from the
// tab strip, or a capture that has since failed.
const STATE_POLL_MS = 500;

/** @type {number|null} */
let currentTabId = null;
/** @type {number|null} */
let meterIntervalId = null;
/** @type {number|null} */
let stateIntervalId = null;

// Last-known fields not returned by every response, so a SET_STATE/RESET round trip
// (which only returns {state, armed}) can still render a status line and mute button
// without guessing.
let lastKnownMuted = false;
let lastKnownRestricted = false;
let lastKnownReason = '';
/** Most recent authoritative state, for snapping a slider once the user lets go of it. */
let lastKnownState = null;

/* -------------------------------------------------------------------------- */
/* Meter drawing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Scale of the bars, in dBFS. The top is 0 and not something higher because the
 * per-tab limiter soft-limits towards LIMITER_CEILING (~-0.09 dBFS) — the meters
 * are tapped after it, so nothing above 0 can ever be drawn, and leaving headroom
 * in the scale for a level that cannot occur would just waste the bar.
 */
const METER_FLOOR_DB = -60;
const METER_TOP_DB = 0;

/**
 * Internal silence sentinel. The engine reports digital silence as `-Infinity`
 * (and JSON turns that into `null` on the way here); both become this, so the
 * ballistics below are plain finite arithmetic with no special cases.
 */
const SILENT_DB = -72;

/** Level at which the over indicator latches, and how long it stays lit. */
const OVER_DB = -0.5;
const OVER_HOLD_MS = 700;

/** Peak cap: how long it sits before it starts falling, and how fast it falls. */
const PEAK_HOLD_MS = 900;
const PEAK_FALL_DB_PER_S = 24;

/** Bar fall-off. Attack is instant — a meter that eases upward reads late. */
const RMS_FALL_DB_PER_S = 56;

const volumeInput = document.getElementById('volume');
const volumeValue = document.getElementById('volume-value');
const volumeNotch = document.getElementById('volume-notch');
const monoInput = document.getElementById('mono');
const balanceInput = document.getElementById('balance');
const balanceValue = document.getElementById('balance-value');
const muteBtn = document.getElementById('mute-btn');
const resetBtn = document.getElementById('reset-btn');
const statusLine = document.getElementById('status-line');
const meterEl = document.getElementById('meter');

const channels = {
  left: {
    fill: document.getElementById('fill-l'),
    cap: document.getElementById('cap-l'),
    rms: SILENT_DB,
    peak: SILENT_DB,
    peakAt: 0,
    drawnRms: -1,
    drawnPeak: -1
  },
  right: {
    fill: document.getElementById('fill-r'),
    cap: document.getElementById('cap-r'),
    rms: SILENT_DB,
    peak: SILENT_DB,
    peakAt: 0,
    drawnRms: -1,
    drawnPeak: -1
  }
};

/** Latest sample from the engine, in dB; consumed by the animation frame. */
let targetLeftRms = SILENT_DB;
let targetRightRms = SILENT_DB;
let targetLeftPeak = SILENT_DB;
let targetRightPeak = SILENT_DB;
let overUntil = 0;
/** @type {number|null} */
let frameId = null;
let lastFrameAt = 0;

volumeInput.max = String(MAX_GAIN);
// Unity sits at 1/MAX_GAIN of the travel; the notch is drawn in the same
// thumb-inset space as the slider fill so the two line up exactly.
volumeNotch.style.left = `calc(6px + ${1 / MAX_GAIN} * (100% - 12px))`;

/**
 * Send a message to the service worker. Popup documents can be torn down mid-flight
 * (the user just clicks elsewhere), which makes `chrome.runtime.sendMessage` reject
 * with a disconnected-port error — treat that the same as "unknown", never as an
 * unhandled rejection.
 *
 * @param {object} message
 * @returns {Promise<any|null>}
 */
async function sendToSW(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response === undefined ? null : response;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} state
 * @returns {boolean}
 */
function isValidState(state) {
  return (
    !!state &&
    typeof state === 'object' &&
    typeof (/** @type {any} */ (state).gain) === 'number' &&
    typeof (/** @type {any} */ (state).mono) === 'boolean' &&
    typeof (/** @type {any} */ (state).balance) === 'number'
  );
}

/**
 * One meter field off the wire, as a finite dB number.
 *
 * `chrome.runtime.sendMessage` is JSON-based, so a `-Infinity` set by the offscreen
 * engine for digital silence does not survive the trip — it arrives here as `null`.
 * `Number.isFinite` (unlike the global `isFinite`) never coerces its argument, so it
 * already returns `false` for `null`, `undefined` and `NaN` as well as `-Infinity` —
 * this is the single coercion point, and no arithmetic runs on a value that has not
 * passed it.
 *
 * @param {unknown} db
 * @returns {number} dB, or SILENT_DB for silence/absent/malformed.
 */
function toDb(db) {
  return Number.isFinite(db) ? /** @type {number} */ (db) : SILENT_DB;
}

/**
 * dB to bar position, 0..1 over the meter scale.
 *
 * @param {number} db
 * @returns {number}
 */
function barPosition(db) {
  const t = (db - METER_FLOOR_DB) / (METER_TOP_DB - METER_FLOOR_DB);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * @param {number} v -1..1
 * @returns {string}
 */
function fmtBalance(v) {
  if (v === 0) return 'centre';
  const pct = Math.round(Math.abs(v) * 100);
  return v < 0 ? `${pct}% L` : `${pct}% R`;
}

/**
 * Paint the filled part of the volume track. Separate from the value text so the
 * fill can follow the thumb during a drag while the readout stays authoritative.
 *
 * @param {number} gain
 */
function paintVolumeFill(gain) {
  volumeInput.style.setProperty('--pf', String(gain / MAX_GAIN));
}

/**
 * @param {number} balance -1..1
 */
function paintBalanceFill(balance) {
  balanceInput.style.setProperty('--pf', String((balance + 1) / 2));
}

/**
 * @param {boolean} disabled
 */
function setAudioControlsDisabled(disabled) {
  volumeInput.disabled = disabled;
  monoInput.disabled = disabled;
  balanceInput.disabled = disabled;
  resetBtn.disabled = disabled;
}

/**
 * Render controls from an authoritative {state, armed} pair plus whatever mute/
 * restricted/reason we last knew. Mute stays enabled even on restricted pages —
 * native tab mute needs no capture.
 *
 * Responses can land well after the user has moved on mid-drag (the first SET_STATE
 * on an unarmed tab is serialised behind the whole arm sequence in the service
 * worker), so a slider or the balance control currently focused is left alone here —
 * writing `valueAsNumber` on every response is what makes the thumb stutter/jump
 * under the user's finger. Everything else (the percentage text, mono, mute, status)
 * still renders from the response every time; the focused control's own 'change'
 * listener snaps it to `lastKnownState` once the interaction ends.
 *
 * @param {{gain:number, mono:boolean, balance:number}} state
 * @param {boolean} armed
 * @param {boolean} muted
 * @param {boolean} restricted
 * @param {string} reason
 */
function renderState(state, armed, muted, restricted, reason) {
  lastKnownState = state;

  // The track fill is painted from the same value as the thumb, under the same
  // guard — painting it from a late response while the thumb is held would leave
  // the coloured part of the track visibly detached from the thumb mid-drag.
  if (document.activeElement !== volumeInput) {
    volumeInput.valueAsNumber = state.gain;
    paintVolumeFill(state.gain);
  }
  volumeValue.textContent = `${Math.round(state.gain * 100)}%`;

  monoInput.checked = state.mono;

  if (document.activeElement !== balanceInput) {
    balanceInput.valueAsNumber = state.balance;
    paintBalanceFill(state.balance);
  }
  balanceValue.textContent = fmtBalance(state.balance);

  muteBtn.textContent = muted ? 'Unmute' : 'Mute';
  muteBtn.dataset.on = muted ? 'true' : 'false';
  muteBtn.disabled = false;

  setAudioControlsDisabled(restricted);

  // The status line only ever shows problems. Whether audio is being processed is
  // already visible in the meter, so the normal, working case says nothing and the
  // line stays the one place a real problem appears.
  if (restricted) {
    setStatus(reason || 'This page cannot be captured.');
  } else if (!armed && !isDefaultState(state)) {
    // A non-default state that failed to arm (reader mode, the PDF viewer, a rejected
    // getMediaStreamId, an expired stream ID) means the audio is not actually being
    // processed, whatever the slider shows — that has to be said, because nothing
    // else on screen would reveal it.
    setStatus(reason || 'Could not start on this tab.');
  } else {
    setStatus('');
  }
}

/**
 * Show a problem, or clear the line entirely. Empty text hides the element rather
 * than leaving a blank row that shifts the layout when it later fills in.
 *
 * @param {string} text
 */
function setStatus(text) {
  statusLine.textContent = text;
  statusLine.hidden = text === '';
}

/**
 * The service worker gave us nothing usable — a missing response, a torn-down popup,
 * or a worker that just restarted. Show that honestly instead of painting defaults as
 * if they were real state.
 *
 * @param {string} message
 */
function renderUnknown(message) {
  setStatus(message);
  setAudioControlsDisabled(true);
  muteBtn.disabled = !currentTabId;
  goIdle();
}

/**
 * Take one meter sample from the engine. This only moves the *targets* — the bars
 * themselves are drawn by the animation frame below, because a 100 ms poll drawn
 * directly is a staircase, not a meter.
 *
 * @param {{ok?:boolean, meter?:object|null}|null} response
 */
function renderMeter(response) {
  // {ok:false, meter:null} is the normal shape for a tab with no live capture graph
  // (unarmed) — not an error. The bars fall away on their own from here.
  if (!response || !response.meter) {
    goIdle();
    return;
  }

  const m = response.meter;
  meterEl.dataset.mode = 'live';

  targetLeftRms = toDb(m.outLeftRmsDb);
  targetRightRms = toDb(m.outRightRmsDb);
  // Defensive fallback for a missing or non-finite per-channel peak (silence
  // arrives as null): a cap sitting on the RMS is merely redundant, whereas
  // defaulting it to silence would draw a cap *below* the bar.
  targetLeftPeak = Number.isFinite(m.outLeftPeakDb) ? m.outLeftPeakDb : targetLeftRms;
  targetRightPeak = Number.isFinite(m.outRightPeakDb) ? m.outRightPeakDb : targetRightRms;

  if (toDb(m.outPeakDb) >= OVER_DB) {
    overUntil = performance.now() + OVER_HOLD_MS;
  }
}

/**
 * No live graph for this tab. Targets drop to silence so the bars fall away at the
 * normal rate rather than blanking, which is what a capture being released actually
 * looks like.
 */
function goIdle() {
  targetLeftRms = SILENT_DB;
  targetRightRms = SILENT_DB;
  targetLeftPeak = SILENT_DB;
  targetRightPeak = SILENT_DB;
  meterEl.dataset.mode = 'idle';
}

/**
 * Advance one channel's ballistics and draw it.
 *
 * Instant attack, timed fall: this is what makes a level bar readable rather than
 * a flicker. The fall rate is in dB per second and is applied against elapsed time,
 * not per frame, so a throttled popup decays at the same speed it looks like it
 * should.
 *
 * @param {{fill:HTMLElement, cap:HTMLElement, rms:number, peak:number, peakAt:number, drawnRms:number, drawnPeak:number}} ch
 * @param {number} targetRms
 * @param {number} targetPeak
 * @param {number} dt   Seconds since the previous frame.
 * @param {number} now  performance.now()
 */
function drawChannel(ch, targetRms, targetPeak, dt, now) {
  ch.rms = targetRms >= ch.rms
    ? targetRms
    : Math.max(targetRms, ch.rms - RMS_FALL_DB_PER_S * dt);

  if (targetPeak >= ch.peak) {
    ch.peak = targetPeak;
    ch.peakAt = now;
  } else if (now - ch.peakAt > PEAK_HOLD_MS) {
    ch.peak = Math.max(targetPeak, ch.peak - PEAK_FALL_DB_PER_S * dt);
  }

  const rmsPos = barPosition(ch.rms);
  const peakPos = barPosition(ch.peak);

  // Sub-pixel changes are not worth a style write at 60 Hz on a ~230 px bar.
  if (Math.abs(rmsPos - ch.drawnRms) > 0.002) {
    ch.fill.style.width = `${(rmsPos * 100).toFixed(2)}%`;
    ch.drawnRms = rmsPos;
  }
  if (Math.abs(peakPos - ch.drawnPeak) > 0.002) {
    ch.cap.style.left = `${(peakPos * 100).toFixed(2)}%`;
    ch.cap.style.opacity = peakPos > 0 ? '1' : '0';
    ch.drawnPeak = peakPos;
  }
}

/**
 * @param {number} now  Frame timestamp from requestAnimationFrame.
 */
function drawFrame(now) {
  // Clamped: a popup that was backgrounded for a second must not fast-forward the
  // decay in one jump, and a first frame has no previous timestamp at all.
  const dt = lastFrameAt === 0 ? 0 : Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  drawChannel(channels.left, targetLeftRms, targetLeftPeak, dt, now);
  drawChannel(channels.right, targetRightRms, targetRightPeak, dt, now);

  meterEl.dataset.clip = now < overUntil ? 'true' : 'false';

  frameId = requestAnimationFrame(drawFrame);
}

function startDrawing() {
  if (frameId !== null) return;
  lastFrameAt = 0;
  frameId = requestAnimationFrame(drawFrame);
}

function stopDrawing() {
  if (frameId === null) return;
  cancelAnimationFrame(frameId);
  frameId = null;
}

async function pollMeter() {
  if (currentTabId === null) return;
  const response = await sendToSW({ target: TARGET.SW, type: MSG.METER, tabId: currentTabId });
  renderMeter(response);
}

/**
 * Slow-cadence GET_STATE so the controls, the mute button and the status line pick
 * up changes the popup did not itself request: the service worker releasing a tab
 * that drifted back to default state, a mute toggled from the tab strip, or a
 * capture that has since failed or stopped. Renders through the same `applyFullResponse` → `renderState` path as everything
 * else, so it inherits the same "leave a focused slider alone" guard.
 */
async function pollState() {
  if (currentTabId === null) return;
  const response = await sendToSW({ target: TARGET.SW, type: MSG.GET_STATE, tabId: currentTabId });
  applyFullResponse(response);
}

function startMeterPolling() {
  stopMeterPolling();
  pollMeter();
  meterIntervalId = setInterval(pollMeter, METER_POLL_MS);
  stateIntervalId = setInterval(pollState, STATE_POLL_MS);
  startDrawing();
}

function stopMeterPolling() {
  stopDrawing();
  if (meterIntervalId !== null) {
    clearInterval(meterIntervalId);
    meterIntervalId = null;
  }
  if (stateIntervalId !== null) {
    clearInterval(stateIntervalId);
    stateIntervalId = null;
  }
}

/**
 * Apply a GET_STATE-shaped response ({state, muted, armed, restricted, reason}),
 * remembering the fields that later SET_STATE/RESET responses won't repeat.
 *
 * @param {any} response
 */
function applyFullResponse(response) {
  if (!response || !isValidState(response.state)) {
    renderUnknown('Unknown state (try reopening the popup).');
    return;
  }
  lastKnownMuted = !!response.muted;
  lastKnownRestricted = !!response.restricted;
  lastKnownReason = typeof response.reason === 'string' ? response.reason : '';
  renderState(response.state, !!response.armed, lastKnownMuted, lastKnownRestricted, lastKnownReason);
}

/**
 * Render a SET_STATE/RESET response ({state, armed} only — no room for a failure
 * reason). If capture failed to arm for a state that is not the neutral default, the
 * response alone would look like a silent success — the slider moved, nothing says
 * the audio was never touched. Follow up with GET_STATE, which the service worker
 * persists the failure reason on per tab (survives even a worker restart), and render
 * that instead.
 *
 * @param {any} response
 */
async function handleStateResponse(response) {
  if (!response || !isValidState(response.state)) return;

  if (!response.armed && !isDefaultState(response.state)) {
    const full = await sendToSW({ target: TARGET.SW, type: MSG.GET_STATE, tabId: currentTabId });
    applyFullResponse(full);
    return;
  }

  renderState(response.state, !!response.armed, lastKnownMuted, lastKnownRestricted, lastKnownReason);
}

function wireControls() {
  volumeInput.addEventListener('input', async () => {
    paintVolumeFill(volumeInput.valueAsNumber);
    if (currentTabId === null) return;
    const patch = { gain: volumeInput.valueAsNumber };
    const response = await sendToSW({
      target: TARGET.SW,
      type: MSG.SET_STATE,
      tabId: currentTabId,
      patch
    });
    await handleStateResponse(response);
  });

  // 'change' fires once the user lets go (mouseup/keyup commit), separately from the
  // continuous 'input' stream above. renderState() skips writing this control while it
  // is focused, so on release it must be explicitly snapped to the last authoritative
  // value — otherwise a drag whose final SET_STATE response hasn't arrived yet could
  // settle showing whatever the user last dragged past the service worker's clamp.
  volumeInput.addEventListener('change', () => {
    if (!lastKnownState) return;
    volumeInput.valueAsNumber = lastKnownState.gain;
    paintVolumeFill(lastKnownState.gain);
  });

  monoInput.addEventListener('change', async () => {
    if (currentTabId === null) return;
    const patch = { mono: monoInput.checked };
    const response = await sendToSW({
      target: TARGET.SW,
      type: MSG.SET_STATE,
      tabId: currentTabId,
      patch
    });
    await handleStateResponse(response);
  });

  balanceInput.addEventListener('input', async () => {
    paintBalanceFill(balanceInput.valueAsNumber);
    if (currentTabId === null) return;
    const patch = { balance: balanceInput.valueAsNumber };
    const response = await sendToSW({
      target: TARGET.SW,
      type: MSG.SET_STATE,
      tabId: currentTabId,
      patch
    });
    await handleStateResponse(response);
  });

  balanceInput.addEventListener('change', () => {
    if (!lastKnownState) return;
    balanceInput.valueAsNumber = lastKnownState.balance;
    paintBalanceFill(lastKnownState.balance);
  });

  muteBtn.addEventListener('click', async () => {
    if (currentTabId === null) return;
    const response = await sendToSW({
      target: TARGET.SW,
      type: MSG.SET_MUTED,
      tabId: currentTabId,
      muted: !lastKnownMuted
    });
    if (response && typeof response.muted === 'boolean') {
      lastKnownMuted = response.muted;
      muteBtn.textContent = lastKnownMuted ? 'Unmute' : 'Mute';
      muteBtn.dataset.on = lastKnownMuted ? 'true' : 'false';
    }
  });

  resetBtn.addEventListener('click', async () => {
    if (currentTabId === null) return;
    const response = await sendToSW({ target: TARGET.SW, type: MSG.RESET, tabId: currentTabId });
    await handleStateResponse(response);
  });
}

async function init() {
  wireControls();

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }

  if (!tab || typeof tab.id !== 'number') {
    renderUnknown('No active tab found.');
    return;
  }

  currentTabId = tab.id;

  // Query the tab, then GET_STATE, then paint. Nothing is painted from defaults
  // first, so a restricted page never flashes enabled controls.
  const response = await sendToSW({ target: TARGET.SW, type: MSG.GET_STATE, tabId: currentTabId });
  applyFullResponse(response);

  startMeterPolling();
}

window.addEventListener('pagehide', stopMeterPolling);

init();
