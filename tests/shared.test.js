const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSiteKey,
  migrateActiveSites,
  setSiteEnabled,
  getContentAction,
  getPopupIndicator,
} = require('../shared.js');

test('getSiteKey collapses sibling subdomains to one site key', () => {
  assert.equal(getSiteKey('www.youtube.com'), 'youtube.com');
  assert.equal(getSiteKey('m.youtube.com'), 'youtube.com');
  assert.equal(getSiteKey('player.soundcloud.com'), 'soundcloud.com');
});

test('getSiteKey preserves common multi-part public suffixes', () => {
  assert.equal(getSiteKey('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(getSiteKey('foo.bar.com.au'), 'bar.com.au');
});

test('migrateActiveSites upgrades legacy hostname entries to site keys', () => {
  assert.deepEqual(
    migrateActiveSites({ 'www.youtube.com': true, 'm.youtube.com': true, 'example.com': false }),
    { 'youtube.com': true },
  );
});

test('setSiteEnabled writes idempotent site-wide keys', () => {
  const enabled = setSiteEnabled({ 'm.youtube.com': true }, 'www.youtube.com', true);
  assert.deepEqual(enabled, { 'youtube.com': true });

  const disabled = setSiteEnabled(enabled, 'music.youtube.com', false);
  assert.deepEqual(disabled, {});
});

test('getContentAction requests reinjection when hook health is stale', () => {
  assert.equal(getContentAction({ enabled: true, injected: false, hookAlive: false }), 'inject');
  assert.equal(getContentAction({ enabled: true, injected: true, hookAlive: false }), 'inject');
  assert.equal(getContentAction({ enabled: true, injected: true, hookAlive: true }), 'start');
  assert.equal(getContentAction({ enabled: false, injected: true, hookAlive: true }), 'stop');
  assert.equal(getContentAction({ enabled: false, injected: false, hookAlive: false }), 'idle');
});

test('getPopupIndicator only shows red for real errors', () => {
  assert.equal(getPopupIndicator({ enabled: true, hookAlive: true, hookActive: true, lastError: '' }), 'green');
  assert.equal(getPopupIndicator({ enabled: true, hookAlive: true, hookActive: false, lastError: '' }), 'gray');
  assert.equal(getPopupIndicator({ enabled: false, hookAlive: false, hookActive: false, lastError: 'boom' }), 'gray');
  assert.equal(getPopupIndicator({ enabled: true, hookAlive: false, hookActive: false, lastError: 'boom' }), 'red');
});
