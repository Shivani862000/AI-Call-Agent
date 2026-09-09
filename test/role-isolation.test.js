'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
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

test('browser-equivalent roles cannot see an existing application sentinel through base-table RLS', async () => {
  const application = new Client({ connectionString: process.env.DATABASE_URL });
  let patientId;
  try {
    await application.connect();
    const marker = `rls-sentinel-${randomUUID()}`;
    const inserted = await application.query(
      `INSERT INTO public.patients (first_name, phone, normalized_phone)
       VALUES ($1, $2, $2) RETURNING id`, [marker, `000${marker.replace(/\D/g, '').padEnd(7, '0').slice(0, 7)}`]
    );
    patientId = inserted.rows[0].id;
    const visible = await application.query('SELECT id FROM public.patients WHERE id = $1', [patientId]);
    assert.equal(visible.rowCount, 1, 'application role could not see its owned sentinel');

    for (const purpose of ['anon', 'authenticated']) {
      const key = purpose.toUpperCase();
      const env = {
        ...process.env,
        DATABASE_URL: process.env[`AI_CALL_AGENT_TEST_${key}_URL`],
        AI_CALL_AGENT_TEST_DB_IDENTITY: process.env[`AI_CALL_AGENT_TEST_${key}_IDENTITY`]
      };
      assertOwnedTestDatabase(env.DATABASE_URL, env, purpose);
      const browser = new Client({ connectionString: env.DATABASE_URL });
      try {
        await browser.connect();
        const hidden = await browser.query('SELECT id FROM public.patients WHERE id = $1', [patientId]);
        assert.equal(hidden.rowCount, 0, `${purpose} role saw the existing sentinel`);
      } finally { await browser.end(); }
    }
  } finally {
    if (patientId) await application.query('DELETE FROM public.patients WHERE id = $1', [patientId]);
    await application.end().catch(() => {});
  }
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
