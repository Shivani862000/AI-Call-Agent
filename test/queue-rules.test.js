'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { blockingReason, evaluateRule, selectPatientsToQueue } = require('../src/queue-rules');

const ok = { id: 1, status: 'active', do_not_call: 0, consent_status: 'unknown', normalized_phone: '9876543210', last_donation_date: '2026-01-01' };
const rule = { id: 'r', enabled: true, service: 'donation', min_days_since: 90, call_type: 'REVIEW_CALL', slot: '10:00' };
const TODAY = '2026-08-30';

test('a callable patient is not blocked', () => {
  assert.strictEqual(blockingReason(ok), null);
});

test('every reason a patient must never be phoned', () => {
  assert.match(blockingReason({ ...ok, do_not_call: 1 }), /do not call/);
  assert.match(blockingReason({ ...ok, consent_status: 'refused' }), /refused consent/);
  assert.match(blockingReason({ ...ok, status: 'inactive' }), /not on the calling list/);
  assert.match(blockingReason({ ...ok, normalized_phone: null }), /no usable mobile/);
  assert.match(blockingReason(null), /not found/);
});

test('a blocked patient is never eligible, however long ago they were seen', () => {
  const longAgo = { ...ok, last_donation_date: '2020-01-01' };
  for (const over of [{ do_not_call: 1 }, { consent_status: 'refused' }, { status: 'inactive' }]) {
    assert.strictEqual(evaluateRule({ ...longAgo, ...over }, rule, TODAY).eligible, false, JSON.stringify(over));
  }
});

test('eligibility turns on days since the last service', () => {
  assert.strictEqual(evaluateRule({ ...ok, last_donation_date: '2026-01-01' }, rule, TODAY).eligible, true);
  assert.strictEqual(evaluateRule({ ...ok, last_donation_date: '2026-08-01' }, rule, TODAY).eligible, false);
});

test('the boundary day is inclusive', () => {
  // exactly 90 days before 2026-08-30
  assert.strictEqual(evaluateRule({ ...ok, last_donation_date: '2026-06-01' }, rule, TODAY).eligible, true);
  assert.strictEqual(evaluateRule({ ...ok, last_donation_date: '2026-06-02' }, rule, TODAY).eligible, false);
});

test('a patient with no recorded service is not cold-called', () => {
  const result = evaluateRule({ ...ok, last_donation_date: null }, rule, TODAY);
  assert.strictEqual(result.eligible, false);
  assert.match(result.reason, /No recorded service date/);
});

test('service: any measures from whichever service was most recent', () => {
  const anyRule = { ...rule, service: 'any' };
  const patient = { ...ok, last_donation_date: '2020-01-01', last_test_date: '2026-08-20' };
  assert.strictEqual(evaluateRule(patient, anyRule, TODAY).eligible, false, 'the recent test must count');
});

test('a disabled rule never fires', () => {
  assert.strictEqual(evaluateRule({ ...ok, last_donation_date: '2020-01-01' }, { ...rule, enabled: false }, TODAY).eligible, false);
});

test('overlapping rules queue a patient once', () => {
  const patients = [{ ...ok, id: 7, last_donation_date: '2020-01-01' }];
  const selected = selectPatientsToQueue({
    patients, today: TODAY,
    rules: [rule, { ...rule, id: 'second', min_days_since: 30 }]
  });
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].rule.id, 'r', 'the first matching rule wins');
});

test('a patient already in the queue is skipped', () => {
  const patients = [{ ...ok, id: 7, last_donation_date: '2020-01-01' }];
  const selected = selectPatientsToQueue({ patients, rules: [rule], today: TODAY, alreadyQueued: new Set([7]) });
  assert.deepStrictEqual(selected, []);
});

test('a malformed date does not queue anyone', () => {
  assert.strictEqual(evaluateRule({ ...ok, last_donation_date: 'last tuesday' }, rule, TODAY).eligible, false);
});
