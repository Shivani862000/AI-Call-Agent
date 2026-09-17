'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyCallOutcomeWorkflow } = require('../services/call-orchestration');
const { processCompletedCallPipeline } = require('../services/post-call-pipeline');

/**
 * Just enough of the database for the workflow: answers the handful of reads
 * it makes and records every write.
 */
function fakeDb({ storedOutcome = 'no_response', earlierNoResponse = 0, call = null } = {}) {
  const writes = [];
  return {
    writes,
    write: (pattern) => writes.find((w) => pattern.test(w.sql)),
    dbGet: async (sql) => {
      if (/SELECT outcome FROM calls WHERE id/.test(sql)) return { outcome: storedOutcome };
      if (/outcome = \? AND id <> \?/.test(sql)) return { count: earlierNoResponse };
      if (/COUNT\(\*\) as count/i.test(sql)) return { count: 1 };
      if (/FROM calls\s+LEFT JOIN customer_queue/.test(sql)) return call;
      if (/FROM customer_queue/.test(sql)) return customer;
      if (/SELECT \* FROM calls WHERE id/.test(sql)) return { ...call, outcome: 'no_response' };
      return null;
    },
    dbRun: async (sql, params) => {
      writes.push({ sql, params });
      return { changes: 1 };
    }
  };
}

const customer = { id: 7, name: 'Ankita', phone: '9999999999', status: 'called', retry_count: 0 };
const call = { id: 42, customer_id: 7 };

test('first no-response call is retried once', async () => {
  const db = fakeDb({ earlierNoResponse: 0 });
  const result = await applyCallOutcomeWorkflow({ ...db, callRecord: call, customer, inferredOutcome: 'no_response' });

  assert.equal(result.customerStatus, 'retry_scheduled');
  assert.ok(result.nextRetryAt);
  const callUpdate = db.write(/UPDATE calls\s+SET outcome/);
  assert.equal(callUpdate.params[0], 'no_response');
  assert.equal(callUpdate.params[1], 'Patient disconnected without giving any feedback');
});

test('a second no-response call is not retried again', async () => {
  const db = fakeDb({ earlierNoResponse: 1 });
  const result = await applyCallOutcomeWorkflow({ ...db, callRecord: call, customer, inferredOutcome: 'no_response' });

  assert.equal(result.customerStatus, 'no_response');
  assert.equal(result.nextRetryAt, null);
});

test('a late "completed" from the provider does not undo the flag', async () => {
  const db = fakeDb({ storedOutcome: 'no_response' });
  await applyCallOutcomeWorkflow({ ...db, callRecord: { ...call, outcome: 'completed' }, customer, inferredOutcome: 'completed' });

  assert.equal(db.writes.length, 0);
});

test('a "completed" on an ordinary call still completes it', async () => {
  const db = fakeDb({ storedOutcome: 'completed' });
  const result = await applyCallOutcomeWorkflow({ ...db, callRecord: call, customer, inferredOutcome: 'completed' });

  assert.equal(result.customerStatus, 'completed');
});

test('pipeline closes a no-response call without analysis or feedback', async () => {
  const record = {
    id: 42,
    customer_id: 7,
    engagement: 'no_response',
    transcript_text: 'AGENT: Namaste, kya meri baat Ankita ji se ho rahi hai?\nCUSTOMER: hello hello',
    recording_object_key: 'calls/42/x.wav'
  };
  const db = fakeDb({ earlierNoResponse: 0, call: record });
  const result = await processCompletedCallPipeline({ ...db, callId: 42 });

  assert.equal(result.ok, true);
  assert.equal(result.noResponse, true);
  assert.equal(result.feedbackId, null);
  assert.ok(db.write(/SET transcript_text = COALESCE[\s\S]*outcome = \?/));
  assert.equal(db.write(/INSERT INTO feedback/), undefined);
  assert.equal(db.write(/analysis_json/), undefined);
});

test('pipeline flags an older call from its transcript alone', async () => {
  const record = {
    id: 43,
    customer_id: 7,
    engagement: null,
    transcript_text: 'AGENT: Namaste, kya meri baat Ankita ji se ho rahi hai?\nCUSTOMER: Hello?\nCUSTOMER: हेलो',
    recording_object_key: 'calls/43/x.wav'
  };
  const db = fakeDb({ earlierNoResponse: 0, call: record });
  const result = await processCompletedCallPipeline({ ...db, callId: 43 });

  assert.equal(result.noResponse, true);
});
