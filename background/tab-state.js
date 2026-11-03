/**
 * Sound Chef — per-tab state storage.
 *
 * Everything the service worker knows must survive its own termination, so this
 * module is the only place that touches `chrome.storage.session`. Nothing here
 * caches in a worker global: a read always goes to storage, because a worker
 * global is gone 30 s after the last event and a stale global is worse than a
 * slow read.
 *
 * Layout:
 *   `tab:<id>`  → TabAudioState              one key per tab, so two tab events
 *                                            can never read-modify-write over
 *                                            each other's tabs
 *   `armed`     → number[]                   CACHE ONLY. The offscreen document
 *                                            holds the graphs and is the truth;
 *                                            this is reconciled against LIST.
 *   `err:<id>`  → string                     last capture failure for a tab, so
 *                                            GET_STATE can report a `reason`
 *                                            even after the worker restarted
 *
 * The store is created with `createTabStore(chromeApi)` rather than grabbing the
 * global `chrome`, so a fake can be injected for testing.
 */

import { ARMED_KEY, clampState, tabStateKey } from '../common/protocol.js';

/** @typedef {import('../common/protocol.js').TabAudioState} TabAudioState */

/**
 * Storage key for the last capture error reported for a tab.
 *
 * Not part of the wire contract — it exists only so the `reason` field of
 * GET_STATE survives a worker restart between the failing SET_STATE and the
 * popup asking why nothing happened.
 *
 * @param {number} tabId
 * @returns {string}
 */
export function errorKey(tabId) {
  return `err:${tabId}`;
}

/**
 * Create a storage accessor bound to a `chrome`-shaped API.
 *
 * @param {any} [chromeApi] Defaults to the ambient `chrome`, read lazily so this
 *   module can be imported under node before any global exists.
 * @returns {{
 *   readState: (tabId: number) => Promise<TabAudioState>,
 *   writeState: (tabId: number, state: TabAudioState) => Promise<void>,
 *   deleteState: (tabId: number) => Promise<void>,
 *   migrateTabKey: (fromTabId: number, toTabId: number) => Promise<void>,
 *   readArmedCache: () => Promise<number[]>,
 *   writeArmedCache: (tabIds: number[]) => Promise<number[]>,
 *   markArmed: (tabId: number) => Promise<number[]>,
 *   markUnarmed: (tabId: number) => Promise<number[]>,
 *   replaceArmed: (fromTabId: number, toTabId: number|null) => Promise<number[]>,
 *   readError: (tabId: number) => Promise<string>,
 *   writeError: (tabId: number, message: string) => Promise<void>,
 *   clearError: (tabId: number) => Promise<void>
 * }}
 */
export function createTabStore(chromeApi) {
  const api = () => chromeApi || globalThis.chrome;
  const session = () => api().storage.session;

  /**
   * Serialises every read-modify-write of the single `armed` key. Two tab events
   * landing in the same turn would otherwise both read the old array and the
   * second write would erase the first.
   * @type {Promise<unknown>}
   */
  let armedChain = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withArmedLock(fn) {
    const run = armedChain.then(fn, fn);
    armedChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * @param {string} key
   * @returns {Promise<any>}
   */
  async function getRaw(key) {
    const bag = await session().get(key);
    return bag ? bag[key] : undefined;
  }

  /**
   * @param {number} tabId
   * @returns {Promise<TabAudioState>}
   */
  async function readState(tabId) {
    // clampState strips unknown keys and repairs anything corrupt, so a raw
    // storage read can be handed straight to it.
    return clampState(await getRaw(tabStateKey(tabId)));
  }

  /**
   * @param {number} tabId
   * @param {TabAudioState} state
   * @returns {Promise<void>}
   */
  async function writeState(tabId, state) {
    await session().set({ [tabStateKey(tabId)]: clampState(state) });
  }

  /**
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function deleteState(tabId) {
    await session().remove([tabStateKey(tabId), errorKey(tabId)]);
  }

  /**
   * Move a tab's settings to a new tabId. `tabs.onReplaced` hands out a brand new
   * id for the same page, and the user's 300% must follow the page, not the id.
   *
   * @param {number} fromTabId
   * @param {number} toTabId
   * @returns {Promise<void>}
   */
  async function migrateTabKey(fromTabId, toTabId) {
    if (fromTabId === toTabId) return;
    const raw = await getRaw(tabStateKey(fromTabId));
    if (raw !== undefined) {
      await session().set({ [tabStateKey(toTabId)]: clampState(raw) });
    }
    await session().remove([tabStateKey(fromTabId), errorKey(fromTabId)]);
  }

  /**
   * @returns {Promise<number[]>}
   */
  async function readArmedCache() {
    const raw = await getRaw(ARMED_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((id) => typeof id === 'number' && Number.isFinite(id));
  }

  /**
   * @param {number[]} tabIds
   * @returns {Promise<number[]>}
   */
  async function writeArmedCache(tabIds) {
    const unique = [...new Set((tabIds || []).filter(
      (id) => typeof id === 'number' && Number.isFinite(id)
    ))];
    await session().set({ [ARMED_KEY]: unique });
    return unique;
  }

  /**
   * @param {number} tabId
   * @returns {Promise<number[]>}
   */
  function markArmed(tabId) {
    return withArmedLock(async () => {
      const ids = await readArmedCache();
      if (ids.includes(tabId)) return ids;
      return writeArmedCache([...ids, tabId]);
    });
  }

  /**
   * @param {number} tabId
   * @returns {Promise<number[]>}
   */
  function markUnarmed(tabId) {
    return withArmedLock(async () => {
      const ids = await readArmedCache();
      if (!ids.includes(tabId)) return ids;
      return writeArmedCache(ids.filter((id) => id !== tabId));
    });
  }

  /**
   * Swap one id for another in the armed cache. `toTabId === null` just drops the
   * old id — used when a prerender swap took the stream down with it.
   *
   * @param {number} fromTabId
   * @param {number|null} toTabId
   * @returns {Promise<number[]>}
   */
  function replaceArmed(fromTabId, toTabId) {
    return withArmedLock(async () => {
      const ids = (await readArmedCache()).filter((id) => id !== fromTabId);
      if (typeof toTabId === 'number') ids.push(toTabId);
      return writeArmedCache(ids);
    });
  }

  /**
   * @param {number} tabId
   * @returns {Promise<string>}
   */
  async function readError(tabId) {
    const raw = await getRaw(errorKey(tabId));
    return typeof raw === 'string' ? raw : '';
  }

  /**
   * @param {number} tabId
   * @param {string} message
   * @returns {Promise<void>}
   */
  async function writeError(tabId, message) {
    await session().set({ [errorKey(tabId)]: String(message || '') });
  }

  /**
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function clearError(tabId) {
    await session().remove(errorKey(tabId));
  }

  return {
    readState,
    writeState,
    deleteState,
    migrateTabKey,
    readArmedCache,
    writeArmedCache,
    markArmed,
    markUnarmed,
    replaceArmed,
    readError,
    writeError,
    clearError
  };
}
