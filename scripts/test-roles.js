'use strict';

const { assertOwnedTestDatabase } = require('../test/support/database');

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('invalid generated role name');
  return `"${value}"`;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function provisionTestRoles() {
  const ownerUrl = process.env.DATABASE_URL;
  assertOwnedTestDatabase(ownerUrl, process.env, 'migration-owner');
  const roles = JSON.parse(process.env.AI_CALL_AGENT_TEST_ROLES || '{}');
  for (const key of ['application', 'anon', 'authenticated']) {
    if (!roles[key]?.name || !roles[key]?.password) throw new Error(`missing ${key} test role`);
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: ownerUrl });
  try {
    await client.connect();
    for (const key of ['application', 'anon', 'authenticated']) {
      const role = roles[key];
      const bypass = key === 'application' ? 'BYPASSRLS' : 'NOBYPASSRLS';
      await client.query(
        `CREATE ROLE ${identifier(role.name)} LOGIN PASSWORD ${literal(role.password)} `
        + `NOSUPERUSER NOCREATEDB NOCREATEROLE ${bypass}`
      );
      await client.query(`GRANT USAGE ON SCHEMA public TO ${identifier(role.name)}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${identifier(role.name)}`
      );
      await client.query(
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${identifier(role.name)}`
      );
      if (key === 'application') {
        await client.query(`GRANT USAGE ON SCHEMA supabase_migrations TO ${identifier(role.name)}`);
        await client.query(
          `GRANT SELECT ON supabase_migrations.schema_migrations TO ${identifier(role.name)}`
        );
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  provisionTestRoles().catch((error) => {
    console.error('[TEST ROLE PROVISION FAILED]', error.message);
    process.exitCode = 1;
  });
}

module.exports = { provisionTestRoles };
