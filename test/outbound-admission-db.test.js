'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTestPatient } = require('./support/fixtures');

test('schema 0021 keeps contact revisions and attempts durable across queue changes', async () => {
  const { initializeDatabase, dbRun, dbGet, dbTx, closeDatabase } = require('../db');
  const { reserveOutboundAttempt, recordAttemptSubmission, recordContactDecision } = require('../services/outbound-admission');
  await initializeDatabase();
  try {
    await withTestPatient(async ({ patientId }) => {
      const customer = await dbRun(
        'INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patientId, 'pending']
      );
      const admitted = await reserveOutboundAttempt({
        dbTx,
        customerId: customer.lastID,
        callType: 'REVIEW_CALL',
        requestKey: `db-attempt-${patientId}`,
        cooldownMs: 0
      });
      assert.equal(admitted.outcome, 'accepted');
      const attempt = { lastID: admitted.attemptId };
      const submitted = await recordAttemptSubmission({
        dbTx,
        attemptId: attempt.lastID,
        response: { status: 'queued', sid: `provider-${patientId}`, providerReturnedSid: true }
      });
      assert.equal(submitted.state, 'submitted');
      const decision = await recordContactDecision({
        dbTx,
        patientId,
        decision: 'refused',
        expectedRevision: 0,
        actorUsername: 'db-test',
        sourceType: 'call_attempt',
        sourceAttemptId: attempt.lastID,
        evidenceRef: 'test-evidence'
      });
      assert.equal(decision.revision, 1);
      const call = await dbRun(
        `INSERT INTO calls (customer_id, patient_id, attempt_id, outcome, call_direction)
         VALUES (?, ?, ?, ?, ?)`,
        [customer.lastID, patientId, attempt.lastID, 'submission_unknown', 'outbound']
      );
      const row = await dbGet(
        `SELECT a.state, a.contact_revision, e.decision, e.new_revision, c.attempt_id
           FROM call_attempts a
           JOIN contact_events e ON e.source_attempt_id = a.id
           JOIN calls c ON c.attempt_id = a.id
          WHERE a.id = ?`,
        [attempt.lastID]
      );
      assert.equal(row.state, 'submitted');
      assert.equal(Number(row.contact_revision), 0);
      assert.equal(row.decision, 'refused');
      assert.equal(Number(row.new_revision), 1);
      assert.equal(Number(row.attempt_id), Number(attempt.lastID));
      await assert.rejects(
        recordContactDecision({
          dbTx,
          patientId,
          decision: 'granted',
          expectedRevision: 0,
          actorUsername: 'stale-test',
          actorRole: 'ADMIN',
          allowRestore: true
        }),
        /stale|revision/i
      );
      const patient = await dbGet('SELECT do_not_call, consent_status, contact_revision FROM patients WHERE id = ?', [patientId]);
      assert.equal(Number(patient.do_not_call), 1);
      assert.equal(patient.consent_status, 'refused');
      assert.equal(Number(patient.contact_revision), 1);
      await assert.rejects(
        dbRun(
          `INSERT INTO call_attempts (request_key, patient_id, destination_snapshot)
           VALUES (?, ?, ?)`,
          [`db-attempt-${patientId}`, patientId, '0000000000']
        ),
        /duplicate key|unique/i
      );
      await dbRun('DELETE FROM calls WHERE id = ?', [call.lastID]);
      await dbRun('DELETE FROM contact_events WHERE source_attempt_id = ?', [attempt.lastID]);
      await dbRun('DELETE FROM call_attempts WHERE id = ?', [attempt.lastID]);
      await dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);
    });
  } finally {
    await closeDatabase();
  }
});
