/**
 * Sound Chef — service worker.
 *
 * The only context with `chrome.tabs`, `chrome.storage`, `chrome.tabCapture`,
 * `chrome.offscreen` and `chrome.action`. The popup and the offscreen document
 * both go through here.
 *
 * Two rules shape everything below:
 *
 *  1. This worker is terminated after 30 s of inactivity. No worker global is
 *     ever the source of truth — every answer is re-derived from
 *     `chrome.storage.session` plus the engine's own LIST.
 *  2. `chrome.runtime.onMessage` fires in every extension context and does not
 *     honour returned promises. So the listener drops anything not addressed to
 *     `sw`, returns `true` for everything it does take, and calls
 *     `sendResponse` itself.
 *
 * The worker is built by `createSoundChefWorker(deps)` so its dependencies
 * (`chrome`, timers) can be injected for testing; the bottom of this file wires
 * up the real one when a real `chrome.runtime` is present.
 */

import {
  DEFAULT_STATE,
  MSG,
  TARGET,
  badgeTextFor,
  clampState,
  describeError,
  isRestrictedUrl,
  restrictionReason
} from '../common/protocol.js';
import { createTabStore } from './tab-state.js';
import { createCaptureManager } from './capture.js';

/** @typedef {import('../common/protocol.js').TabAudioState} TabAudioState */

/**
 * Decide whether the popup should treat a tab as uncapturable.
 *
 * The extension has no `tabs` permission, so `tab.url` is only visible while
 * the activeTab grant from opening the popup holds. Chrome drops that grant when
 * the tab navigates, and the popup keeps polling, so a missing `url` on a tab
 * that still exists means "not visible to us", not "restricted". In that case
 * the controls stay enabled and a capture attempt reports Chrome's own error if
 * it cannot proceed.
 *
 * @param {any|null} tab
 * @returns {{restricted: boolean, reason: string}}
 */
export function classifyTab(tab) {
  if (!tab) {
    return { restricted: true, reason: 'This tab is no longer available.' };
  }
  const url = typeof tab.url === 'string' ? tab.url : undefined;
  if (url === undefined) return { restricted: false, reason: '' };
  if (!isRestrictedUrl(url)) return { restricted: false, reason: '' };
  return { restricted: true, reason: restrictionReason(url) };
}

/**
 * Build the worker.
 *
 * @param {{
 *   chromeApi?: any,
 *   store?: ReturnType<typeof createTabStore>,
 *   capture?: ReturnType<typeof createCaptureManager>,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   releaseDelayMs?: number,
 *   documentIdleMs?: number
 * }} [deps]
 */
