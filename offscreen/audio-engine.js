/**
 * Sound Chef — offscreen audio engine.
 *
 * Owns the single AudioContext for the whole offscreen document and one Web Audio
 * graph per captured tab, all summing through a shared master limiter into
 * `ctx.destination`. Capturing a tab silences that tab's own output, so this
 * destination connection is the only remaining path to the speakers: dropping it
 * produces total silence, not merely "no boost".
 *
 * Everything above `AudioEngine` is pure maths with no Web Audio and no `chrome.*`
 * dependency, so the limiter curves and balance laws can be unit-tested under
 * node. The class body touches `AudioContext` only inside methods, so importing
 * this module outside a browser is side-effect free.
 */

import {
  MAX_GAIN,
  MASTER_HEADROOM,
  RAMP_SECONDS,
  clampState,
  describeError
} from '../common/protocol.js';

/* -------------------------------------------------------------------------- */
/* Limiter curves — pure maths                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Amplitude below which the per-tab limiter is bit-transparent (-3 dBFS).
 * @type {number}
 */
export const TAB_LIMITER_THRESHOLD = 0.7;

/**
 * Amplitude below which the master limiter is bit-transparent (-1 dBFS). Higher
 * than the tab threshold on purpose: a single tab already leaves its own limiter at
 * <= 1.0, so the master must stay out of the way until several tabs sum.
 * @type {number}
 */
export const MASTER_LIMITER_THRESHOLD = 0.9;

/**
 * Asymptote of both limiter curves, i.e. the highest amplitude either can emit.
 *
 * Deliberately below 1.0. `WaveShaperNode.oversample = '4x'` resamples through
 * filters that can overshoot roughly 1% on hard-limited material, so a curve that
 * asymptotes to exactly 1.0 makes "output never exceeds 0 dBFS" unachievable by
 * construction — the meter would read a fraction of a dB over on loud content with
 * nothing audibly wrong.
 *
 * 0.990 is chosen so that a full 1% overshoot still lands inside full scale:
 * 0.990 x 1.01 = 0.9999. It costs 0.0873 dB of maximum loudness, which is
 * inaudible, and it keeps the over indicator from lighting on resampling
 * artefacts that a listener cannot tell apart from real clipping.
 * @type {number}
 */
export const LIMITER_CEILING = 0.990;

/**
 * Samples per limiter curve.
 *
 * `WaveShaperNode` spreads the curve over the input range [-1, 1] and interpolates
 * linearly between samples, so resolution is set by the *narrowest* region that has
 * to stay accurate. For the tab limiter the transparent region is only
 * 0.7 / MAX_GAIN = 11.7% of the domain; 16385 points still put ~956 samples inside
 * it (~1.5e-3 of signal amplitude apart), which keeps interpolation error far below
 * the 1e-3 transparency budget even where the knee starts to curve.
 *
 * The count is odd so that index (n-1)/2 lands exactly on input 0, which makes the
 * curve exactly odd-symmetric and the zero crossing exact rather than interpolated.
 * @type {number}
 */
export const LIMITER_CURVE_POINTS = 16385;

/**
 * Gain applied *before* the per-tab WaveShaper.
 *
 * Load-bearing, not cosmetic: `WaveShaperNode` clamps its input to [-1, 1] before
 * the curve lookup, so a curve fed raw signal would hard-clip everything above
 * unity — precisely the range a 600% booster lives in. The pre-scaler maps the
 * 0..MAX_GAIN signal range onto the curve's domain; the curve carries the makeup
 * gain back out.
 * @type {number}
 */
export const TAB_PRE_SCALE = 1 / MAX_GAIN;

/**
 * Gain applied before the master WaveShaper, for the same reason.
 * @type {number}
 */
export const MASTER_PRE_SCALE = 1 / MASTER_HEADROOM;

/**
 * Soft-saturation transfer function: identity up to `threshold`, then a tanh knee
 * that is C1-continuous at the threshold (both sides have slope 1) and asymptotes
 * to exactly `LIMITER_CEILING`. Odd-symmetric.
 *
 * Sizing the knee as `ceiling - threshold` is what keeps the slope at the threshold
 * exactly 1 whatever the ceiling is, so lowering the ceiling costs headroom at the
 * top and changes nothing below the threshold.
 *
 * @param {number} x          Signal amplitude.
 * @param {number} threshold  Amplitude below which the function is the identity.
 * @param {number} ceiling    Asymptote of the saturated region.
 * @returns {number}
 */
