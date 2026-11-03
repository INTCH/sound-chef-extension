/**
 * Sound Chef — shared protocol.
 *
 * The single source of truth for message types, state shape, clamp rules and the
 * constants shared by the service worker, the offscreen document and the popup.
 *
 * This module is imported by all three contexts, so it must stay pure data and pure
 * functions: no `chrome.*` calls, no DOM, no top-level side effects. The offscreen
 * document only has `chrome.runtime`, and the service worker has no DOM — anything
 * else in here would break one of them.
 */

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Per-tab audio state. This is exactly what the audio graph consumes.
 *
 * `muted` is deliberately NOT part of this shape: mute is Chrome's own tab state,
 * read from `tab.mutedInfo.muted` and written with `chrome.tabs.update({muted})`.
 * It never touches the audio graph and never decides whether a tab is captured.
 *
 * @typedef {Object} TabAudioState
 * @property {number}  gain    0..MAX_GAIN — 1 = 100%
 * @property {boolean} mono    true = downmix to mono
 * @property {number}  balance -1..1 — 0 = centre, -1 = full left, 1 = full right
 */

/**
 * One meter sample from the offscreen engine. All levels are dBFS and are
 * `-Infinity` when the signal is silent — consumers must handle that before
 * doing arithmetic or laying out a bar. Note that `-Infinity` does not survive
 * `chrome.runtime.sendMessage` (the payload is JSON-serialised) and reaches the
 * popup as `null`, so a reader must accept both.
 *
 * @typedef {Object} MeterReading
 * @property {number} inRmsDb        RMS of the captured stream, before gain
 * @property {number} outRmsDb       RMS after the whole chain
 * @property {number} outLeftRmsDb   RMS of the left output channel
 * @property {number} outRightRmsDb  RMS of the right output channel
 * @property {number} outLeftPeakDb  Peak sample of the left output channel
 * @property {number} outRightPeakDb Peak sample of the right output channel
 * @property {number} outPeakDb      Peak sample after the whole chain, both channels
 * @property {number} masterRmsDb    DOCUMENT-GLOBAL: RMS after the master limiter, summed over every captured tab — NOT the tab this METER named
 * @property {number} masterPeakDb   DOCUMENT-GLOBAL: peak after the master limiter, summed over every captured tab — NOT the tab this METER named
 * @property {string} contextState   AudioContext.state: 'running' | 'suspended' | 'closed'
 */

/**
 * Highest gain the UI may request. 6 = 600%.
 * @type {number}
 */
export const MAX_GAIN = 6;

/**
 * Linear-amplitude range the offscreen master limiter stage is shaped over, so
 * boosted signal has somewhere to go before the ceiling flattens it. Lives here
 * only so the engine and anything reading its meters agree on one number.
 * @type {number}
 */
export const MASTER_HEADROOM = 4;

/**
 * Neutral state — a tab in this state is indistinguishable from an uncaptured tab,
 * which is what lets capture be released. Frozen so a shared reference cannot be
 * mutated from another module; always copy it (or call `clampState`) before editing.
 * @type {Readonly<TabAudioState>}
 */
export const DEFAULT_STATE = Object.freeze({ gain: 1, mono: false, balance: 0 });

/**
 * Path of the offscreen document, relative to the extension root.
 *
 * Load-bearing: `background/capture.js` hands this to `chrome.offscreen.createDocument`
 * and the offscreen document is authored at exactly this path. Changing one without
 * the other is a silent runtime failure.
 * @type {string}
 */
export const OFFSCREEN_URL = 'offscreen/offscreen.html';

/**
 * Grace period before a tab that has returned to default state has its capture torn
 * down, so a slider swept back through 100% does not thrash the graph.
 * @type {number}
 */
export const RELEASE_DELAY_MS = 1500;

/**
 * Ramp length for AudioParam changes. Direct `.value` assignment is a discontinuity
 * and clicks; ~15 ms is responsive without zipper noise.
 * @type {number}
 */
export const RAMP_SECONDS = 0.015;

/* -------------------------------------------------------------------------- */
/* Storage keys                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Storage key holding the set of tabs the extension is currently armed for.
 * @type {string}
 */
export const ARMED_KEY = 'armed';