export function createSoundChefWorker(deps) {
  const options = deps || {};
  const api = () => options.chromeApi || globalThis.chrome;
  const store = options.store || createTabStore(options.chromeApi);
  const capture =
    options.capture ||
    createCaptureManager({
      chromeApi: options.chromeApi,
      store,
      timers: options.timers,
      releaseDelayMs: options.releaseDelayMs,
      documentIdleMs: options.documentIdleMs,
      armFailureCacheMs: options.armFailureCacheMs,
      // `enqueue` is a hoisted function declaration, so this closes over it
      // before it is defined below. Giving capture.js the same per-tab queue the
      // message handlers use is what stops a release timer from tearing down a
      // graph in between a SET_STATE's write and its APPLY.
      runExclusive: (tabId, fn) => enqueue(tabId, fn)
    });

  /**
   * Serialises state mutations per tab. A drag delivers ~20 SET_STATE that all
   * read-modify-write the same key; without this the last message to *arrive* is
   * not necessarily the last one to *land*, and the slider's final position can
   * be lost. Ordering only — never a cache.
   * @type {Map<number, Promise<unknown>>}
   */
  const tabQueues = new Map();

  /**
   * @template T
   * @param {number} tabId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function enqueue(tabId, fn) {
    const previous = tabQueues.get(tabId) || Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(() => {}, () => {});
    tabQueues.set(tabId, settled);
    settled.then(() => {
      if (tabQueues.get(tabId) === settled) tabQueues.delete(tabId);
    });
    return run;
  }

  /**
   * Take two tabs' slots at once, always in ascending id order. `onReplaced`
   * touches both the old and the new tab, and a fixed acquisition order is what
   * keeps two nested waits from ever forming a cycle.
   *
   * @template T
   * @param {number} a
   * @param {number} b
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function enqueuePair(a, b, fn) {
    if (a === b) return enqueue(a, fn);
    const first = Math.min(a, b);
    const second = Math.max(a, b);
    return enqueue(first, () => enqueue(second, fn));
  }

  /* ---------------------------------------------------------------- */
  /* Tab facts                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * @param {number} tabId
   * @returns {Promise<any|null>} null when the tab is gone
   */
  async function getTab(tabId) {
    try {
      return await api().tabs.get(tabId);
    } catch {
      return null;
    }
  }

  /**
   * Chrome's own tab mute. Deliberately not part of TabAudioState and never
   * written to storage — Chrome already remembers it.
   *
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  async function readMuted(tabId) {
    const tab = await getTab(tabId);
    return !!(tab && tab.mutedInfo && tab.mutedInfo.muted);
  }

  /**
   * Always tab-scoped. A `setBadgeText` without `tabId` sets the default badge
   * for every tab, which would leak one tab's gain onto all of them.
   *
   * @param {number} tabId
   * @param {TabAudioState} state
   * @param {boolean} muted
   * @returns {Promise<void>}
   */
  async function updateBadge(tabId, state, muted) {
    try {
      await api().action.setBadgeText({ tabId, text: badgeTextFor(state, muted) });
    } catch {
      // The tab closed mid-flight. Nothing to show it on.
    }
  }

  /**
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function refreshBadge(tabId) {
    const [state, muted] = await Promise.all([store.readState(tabId), readMuted(tabId)]);
    await updateBadge(tabId, state, muted);
  }

  /* ---------------------------------------------------------------- */
  /* Message handlers                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Opening the popup must not capture anything, so this only reads.
   *
   * @param {number} tabId
   * @returns {Promise<{state: TabAudioState, muted: boolean, armed: boolean,
   *   restricted: boolean, reason: string}>}
   */
  async function handleGetState(tabId) {
    const tab = await getTab(tabId);
    const classified = classifyTab(tab);
    const restricted = classified.restricted;
    const muted = !!(tab && tab.mutedInfo && tab.mutedInfo.muted);
    const state = await store.readState(tabId);
    // Reconciles against the engine's LIST first, so a worker that just woke up
    // does not report a dead graph as armed.
    const armed = await capture.isArmed(tabId);
    const reason = restricted ? classified.reason : await store.readError(tabId);

    await updateBadge(tabId, state, muted);
    return { state, muted, armed, restricted, reason };
  }

  /**
   * The only path that arms, applies or schedules a release.
   *
   * The patch goes through `clampState` and the clamped result is returned as
   * authoritative: `clampState` does not coerce numeric strings, so a popup that
   * sends `{gain: '3'}` gets `gain: 1` back and can correct its own slider
   * instead of silently disagreeing with the engine.
   *
   * @param {number} tabId
   * @param {Partial<TabAudioState>|null|undefined} patch
   * @returns {Promise<{state: TabAudioState, armed: boolean}>}
   */
  function handleSetState(tabId, patch) {
    return enqueue(tabId, async () => {
      const current = await store.readState(tabId);
      const merged = patch && typeof patch === 'object' ? { ...current, ...patch } : current;
      const next = clampState(merged);

      await store.writeState(tabId, next);
      await updateBadge(tabId, next, await readMuted(tabId));

      const result = await capture.syncTab(tabId, next);
      if (result.error) {
        await store.writeError(tabId, result.error);
      } else {
        await store.clearError(tabId);
      }
      return { state: next, armed: result.armed };
    });
  }

  /**
   * Mute is Chrome's, not ours. No capture, no blue indicator, works on
   * restricted pages, and never touches TabAudioState, storage or armed-ness.
   *
   * @param {number} tabId
   * @param {boolean} muted
   * @returns {Promise<{muted: boolean}>}
   */
  async function handleSetMuted(tabId, muted) {
    try {
      await api().tabs.update(tabId, { muted: !!muted });
    } catch {
      // Tab gone; fall through and report what Chrome actually has.
    }
    const actual = await readMuted(tabId);
    await updateBadge(tabId, await store.readState(tabId), actual);
    return { muted: actual };
  }

  /**
   * RESET releases immediately, with no grace period.
   *
   * @param {number} tabId
   * @returns {Promise<{state: TabAudioState, armed: boolean}>}
   */
  function handleReset(tabId) {
    return enqueue(tabId, async () => {
      const next = clampState(DEFAULT_STATE);
      await store.writeState(tabId, next);
      await capture.releaseTab(tabId, { force: true });
      await store.clearError(tabId);
      await updateBadge(tabId, next, await readMuted(tabId));
      return { state: next, armed: false };
    });
  }

  /**
   * @param {number} tabId
   * @returns {Promise<{ok: boolean, meter: any}>}
   */
  async function handleMeter(tabId) {
    if (!(await capture.isArmed(tabId))) return { ok: false, meter: null };
    return capture.relayMeter(tabId);
  }

  /**
   * The engine reports that a stream died. Settings stay; only the capture
   * goes away.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  function handleStreamEnded(tabId) {
    // Read the generation now, as the message arrives — not inside the queued
    // body. If an arm completes while this waits its turn, the engine is telling
    // us about a stream we have already replaced, and acting on it would mark a
    // live graph unarmed. The next nudge would then START a second graph on the
    // same tab: double gain.
    const seenGeneration = capture.armGenerationFor(tabId);

    // On the queue so it cannot land in the middle of an arm: otherwise the
    // arm's markArmed/clearError can overwrite this, and the popup shows
    // "armed" with the stop message gone.
    return enqueue(tabId, async () => {
      if (capture.armGenerationFor(tabId) !== seenGeneration) return;
      await capture.forgetTab(tabId);
      await store.writeError(
        tabId,
        'Audio capture stopped. Change a control to start it again.'
      );
      await refreshBadge(tabId);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Tab events                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * The tab is gone: stop the graph, forget the settings, drop the
   * armed entry. Chrome discards the tab-scoped badge with the tab.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function handleTabRemoved(tabId) {
    // On the queue, and last. A drag in flight when the tab closes has queued
    // SET_STATE calls behind it; running the teardown off-queue lets one of them
    // re-arm a tab that no longer exists, leaving a live graph and a stale armed
    // entry for the rest of the session.
    await enqueue(tabId, async () => {
      await capture.releaseTab(tabId, { force: true });
      await store.deleteState(tabId);
    });
    // `enqueue` removes its own map entry once the chain drains; deleting it
    // here could drop a chain a later message already joined.
  }

  /**
   * A prerender/preview swap replaced the tab. The settings follow the
   * page to its new id; the stream almost certainly did not survive, so the new
   * tab is treated as unarmed until the user touches a control again.
   *
   * @param {number} addedTabId
   * @param {number} removedTabId
   * @returns {Promise<void>}
   */
  async function handleTabReplaced(addedTabId, removedTabId) {
    await enqueuePair(removedTabId, addedTabId, async () => {
      await store.migrateTabKey(removedTabId, addedTabId);
      await capture.rekey(removedTabId, addedTabId);
      await refreshBadge(addedTabId);
    });
  }

  /**
   * Mute can also be toggled from Chrome's own tab context menu, which never
   * reaches SET_MUTED. Keep the badge honest when that happens.
   *
   * @param {number} tabId
   * @param {{mutedInfo?: {muted: boolean}}} changeInfo
   * @returns {Promise<void>}
   */
  async function handleTabUpdated(tabId, changeInfo) {
    if (!changeInfo || !changeInfo.mutedInfo) return;
    await refreshBadge(tabId);
  }

  /* ---------------------------------------------------------------- */
  /* Routing                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * @param {any} message
   * @returns {Promise<any>|null} null when the message is not ours
   */
  function routeMessage(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.target !== TARGET.SW) return null;

    const tabId = message.tabId;
    switch (message.type) {
      case MSG.GET_STATE:
        return handleGetState(tabId);
      case MSG.SET_STATE:
        return handleSetState(tabId, message.patch);
      case MSG.SET_MUTED:
        return handleSetMuted(tabId, message.muted);
      case MSG.RESET:
        return handleReset(tabId);
      case MSG.METER:
        return handleMeter(tabId);
      case MSG.STREAM_ENDED:
        return handleStreamEnded(tabId).then(() => undefined);
      default:
        return null;
    }
  }

  /**
   * The `chrome.runtime.onMessage` listener. Returns `true` for everything it
   * takes, because MV3 will not wait on a returned promise, and `false` for
   * everything else so other contexts' listeners are not starved.
   *
   * @param {any} message
   * @param {any} _sender
   * @param {(response?: any) => void} sendResponse
   * @returns {boolean}
   */
  function onMessage(message, _sender, sendResponse) {
    const pending = routeMessage(message);
    if (!pending) return false;
    pending.then(
      (response) => sendResponse(response),
      (err) => sendResponse({ error: describeError(err) })
    );
    return true;
  }

  /**
   * Registered synchronously at the top level of the worker — a listener added
   * inside an `await` is missed on the wake-up event that started the worker.
   *
   * @returns {void}
   */
  function registerListeners() {
    const chromeApi = api();
    chromeApi.runtime.onMessage.addListener(onMessage);
    chromeApi.tabs.onRemoved.addListener((tabId) => {
      void handleTabRemoved(tabId);
    });
    chromeApi.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
      void handleTabReplaced(addedTabId, removedTabId);
    });
    if (chromeApi.tabs.onUpdated) {
      chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
        void handleTabUpdated(tabId, changeInfo);
      });
    }
  }

  return {
    store,
    capture,
    onMessage,
    routeMessage,
    registerListeners,
    handleGetState,
    handleSetState,
    handleSetMuted,
    handleReset,
    handleMeter,
    handleStreamEnded,
    handleTabRemoved,
    handleTabReplaced,
    handleTabUpdated,
    refreshBadge
  };
}

// Real-browser wiring. Guarded so this module can be imported without a
// `chrome` global (the unit tests import it under node).
if (
  typeof globalThis.chrome !== 'undefined' &&
  globalThis.chrome.runtime &&
  globalThis.chrome.runtime.onMessage
) {
  createSoundChefWorker().registerListeners();
}
