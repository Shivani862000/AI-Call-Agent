const { Pool } = require('pg');

const LOCAL_SUPABASE_PORT = '54322';
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

function getTestConnectionString(env = process.env) {
  const connectionString = env.SUPABASE_TEST_DB_URL
    || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const parsed = new URL(connectionString);
  const isLocalSupabase = ['127.0.0.1', 'localhost'].includes(parsed.hostname)
    && parsed.port === LOCAL_SUPABASE_PORT
    && parsed.pathname === '/postgres';
  const isNamedTestDatabase = parsed.pathname.slice(1).endsWith('_test');

  if (!isLocalSupabase && !isNamedTestDatabase) {
    throw new Error('SUPABASE_TEST_DB_URL must target local Supabase or a database ending in _test');
  }

  if (env.SUPABASE_DB_URL && connectionString === env.SUPABASE_DB_URL) {
    throw new Error('SUPABASE_TEST_DB_URL must not equal SUPABASE_DB_URL');
  }

  return connectionString;
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
  truncateApplicationTables,
  withTestDatabase
};
