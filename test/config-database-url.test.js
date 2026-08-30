'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateDatabaseUrl } = require('../src/config');

test('accepts a postgres connection string', () => {
  assert.strictEqual(
    validateDatabaseUrl('postgresql://user:pw@host.pooler.supabase.com:5432/postgres'),
    null
  );
});

test('accepts the postgres:// scheme', () => {
  assert.strictEqual(validateDatabaseUrl('postgres://user:pw@host:5432/db'), null);
});

test('rejects a leftover SQLite file path', () => {
  const issue = validateDatabaseUrl('/app/data/feedback.db');
  assert.match(issue, /postgres/i);
});

test('rejects an empty value', () => {
  assert.match(validateDatabaseUrl(''), /required/i);
});
