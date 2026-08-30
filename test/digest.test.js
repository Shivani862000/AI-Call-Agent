'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { digestIsDue } = require('../src/scheduler');

const at = (iso) => new Date(iso);
const config = { send_at: '08:00', timezone: 'Asia/Kolkata', last_sent_date: null };

test('not due before the configured local time', () => {
  // 01:00 UTC is 06:30 IST — before 08:00
  assert.strictEqual(digestIsDue(config, at('2026-08-30T01:00:00Z')).due, false);
});

test('due once the local time has passed', () => {
  // 04:00 UTC is 09:30 IST
  assert.strictEqual(digestIsDue(config, at('2026-08-30T04:00:00Z')).due, true);
});

test('not sent twice on the same local day', () => {
  const { today } = digestIsDue(config, at('2026-08-30T04:00:00Z'));
  const already = { ...config, last_sent_date: today };
  assert.strictEqual(digestIsDue(already, at('2026-08-30T06:00:00Z')).due, false);
});

test('the local day is the configured timezone, not UTC', () => {
  // 20:00 UTC on the 30th is 01:30 IST on the 31st — a new local day.
  assert.strictEqual(digestIsDue(config, at('2026-08-30T20:00:00Z')).today, '2026-08-31');
});

test('a later send time is respected', () => {
  const evening = { ...config, send_at: '20:00' };
  assert.strictEqual(digestIsDue(evening, at('2026-08-30T04:00:00Z')).due, false);
  assert.strictEqual(digestIsDue(evening, at('2026-08-30T15:00:00Z')).due, true);
});