/**
 * Storage key for one tab's {@link TabAudioState}.
 *
 * @param {number} tabId
 * @returns {string}
 */
export function tabStateKey(tabId) {
  return `tab:${tabId}`;
}

/* -------------------------------------------------------------------------- */
/* Messaging                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Message addressing. `chrome.runtime.onMessage` fires in *every* extension context,
 * so every message carries `target` and every listener drops anything not addressed
 * to it — otherwise the popup receives the service worker's traffic to the offscreen
 * document and vice versa.
 *
 * @type {Readonly<{SW: 'sw', OFFSCREEN: 'offscreen'}>}
 */
export const TARGET = Object.freeze({
  SW: 'sw',
  OFFSCREEN: 'offscreen'
});

/**
 * Every message `type` on the wire. Each key equals its own value, so `MSG.START`
 * is `'START'`; the value strings are what travel between contexts.
 *
 * Wire shapes — request → response:
 *
 *   popup → sw   {target:'sw', type:'GET_STATE', tabId}
 *                  → {state, muted, armed, restricted, reason}
 *   popup → sw   {target:'sw', type:'SET_STATE', tabId, patch}
 *                  → {state, armed}
 *   popup → sw   {target:'sw', type:'SET_MUTED', tabId, muted}
 *                  → {muted}
 *   popup → sw   {target:'sw', type:'RESET', tabId}
 *                  → {state, armed}
 *   popup → sw   {target:'sw', type:'METER', tabId}
 *                  → {ok, meter}            (sw relays to the offscreen document)
 *
 *   sw → offscreen {target:'offscreen', type:'START', tabId, streamId, state}
 *                  → {ok:true} | {ok:false, error}
 *   sw → offscreen {target:'offscreen', type:'APPLY', tabId, state}
 *                  → {ok:boolean}
 *   sw → offscreen {target:'offscreen', type:'STOP', tabId}
 *                  → {ok:true, remaining:number}
 *   sw → offscreen {target:'offscreen', type:'REKEY', fromTabId, toTabId}
 *                  → {ok:boolean, present:boolean}
 *   sw → offscreen {target:'offscreen', type:'LIST'}
 *                  → {tabIds:number[]}
 *   sw → offscreen {target:'offscreen', type:'METER', tabId}
 *                  → {ok, meter}
 *
 *   offscreen → sw {target:'sw', type:'STREAM_ENDED', tabId}   — no response
 *
 * `METER` is one constant covering both hops (popup→sw and sw→offscreen); the
 * `target` field is what distinguishes them.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const MSG = Object.freeze({
  GET_STATE: 'GET_STATE',
  SET_STATE: 'SET_STATE',
  SET_MUTED: 'SET_MUTED',
  RESET: 'RESET',
  METER: 'METER',
  START: 'START',
  APPLY: 'APPLY',
  STOP: 'STOP',
  REKEY: 'REKEY',
  LIST: 'LIST',
  STREAM_ENDED: 'STREAM_ENDED'
});

/* -------------------------------------------------------------------------- */
/* State helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Clamp one numeric field. Anything that is not a finite JS number — NaN, Infinity,
 * a numeric string, null — falls back to the default rather than propagating a bad
 * value into an AudioParam, where NaN poisons the whole graph for good.
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalise any partial/untrusted object into a complete, in-range state.
 *
 * Always returns a fresh object, never the input and never `DEFAULT_STATE` itself,
 * so callers can mutate the result freely. Missing keys take the default.
 *
 * @param {Partial<TabAudioState>|null|undefined} partial
 * @returns {TabAudioState}
 */
export function clampState(partial) {
  const source = (partial && typeof partial === 'object') ? partial : {};
  return {
    gain: clampNumber(source.gain, 0, MAX_GAIN, DEFAULT_STATE.gain),
    mono: source.mono === undefined ? DEFAULT_STATE.mono : Boolean(source.mono),
    balance: clampNumber(source.balance, -1, 1, DEFAULT_STATE.balance)
  };
}

/**
 * True when the state is exactly neutral.
 *
 * Exact equality on purpose — no epsilon. This gates releasing capture, and a fuzzy
 * match would tear the graph down while the user sits at 101%, jumping the audio.
 *
 * @param {TabAudioState} state
 * @returns {boolean}
 */
