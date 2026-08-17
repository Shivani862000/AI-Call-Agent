'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcrypt');

test('database synchronizes call status and creates a valid backup', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-call-agent-db-'));
  process.env.DATABASE_URL = path.join(tempDir, 'feedback.db');
  process.env.DATABASE_BACKUP_DIR = path.join(tempDir, 'backups');
  process.env.DATABASE_BACKUP_RETENTION = '2';
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_USERNAME = 'phase1-admin';
  process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('phase1-password', 4);
  process.env.AUTH_SIGNING_SECRET = 'database-test-signing-secret-with-at-least-32-bytes';
  process.env.SUBMITTED_CALL_GRACE_MS = '1';

  const {
    initializeDatabase,
    dbRun,
    dbGet,
    dbAll,
    backupDatabase,
    getDb
  } = require('../db');

  t.after(async () => {
    await new Promise((resolve) => getDb().close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await initializeDatabase();
  const initialUsers = await dbAll('SELECT username, role FROM users ORDER BY username');
  assert.deepEqual(initialUsers, [{ username: 'phase1-admin', role: 'ADMIN' }]);

  await dbRun(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
    ['agent-one', bcrypt.hashSync('agent-password', 4), 'AGENT']
  );
  await dbRun(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
    ['extra-admin', bcrypt.hashSync('extra-password', 4), 'ADMIN']
  );

  await new Promise((resolve, reject) => getDb().close((error) => error ? reject(error) : resolve()));
  await initializeDatabase();
  const migratedUsers = await dbAll('SELECT username, role FROM users ORDER BY username');
  assert.deepEqual(migratedUsers, [
    { username: 'agent-one', role: 'AGENT' },
    { username: 'extra-admin', role: 'AGENT' },
    { username: 'phase1-admin', role: 'ADMIN' }
  ]);

  const { verifyCredentials } = require('../src/auth');
  assert.deepEqual(
    await verifyCredentials('phase1-admin', 'phase1-password'),
    { success: true, username: 'phase1-admin', role: 'ADMIN' }
  );
  assert.deepEqual(await verifyCredentials('admin', '1234'), { success: false });

  const customer = await dbRun(
    'INSERT INTO customers (name, phone, status) VALUES (?, ?, ?)',
    ['Backup Test', '+910000000000', 'called']
  );
  const call = await dbRun(
    'INSERT INTO calls (customer_id, outcome, called_at) VALUES (?, ?, ?)',
    [customer.lastID, 'completed', new Date().toISOString()]
  );

  const inserted = await dbGet('SELECT status FROM calls WHERE id = ?', [call.lastID]);
  assert.equal(inserted.status, 'completed');

  await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['failed', call.lastID]);
  const updated = await dbGet('SELECT status FROM calls WHERE id = ?', [call.lastID]);
  assert.equal(updated.status, 'failed');

  const staleCustomer = await dbRun(
    'INSERT INTO customers (name, phone, status, auto_retry_enabled) VALUES (?, ?, ?, ?)',
    ['Stale Attempt Test', '+910000000001', 'called', 0]
  );
  await dbRun(
    `INSERT INTO calls (customer_id, outcome, called_at, call_direction, media_packets)
     VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    [
      staleCustomer.lastID, 'scheduled_initiated', '2026-01-01T10:00:00.000Z', 'outbound', 0,
      staleCustomer.lastID, 'scheduled_initiated', '2026-01-01T10:02:00.000Z', 'outbound', 0
    ]
  );

  const { markSubmittedCallsWithoutMediaFailed } = require('../src/scheduler');
  await markSubmittedCallsWithoutMediaFailed();

  const staleCalls = await dbAll(
    'SELECT outcome, last_event FROM calls WHERE customer_id = ? ORDER BY called_at',
    [staleCustomer.lastID]
  );
  assert.deepEqual(staleCalls, [
    { outcome: 'failed', last_event: 'media_timeout' },
    { outcome: 'failed', last_event: 'media_timeout' }
  ]);
  const finalizedCustomer = await dbGet(
    'SELECT status, attempt_count FROM customers WHERE id = ?',
    [staleCustomer.lastID]
  );
  assert.deepEqual(finalizedCustomer, { status: 'failed', attempt_count: 1 });

  const backupPath = await backupDatabase();
  assert.equal(fs.existsSync(backupPath), true);
  assert.ok(fs.statSync(backupPath).size > 0);
});
