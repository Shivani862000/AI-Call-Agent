const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  getTestConnectionString,
  hasHostedTestDatabase
} = require('./postgres-test-context');

const projectRef = 'abcdefghijklmnopqrst';
const directUrl = `postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?sslmode=require`;
const baseEnv = {
  SUPABASE_TEST_DB_URL: directUrl,
  SUPABASE_TEST_PROJECT_REF: projectRef,
  SUPABASE_TEST_ALLOW_RESET: 'true'
};

test('hosted test configuration accepts a matching direct Supabase connection', () => {
  assert.equal(getTestConnectionString(baseEnv), directUrl);
  assert.equal(hasHostedTestDatabase(baseEnv), true);
});

test('hosted test configuration accepts a matching Supabase pooler connection', () => {
  const poolerUrl = `postgresql://postgres.${projectRef}:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require`;

  assert.equal(getTestConnectionString({
    ...baseEnv,
    SUPABASE_TEST_DB_URL: poolerUrl
  }), poolerUrl);
});

test('hosted test configuration rejects local and mismatched projects', () => {
  assert.throws(
    () => getTestConnectionString({
      ...baseEnv,
      SUPABASE_TEST_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
    }),
    /must match SUPABASE_TEST_PROJECT_REF/
  );

  assert.throws(
    () => getTestConnectionString({
      ...baseEnv,
      SUPABASE_TEST_DB_URL: 'postgresql://postgres:secret@db.wrongprojectref.supabase.co:5432/postgres'
    }),
    /must match SUPABASE_TEST_PROJECT_REF/
  );
});

test('hosted test configuration requires explicit destructive-test consent', () => {
  assert.equal(hasHostedTestDatabase({ ...baseEnv, SUPABASE_TEST_ALLOW_RESET: 'false' }), false);
  assert.throws(
    () => getTestConnectionString({ ...baseEnv, SUPABASE_TEST_ALLOW_RESET: 'false' }),
    /must be exactly true/
  );
});

test('hosted test configuration refuses the production database URL', () => {
  assert.throws(
    () => getTestConnectionString({ ...baseEnv, SUPABASE_DB_URL: directUrl }),
    /must not equal SUPABASE_DB_URL/
  );
});

test('explicit database-test runs fail fast when hosted settings are absent', () => {
  assert.equal(hasHostedTestDatabase({}), false);
  assert.throws(
    () => hasHostedTestDatabase({ REQUIRE_SUPABASE_TEST_DB: '1' }),
    /SUPABASE_TEST_DB_URL/
  );
});