export function isDefaultState(state) {
  return !!state && state.gain === 1 && state.mono === false && state.balance === 0;
}

/**
 * Badge text for the toolbar action. Precedence is first-match-wins in the order
 * below; a tab that is both boosted and mono shows the boost. Three contexts depend
 * on getting the same answer, so the order is contract, not preference.
 *
 * The longest possible result is `'600'` — the badge only fits about four characters.
 *
 * @param {TabAudioState} state
 * @param {boolean} muted  Chrome's own tab mute, not part of TabAudioState
 * @returns {string}
 */
export function badgeTextFor(state, muted) {
  if (muted) return 'off';
  const s = state || DEFAULT_STATE;
  if (s.gain !== 1) return String(Math.round(s.gain * 100));
  if (s.mono) return 'M';
  if (s.balance < 0) return 'L';
  if (s.balance > 0) return 'R';
  return '';
}

/* -------------------------------------------------------------------------- */
/* URL guards                                                                  */
/* -------------------------------------------------------------------------- */

/** Schemes the extension can neither capture nor script. */
const RESTRICTED_SCHEMES = new Set([
  'chrome:',
  'chrome-untrusted:',
  'chrome-extension:',
  'chrome-search:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
  'file:'
]);

/**
 * True for pages the extension cannot capture or script — browser UI, other
 * extensions, the Web Store, and local files (which need a per-extension opt-in).
 *
 * The URL is parsed rather than substring-matched: `includes('chrome://')` would
 * call `https://example.com/?u=chrome://settings` restricted, which any page could
 * trigger deliberately. An absent or unparseable URL is treated as restricted —
 * the popup can open before the tab reports one, and guessing wrong the other way
 * means a failed capture.
 *
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isRestrictedUrl(url) {
  if (typeof url !== 'string' || url === '') return true;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  if (RESTRICTED_SCHEMES.has(parsed.protocol)) return true;
  return isWebStoreUrl(parsed);
}

/**
 * The Web Store blocks extension access on both its current and legacy hosts.
 *
 * @param {URL} parsed
 * @returns {boolean}
 */
function isWebStoreUrl(parsed) {
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname === 'chromewebstore.google.com') return true;
  return parsed.hostname === 'chrome.google.com' &&
    (parsed.pathname === '/webstore' || parsed.pathname.startsWith('/webstore/'));
}

/**
 * Human-readable explanation for a URL that {@link isRestrictedUrl} rejects. The
 * popup shows this verbatim, so it is a sentence, not an error code.
 *
 * @param {string|null|undefined} url
 * @returns {string}
 */
export function restrictionReason(url) {
  if (typeof url !== 'string' || url === '') {
    return 'This tab has not loaded a page yet.';
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'This page cannot be captured.';
  }

  switch (parsed.protocol) {
    case 'file:':
      return 'Local files (file://) are not supported.';
    case 'chrome-extension:':
      return 'Extension pages cannot be captured.';
    case 'chrome:':
    case 'chrome-untrusted:':
    case 'chrome-search:':
    case 'devtools:':
    case 'edge:':
    case 'about:':
    case 'view-source:':
      return 'Browser pages (such as chrome:// and about:) cannot be captured.';
    default:
      break;
  }

  if (isWebStoreUrl(parsed)) {
    return 'The Chrome Web Store does not allow extensions to run on its pages.';
  }
  return 'This page cannot be captured.';
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Flatten anything thrown into one readable line. Capture failures reach the
 * popup as a `reason`, and the messages Chrome puts on its own errors (activeTab,
 * restricted pages) are the most useful thing available, so they are kept.
 *
 * Total: it runs on last-resort error paths, where a second throw would cost the
 * caller its response. A Symbol, or an object whose `toString` throws, must not
 * escape.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  if (!err) return 'Unknown error.';
  try {
    if (typeof err === 'string') return err;
    if (typeof err === 'object' && 'message' in err && err.message) {
      const message = String(/** @type {{message: unknown}} */ (err).message);
      const name = /** @type {{name?: unknown}} */ (err).name;
      return typeof name === 'string' && name !== '' && name !== 'Error'
        ? `${name}: ${message}`
        : message;
    }
    return String(err);
  } catch {
    return 'Unknown error.';
  }
}
