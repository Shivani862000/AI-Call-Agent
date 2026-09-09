'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Hydration matches an incoming media stream to the call that was placed. It
// looked up a queue entry for the number and then searched that entry for a
// recent call, which stopped working the moment a patient could have more than
// one entry: the unordered LIMIT 1 picked an arbitrary row and the call was
// never found. The failure is silent and total -- the session stays "incoming",
// so the outbound script is never used, and the call is never marked completed
// or given a transcript.
test('the outbound call is found even when the patient has several queue entries', async () => {
  const { initializeDatabase, dbRun, closeDatabase } = require('../db');
  const { findRecentOutboundCallContextByPhone } = require('../src/call-management');
  const { withTestPatient } = require('./support/fixtures');
  await initializeDatabase();

  try {
    await withTestPatient(async ({ patientId, phone }) => {
    // Several entries for one patient; only the last carries the placed call.
    const older = await dbRun(
      'INSERT INTO customers (patient_id, status, scheduled_datetime) VALUES (?, ?, now())',
      [patientId, 'scheduled']
    );
    const decoy = await dbRun(
      'INSERT INTO customers (patient_id, status, scheduled_datetime) VALUES (?, ?, now())',
      [patientId, 'scheduled']
    );
    const calling = await dbRun(
      'INSERT INTO customers (patient_id, status, scheduled_datetime) VALUES (?, ?, now())',
      [patientId, 'scheduled']
    );
    const call = await dbRun(
      `INSERT INTO calls (customer_id, outcome, call_direction, call_type, called_at)
       VALUES (?, 'scheduled_initiated', 'outbound', 'REVIEW_CALL', now())`,
      [calling.lastID]
    );

    const context = await findRecentOutboundCallContextByPhone(phone);

    assert.ok(context, 'no outbound context was found for the number that was called');
    assert.equal(Number(context.call.id), Number(call.lastID));
    assert.equal(Number(context.customer.id), Number(calling.lastID),
      'the entry the call was placed for should win, not an arbitrary one');
    assert.notEqual(Number(context.customer.id), Number(decoy.lastID));
    assert.notEqual(Number(context.customer.id), Number(older.lastID));
    });
  } finally {
    await closeDatabase();
  }
});

test('an unknown number yields no context', async () => {
  const { initializeDatabase, closeDatabase } = require('../db');
  const { findRecentOutboundCallContextByPhone } = require('../src/call-management');
  await initializeDatabase();
  try {
    assert.equal(await findRecentOutboundCallContextByPhone('0000000000'), null);
    assert.equal(await findRecentOutboundCallContextByPhone(''), null);
  } finally {
    await closeDatabase();
  }
});
