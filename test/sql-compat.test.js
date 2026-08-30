'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toPgPlaceholders } = require('../src/sql-compat');

test('numbers placeholders in order', () => {
  assert.strictEqual(
    toPgPlaceholders('SELECT * FROM customers WHERE phone = ? AND status = ?'),
    'SELECT * FROM customers WHERE phone = $1 AND status = $2'
  );
});

test('leaves SQL without placeholders untouched', () => {
  assert.strictEqual(toPgPlaceholders('SELECT 1'), 'SELECT 1');
});

test('does not rewrite a question mark inside a string literal', () => {
  assert.strictEqual(
    toPgPlaceholders("UPDATE calls SET notes = 'why?' WHERE id = ?"),
    "UPDATE calls SET notes = 'why?' WHERE id = $1"
  );
});

test('handles an escaped quote inside a literal', () => {
  assert.strictEqual(
    toPgPlaceholders("UPDATE calls SET notes = 'it''s ok?' WHERE id = ?"),
    "UPDATE calls SET notes = 'it''s ok?' WHERE id = $1"
  );
});

const { withReturningId, ID_TABLES } = require('../src/sql-compat');

test('appends RETURNING id to an insert on an id-bearing table', () => {
  assert.strictEqual(
    withReturningId('INSERT INTO customers (name) VALUES ($1)'),
    'INSERT INTO customers (name) VALUES ($1) RETURNING id'
  );
});

test('leaves app_state alone because it has no id column', () => {
  const sql = 'INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
  assert.strictEqual(withReturningId(sql), sql);
});

test('leaves non-insert statements alone', () => {
  const sql = 'UPDATE calls SET outcome = $1 WHERE id = $2';
  assert.strictEqual(withReturningId(sql), sql);
});

test('does not double-append when RETURNING is already present', () => {
  const sql = 'INSERT INTO calls (customer_id) VALUES ($1) RETURNING id';
  assert.strictEqual(withReturningId(sql), sql);
});

test('id table list covers every table except app_state', () => {
  assert.ok(ID_TABLES.has('customers'));
  assert.ok(ID_TABLES.has('support_tickets'));
  assert.ok(!ID_TABLES.has('app_state'));
});

test('ID_TABLES covers every table declared with an identity id', () => {
  // Guards the failure mode where a new table is added to a migration but not
  // here: the INSERT succeeds, RETURNING id is skipped, and lastID is silently
  // null -- so the API returns nothing for a row that was created.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');

  const declared = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of sql.matchAll(/create table (?:if not exists )?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      if (/id\s+bigint generated always as identity/i.test(match[2])) declared.add(match[1].toLowerCase());
    }
  }

  assert.ok(declared.size >= 10, `expected to find the tables, found ${declared.size}`);
  const missing = [...declared].filter((table) => !ID_TABLES.has(table));
  assert.deepStrictEqual(missing, [], `add these to ID_TABLES in src/sql-compat.js: ${missing.join(', ')}`);
});
