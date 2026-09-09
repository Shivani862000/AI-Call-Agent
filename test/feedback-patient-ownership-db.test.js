'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withTestPatient } = require('./support/fixtures');

test('feedback is anchored to the patient and survives queue deletion', async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();
  try {
    await withTestPatient(async ({ patientId }) => {
      const customer = await dbRun('INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patientId, 'pending']);
      const call = await dbRun('INSERT INTO calls (customer_id, outcome) VALUES (?, ?)', [customer.lastID, 'completed']);
      const feedback = await dbRun(
        'INSERT INTO feedback (customer_id, call_id, review_text, stars) VALUES (?, ?, ?, ?)',
        [customer.lastID, call.lastID, 'retained history', 5]
      );
      const owned = await dbGet('SELECT patient_id FROM feedback WHERE id = ?', [feedback.lastID]);
      assert.equal(Number(owned.patient_id), Number(patientId));

      await dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);
      const surviving = await dbGet('SELECT customer_id, patient_id, call_id FROM feedback WHERE id = ?', [feedback.lastID]);
      assert.equal(surviving.customer_id, null);
      assert.equal(Number(surviving.patient_id), Number(patientId));
      assert.equal(Number(surviving.call_id), Number(call.lastID));
      await assert.rejects(dbRun('DELETE FROM patients WHERE id = ?', [patientId]));
    });
  } finally {
    await closeDatabase();
  }
});

test('manual feedback without a call is anchored through its customer', async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();
  try {
    await withTestPatient(async ({ patientId }) => {
      const customer = await dbRun('INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patientId, 'pending']);
      const feedback = await dbRun(
        'INSERT INTO feedback (customer_id, review_text, stars) VALUES (?, ?, ?)',
        [customer.lastID, 'manual history', 4]
      );
      const row = await dbGet('SELECT patient_id FROM feedback WHERE id = ?', [feedback.lastID]);
      assert.equal(Number(row.patient_id), Number(patientId));
    });
  } finally {
    await closeDatabase();
  }
});
