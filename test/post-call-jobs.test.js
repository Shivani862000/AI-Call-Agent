'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RETRY_DELAYS_MS, buildInputRevision, retryDelayMs } = require('../services/post-call-jobs');

test('input revisions are stable and change when persisted evidence changes', () => {
  const call = { id: 4, transcript_status: 'completed', transcript_text: 'CUSTOMER: hello' };
  assert.equal(buildInputRevision(call), buildInputRevision({ ...call }));
  assert.notEqual(buildInputRevision(call), buildInputRevision({ ...call, transcript_text: 'CUSTOMER: goodbye' }));
});

test('retry policy uses bounded 1, 5, 15, 60 and 240 minute delays', () => {
  assert.deepEqual(RETRY_DELAYS_MS, [60_000, 300_000, 900_000, 3_600_000, 14_400_000]);
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(5), 14_400_000);
  assert.equal(retryDelayMs(99), 14_400_000);
});
