'use strict';

/**
 * Test patients that clean themselves up.
 *
 * These tests run against the shared development database, which is the same
 * one UAT serves, so anything left behind shows up in the app as a real
 * patient. Four fixtures did exactly that: cleanup sat after the assertions
 * rather than in a finally, so a failure leaked, and the patient delete
 * swallowed its own error.
 *
 * The prefix is checked by removeTestPatients, so a leak from a killed run can
 * still be swept up afterwards.
 */
const TEST_NAME_PREFIX = 'zztest-';

async function removeTestPatient(patientId) {
  const { dbRun, dbAll } = require('../../db');
  const entries = await dbAll('SELECT id FROM customers WHERE patient_id = ?', [patientId]);

  for (const entry of entries) {
    await dbRun('DELETE FROM feedback WHERE customer_id = ?', [entry.id]);
    await dbRun('DELETE FROM calls WHERE customer_id = ?', [entry.id]);
  }
  // Calls keep patient_id after their queue entry goes, so they are removed by
  // patient too or they outlive everything else.
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
  const phone = String(Date.now()).slice(-10);
  const patient = await dbRun(
    'INSERT INTO patients (first_name, phone, normalized_phone) VALUES (?, ?, ?)',
    [`${TEST_NAME_PREFIX}${phone}`, phone, phone]
  );

  try {
    return await run({ patientId: patient.lastID, phone });
  } finally {
    await removeTestPatient(patient.lastID);
  }
}

module.exports = { withTestPatient, removeTestPatient, TEST_NAME_PREFIX };
