'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EVENT_MATCH_STATES, extractEventIdentity, matchCallEvent, safeEventPayload } = require('../src/call-events');

const attempts = [
  { id: 11, request_key: 'request-a', provider_call_id: 'sid-a', destination_snapshot: '9990000001', state: 'submitted' },
  { id: 12, request_key: 'request-b', provider_call_id: 'sid-b', destination_snapshot: '9990000001', state: 'submitted' }
];

test('extracts provider, attempt, request and phone identity without coercing blanks', () => {
  assert.deepEqual(extractEventIdentity({ CallSid: 'SID-A', attemptId: 11, requestKey: 'request-a', phoneno: '9990000001' }), {
    attemptId: '11', requestKey: 'request-a', providerId: 'sid-a', phone: '9990000001'
  });
});

test('attempt and request identity take precedence over provider ambiguity', () => {
  assert.equal(matchCallEvent({ event: { attempt_id: 11, CallSid: 'sid-b' }, attempts }).attempt.id, 11);
  assert.equal(matchCallEvent({ event: { request_key: 'request-b', CallSid: 'sid-a' }, attempts }).attempt.id, 12);
});

test('known provider identity matches only the scoped durable attempt', () => {
  const result = matchCallEvent({ event: { CallSid: 'SID-B' }, attempts });
  assert.equal(result.state, EVENT_MATCH_STATES.MATCHED);
  assert.equal(result.attempt.id, 12);
});

test('unknown supplied provider identity never falls back to phone', () => {
  const result = matchCallEvent({ event: { CallSid: 'sid-missing', phoneno: '9990000001' }, attempts, allowIdless: true });
  assert.equal(result.state, EVENT_MATCH_STATES.UNMATCHED);
  assert.equal(result.reason, 'unknown_provider_id');
});

test('phone-only matching is quarantined by default and ambiguous when enabled', () => {
  assert.equal(matchCallEvent({ event: { phoneno: '9990000001' }, attempts }).reason, 'identity_required');
  assert.equal(matchCallEvent({ event: { phoneno: '9990000001' }, attempts, allowIdless: true }).state, EVENT_MATCH_STATES.AMBIGUOUS);
});

test('id-less compatibility can match one eligible attempt only', () => {
  const result = matchCallEvent({ event: { phoneno: '9990000001' }, attempts: [attempts[0]], allowIdless: true });
  assert.equal(result.state, EVENT_MATCH_STATES.MATCHED);
  assert.equal(result.reason, 'idless_unique_compatibility');
});

test('inbox payload keeps correlation fields and drops unrelated provider data', () => {
  const safe = safeEventPayload({ CallSid: 'sid-a', event: 'completed', phoneno: '9990000001', ukey: 'provider-secret', transcript: 'private raw text' });
  assert.equal(safe.CallSid, 'sid-a');
  assert.equal(safe.ukey, undefined);
  assert.equal(safe.transcript, undefined);
});
