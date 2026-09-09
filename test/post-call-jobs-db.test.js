'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTestPatient } = require('./support/fixtures');

test('post-call completion claims are leased, fenced and retryable', async () => {
  const { initializeDatabase, dbRun, dbGet, dbTx, closeDatabase } = require('../db');
  const { claimPostCallJob, completePostCallJob, failPostCallJob } = require('../services/post-call-jobs');
  await initializeDatabase();
  try {
    await withTestPatient(async ({ patientId }) => {
      const customer = await dbRun('INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patientId, 'called']);
      const call = await dbRun(
        'INSERT INTO calls (customer_id, patient_id, outcome, call_direction) VALUES (?, ?, ?, ?)',
        [customer.lastID, patientId, 'completed', 'outbound']
      );
      const first = await claimPostCallJob({ dbTx, callId: call.lastID, inputRevision: 'revision-a' });
      assert.equal(first.state, 'claimed');
      const second = await claimPostCallJob({ dbTx, callId: call.lastID, inputRevision: 'revision-a' });
      assert.equal(second.state, 'busy');
      assert.equal((await completePostCallJob({ dbTx, jobId: first.job.id, claimToken: 'wrong' })).changed, false);
      assert.equal((await failPostCallJob({ dbTx, jobId: first.job.id, claimToken: first.token, attemptCount: 1, errorCode: 'synthetic' })).changed, true);
      const row = await dbGet('SELECT status, attempt_count, last_error_code FROM post_call_jobs WHERE id = ?', [first.job.id]);
      assert.equal(row.status, 'blocked');
      assert.equal(Number(row.attempt_count), 1);
      assert.equal(row.last_error_code, 'synthetic');
      await dbRun('DELETE FROM calls WHERE id = ?', [call.lastID]);
      assert.equal(await dbGet('SELECT id FROM post_call_jobs WHERE id = ?', [first.job.id]), undefined);
    });
  } finally {
    await closeDatabase();
  }
});
