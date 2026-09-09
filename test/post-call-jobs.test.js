'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RETRY_DELAYS_MS, buildInputRevision, retryDelayMs, listDuePostCallJobs, recoverDuePostCallJobs } = require('../services/post-call-jobs');

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

test('recovery scans due jobs and processes each call without stopping on one failure', async () => {
  const calls = [];
  const result = await recoverDuePostCallJobs({
    dbAll: async (sql, params) => {
      assert.match(sql, /claim_expires_at/);
      assert.equal(params.length, 3);
      return [{ call_id: 11 }, { call_id: 12 }];
    },
    processCall: async callId => {
      calls.push(callId);
      if (callId === 12) throw Object.assign(new Error('busy'), { code: 'already_processing' });
      return { ok: true, callId };
    }
  });
  assert.deepEqual(calls, [11, 12]);
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.results[1], { ok: false, callId: 12, reason: 'already_processing' });
});

test('due-job listing validates its bounded batch size', async () => {
  await assert.rejects(listDuePostCallJobs({ dbAll: async () => [], limit: 0 }), /limit/);
  await assert.rejects(listDuePostCallJobs({ dbAll: async () => [], limit: 101 }), /limit/);
});
