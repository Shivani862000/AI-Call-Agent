'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('calls.status mirrors calls.outcome via trigger', async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();

  const marker = `nondialable:${randomUUID()}`;
  const patient = await dbRun(
    'INSERT INTO patients (first_name, phone) VALUES (?, ?)', [marker, marker]
  );
  let customer;
  let created;

  try {
    customer = await dbRun(
      'INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patient.lastID, 'pending']
    );
    // Insert with an outcome and no status: the insert trigger fills status in.
    created = await dbRun(
      'INSERT INTO calls (customer_id, outcome) VALUES (?, ?)',
      [customer.lastID, 'completed']
    );
    let call = await dbGet('SELECT status FROM calls WHERE id = ?', [created.lastID]);
    assert.equal(call.status, 'completed');

    // Changing outcome later must move status with it.
    await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['no-answer', created.lastID]);
    call = await dbGet('SELECT status FROM calls WHERE id = ?', [created.lastID]);
    assert.equal(call.status, 'no-answer');
  } finally {
    if (created?.lastID) {
      await dbRun('DELETE FROM feedback WHERE call_id = ?', [created.lastID]);
      await dbRun('DELETE FROM call_supervisor_events WHERE call_id = ?', [created.lastID]);
      await dbRun('DELETE FROM calls WHERE id = ?', [created.lastID]);
    }
    await dbRun('DELETE FROM calls WHERE patient_id = ?', [patient.lastID]);
    if (customer?.lastID) await dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);
    await dbRun('DELETE FROM patients WHERE id = ?', [patient.lastID]);
    await closeDatabase();
  }
});

// Removing one scheduled call used to delete every call that patient had ever
// had, recordings and feedback included, because calls and feedback cascaded
// from the queue entry. A call belongs to the patient now.
test('deleting a queue entry keeps the calls and feedback', async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();

  const { withTestPatient } = require('./support/fixtures');
  try {
    await withTestPatient(async ({ patientId }) => {
  const patient = { lastID: patientId };
  const customer = await dbRun(
    'INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patientId, 'pending']
  );
  const call = await dbRun(
    'INSERT INTO calls (customer_id, outcome) VALUES (?, ?)',
    [customer.lastID, 'completed']
  );
  await dbRun(
    'INSERT INTO feedback (customer_id, call_id, review_text, stars) VALUES (?, ?, ?, ?)',
    [customer.lastID, call.lastID, 'cascade check', 5]
  );

  // The trigger anchors the call to the person, so history survives the entry.
  const beforeDelete = await dbGet('SELECT patient_id FROM calls WHERE id = ?', [call.lastID]);
  assert.equal(Number(beforeDelete.patient_id), Number(patient.lastID));

  await dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);

  const survivingCall = await dbGet('SELECT id, customer_id, patient_id FROM calls WHERE id = ?', [call.lastID]);
  assert.ok(survivingCall, 'the call was deleted with the queue entry');
  assert.equal(survivingCall.customer_id, null, 'the link to the deleted entry should be cleared');
  assert.equal(Number(survivingCall.patient_id), Number(patient.lastID), 'the call should still name the patient');

  const survivingFeedback = await dbGet('SELECT id, call_id FROM feedback WHERE call_id = ?', [call.lastID]);
  assert.ok(survivingFeedback, 'the feedback was deleted with the queue entry');
    });
  } finally { await closeDatabase(); }
});

// A patient may have several calls scheduled at once; scheduling one used to
// overwrite the last, because patient_id was unique on the queue.
test('a patient can have more than one call scheduled', async () => {
  const { initializeDatabase, dbRun, dbAll, closeDatabase } = require('../db');
  await initializeDatabase();

  const { withTestPatient } = require('./support/fixtures');
  try {
    await withTestPatient(async ({ patientId }) => {
  const patient = { lastID: patientId };
  const first = await dbRun(
    'INSERT INTO customers (patient_id, status, scheduled_datetime) VALUES (?, ?, now())',
    [patientId, 'scheduled']
  );
  const second = await dbRun(
    'INSERT INTO customers (patient_id, status, scheduled_datetime) VALUES (?, ?, now())',
    [patientId, 'scheduled']
  );

  assert.notEqual(first.lastID, second.lastID, 'each scheduled call needs its own id');
  const rows = await dbAll('SELECT id FROM customers WHERE patient_id = ?', [patient.lastID]);
  assert.equal(rows.length, 2);

  // Removing one leaves the other alone.
  await dbRun('DELETE FROM customers WHERE id = ?', [first.lastID]);
  const remaining = await dbAll('SELECT id FROM customers WHERE patient_id = ?', [patient.lastID]);
  assert.equal(remaining.length, 1);
  assert.equal(Number(remaining[0].id), Number(second.lastID));
    });
  } finally { await closeDatabase(); }
});
