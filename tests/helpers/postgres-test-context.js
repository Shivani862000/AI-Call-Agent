const { Pool } = require('pg');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env.test.local') });

const APPLICATION_TABLES = [
  'call_supervisor_events',
  'feedback',
  'calls',
  'customers',
  'campaign_configurations',
  'support_tickets',
  'agents',
  'application_state',
  'app_user_roles',
  'app_users',
  'clients'
];

function requiredHostedTestSettings(env = process.env) {
  const missing = [
    'SUPABASE_TEST_DB_URL',
    'SUPABASE_TEST_PROJECT_REF',
    'SUPABASE_TEST_ALLOW_RESET'
  ].filter((name) => !env[name]);

  if (missing.length > 0) {
    throw new Error(`Hosted database tests require ${missing.join(', ')}`);
  }

  if (env.SUPABASE_TEST_ALLOW_RESET !== 'true') {
    throw new Error('SUPABASE_TEST_ALLOW_RESET must be exactly true for destructive hosted tests');
  }

  return {
    connectionString: env.SUPABASE_TEST_DB_URL,
    projectRef: env.SUPABASE_TEST_PROJECT_REF
  };
}

function getTestConnectionString(env = process.env) {
  const { connectionString, projectRef } = requiredHostedTestSettings(env);
  const parsed = new URL(connectionString);
  const username = decodeURIComponent(parsed.username);
  const isDirectProjectHost = parsed.hostname === `db.${projectRef}.supabase.co`;
  const isPoolerHost = parsed.hostname.endsWith('.pooler.supabase.com')
    && username.endsWith(`.${projectRef}`);

  if (!isDirectProjectHost && !isPoolerHost) {
    throw new Error('SUPABASE_TEST_DB_URL must match SUPABASE_TEST_PROJECT_REF on a hosted Supabase connection');
  }

  if (env.SUPABASE_DB_URL && connectionString === env.SUPABASE_DB_URL) {
    throw new Error('SUPABASE_TEST_DB_URL must not equal SUPABASE_DB_URL');
  }

  return connectionString;
}

function hasHostedTestDatabase(env = process.env) {
  const configured = Boolean(
    env.SUPABASE_TEST_DB_URL
    && env.SUPABASE_TEST_PROJECT_REF
    && env.SUPABASE_TEST_ALLOW_RESET === 'true'
  );

  if (!configured && env.REQUIRE_SUPABASE_TEST_DB === '1') {
    requiredHostedTestSettings(env);
  }

  return configured;
}

async function truncateApplicationTables(pool) {
  const existing = await pool.query(
    `select tablename
       from pg_tables
      where schemaname = 'public'
        and tablename = any($1::text[])`,
    [APPLICATION_TABLES]
  );

  if (existing.rows.length === 0) return;

  const names = existing.rows
    .map(({ tablename }) => `public."${tablename.replaceAll('"', '""')}"`)
    .join(', ');
  await pool.query(`truncate table ${names} restart identity cascade`);
}

async function withTestDatabase(run, env = process.env) {
  const connectionString = getTestConnectionString(env);
  const pool = new Pool({ connectionString, max: 2 });

  try {
    await truncateApplicationTables(pool);
    return await run({ connectionString, pool });
  } finally {
    await truncateApplicationTables(pool);
    await pool.end();
  }
}

module.exports = {
  getTestConnectionString,
  hasHostedTestDatabase,
  truncateApplicationTables,
  withTestDatabase
};
