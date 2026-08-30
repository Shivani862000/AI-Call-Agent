'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateDatabaseUrl, resolveDatabaseUrl, databaseUrlVarName } = require('../src/config');

const DEV = 'postgresql://u:p@db.dev.supabase.co:5432/postgres';
const PROD = 'postgresql://u:p@db.prod.supabase.co:5432/postgres';

test('accepts a postgres connection string', () => {
  assert.strictEqual(validateDatabaseUrl(PROD), null);
});

test('accepts the postgres:// scheme', () => {
  assert.strictEqual(validateDatabaseUrl('postgres://user:pw@host:5432/db'), null);
});

test('rejects a leftover SQLite file path', () => {
  assert.match(validateDatabaseUrl('/app/data/feedback.db'), /postgres/i);
});

test('rejects an empty value, naming the variable that was read', () => {
  assert.match(validateDatabaseUrl('', 'SUPABASE_URL_DEV'), /SUPABASE_URL_DEV is required/);
});

test('local and UAT resolve to the dev project', () => {
  const env = { NODE_ENV: 'development', SUPABASE_URL: PROD, SUPABASE_URL_DEV: DEV };
  assert.strictEqual(resolveDatabaseUrl(env), DEV);
  assert.strictEqual(databaseUrlVarName(env), 'SUPABASE_URL_DEV');
});

test('production resolves to the production project', () => {
  const env = { NODE_ENV: 'production', SUPABASE_URL: PROD, SUPABASE_URL_DEV: DEV };
  assert.strictEqual(resolveDatabaseUrl(env), PROD);
  assert.strictEqual(databaseUrlVarName(env), 'SUPABASE_URL');
});

test('an unset NODE_ENV never reaches production by accident', () => {
  const env = { SUPABASE_URL: PROD, SUPABASE_URL_DEV: DEV };
  assert.strictEqual(resolveDatabaseUrl(env), DEV);
});

test('DATABASE_URL overrides both, for scripts targeting one database', () => {
  const env = { NODE_ENV: 'production', DATABASE_URL: DEV, SUPABASE_URL: PROD, SUPABASE_URL_DEV: DEV };
  assert.strictEqual(resolveDatabaseUrl(env), DEV);
  assert.strictEqual(databaseUrlVarName(env), 'DATABASE_URL');
});
