'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('fixture cleanup survives an injected assertion failure', async () => {
  const { initializeDatabase, closeDatabase, dbGet, dbRun } = require('../db');
  const { withTestPatient } = require('./support/fixtures');
  await initializeDatabase();
  let patientId;
  let customerId;
  let callId;
  try {
    await assert.rejects(withTestPatient(async (fixture) => {
      patientId = fixture.patientId;
      const customer = await dbRun(
        'INSERT INTO customers (patient_id, status) VALUES (?, ?)', [patientId, 'pending']
      );
      customerId = customer.lastID;
      const call = await dbRun(
        'INSERT INTO calls (customer_id, outcome) VALUES (?, ?)', [customer.lastID, 'completed']
      );
      callId = call.lastID;
      await dbRun('INSERT INTO feedback (customer_id, call_id) VALUES (?, ?)', [customer.lastID, call.lastID]);
      await dbRun('INSERT INTO call_supervisor_events (call_id, event_type) VALUES (?, ?)', [call.lastID, 'test']);
      assert.fail('injected fixture failure');
    }), /injected fixture failure/);
    assert.equal(await dbGet('SELECT id FROM patients WHERE id = ?', [patientId]), undefined);
    assert.equal(await dbGet('SELECT id FROM customers WHERE id = ?', [customerId]), undefined);
    assert.equal(await dbGet('SELECT id FROM calls WHERE id = ?', [callId]), undefined);
    assert.equal(await dbGet('SELECT id FROM feedback WHERE call_id = ?', [callId]), undefined);
    assert.equal(await dbGet('SELECT id FROM call_supervisor_events WHERE call_id = ?', [callId]), undefined);
  } finally { await closeDatabase(); }
});

test('a failed migration rolls back and closes its client', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-migration-'));
  fs.writeFileSync(path.join(dir, '9999_bad.sql'), 'CREATE TABLE rollback_probe(id int); SELECT invalid syntax;');
  const { runMigrations } = require('../scripts/migrate');
  const { assertOwnedTestDatabase } = require('./support/database');
  const { initializeDatabase, closeDatabase, dbGet } = require('../db');
  try {
    await assert.rejects(runMigrations({ connectionString: process.env.DATABASE_URL,
      migrationsDir: dir, expectedVersion: '9999', validateConnection: assertOwnedTestDatabase }), /migration 9999_bad.sql failed/);
    await initializeDatabase();
    const row = await dbGet(`SELECT to_regclass('public.rollback_probe') AS name`);
    assert.equal(row.name, null);
  } finally {
    await closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
