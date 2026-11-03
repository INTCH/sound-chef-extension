/**
 * Sound Chef — capture lifecycle.
 *
 * Owns the offscreen document, the tab-capture stream ids, and the decision of
 * when a tab is armed. Nothing in here is the source of truth: the offscreen
 * document holds the actual Web Audio graphs, so every worker generation
 * reconciles against its LIST before it is allowed to START anything.
 *
 * The three races this module exists to lose safely:
 *
 *  - A slider drag fires ~20 SET_STATE in 400 ms. Arming is single-flight per
 *    tab (`armInFlight`), so 20 messages mint one stream id and send one START.
 *  - Only one offscreen document may exist. `ensureOffscreenDocument` is
 *    single-flight too, because two `await`s can both see "no document".
 *  - Closing the document when the last graph goes away can land between another
 *    tab's mint and its START, which silently kills that tab's audio. So the
 *    close waits for an idle period AND re-checks that no arm is in flight.
 *
 * Created with `createCaptureManager({chromeApi, store, timers})` rather than
 * reaching for globals, so `chrome` and the timers can be injected for testing.
 */

import {
  MSG,
  OFFSCREEN_URL,
  RELEASE_DELAY_MS,
  TARGET,
  describeError,
  isDefaultState
} from '../common/protocol.js';

/** @typedef {import('../common/protocol.js').TabAudioState} TabAudioState */

/**
 * How long the offscreen document must sit with zero graphs before it is torn
 * down. Long enough that a user flicking a tab back to non-default, or a second
 * tab arming, keeps the document (and its AudioContext) warm.
 * @type {number}
 */
export const DOCUMENT_IDLE_MS = 5000;

/**
 * How long a failed arm suppresses further arm attempts for the same tab.
 *
 * Without this, one slider drag over a page that cannot be captured — the
 * built-in PDF viewer, reader mode, anything `isRestrictedUrl` does not catch —
 * mints and rejects a stream id per input event, ~20 sequential round trips that
 * leave the popup seconds behind the pointer. Short enough that a deliberate
 * retry after reading the error still works.
 * @type {number}
 */
export const ARM_FAILURE_CACHE_MS = 1000;

/** Reason string handed to `chrome.offscreen.createDocument`. */
const OFFSCREEN_JUSTIFICATION =
  'Apply per-tab gain, mono downmix and balance to captured tab audio.';

/**
 * @param {{
 *   chromeApi?: any,
 *   store: ReturnType<import('./tab-state.js').createTabStore>,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   releaseDelayMs?: number,
 *   documentIdleMs?: number,
 *   armFailureCacheMs?: number,
 *   runExclusive?: (tabId: number, fn: () => Promise<any>) => Promise<any>
 * }} deps
 */
