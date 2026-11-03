import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STATE,
  MAX_GAIN,
  badgeTextFor,
  clampState,
  describeError,
  isDefaultState,
  isRestrictedUrl,
  restrictionReason
} from '../common/protocol.js';

test('clampState fills defaults and clamps ranges', () => {
  assert.deepEqual(clampState(undefined), { ...DEFAULT_STATE });
  assert.deepEqual(clampState({ gain: 99, balance: -5 }), { gain: MAX_GAIN, mono: false, balance: -1 });
  assert.deepEqual(clampState({ gain: '3', balance: Number.NaN }), { ...DEFAULT_STATE });
  assert.equal(clampState({ mono: 1 }).mono, true);
  assert.notEqual(clampState(DEFAULT_STATE), DEFAULT_STATE);
});

test('isDefaultState is exact', () => {
  assert.equal(isDefaultState({ gain: 1, mono: false, balance: 0 }), true);
  assert.equal(isDefaultState({ gain: 1.01, mono: false, balance: 0 }), false);
  assert.equal(isDefaultState(null), false);
});

test('badgeTextFor follows its precedence order', () => {
  assert.equal(badgeTextFor({ gain: 2.5, mono: true, balance: -1 }, true), 'off');
  assert.equal(badgeTextFor({ gain: 2.5, mono: true, balance: -1 }, false), '250');
  assert.equal(badgeTextFor({ gain: 1, mono: true, balance: -1 }, false), 'M');
  assert.equal(badgeTextFor({ gain: 1, mono: false, balance: -0.2 }, false), 'L');
  assert.equal(badgeTextFor({ gain: 1, mono: false, balance: 0.2 }, false), 'R');
  assert.equal(badgeTextFor(DEFAULT_STATE, false), '');
  assert.equal(badgeTextFor({ gain: MAX_GAIN, mono: false, balance: 0 }, false), '600');
});

test('isRestrictedUrl parses rather than substring-matching', () => {
  assert.equal(isRestrictedUrl('https://example.com/'), false);
  assert.equal(isRestrictedUrl('https://example.com/?u=chrome://settings'), false);
  assert.equal(isRestrictedUrl('chrome://settings'), true);
  assert.equal(isRestrictedUrl('chrome-extension://abc/page.html'), true);
  assert.equal(isRestrictedUrl('file:///tmp/a.html'), true);
  assert.equal(isRestrictedUrl('https://chromewebstore.google.com/detail/x'), true);
  assert.equal(isRestrictedUrl('https://chrome.google.com/webstore/detail/x'), true);
  assert.equal(isRestrictedUrl('https://chrome.google.com/other'), false);
  assert.equal(isRestrictedUrl(''), true);
  assert.equal(isRestrictedUrl(undefined), true);
  assert.equal(isRestrictedUrl('not a url'), true);
});

test('restrictionReason names the actual cause', () => {
  assert.match(restrictionReason(''), /not loaded a page/);
  assert.match(restrictionReason('file:///tmp/a.html'), /Local files/);
  assert.match(restrictionReason('chrome://settings'), /Browser pages/);
  assert.match(restrictionReason('about:blank'), /Browser pages/);
  assert.match(restrictionReason('chrome-extension://abc/x.html'), /Extension pages/);
  assert.match(restrictionReason('https://chromewebstore.google.com/'), /Web Store/);
  assert.equal(restrictionReason('not a url'), 'This page cannot be captured.');
});

test('describeError is total and readable', () => {
  assert.equal(describeError(null), 'Unknown error.');
  assert.equal(describeError('plain'), 'plain');
  assert.equal(describeError(new Error('boom')), 'boom');
  assert.equal(describeError(new TypeError('bad')), 'TypeError: bad');
  assert.equal(describeError({ message: 'from chrome' }), 'from chrome');
  assert.equal(describeError(Symbol('s')), 'Symbol(s)');
  const hostile = { toString() { throw new Error('no'); } };
  assert.equal(describeError(hostile), 'Unknown error.');
});
