'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const HAS_DB = /^postgres/i.test(String(process.env.DATABASE_URL || ''));

test('calls.status mirrors calls.outcome via trigger', { skip: !HAS_DB && 'DATABASE_URL not set' }, async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();

  const marker = `trigger-test-${Date.now()}`;
  const customer = await dbRun(
    'INSERT INTO customers (name, phone, status) VALUES (?, ?, ?)',
    [marker, marker, 'pending']
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
    await closeDatabase();
  }
});

test('deleting a customer cascades to calls and feedback', { skip: !HAS_DB && 'DATABASE_URL not set' }, async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();

  const marker = `cascade-test-${Date.now()}`;
  const customer = await dbRun(
    'INSERT INTO customers (name, phone, status) VALUES (?, ?, ?)',
    [marker, marker, 'pending']
  );
  const call = await dbRun(
    'INSERT INTO calls (customer_id, outcome) VALUES (?, ?)',
    [customer.lastID, 'completed']
  );
  await dbRun(
    'INSERT INTO feedback (customer_id, call_id, review_text, stars) VALUES (?, ?, ?, ?)',
    [customer.lastID, call.lastID, 'cascade check', 5]
  );

  await dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);

  const orphanCall = await dbGet('SELECT id FROM calls WHERE id = ?', [call.lastID]);
  const orphanFeedback = await dbGet('SELECT id FROM feedback WHERE customer_id = ?', [customer.lastID]);
  assert.equal(orphanCall, undefined);
  assert.equal(orphanFeedback, undefined);

  await closeDatabase();
});