function saturate(x, threshold, ceiling) {
  const magnitude = Math.abs(x);
  if (magnitude <= threshold) return x;
  const knee = ceiling - threshold;
  const shaped = threshold + knee * Math.tanh((magnitude - threshold) / knee);
  return x < 0 ? -shaped : shaped;
}

/**
 * Build a `WaveShaperNode.curve` for a limiter whose input has already been scaled
 * by `1 / range`.
 *
 * Sample i of the returned array is the output for shaper input
 * `u = 2i/(n-1) - 1`, i.e. for a pre-scaler input of `u * range`.
 *
 * @param {{threshold: number, range: number, points?: number, ceiling?: number}} options
 * @returns {Float32Array}
 */
export function buildLimiterCurve({
  threshold,
  range,
  points = LIMITER_CURVE_POINTS,
  ceiling = LIMITER_CEILING
}) {
  if (!Number.isFinite(range) || range <= 0) {
    throw new RangeError('buildLimiterCurve: range must be a finite number > 0');
  }
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 1) {
    throw new RangeError('buildLimiterCurve: ceiling must be in (0, 1]');
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= ceiling) {
    throw new RangeError('buildLimiterCurve: threshold must be in (0, ceiling)');
  }
  if (!Number.isInteger(points) || points < 3) {
    throw new RangeError('buildLimiterCurve: points must be an integer >= 3');
  }

  const curve = new Float32Array(points);
  const last = points - 1;
  for (let i = 0; i <= last; i += 1) {
    const u = (2 * i) / last - 1;
    curve[i] = saturate(u * range, threshold, ceiling);
  }
  return curve;
}

/**
 * The exact curve the per-tab limiter uses. Exported so the unit tests exercise
 * the shipped curve rather than a re-specified copy of it.
 * @returns {Float32Array}
 */
export function createTabLimiterCurve() {
  return buildLimiterCurve({ threshold: TAB_LIMITER_THRESHOLD, range: MAX_GAIN });
}

/**
 * The exact curve the master limiter uses.
 * @returns {Float32Array}
 */
export function createMasterLimiterCurve() {
  return buildLimiterCurve({ threshold: MASTER_LIMITER_THRESHOLD, range: MASTER_HEADROOM });
}

/**
 * Reproduce `WaveShaperNode`'s curve lookup: clamp the input to [-1, 1], map it onto
 * the curve index space and interpolate linearly, matching the algorithm in the Web
 * Audio spec. Used by the unit tests; there is no browser API that exposes the
 * lookup, so this is the only way to assert the transfer function numerically.
 *
 * `oversample` is not modelled — it only affects aliasing, not the transfer curve.
 *
 * @param {Float32Array} curve
 * @param {number} input  Value arriving at the shaper, i.e. already pre-scaled.
 * @returns {number}
 */
export function evaluateShaperCurve(curve, input) {
  const n = curve.length;
  if (n === 0) return 0;
  if (n === 1) return curve[0];

  const clamped = Math.min(1, Math.max(-1, input));
  const virtualIndex = 0.5 * (clamped + 1) * (n - 1);
  const index = Math.floor(virtualIndex);
  if (index >= n - 1) return curve[n - 1];

  const fraction = virtualIndex - index;
  return (1 - fraction) * curve[index] + fraction * curve[index + 1];
}

/**
 * Full pre-scaler + shaper round trip, in signal amplitude on both ends.
 *
 * @param {Float32Array} curve
 * @param {number} x         Signal amplitude arriving at the pre-scaler.
 * @param {number} preScale  The pre-scaler's gain.
 * @returns {number}
 */
export function evaluateLimiter(curve, x, preScale) {
  return evaluateShaperCurve(curve, x * preScale);
}

/* -------------------------------------------------------------------------- */
/* Balance law                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Channel gains for the balance stage. Pure, so both laws are testable offline.
 *
 * Two different laws, because "balance" means two different things depending on
 * whether the signal is still stereo:
 *
 * - **stereo** — a true balance: attenuate the far channel and leave the near one
 *   alone. A balance slider must not double as a loudness control. (A
 *   `StereoPannerNode` at pan = -1 sums R into L, which makes a near-mono podcast
 *   about 6 dB louder and, at 600%, drives the tab limiter at 12x into audible
 *   saturation on material that was clean at centre.)
 * - **mono** — a pan, preserving total energy in the surviving ear. The signal is
 *   already correlated, so there is no image to protect, and a listener using one
 *   earbud wants all of the energy in it.
 *
 * Both laws return `(1, 1)` at `balance = 0`, so switching between them at centre
 * is continuous and a mono toggle at any balance just ramps two gains.
 *
 * @param {number} balance -1..1
 * @param {boolean} mono
 * @returns {{left: number, right: number}}
 */
