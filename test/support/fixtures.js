'use strict';

/**
 * Test patients that clean themselves up.
 *
 * Test identities are UUID-based and deliberately cannot be dialled. Cleanup
 * deletes dependent rows in foreign-key order and is always invoked in finally.
 */
const TEST_NAME_PREFIX = 'zztest-';

async function removeTestPatient(patientId, { callIds = [] } = {}) {
  const { dbRun, dbAll } = require('../../db');
  const entries = await dbAll('SELECT id FROM customers WHERE patient_id = ?', [patientId]);
  const ownedCalls = await dbAll(
    'SELECT id FROM calls WHERE patient_id = ? OR customer_id = ANY(?)',
    [patientId, entries.map((entry) => entry.id)]
  );
  const calls = [...new Set([...callIds, ...ownedCalls.map((call) => call.id)])];

  for (const callId of calls) {
    await dbRun('DELETE FROM call_supervisor_events WHERE call_id = ?', [callId]);
    await dbRun('DELETE FROM feedback WHERE call_id = ?', [callId]);
    await dbRun('DELETE FROM calls WHERE id = ?', [callId]);
  }
  for (const entry of entries) await dbRun('DELETE FROM feedback WHERE customer_id = ?', [entry.id]);
  await dbRun('DELETE FROM calls WHERE patient_id = ?', [patientId]);
  await dbRun('DELETE FROM customers WHERE patient_id = ?', [patientId]);
  await dbRun('DELETE FROM patients WHERE id = ?', [patientId]);
}

/**
 * Creates a patient, runs the test with it, and removes it and everything that
 * hangs off it -- whether the test passed, failed or threw.
 */
async function withTestPatient(run) {
  const { dbRun } = require('../../db');
  const id = require('node:crypto').randomUUID();
  const phone = `000${id.replace(/\D/g, '').padEnd(7, '0').slice(0, 7)}`;
  const callIds = [];
  const patient = await dbRun(
    'INSERT INTO patients (first_name, phone, normalized_phone) VALUES (?, ?, ?)',
    [`${TEST_NAME_PREFIX}${phone}`, phone, phone]
  );

  try {
    return await run({
      patientId: patient.lastID,
      phone,
      trackCallId(callId) { if (callId != null) callIds.push(callId); return callId; }
    });
  } finally {
    await removeTestPatient(patient.lastID, { callIds });
  }
}

module.exports = { withTestPatient, removeTestPatient, TEST_NAME_PREFIX };