export function createCaptureManager(deps) {
  const store = deps.store;
  const api = () => deps.chromeApi || globalThis.chrome;
  const setTimer = (fn, ms) =>
    (deps.timers ? deps.timers.setTimeout : globalThis.setTimeout)(fn, ms);
  const clearTimer = (id) =>
    (deps.timers ? deps.timers.clearTimeout : globalThis.clearTimeout)(id);
  const releaseDelayMs =
    typeof deps.releaseDelayMs === 'number' ? deps.releaseDelayMs : RELEASE_DELAY_MS;
  const documentIdleMs =
    typeof deps.documentIdleMs === 'number' ? deps.documentIdleMs : DOCUMENT_IDLE_MS;
  const armFailureCacheMs =
    typeof deps.armFailureCacheMs === 'number' ? deps.armFailureCacheMs : ARM_FAILURE_CACHE_MS;

  /**
   * Runs a function with exclusive access to one tab. The service worker passes
   * its per-tab message queue in here, which is what makes a timer-driven
   * release mutually exclusive with an in-flight SET_STATE — the release reads
   * the state and the message handler writes it, so they cannot be allowed to
   * interleave. Falls back to "just run it" when nothing is injected.
   * @type {(tabId: number, fn: () => Promise<any>) => Promise<any>}
   */
  const runExclusive = deps.runExclusive || ((_tabId, fn) => fn());

  /** @type {Map<number, Promise<{armed: boolean, error: string}>>} */
  const armInFlight = new Map();
  /** @type {Map<number, unknown>} */
  const releaseTimers = new Map();
  /** @type {Map<number, {error: string, timer: unknown}>} */
  const recentFailures = new Map();
  /**
   * Bumped every time a tab gets a NEW live graph. `STREAM_ENDED` carries only a
   * tabId, so this is the only way to tell "the stream you are telling me about
   * is the one I still have" from "you are reporting the death of a stream I
   * have already replaced".
   * @type {Map<number, number>}
   */
  const armGeneration = new Map();
  /** @type {Promise<void>|null} */
  let creatingDocument = null;
  /** @type {Promise<void>|null} */
  let closingDocument = null;
  /** @type {unknown} */
  let documentCloseTimer = null;
  /** @type {Promise<number[]>|null} */
  let reconcilePromise = null;

  /* ---------------------------------------------------------------- */
  /* Offscreen document                                                */
  /* ---------------------------------------------------------------- */

  /**
   * @returns {Promise<boolean>}
   */
  async function hasOffscreenDocument() {
    const chromeApi = api();
    try {
      if (chromeApi.offscreen && typeof chromeApi.offscreen.hasDocument === 'function') {
        return !!(await chromeApi.offscreen.hasDocument());
      }
      if (chromeApi.runtime && typeof chromeApi.runtime.getContexts === 'function') {
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        return Array.isArray(contexts) && contexts.length > 0;
      }
    } catch {
      // Treat an unavailable probe as "no document"; createDocument's own
      // duplicate error is the backstop.
    }
    return false;
  }

  /**
   * Make sure the one permitted offscreen document exists.
   * Single-flight: concurrent callers share one `createDocument` call, and a
   * duplicate-document rejection is treated as success because it means someone
   * else won the race.
   *
   * @returns {Promise<void>}
   */
  async function ensureOffscreenDocument() {
    // A teardown already under way must finish first. `hasDocument()` still
    // answers "yes" for a document that is mid-close, and by the time we minted
    // a stream id against it the port would be dead. Waiting means we simply
    // create a fresh one afterwards.
    while (closingDocument) await closingDocument;
    if (await hasOffscreenDocument()) return;
    if (!creatingDocument) {
      creatingDocument = api()
        .offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['USER_MEDIA'],
          justification: OFFSCREEN_JUSTIFICATION
        })
        .then(
          () => undefined,
          (err) => {
            if (/single offscreen document/i.test(describeError(err))) return undefined;
            throw err;
          }
        );
      const pending = creatingDocument;
      // Clear only our own entry, so a later create is not cancelled by an
      // earlier one finishing.
      pending.then(
        () => { if (creatingDocument === pending) creatingDocument = null; },
        () => { if (creatingDocument === pending) creatingDocument = null; }
      );
    }
    await creatingDocument;
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {Promise<any>} `null` when nothing answered (no document).
   */
  async function sendToOffscreen(message) {
    try {
      const response = await api().runtime.sendMessage({
        target: TARGET.OFFSCREEN,
        ...message
      });
      return response === undefined ? null : response;
    } catch {
      // "Could not establish connection. Receiving end does not exist." — the
      // document is gone. Callers treat that as "no graph".
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Reconcile the armed cache against the real graphs                 */
  /* ---------------------------------------------------------------- */

  /**
   * After a worker restart the `armed` array in storage may name tabs
   * whose graphs died with the previous document. Trusting it would send a
   * second START for a live tab (double gain) or skip a START for a dead one
   * (silence). Runs at most once per worker generation.
   *
   * @returns {Promise<number[]>} the live tab ids
   */
  function reconcileArmed() {
    if (reconcilePromise) return reconcilePromise;
    reconcilePromise = (async () => {
      if (!(await hasOffscreenDocument())) {
        return store.writeArmedCache([]);
      }
      const response = await sendToOffscreen({ type: MSG.LIST });
      if (!response || !Array.isArray(response.tabIds)) {
        return store.writeArmedCache([]);
      }
      return store.writeArmedCache(response.tabIds);
    })().catch(async () => store.readArmedCache());
    return reconcilePromise;
  }

  /**
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  async function isArmed(tabId) {
    await reconcileArmed();
    const ids = await store.readArmedCache();
    return ids.includes(tabId);
  }

  /* ---------------------------------------------------------------- */
  /* Arm and apply                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Suppress arm attempts for this tab for a short window. Timer-based rather
   * than clock-based so the injected timers govern it.
   *
   * @param {number} tabId
   * @param {string} error
   * @returns {void}
   */
  function rememberFailure(tabId, error) {
    forgetFailure(tabId);
    const timer = setTimer(() => recentFailures.delete(tabId), armFailureCacheMs);
    recentFailures.set(tabId, { error, timer });
  }

  /**
   * @param {number} tabId
   * @returns {void}
   */
  function forgetFailure(tabId) {
    const entry = recentFailures.get(tabId);
    if (!entry) return;
    clearTimer(entry.timer);
    recentFailures.delete(tabId);
  }

  /**
   * @param {number} tabId
   * @param {TabAudioState} state
   * @returns {Promise<{armed: boolean, error: string}>}
   */
  async function performArm(tabId, state) {
    const result = await attemptArm(tabId, state);
    if (result.armed) {
      forgetFailure(tabId);
    } else {
      rememberFailure(tabId, result.error);
      // Every failure path gets here. `ensureOffscreenDocument` may already have
      // built a document with a live AudioContext in it; nothing else would ever
      // close it, so one nudge on an uncapturable page would leak it for the
      // rest of the session.
      scheduleDocumentClose();
    }
    return result;
  }

  /**
   * Ensure the document, mint a stream id and hand it over immediately. The id is
   * single-use and expires within seconds, so it is never stored and never
   * retried; a failure means minting a fresh one next time.
   *
   * @param {number} tabId
   * @param {TabAudioState} state
   * @returns {Promise<{armed: boolean, error: string}>}
   */
  async function attemptArm(tabId, state) {
    try {
      await ensureOffscreenDocument();
      // A pending "close the idle document" must not fire between the mint and
      // the START below.
      cancelDocumentClose();

      const streamId = await api().tabCapture.getMediaStreamId({ targetTabId: tabId });
      if (!streamId) {
        return { armed: false, error: 'Chrome returned no capture stream id.' };
      }

      const response = await sendToOffscreen({
        type: MSG.START,
        tabId,
        streamId,
        state
      });
      if (!response) {
        return {
          armed: false,
          error: 'The audio engine is not running. Reopen the popup and try again.'
        };
      }
      if (response.ok !== true) {
        return { armed: false, error: describeError(response.error) };
      }

      armGeneration.set(tabId, (armGeneration.get(tabId) || 0) + 1);
      await store.markArmed(tabId);
      return { armed: true, error: '' };
    } catch (err) {
      return { armed: false, error: describeError(err) };
    }
  }

  /**
   * Arming is single-flight and idempotent per tab. The map entry is set
   * synchronously so a second caller in the same turn cannot slip past it.
   *
   * @param {number} tabId
   * @param {TabAudioState} state
   * @returns {Promise<{armed: boolean, error: string}>}
   */
  function armTab(tabId, state) {
    const existing = armInFlight.get(tabId);
    if (existing) return existing;

    // Negative cache: a drag over a page that cannot be captured must not mint a
    // stream id per input event. The user's own retry, a RESET, or the window
    // expiring all clear it.
    const failure = recentFailures.get(tabId);
    if (failure) return Promise.resolve({ armed: false, error: failure.error });

    const pending = performArm(tabId, state);
    armInFlight.set(tabId, pending);
    pending.then(
      () => { if (armInFlight.get(tabId) === pending) armInFlight.delete(tabId); },
      () => { if (armInFlight.get(tabId) === pending) armInFlight.delete(tabId); }
    );
    return pending;
  }

  /**
   * Once armed, a change is just an APPLY. A failed APPLY means the
   * graph is gone, so the armed entry is dropped and the next change re-arms.
   *
   * @param {number} tabId
   * @param {TabAudioState} state
   * @returns {Promise<boolean>}
   */
  async function applyState(tabId, state) {
    const response = await sendToOffscreen({ type: MSG.APPLY, tabId, state });
    if (!response || response.ok !== true) {
      await store.markUnarmed(tabId);
      return false;
    }
    return true;
  }

  /**
   * Entry point: bring capture in line with a tab's new state.
   *
   * @param {number} tabId
   * @param {TabAudioState} state
   * @returns {Promise<{armed: boolean, error: string}>}
   */
  async function syncTab(tabId, state) {
    if (isDefaultState(state)) {
      scheduleRelease(tabId);
      return { armed: await isArmed(tabId), error: '' };
    }

    cancelRelease(tabId);

    const inFlight = armInFlight.get(tabId);
    if (inFlight) {
      const result = await inFlight;
      // The arm carried whatever state it started with; push the newest one.
      if (result.armed) {
        const ok = await applyState(tabId, state);
        return { armed: ok, error: ok ? '' : 'The audio engine dropped this tab.' };
      }
      return result;
    }

    if (await isArmed(tabId)) {
      const ok = await applyState(tabId, state);
      if (ok) return { armed: true, error: '' };
      // Graph vanished under us — arm again with a fresh gesture-backed mint.
      return armTab(tabId, state);
    }

    return armTab(tabId, state);
  }

  /* ---------------------------------------------------------------- */
  /* Release and document teardown                                     */
  /* ---------------------------------------------------------------- */

  /**
   * A tab back at default is a release candidate, but only after a
   * grace period. Sweeping a slider 200% → 100% → 300% passes through the
   * default detent; releasing there would tear the graph down and rebuild it,
   * which is an audible gap plus a blue-indicator flicker.
   *
   * @param {number} tabId
   * @returns {void}
   */
  function scheduleRelease(tabId) {
    if (releaseTimers.has(tabId)) return;
    const id = setTimer(() => {
      releaseTimers.delete(tabId);
      // Take the tab's exclusive slot. The release reads the state and decides
      // whether to tear the graph down; SET_STATE writes that state. Running
      // them on the same queue is the only thing that makes the decision
      // trustworthy — see releaseTab's re-read comment.
      void runExclusive(tabId, () => releaseTab(tabId));
    }, releaseDelayMs);
    releaseTimers.set(tabId, id);
  }

  /**
   * Cancel a pending release because the tab left default again.
   *
   * @param {number} tabId
   * @returns {void}
   */
  function cancelRelease(tabId) {
    if (!releaseTimers.has(tabId)) return;
    clearTimer(releaseTimers.get(tabId));
    releaseTimers.delete(tabId);
  }

  /**
   * Stop capturing one tab.
   *
   * @param {number} tabId
   * @param {{force?: boolean}} [options] `force` skips the "still default?"
   *   re-check — used by RESET and by tab removal.
   * @returns {Promise<boolean>} whether a STOP was actually sent
   */
  async function releaseTab(tabId, options) {
    const force = !!(options && options.force);
    cancelRelease(tabId);

    if (!force) {
      // The timer may have been queued behind other work; re-read rather than
      // trusting the state that scheduled it.
      const state = await store.readState(tabId);
      if (!isDefaultState(state)) return false;
    }

    const inFlight = armInFlight.get(tabId);
    if (inFlight) await inFlight;

    if (!force) {
      // Read again, as late as possible. A storage read answers with the value
      // as of when it was dispatched, so the check above can be stale by the
      // time the await chain above unwinds: the user drags to 300%, SET_STATE
      // writes it and APPLYs, and this function would then STOP the graph out
      // from under a tab the popup has already been told is armed. Callers
      // arriving through `runExclusive` cannot interleave with SET_STATE at all;
      // this covers the direct callers that do not.
      const state = await store.readState(tabId);
      if (!isDefaultState(state)) return false;
    }

    const response = await sendToOffscreen({ type: MSG.STOP, tabId });
    await store.markUnarmed(tabId);
    // The user asked for this tab to stop; a stale capture failure must not
    // suppress their next attempt.
    forgetFailure(tabId);

    if (response && response.remaining === 0) scheduleDocumentClose();
    return true;
  }

  /**
   * The document is only closed once it has been empty for a while AND
   * nothing is arming. Closing the instant `remaining` hits 0 races another
   * tab's in-flight arm: the document dies between that tab's mint and its
   * START, the id expires, and the tab is left non-default with no audio and no
   * error to show for it.
   *
   * @returns {void}
   */
  function scheduleDocumentClose() {
    cancelDocumentClose();
    documentCloseTimer = setTimer(() => {
      documentCloseTimer = null;
      void closeDocumentIfIdle();
    }, documentIdleMs);
  }

  /** @returns {void} */
  function cancelDocumentClose() {
    if (documentCloseTimer === null) return;
    clearTimer(documentCloseTimer);
    documentCloseTimer = null;
  }

  /**
   * The guarded teardown itself.
   *
   * @returns {Promise<boolean>} whether the document was closed
   */
  async function closeDocumentIfIdle() {
    if (armInFlight.size > 0) return false;
    if (!(await hasOffscreenDocument())) return false;

    const response = await sendToOffscreen({ type: MSG.LIST });
    if (!response || !Array.isArray(response.tabIds) || response.tabIds.length > 0) {
      return false;
    }
    // Re-check after every await: an arm may have started while LIST was in
    // flight, and it has already passed cancelDocumentClose().
    if (armInFlight.size > 0 || creatingDocument) return false;

    // From here the close is committed and cannot be re-checked away — calling
    // closeDocument() is the point of no return. `closingDocument` is published
    // synchronously, before the first await, so any arm that starts from now on
    // blocks in ensureOffscreenDocument until the teardown (and the armed-cache
    // reset below) has finished, then builds a fresh document. Without it, that
    // arm's markArmed would be erased by the writeArmedCache here.
    const teardown = (async () => {
      await api().offscreen.closeDocument();
      await store.writeArmedCache([]);
    })();
    closingDocument = teardown.then(() => {}, () => {});
    const marker = closingDocument;
    try {
      await teardown;
      return true;
    } catch {
      return false;
    } finally {
      if (closingDocument === marker) closingDocument = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Tab identity changes and stream death                             */
  /* ---------------------------------------------------------------- */

  /**
   * `tabs.onReplaced` hands the same page a new tabId. Tell the engine
   * to rekey; if it has no graph under the old id (the usual case, because a
   * prerender swap kills the stream) the new tab is simply unarmed with the old
   * settings intact.
   *
   * @param {number} fromTabId
   * @param {number} toTabId
   * @returns {Promise<{ok: boolean, present: boolean}>}
   */
  async function rekey(fromTabId, toTabId) {
    cancelRelease(fromTabId);
    const response = await sendToOffscreen({ type: MSG.REKEY, fromTabId, toTabId });
    const present = !!(response && response.present);
    await store.replaceArmed(fromTabId, present ? toTabId : null);
    return { ok: !!(response && response.ok), present };
  }

  /**
   * The stream ended on its own (prerender swap, tab discard, user
   * revoked sharing). Drop the armed entry and let the document wind down, but
   * keep the user's settings: the next popup interaction re-arms with a fresh
   * gesture.
   *
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function forgetTab(tabId) {
    cancelRelease(tabId);
    forgetFailure(tabId);
    await store.markUnarmed(tabId);
    scheduleDocumentClose();
  }

  /**
   * Relay the popup's METER request to the engine.
   *
   * @param {number} tabId
   * @returns {Promise<{ok: boolean, meter: any}>}
   */
  async function relayMeter(tabId) {
    const response = await sendToOffscreen({ type: MSG.METER, tabId });
    if (!response || response.ok !== true) return { ok: false, meter: null };
    return { ok: true, meter: response.meter || null };
  }

  return {
    // lifecycle
    ensureOffscreenDocument,
    hasOffscreenDocument,
    reconcileArmed,
    isArmed,
    armTab,
    applyState,
    syncTab,
    scheduleRelease,
    cancelRelease,
    releaseTab,
    scheduleDocumentClose,
    cancelDocumentClose,
    closeDocumentIfIdle,
    rekey,
    forgetTab,
    relayMeter,
    sendToOffscreen,
    forgetFailure,
    /**
     * Read the tab's current arm generation. Capture it when a STREAM_ENDED
     * arrives and compare before acting on it.
     * @param {number} tabId
     * @returns {number}
     */
    armGenerationFor: (tabId) => armGeneration.get(tabId) || 0,
    // introspection, used by the unit tests
    inFlightCount: () => armInFlight.size,
    pendingReleaseCount: () => releaseTimers.size,
    cachedFailureCount: () => recentFailures.size
  };
}
