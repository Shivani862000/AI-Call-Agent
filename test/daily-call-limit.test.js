'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();
const { resolveDatabaseUrl } = require('../src/config');
const HAS_DB = /^postgres/i.test(resolveDatabaseUrl());

const { MAX_CALLS_PER_DAY, countOutboundCallsToday } = require('../src/call-management');

test('the daily limit is a stated number, not a magic one', () => {
  assert.equal(MAX_CALLS_PER_DAY, 3);
});

// current_date is UTC, so the counter reset at 05:30 IST rather than midnight:
// calls made on an Indian evening counted against the next morning's allowance.
test('the day is India\'s day, not the server\'s',
  { skip: !HAS_DB && 'no Supabase connection configured' }, async () => {
  const { initializeDatabase, dbRun, closeDatabase } = require('../db');
  await initializeDatabase();

  const phone = String(Date.now()).slice(-10);
  const patient = await dbRun(
    'INSERT INTO patients (first_name, phone, normalized_phone) VALUES (?, ?, ?)',
    [`limit-${phone}`, phone, phone]
  );
  const entry = await dbRun(
    'INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patient.lastID, 'pending']
  );

  try {
    assert.equal(await countOutboundCallsToday(phone), 0);

    // 20:00 IST today is 14:30 UTC today -- the same day either way.
    await dbRun(
      `INSERT INTO calls (customer_id, outcome, call_direction, called_at)
       VALUES (?, 'completed', 'outbound', (((now() AT TIME ZONE 'Asia/Kolkata')::date + interval '20 hours') AT TIME ZONE 'Asia/Kolkata'))`,
      [entry.lastID]
    );
    assert.equal(await countOutboundCallsToday(phone), 1);

    // 01:00 IST today is 19:30 UTC yesterday. Counted under UTC's yesterday,
    // it would be missed; it belongs to today in India.
    await dbRun(
      `INSERT INTO calls (customer_id, outcome, call_direction, called_at)
       VALUES (?, 'completed', 'outbound', (((now() AT TIME ZONE 'Asia/Kolkata')::date + interval '1 hour') AT TIME ZONE 'Asia/Kolkata'))`,
      [entry.lastID]
    );
    assert.equal(await countOutboundCallsToday(phone), 2, 'an early-morning Indian call was not counted as today');

    // Yesterday in India must not count.
    await dbRun(
      `INSERT INTO calls (customer_id, outcome, call_direction, called_at)
       VALUES (?, 'completed', 'outbound', (((now() AT TIME ZONE 'Asia/Kolkata')::date - interval '3 hours') AT TIME ZONE 'Asia/Kolkata'))`,
      [entry.lastID]
    );
    assert.equal(await countOutboundCallsToday(phone), 2, 'a call from yesterday in India was counted as today');

    await dbRun('DELETE FROM calls WHERE customer_id = ?', [entry.lastID]);
    await dbRun('DELETE FROM customers WHERE id = ?', [entry.lastID]);
  } finally {
    await dbRun('DELETE FROM patients WHERE id = ?', [patient.lastID]).catch(() => {});
    await closeDatabase();
  }
});
