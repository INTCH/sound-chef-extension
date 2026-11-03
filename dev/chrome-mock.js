/**
 * Development only: a tiny stand-in for the `chrome.*` calls the popup makes, so
 * popup/popup.html can be rendered as a plain web page (for screenshots and
 * styling work). It is not part of the packaged extension.
 *
 * Query parameters (all optional):
 *   gain=2.5         boost, 0..6 (1 = 100%)
 *   mono=1           mono downmix on
 *   balance=-0.3     -1..1
 *   muted=1          tab muted
 *   restricted=1     pretend the tab is a page that cannot be captured
 *   silent=1         no meter signal
 */

const params = new URLSearchParams(location.search);
const num = (key, fallback) => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : fallback;
};

const state = {
  gain: num('gain', 2.5),
  mono: params.get('mono') === '1',
  balance: num('balance', 0)
};
let muted = params.get('muted') === '1';
const restricted = params.get('restricted') === '1';
const silent = params.get('silent') === '1';

const isDefault = () => state.gain === 1 && !state.mono && state.balance === 0;
const armed = () => !restricted && !isDefault();

/** A slowly moving synthetic level so the meter looks alive. */
function meter() {
  const t = performance.now() / 1000;
  const base = -14 + 20 * Math.log10(Math.max(0.05, Math.min(1, state.gain / 2.5)));
  const wobble = 3 * Math.sin(t * 2.1) + 1.5 * Math.sin(t * 5.3);
  const left = base + wobble + (state.balance > 0 ? 20 * Math.log10(1 - state.balance + 1e-3) : 0);
  const right = base + wobble + 0.8 + (state.balance < 0 ? 20 * Math.log10(1 + state.balance + 1e-3) : 0);
  const l = Math.min(-0.1, state.mono ? (left + right) / 2 : left);
  const r = Math.min(-0.1, state.mono ? (left + right) / 2 : right);
  return {
    outLeftRmsDb: l,
    outRightRmsDb: r,
    outLeftPeakDb: Math.min(-0.1, l + 6),
    outRightPeakDb: Math.min(-0.1, r + 6),
    outPeakDb: Math.min(-0.1, Math.max(l, r) + 6)
  };
}

function handle(message) {
  switch (message.type) {
    case 'GET_STATE':
      return {
        state: { ...state },
        muted,
        armed: armed(),
        restricted,
        reason: restricted ? 'Browser pages (such as chrome:// and about:) cannot be captured.' : ''
      };
    case 'SET_STATE':
      Object.assign(state, message.patch || {});
      return { state: { ...state }, armed: armed() };
    case 'RESET':
      Object.assign(state, { gain: 1, mono: false, balance: 0 });
      return { state: { ...state }, armed: false };
    case 'SET_MUTED':
      muted = !!message.muted;
      return { muted };
    case 'METER':
      return armed() && !silent ? { ok: true, meter: meter() } : { ok: false, meter: null };
    default:
      return null;
  }
}

globalThis.chrome = {
  runtime: {
    async sendMessage(message) {
      return handle(message);
    }
  },
  tabs: {
    async query() {
      return [{ id: 1 }];
    }
  }
};