export function balanceGains(balance, mono) {
  const b = Number.isFinite(balance) ? Math.min(1, Math.max(-1, balance)) : 0;
  if (mono) {
    return { left: 1 - b, right: 1 + b };
  }
  return {
    left: b <= 0 ? 1 : 1 - b,
    right: b >= 0 ? 1 : 1 + b
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Analyser window. ~46 ms at 48 kHz — long enough for a stable RMS. */
const METER_FFT_SIZE = 2048;

/**
 * Stop every track of a stream that no graph owns. Total — it runs on error paths
 * where a second throw would strand the capture.
 *
 * @param {MediaStream} stream
 * @returns {void}
 */
function stopAllTracks(stream) {
  try {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Already ended.
      }
    }
  } catch {
    // Not a usable MediaStream; nothing to release.
  }
}

/**
 * Normalise a tab id off the wire into a Map key.
 *
 * Unlike `clampState`, this *does* coerce: tab ids are identifiers, not audio
 * parameters, and a string id that silently misses the registry would look exactly
 * like a dead graph.
 *
 * Total: `Number(Symbol())` throws, and STOP/APPLY/LIST are contractually
 * non-throwing for any input the service worker can hand them.
 *
 * @param {unknown} tabId
 * @returns {number|null} null when the value cannot be a tab id.
 */
function toTabKey(tabId) {
  let n;
  try {
    n = Number(tabId);
  } catch {
    return null;
  }
  return Number.isInteger(n) ? n : null;
}

/**
 * Schedule an AudioParam change. Direct `.value` assignment on a live graph is a
 * discontinuity and clicks; a short linear ramp from the current value does not.
 *
 * @param {AudioParam} param
 * @param {number} value
 * @param {number} now  `ctx.currentTime`
 * @returns {void}
 */
function rampParam(param, value, now) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + RAMP_SECONDS);
}

/**
 * True RMS and peak of an analyser's current time-domain window.
 *
 * `getFloatTimeDomainData` and not `getFloatFrequencyData`: the frequency data is
 * already windowed, smoothed and in dB per bin, which is the wrong quantity.
 *
 * @param {AnalyserNode} analyser
 * @param {Float32Array} buffer  Reused between calls to avoid per-poll allocation.
 * @returns {{rms: number, peak: number}}
 */
function measure(analyser, buffer) {
  analyser.getFloatTimeDomainData(buffer);
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i];
    sumSquares += sample * sample;
    const magnitude = sample < 0 ? -sample : sample;
    if (magnitude > peak) peak = magnitude;
  }
  return { rms: Math.sqrt(sumSquares / buffer.length), peak };
}

/**
 * Linear amplitude to dBFS. Digital silence is `-Infinity`, never `NaN` and never a
 * sentinel like -1000 that a consumer could mistake for a real level.
 *
 * @param {number} amplitude
 * @returns {number}
 */
function toDb(amplitude) {
  if (!Number.isFinite(amplitude) || amplitude <= 0) return -Infinity;
  return 20 * Math.log10(amplitude);
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} TabGraph
 * @property {number} tabId            Current key; REKEY rewrites this.
 * @property {MediaStream} stream
 * @property {MediaStreamTrack[]} tracks
 * @property {() => void} handleEnded
 * @property {boolean} disposed
 * @property {import('../common/protocol.js').TabAudioState} state
 * @property {AudioNode[]} nodes       Everything to disconnect on teardown.
 * @property {GainNode} stereoGain
 * @property {GainNode} monoGain
 * @property {GainNode} balLeft
 * @property {GainNode} balRight
 * @property {GainNode} boost
 * @property {AnalyserNode} inMeter
 * @property {AnalyserNode} outMeterL
 * @property {AnalyserNode} outMeterR
 * @property {Float32Array} inBuffer
 * @property {Float32Array} leftBuffer
 * @property {Float32Array} rightBuffer
 */

