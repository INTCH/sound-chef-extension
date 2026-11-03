import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_GAIN, MASTER_HEADROOM } from '../common/protocol.js';
import {
  LIMITER_CEILING,
  MASTER_LIMITER_THRESHOLD,
  MASTER_PRE_SCALE,
  TAB_LIMITER_THRESHOLD,
  TAB_PRE_SCALE,
  balanceGains,
  buildLimiterCurve,
  createMasterLimiterCurve,
  createTabLimiterCurve,
  evaluateLimiter
} from '../offscreen/audio-engine.js';

const tabCurve = createTabLimiterCurve();
const masterCurve = createMasterLimiterCurve();

test('tab limiter is transparent below its threshold', () => {
  for (let x = -TAB_LIMITER_THRESHOLD; x <= TAB_LIMITER_THRESHOLD; x += 0.01) {
    assert.ok(Math.abs(evaluateLimiter(tabCurve, x, TAB_PRE_SCALE) - x) < 1e-3, `x=${x}`);
  }
});

test('tab limiter never exceeds the ceiling across the whole boost range', () => {
  for (let x = 0; x <= MAX_GAIN; x += 0.005) {
    const y = evaluateLimiter(tabCurve, x, TAB_PRE_SCALE);
    assert.ok(y <= LIMITER_CEILING + 1e-6, `x=${x} y=${y}`);
    assert.ok(Math.abs(evaluateLimiter(tabCurve, -x, TAB_PRE_SCALE) + y) < 1e-6);
  }
});

test('tab limiter is monotonic', () => {
  let previous = -Infinity;
  for (let x = -MAX_GAIN; x <= MAX_GAIN; x += 0.01) {
    const y = evaluateLimiter(tabCurve, x, TAB_PRE_SCALE);
    assert.ok(y >= previous - 1e-7);
    previous = y;
  }
});

test('master limiter is transparent for one tab and bounded for several', () => {
  for (let x = 0; x <= MASTER_LIMITER_THRESHOLD; x += 0.01) {
    assert.ok(Math.abs(evaluateLimiter(masterCurve, x, MASTER_PRE_SCALE) - x) < 1e-3);
  }
  for (let x = 0; x <= MASTER_HEADROOM; x += 0.01) {
    assert.ok(evaluateLimiter(masterCurve, x, MASTER_PRE_SCALE) <= LIMITER_CEILING + 1e-6);
  }
});

test('buildLimiterCurve rejects bad options', () => {
  assert.throws(() => buildLimiterCurve({ threshold: 0.5, range: 0 }), RangeError);
  assert.throws(() => buildLimiterCurve({ threshold: 1, range: 1 }), RangeError);
  assert.throws(() => buildLimiterCurve({ threshold: 0.5, range: 1, points: 2 }), RangeError);
});

test('stereo balance attenuates only the far channel', () => {
  assert.deepEqual(balanceGains(0, false), { left: 1, right: 1 });
  assert.deepEqual(balanceGains(-1, false), { left: 1, right: 0 });
  assert.deepEqual(balanceGains(0.25, false), { left: 0.75, right: 1 });
});

test('mono balance pans and preserves the summed gain', () => {
  assert.deepEqual(balanceGains(0, true), { left: 1, right: 1 });
  assert.deepEqual(balanceGains(1, true), { left: 0, right: 2 });
  const g = balanceGains(-0.4, true);
  assert.ok(Math.abs(g.left + g.right - 2) < 1e-12);
  assert.deepEqual(balanceGains(Number.NaN, true), { left: 1, right: 1 });
});
