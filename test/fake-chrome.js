/**
 * A small in-memory stand-in for the `chrome.*` APIs the service worker uses,
 * plus a fake offscreen engine behind `runtime.sendMessage` and manual timers.
 */

export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** Fire every timer currently scheduled (not ones they schedule). */
    runAll() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, timer] of due) timer.fn();
    },
    get size() {
      return pending.size;
    }
  };
}

function event() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), listeners };
}

/**
 * @param {{tabs?: Record<number, object>, captureError?: string}} [options]
 */
export function createFakeChrome(options = {}) {
  const storage = new Map();
  const tabs = new Map(Object.entries(options.tabs || {}).map(([id, tab]) => [Number(id), { id: Number(id), ...tab }]));
  const badges = new Map();
  const calls = { getMediaStreamId: 0, offscreen: [] };
  const graphs = new Set();
  let hasDocument = false;

  function offscreenHandle(message) {
    calls.offscreen.push(message.type);
    switch (message.type) {
      case 'START':
        graphs.add(message.tabId);
        return { ok: true };
      case 'APPLY':
        return { ok: graphs.has(message.tabId) };
      case 'STOP':
        graphs.delete(message.tabId);
        return { ok: true, remaining: graphs.size };
      case 'LIST':
        return { tabIds: [...graphs] };
      case 'METER':
        return graphs.has(message.tabId)
          ? { ok: true, meter: { outLeftRmsDb: -20, outRightRmsDb: -20, outPeakDb: -6 } }
          : { ok: false, meter: null };
      case 'REKEY':
        return { ok: true, present: false };
      default:
        return { ok: false, error: 'unknown' };
    }
  }

  const chrome = {
    storage: {
      session: {
        async get(key) {
          return storage.has(key) ? { [key]: structuredClone(storage.get(key)) } : {};
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) storage.set(k, structuredClone(v));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) storage.delete(k);
        }
      }
    },
    tabs: {
      async get(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        return structuredClone(tabs.get(id));
      },
      async update(id, props) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        if ('muted' in props) tab.mutedInfo = { muted: !!props.muted };
        return structuredClone(tab);
      },
      onRemoved: event(),
      onReplaced: event(),
      onUpdated: event()
    },
    action: {
      async setBadgeText({ tabId, text }) {
        badges.set(tabId, text);
      }
    },
    offscreen: {
      async hasDocument() {
        return hasDocument;
      },
      async createDocument() {
        hasDocument = true;
      },
      async closeDocument() {
        hasDocument = false;
        graphs.clear();
      }
    },
    tabCapture: {
      async getMediaStreamId({ targetTabId }) {
        calls.getMediaStreamId += 1;
        if (options.captureError) throw new Error(options.captureError);
        return `stream-${targetTabId}-${calls.getMediaStreamId}`;
      }
    },
    runtime: {
      onMessage: event(),
      async sendMessage(message) {
        if (message.target !== 'offscreen') return undefined;
        if (!hasDocument) throw new Error('Could not establish connection. Receiving end does not exist.');
        return offscreenHandle(message);
      }
    }
  };

  return { chrome, storage, tabs, badges, calls, graphs, isDocumentOpen: () => hasDocument };
}