/**
 * One engine per offscreen document. Holds the authoritative registry of live
 * graphs — the service worker's stored `armed` set is only a cache, because the
 * worker is torn down after 30 s of inactivity while this document and its
 * MediaStreams keep running. `list()` is what the worker re-syncs against.
 */
export class AudioEngine {
  /**
   * @param {{onStreamEnded?: (tabId: number) => void}} [options]
   */
  constructor({ onStreamEnded } = {}) {
    /** @type {(tabId: number) => void} */
    this.onStreamEnded = typeof onStreamEnded === 'function' ? onStreamEnded : () => {};
    /** @type {Map<number, TabGraph>} */
    this.graphs = new Map();
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {{bus: GainNode, preScale: GainNode, limiter: WaveShaperNode, meterSink: GainNode}|null} */
    this.master = null;

    // Built once and shared by every tab limiter: the curve is read-only to the
    // node and identical for all tabs, so 64 KB total rather than per graph.
    this.tabCurve = createTabLimiterCurve();
    this.masterCurve = createMasterLimiterCurve();
  }

  /**
   * Create the shared context and master chain on first use, and make sure the
   * context is running.
   *
   * A suspended context stops `currentTime` advancing, which turns every
   * `linearRampToValueAtTime` into a silent no-op while `start()` still reports
   * success — so the resume is not optional and `contextState` is reported in every
   * meter reading.
   *
   * @returns {Promise<AudioContext>}
   */
  async ensureContext() {
    if (!this.ctx) {
      const ctx = new AudioContext();

      const bus = ctx.createGain();
      const preScale = ctx.createGain();
      preScale.gain.value = MASTER_PRE_SCALE;
      const limiter = ctx.createWaveShaper();
      limiter.curve = this.masterCurve;
      limiter.oversample = '4x';

      bus.connect(preScale);
      preScale.connect(limiter);
      limiter.connect(ctx.destination);

      // Silent terminal for the analyser taps. A node that is not reachable from
      // the destination is not guaranteed to be pulled by the renderer; routing the
      // analysers through a gain of exactly 0 keeps them inside the rendered graph
      // without putting a single sample of them on the audible path.
      const meterSink = ctx.createGain();
      meterSink.gain.value = 0;
      meterSink.connect(ctx.destination);

      // Tap the *summed* output, after the master limiter. The per-tab meters sit
      // upstream of the master, so they cannot show what the master does to
      // several tabs playing at once; masterRmsDb / masterPeakDb can.
      const masterMeter = ctx.createAnalyser();
      masterMeter.fftSize = METER_FFT_SIZE;
      limiter.connect(masterMeter);
      masterMeter.connect(meterSink);

      this.ctx = ctx;
      this.master = {
        bus,
        preScale,
        limiter,
        meterSink,
        masterMeter,
        masterBuffer: new Float32Array(masterMeter.fftSize)
      };
    }

    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        // A closed context cannot resume; the caller surfaces the failure instead.
      }
    }
    return this.ctx;
  }

  /**
   * Capture a tab and build its graph.
   *
   * START on a tabId that already has a graph **replaces** it: the old graph is torn
   * down first and a fresh one built. Rejecting instead would leave a dead graph
   * (a reloaded or prerender-swapped tab whose stream already ended) wedged in the
   * registry with no way for the service worker to recover.
   *
   * @param {number} tabId
   * @param {string} streamId  Single-use `chrome.tabCapture` id; consumed immediately.
   * @param {Partial<import('../common/protocol.js').TabAudioState>} state
   * @returns {Promise<{ok: true}|{ok: false, error: string}>}
   */
  async start(tabId, streamId, state) {
    const key = toTabKey(tabId);
    if (key === null) return { ok: false, error: 'Invalid tab id.' };
    if (typeof streamId !== 'string' || streamId === '') {
      return { ok: false, error: 'Missing capture stream id.' };
    }

    let ctx;
    try {
      ctx = await this.ensureContext();
    } catch (err) {
      return { ok: false, error: `AudioContext unavailable: ${describeError(err)}` };
    }
    if (ctx.state === 'closed') {
      return { ok: false, error: 'AudioContext is closed.' };
    }

    this.destroyGraph(key);

    let stream;
    try {
      // Legacy mandatory-constraint form. The modern `deviceId` form throws
      // OverconstrainedError for tab capture streams.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      });
    } catch (err) {
      return { ok: false, error: `getUserMedia failed: ${describeError(err)}` };
    }

    // From here until `graphs.set`, this stream is live and silencing the tab while
    // nothing in the registry references it. If we return without stopping it,
    // `destroyGraph` can never find it: the tab stays muted with the capture
    // indicator up until the user closes it, and the next START stacks a second
    // capture on top. So every exit from this block stops the tracks first.
    let graph;
    try {
      // A second START for the same tab may have landed while we awaited the stream.
      this.destroyGraph(key);
      graph = this.buildGraph(ctx, key, stream, clampState(state));
    } catch (err) {
      stopAllTracks(stream);
      return { ok: false, error: `Audio graph construction failed: ${describeError(err)}` };
    }

    this.graphs.set(key, graph);
    return { ok: true };
  }

  /**
   * Wire one tab's nodes. Both the stereo and mono paths stay connected for the
   * lifetime of the graph and are cross-faded; `disconnect()`/`connect()` on a live
   * graph has a long history of click artefacts in Chrome, and a cross-fade avoids
   * the topology change entirely.
   *
   * @param {AudioContext} ctx
   * @param {number} tabId
   * @param {MediaStream} stream
   * @param {import('../common/protocol.js').TabAudioState} state
   * @returns {TabGraph}
   */
  buildGraph(ctx, tabId, stream, state) {
    const master = /** @type {{bus: GainNode, meterSink: GainNode}} */ (this.master);

    const source = ctx.createMediaStreamSource(stream);

    const inMeter = ctx.createAnalyser();
    inMeter.fftSize = METER_FFT_SIZE;

    const stereoGain = ctx.createGain();

    // Explicit single-channel + 'speakers' interpretation is what performs the
    // 0.5 * (L + R) downmix.
    const monoDown = ctx.createGain();
    monoDown.channelCount = 1;
    monoDown.channelCountMode = 'explicit';
    monoDown.channelInterpretation = 'speakers';

    // The same mono signal into both merger inputs. Feeding one channel straight
    // into StereoPannerNode would apply equal-power panning and lose ~3 dB against
    // the stereo path; this up-mix keeps the two paths level-matched.
    const monoMerge = ctx.createChannelMerger(2);
    const monoGain = ctx.createGain();

    // Forced to stereo. A ChannelSplitterNode interprets its input as *discrete*,
    // so a 1-channel input would land on output 0 with output 1 zeroed — the
    // balance stage would silence the right channel of a mono tab. Making the mix
    // explicitly 2-channel with 'speakers' interpretation up-mixes a mono source
    // properly (and down-mixes a >2-channel one) before the split.
    const mix = ctx.createGain();
    mix.channelCount = 2;
    mix.channelCountMode = 'explicit';
    mix.channelInterpretation = 'speakers';

    // Balance: split, scale each channel, merge. Both balance laws are the same
    // topology and differ only in the two gain values, so switching between them
    // is a ramp and never a reconnection.
    const balSplit = ctx.createChannelSplitter(2);
    const balLeft = ctx.createGain();
    const balRight = ctx.createGain();
    const balMerge = ctx.createChannelMerger(2);

    const boost = ctx.createGain();

    const preScale = ctx.createGain();
    preScale.gain.value = TAB_PRE_SCALE;

    const limiter = ctx.createWaveShaper();
    limiter.curve = this.tabCurve;
    limiter.oversample = '4x';

    // AnalyserNode downmixes its input to mono, so per-channel levels need a
    // splitter and one analyser per channel, which is what makes balance visible.
    const outSplit = ctx.createChannelSplitter(2);
    const outMeterL = ctx.createAnalyser();
    outMeterL.fftSize = METER_FFT_SIZE;
    const outMeterR = ctx.createAnalyser();
    outMeterR.fftSize = METER_FFT_SIZE;

    source.connect(inMeter);
    inMeter.connect(master.meterSink);

    source.connect(stereoGain);
    source.connect(monoDown);
    monoDown.connect(monoMerge, 0, 0);
    monoDown.connect(monoMerge, 0, 1);
    monoMerge.connect(monoGain);

    stereoGain.connect(mix);
    monoGain.connect(mix);
    mix.connect(balSplit);
    balSplit.connect(balLeft, 0);
    balSplit.connect(balRight, 1);
    balLeft.connect(balMerge, 0, 0);
    balRight.connect(balMerge, 0, 1);
    balMerge.connect(boost);
    boost.connect(preScale);
    preScale.connect(limiter);

    limiter.connect(master.bus);
    limiter.connect(outSplit);
    outSplit.connect(outMeterL, 0);
    outSplit.connect(outMeterR, 1);
    outMeterL.connect(master.meterSink);
    outMeterR.connect(master.meterSink);

    // Nothing is flowing yet, so the initial values need no ramp.
    const initialBalance = balanceGains(state.balance, state.mono);
    stereoGain.gain.value = state.mono ? 0 : 1;
    monoGain.gain.value = state.mono ? 1 : 0;
    balLeft.gain.value = initialBalance.left;
    balRight.gain.value = initialBalance.right;
    boost.gain.value = state.gain;

    /** @type {TabGraph} */
    const graph = {
      tabId,
      stream,
      tracks: stream.getTracks(),
      handleEnded: () => {},
      disposed: false,
      state,
      nodes: [
        source, inMeter, stereoGain, monoDown, monoMerge, monoGain, mix,
        balSplit, balLeft, balRight, balMerge,
        boost, preScale, limiter, outSplit, outMeterL, outMeterR
      ],
      stereoGain,
      monoGain,
      balLeft,
      balRight,
      boost,
      inMeter,
      outMeterL,
      outMeterR,
      inBuffer: new Float32Array(inMeter.fftSize),
      leftBuffer: new Float32Array(outMeterL.fftSize),
      rightBuffer: new Float32Array(outMeterR.fftSize)
    };

    graph.handleEnded = () => {
      if (graph.disposed) return;
      // `graph.tabId` and not the captured `tabId`: REKEY may have renamed it.
      const endedTabId = graph.tabId;
      this.destroyGraph(endedTabId);
      this.onStreamEnded(endedTabId);
    };
    for (const track of graph.tracks) {
      track.addEventListener('ended', graph.handleEnded);
    }

    return graph;
  }

  /**
   * Apply a new state to a live graph. Every change is a ramp from the current
   * value; mono is a cross-fade between the two permanently connected paths.
   *
   * The state goes through `clampState` even when the service worker already
   * clamped it — this is the last guard before an AudioParam, where a NaN poisons
   * the graph permanently.
   *
   * @param {number} tabId
   * @param {Partial<import('../common/protocol.js').TabAudioState>} state
   * @returns {{ok: boolean}}
   */
  apply(tabId, state) {
    const key = toTabKey(tabId);
    if (key === null) return { ok: false };
    const graph = this.graphs.get(key);
    if (!graph || !this.ctx || this.ctx.state === 'closed') return { ok: false };

    const settled = clampState(state);
    try {
      const now = this.ctx.currentTime;
      const balance = balanceGains(settled.balance, settled.mono);
      rampParam(graph.boost.gain, settled.gain, now);
      rampParam(graph.balLeft.gain, balance.left, now);
      rampParam(graph.balRight.gain, balance.right, now);
      rampParam(graph.stereoGain.gain, settled.mono ? 0 : 1, now);
      rampParam(graph.monoGain.gain, settled.mono ? 1 : 0, now);
    } catch {
      // The service worker reads a plain {ok:false} as "this graph is dead, re-arm
      // it". A throw would reach it as a rejected sendMessage, which it cannot
      // tell apart from the offscreen document having gone away.
      return { ok: false };
    }
    graph.state = settled;
    return { ok: true };
  }

  /**
   * Tear a graph down and report how many are left.
   *
   * Total and idempotent by contract: the service worker calls STOP speculatively,
   * including for tabs it only *believes* are armed, so an unknown or malformed tab
   * id is still `{ok:true}` and this must never throw.
   *
   * @param {number} tabId
   * @returns {{ok: true, remaining: number}}
   */
  stop(tabId) {
    const key = toTabKey(tabId);
    if (key !== null) {
      try {
        this.destroyGraph(key);
      } catch {
        // destroyGraph drops the registry entry before it touches the stream, so
        // the count below is already right; the delete is belt and braces.
        this.graphs.delete(key);
      }
    }
    return { ok: true, remaining: this.graphs.size };
  }

  /**
   * Rename a graph after a prerender activation swapped the tab id.
   *
   * Bookkeeping only. The swap destroys the WebContents the MediaStream is bound to,
   * so the stream ends regardless; there is nothing to keep alive. `present:false`
   * tells the service worker the capture is gone and the new tab needs a fresh
   * START.
   *
   * @param {number} fromTabId
   * @param {number} toTabId
   * @returns {{ok: boolean, present: boolean}}
   */
  rekey(fromTabId, toTabId) {
    const fromKey = toTabKey(fromTabId);
    const toKey = toTabKey(toTabId);
    if (fromKey === null || toKey === null) return { ok: false, present: false };

    const graph = this.graphs.get(fromKey);
    if (!graph) return { ok: true, present: false };
    if (fromKey === toKey) return { ok: true, present: true };

    this.destroyGraph(toKey);
    this.graphs.delete(fromKey);
    graph.tabId = toKey;
    this.graphs.set(toKey, graph);
    return { ok: true, present: true };
  }

  /**
   * The authoritative armed set: tabs that really have a live graph in this
   * document right now.
   *
   * Total, cheap and non-throwing by contract — it runs on every service-worker
   * wake-up, reads nothing but the registry, and touches neither the AudioContext
   * nor storage, so it answers correctly even when the context never initialised.
   * A LIST that failed would make the worker re-arm tabs that are already armed.
   *
   * @returns {{tabIds: number[]}}
   */
  list() {
    return { tabIds: [...this.graphs.keys()] };
  }

  /**
   * Sample one tab's meters.
   *
   * `outRmsDb` and `outPeakDb` are derived from the two per-channel analysers
   * (power average and max respectively) rather than a third analyser, which would
   * have downmixed to mono and reported the same thing less precisely.
   *
   * @param {number} tabId
   * @returns {{ok: true, meter: import('../common/protocol.js').MeterReading}|{ok: false, meter: null}}
   */
  meter(tabId) {
    const key = toTabKey(tabId);
    const graph = key === null ? undefined : this.graphs.get(key);
    if (!graph || !this.ctx) return { ok: false, meter: null };

    const input = measure(graph.inMeter, graph.inBuffer);
    const left = measure(graph.outMeterL, graph.leftBuffer);
    const right = measure(graph.outMeterR, graph.rightBuffer);
    const outRms = Math.sqrt((left.rms * left.rms + right.rms * right.rms) / 2);

    // Document-global, not per-tab: the master is the sum of every capture, so
    // these two fields read the same whichever tab is asked.
    const master = this.master && this.master.masterMeter
      ? measure(this.master.masterMeter, this.master.masterBuffer)
      : { rms: 0, peak: 0 };

    return {
      ok: true,
      meter: {
        inRmsDb: toDb(input.rms),
        outRmsDb: toDb(outRms),
        outLeftRmsDb: toDb(left.rms),
        outRightRmsDb: toDb(right.rms),
        // Per-channel peaks as well as the combined one: the popup draws a peak-hold
        // cap over each channel's RMS bar, and a shared max would pin both caps to
        // whichever channel is louder — which is exactly the thing a balance or mono
        // change is meant to make visible.
        outLeftPeakDb: toDb(left.peak),
        outRightPeakDb: toDb(right.peak),
        outPeakDb: toDb(Math.max(left.peak, right.peak)),
        masterRmsDb: toDb(master.rms),
        masterPeakDb: toDb(master.peak),
        contextState: this.ctx.state
      }
    };
  }

  /**
   * Stop every track and drop the graph.
   *
   * Stopping the tracks is the point: until the last one is stopped the tab stays
   * silenced and Chrome keeps showing the blue capture indicator. Disconnecting
   * nodes alone does neither.
   *
   * @param {number} tabId
   * @returns {boolean} true when a graph was actually removed.
   */
  destroyGraph(tabId) {
    const graph = this.graphs.get(tabId);
    if (!graph) return false;

    // Set before stopping tracks so a late 'ended' cannot report a stream death for
    // a graph we deliberately replaced.
    graph.disposed = true;
    this.graphs.delete(tabId);

    for (const track of graph.tracks) {
      // Two separate guards on purpose: sharing one would let a throw from
      // removeEventListener skip track.stop(), and until every track is stopped
      // the tab stays silenced and Chrome keeps the blue capture indicator up.
      try {
        track.removeEventListener('ended', graph.handleEnded);
      } catch {
        // Listener already detached.
      }
      try {
        track.stop();
      } catch {
        // A track the browser already ended throws nothing useful.
      }
    }
    for (const node of graph.nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    return true;
  }
}
