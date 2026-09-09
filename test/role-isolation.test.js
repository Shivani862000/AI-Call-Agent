'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { assertOwnedTestDatabase } = require('./support/database');

test('application regressions use the restricted trusted server role', async () => {
  const connectionString = process.env.DATABASE_URL;
  assertOwnedTestDatabase(connectionString, process.env, 'application');
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    assert.deepEqual(result.rows[0], {
      rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: true
    });
    await assert.rejects(client.query('CREATE ROLE forbidden_role'), /permission denied/);
  } finally { await client.end(); }
});

for (const purpose of ['anon', 'authenticated']) {
  test(`${purpose} equivalent is constrained by RLS and cannot escalate`, async () => {
    const key = purpose.toUpperCase();
    const env = {
      ...process.env,
      DATABASE_URL: process.env[`AI_CALL_AGENT_TEST_${key}_URL`],
      AI_CALL_AGENT_TEST_DB_IDENTITY: process.env[`AI_CALL_AGENT_TEST_${key}_IDENTITY`]
    };
    const connectionString = env.DATABASE_URL;
    assertOwnedTestDatabase(connectionString, env, purpose);
    const client = new Client({ connectionString });
    try {
      await client.connect();
      const rows = await client.query('SELECT id FROM public.patients');
      assert.equal(rows.rowCount, 0, 'RLS exposed base-table rows');
      await assert.rejects(client.query('CREATE TABLE public.forbidden_probe(id int)'), /permission denied/);
      const ownerRole = decodeURIComponent(new URL(process.env.AI_CALL_AGENT_TEST_OWNER_URL).username);
      await assert.rejects(client.query(`SET ROLE "${ownerRole}"`), /permission denied/);
    } finally { await client.end(); }
  });
}
