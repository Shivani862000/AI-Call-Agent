'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();
const { resolveDatabaseUrl } = require('../src/config');
const HAS_DB = /^postgres/i.test(resolveDatabaseUrl());

test('calls.status mirrors calls.outcome via trigger', { skip: !HAS_DB && 'no Supabase connection configured' }, async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();

  const marker = `trigger-test-${Date.now()}`;
  const patient = await dbRun(
    'INSERT INTO patients (first_name, phone) VALUES (?, ?)', [marker, marker]
  );
  const customer = await dbRun(
    'INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patient.lastID, 'pending']
  );

  try {
    // Insert with an outcome and no status: the insert trigger fills status in.
    const created = await dbRun(
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
    // Cascade removes the call row with the customer.
    await dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);
    await dbRun('DELETE FROM patients WHERE id = ?', [patient.lastID]);
    await closeDatabase();
  }
});

// Removing one scheduled call used to delete every call that patient had ever
// had, recordings and feedback included, because calls and feedback cascaded
// from the queue entry. A call belongs to the patient now.
test('deleting a queue entry keeps the calls and feedback', { skip: !HAS_DB && 'no Supabase connection configured' }, async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();

  const { withTestPatient } = require('./support/fixtures');
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
  await closeDatabase();
});

// A patient may have several calls scheduled at once; scheduling one used to
// overwrite the last, because patient_id was unique on the queue.
test('a patient can have more than one call scheduled', { skip: !HAS_DB && 'no Supabase connection configured' }, async () => {
  const { initializeDatabase, dbRun, dbAll, closeDatabase } = require('../db');
  await initializeDatabase();

  const { withTestPatient } = require('./support/fixtures');
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
  await closeDatabase();
});

test('a no-response call is not turned back into a completed one', { skip: !HAS_DB && 'no Supabase connection configured' }, async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();

  const marker = `no-response-test-${Date.now()}`;
  const patient = await dbRun('INSERT INTO patients (first_name, phone) VALUES (?, ?)', [marker, marker]);
  const customer = await dbRun('INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patient.lastID, 'pending']);

  try {
    const created = await dbRun(
      'INSERT INTO calls (customer_id, outcome, outcome_detail) VALUES (?, ?, ?)',
      [customer.lastID, 'no_response', 'Patient disconnected without giving any feedback']
    );

    // What the hangup handler and the provider webhook write afterwards.
    await dbRun('UPDATE calls SET outcome = ?, outcome_detail = ? WHERE id = ?', ['completed', 'completed', created.lastID]);
    let call = await dbGet('SELECT outcome, outcome_detail, status FROM calls WHERE id = ?', [created.lastID]);
    assert.equal(call.outcome, 'no_response');
    assert.equal(call.outcome_detail, 'Patient disconnected without giving any feedback');
    assert.equal(call.status, 'no_response');

    // A real change of outcome still goes through.
    await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['failed', created.lastID]);
    call = await dbGet('SELECT outcome FROM calls WHERE id = ?', [created.lastID]);
    assert.equal(call.outcome, 'failed');
  } finally {
    await dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);
    await dbRun('DELETE FROM patients WHERE id = ?', [patient.lastID]);
    await closeDatabase();
  }
});
