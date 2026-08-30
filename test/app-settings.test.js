'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { defaultsFor, withDefaults, validateSetting, createSettingsStore } = require('../src/app-settings');

test('both defaults are inert — nothing sends, nothing dials', () => {
  assert.strictEqual(defaultsFor('owner_digest').enabled, false);
  assert.deepStrictEqual(defaultsFor('owner_digest').recipients, []);
  assert.strictEqual(defaultsFor('auto_queue').enabled, false);
});

test('defaults are copies, so a caller cannot mutate them for everyone', () => {
  defaultsFor('owner_digest').recipients.push('leak@example.com');
  assert.deepStrictEqual(defaultsFor('owner_digest').recipients, []);
});

test('a stored value keeps defaults for keys it omits', () => {
  const merged = withDefaults('owner_digest', { enabled: true, recipients: ['a@b.in'] });
  assert.strictEqual(merged.send_at, '08:00', 'a setting added later must not be lost');
  assert.strictEqual(merged.enabled, true);
});

test('malformed stored values fall back rather than throwing', () => {
  assert.deepStrictEqual(withDefaults('owner_digest', null), defaultsFor('owner_digest'));
  assert.deepStrictEqual(withDefaults('owner_digest', 'garbage'), defaultsFor('owner_digest'));
  assert.deepStrictEqual(withDefaults('owner_digest', ['a']), defaultsFor('owner_digest'));
});

test('the digest cannot be switched on with nobody to send it to', () => {
  assert.match(validateSetting('owner_digest', { enabled: true, recipients: [], send_at: '08:00' }), /at least one recipient/);
  assert.strictEqual(validateSetting('owner_digest', { enabled: true, recipients: ['a@b.in'], send_at: '08:00' }), null);
});

test('digest validation rejects bad addresses and times', () => {
  assert.match(validateSetting('owner_digest', { enabled: false, recipients: ['nope'], send_at: '08:00' }), /not a valid email/);
  assert.match(validateSetting('owner_digest', { enabled: false, recipients: [], send_at: '25:00' }), /24-hour time/);
});

test('queue rules are validated before they can dial anyone', () => {
  const rule = (over) => ({ enabled: false, rules: [{ id: 'r', service: 'donation', min_days_since: 90, call_type: 'REVIEW_CALL', slot: '10:00', ...over }] });
  assert.strictEqual(validateSetting('auto_queue', rule({})), null);
  assert.match(validateSetting('auto_queue', rule({ service: 'everyone' })), /donation, test or any/);
  assert.match(validateSetting('auto_queue', rule({ min_days_since: 0 })), /at least 1/);
  assert.match(validateSetting('auto_queue', rule({ slot: 'morning' })), /24-hour time/);
  assert.match(validateSetting('auto_queue', rule({ id: '' })), /needs an id/);
});

test('a failing read returns defaults instead of breaking the caller', async () => {
  const store = createSettingsStore({ dbGet: async () => { throw new Error('db down'); }, dbRun: async () => {} });
  assert.deepStrictEqual(await store.get('auto_queue'), defaultsFor('auto_queue'));
});

test('set refuses invalid values with a 400', async () => {
  let wrote = false;
  const store = createSettingsStore({ dbGet: async () => null, dbRun: async () => { wrote = true; } });
  await assert.rejects(() => store.set('owner_digest', { enabled: true, recipients: [] }), /at least one recipient/);
  assert.strictEqual(wrote, false, 'nothing may be written when validation fails');
});

test('patch preserves untouched keys', async () => {
  let stored = { enabled: true, recipients: ['a@b.in'], send_at: '09:00' };
  const store = createSettingsStore({
    dbGet: async () => ({ value: stored }),
    dbRun: async (_sql, params) => { stored = JSON.parse(params[1]); }
  });
  await store.patch('owner_digest', { last_sent_date: '2026-08-30' }, 'tester');
  assert.strictEqual(stored.send_at, '09:00');
  assert.strictEqual(stored.last_sent_date, '2026-08-30');
  assert.deepStrictEqual(stored.recipients, ['a@b.in']);
});
