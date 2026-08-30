'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveStorageUrl, resolveServiceRoleKey } = require('../src/config');

const POOLER = 'postgresql://postgres.abcdefghijklmnop:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres';
const DIRECT = 'postgresql://postgres:pw@db.zyxwvutsrqponml.supabase.co:5432/postgres';

test('derives the storage host from a pooler connection string', () => {
  assert.strictEqual(
    resolveStorageUrl({ NODE_ENV: 'production', SUPABASE_URL: POOLER }),
    'https://abcdefghijklmnop.supabase.co/storage/v1'
  );
});

test('derives the storage host from a direct connection string', () => {
  assert.strictEqual(
    resolveStorageUrl({ SUPABASE_URL_DEV: DIRECT }),
    'https://zyxwvutsrqponml.supabase.co/storage/v1'
  );
});

test('an explicit SUPABASE_API_URL wins', () => {
  assert.strictEqual(
    resolveStorageUrl({ SUPABASE_API_URL: 'https://custom.example/', SUPABASE_URL_DEV: DIRECT }),
    'https://custom.example/storage/v1'
  );
});

test('returns empty rather than a malformed host when nothing is configured', () => {
  assert.strictEqual(resolveStorageUrl({}), '');
});

test('storage host follows the same environment split as the database', () => {
  const env = { NODE_ENV: 'production', SUPABASE_URL: POOLER, SUPABASE_URL_DEV: DIRECT };
  assert.match(resolveStorageUrl(env), /abcdefghijklmnop/);
  assert.match(resolveStorageUrl({ ...env, NODE_ENV: 'development' }), /zyxwvutsrqponml/);
});

test('service role key follows the environment split', () => {
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'prod-key', SUPABASE_SERVICE_ROLE_KEY_DEV: 'dev-key' };
  assert.strictEqual(resolveServiceRoleKey({ ...env, NODE_ENV: 'production' }), 'prod-key');
  assert.strictEqual(resolveServiceRoleKey({ ...env, NODE_ENV: 'development' }), 'dev-key');
});
