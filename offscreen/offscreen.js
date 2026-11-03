/**
 * Sound Chef — offscreen document entry point.
 *
 * Translates the `target: 'offscreen'` half of the message table into calls on the
 * single `AudioEngine`, and reports stream deaths back to the service worker.
 *
 * Only `chrome.runtime` exists here — no `chrome.tabs`, no `chrome.storage`, no
 * `chrome.offscreen`. Anything else has to be asked of the service worker.
 */

import { MSG, TARGET, describeError } from '../common/protocol.js';
import { AudioEngine } from './audio-engine.js';

const engine = new AudioEngine({ onStreamEnded: notifyStreamEnded });

/**
 * Tell the service worker a capture died on its own (tab closed, navigated, or
 * prerender-swapped). Unsolicited and unanswered.
 *
 * The send is allowed to fail: it wakes the worker, but the worker can also be mid
 * teardown, and there is nothing useful to do about it here.
 *
 * @param {number} tabId
 * @returns {void}
 */
function notifyStreamEnded(tabId) {
  try {
    const sent = chrome.runtime.sendMessage({
      target: TARGET.SW,
      type: MSG.STREAM_ENDED,
      tabId
    });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch {
    // No receiving end.
  }
}

/**
 * Read a field off an untrusted message without letting the read itself throw.
 *
 * @param {Object} message
 * @param {string} key
 * @returns {unknown}
 */
function readField(message, key) {
  try {
    return message[key];
  } catch {
    return undefined;
  }
}

/** @returns {number} The live graph count, or 0 if even that cannot be read. */
function safeRemaining() {
  try {
    return engine.graphs.size;
  } catch {
    return 0;
  }
}

/** @returns {number[]} The live registry, or an empty list as a last resort. */
function safeTabIds() {
  try {
    return engine.list().tabIds;
  } catch {
    return [];
  }
}

/**
 * A **shape-complete** response for a request that failed unexpectedly.
 *
 * A generic `{ok:false, error}` is not good enough here, because the service
 * worker branches on fields that would then be missing:
 *   - STOP is called speculatively and must stay `{ok:true, remaining}`, or the
 *     worker treats a stop it asked for as a failure.
 *   - LIST without `tabIds` reads as `undefined` on the worker's side; it re-arms
 *     and (were START not idempotent) would stack a second graph on a live tab.
 *   - REKEY is branched on `present`, not on `ok`.
 *   - METER consumers destructure `meter`.
 * So every fallback carries its own message type's full shape, plus `error` for
 * diagnosis.
 *
 * @param {unknown} type  The message type, or undefined if it could not be read.
 * @param {unknown} err
 * @returns {Object}
 */
function fallbackResponse(type, err) {
  const error = describeError(err);
  switch (type) {
    case MSG.STOP:
      return { ok: true, remaining: safeRemaining(), error };
    case MSG.LIST:
      return { tabIds: safeTabIds(), error };
    case MSG.REKEY:
      return { ok: false, present: false, error };
    case MSG.METER:
      return { ok: false, meter: null, error };
    default:
      return { ok: false, error };
  }
}

/**
 * Route one message to the engine.
 *
 * @param {Object} message
 * @param {unknown} type  Pre-read, so a message whose `type` getter throws still
 *                        lands on the default branch instead of exploding here.
 * @returns {Promise<Object>}
 */
async function handleMessage(message, type) {
  switch (type) {
    case MSG.START:
      return engine.start(readField(message, 'tabId'), readField(message, 'streamId'), readField(message, 'state'));
    case MSG.APPLY:
      return engine.apply(readField(message, 'tabId'), readField(message, 'state'));
    case MSG.STOP:
      return engine.stop(readField(message, 'tabId'));
    case MSG.REKEY:
      return engine.rekey(readField(message, 'fromTabId'), readField(message, 'toTabId'));
    case MSG.LIST:
      return engine.list();
    case MSG.METER:
      return engine.meter(readField(message, 'tabId'));
    default:
      return { ok: false, error: `Unknown message type: ${describeError(type)}` };
  }
}

// `chrome.runtime.onMessage` fires in every extension context, so anything not
// addressed here is dropped by returning false — returning true would leave the
// popup's own service-worker traffic waiting on a response this document will
// never send.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (readField(message, 'target') !== TARGET.OFFSCREEN) return false;

  const type = readField(message, 'type');

  let answered = false;
  /**
   * The single exit. Every path through this listener has to reach it exactly
   * once: an unanswered port leaves the service worker waiting until Chrome tears
   * the channel down, which it cannot tell apart from the document being gone.
   *
   * @param {Object} payload
   * @returns {void}
   */
  const respond = (payload) => {
    if (answered) return;
    answered = true;
    try {
      sendResponse(
        payload && typeof payload === 'object'
          ? payload
          : fallbackResponse(type, 'handler produced no response')
      );
    } catch {
      // The port is already closed — the worker died mid-request. Nothing to do,
      // but it must not escape as a rejection either.
    }
  };

  let pending;
  try {
    pending = handleMessage(message, type);
  } catch (err) {
    // An async function should not throw synchronously, but if one ever did the
    // port would stay open for the full channel timeout.
    respond(fallbackResponse(type, err));
    return true;
  }

  pending
    .then(
      (result) => respond(result),
      (err) => respond(fallbackResponse(type, err))
    )
    // `.then(onFulfilled, onRejected)` does NOT route a throw from onFulfilled to
    // onRejected. `respond` is already total, so this only exists so that no
    // future edit can turn a slip there into a silent hang.
    .catch(() => respond(fallbackResponse(type, 'response dispatch failed')));

  // Required: an async listener that does not return true has its message port
  // closed before sendResponse runs. Returning a Promise is not a reliable
  // substitute in MV3.
  return true;
});
