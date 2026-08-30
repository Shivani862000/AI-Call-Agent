require('dotenv').config();
const { Pool } = require('pg');
const { toPgPlaceholders, withReturningId } = require('./src/sql-compat');

/** Bump this when a migration is added. Checked against Supabase at boot. */
const EXPECTED_SCHEMA_VERSION = '0001';

let pool;

function getPool() {
  if (!pool) throw new Error('Database is not initialized. Call initializeDatabase() first.');
  return pool;
}

async function query(sql, params = []) {
  const text = withReturningId(toPgPlaceholders(sql));
  return getPool().query(text, params);
}

async function dbRun(sql, params = []) {
  const result = await query(sql, params);
  return {
    lastID: result.rows?.[0]?.id ?? null,
    changes: result.rowCount ?? 0
  };
}

async function dbGet(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0];
}

async function dbAll(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

/**
 * Runs `fn` inside a single transaction on one pooled client.
 *
 * A pool will hand consecutive dbRun('BEGIN') / dbRun('COMMIT') calls to
 * different connections, which silently stops them being one transaction.
 * Anything transactional must go through here.
 *
 * `fn` receives { run, get, all } bound to the checked-out client.
 */
async function dbTx(fn) {
  const client = await getPool().connect();
  const exec = async (sql, params = []) =>
    client.query(withReturningId(toPgPlaceholders(sql)), params);

  try {
    await client.query('BEGIN');
    const result = await fn({
      run: async (sql, params) => {
        const r = await exec(sql, params);
        return { lastID: r.rows?.[0]?.id ?? null, changes: r.rowCount ?? 0 };
      },
      get: async (sql, params) => (await exec(sql, params)).rows[0],
      all: async (sql, params) => (await exec(sql, params)).rows
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function assertSchemaVersion() {
  const row = await dbGet(
    `SELECT version FROM supabase_migrations.schema_migrations
      ORDER BY version DESC LIMIT 1`
  );
  const applied = row?.version || '(none)';
  if (!applied.startsWith(EXPECTED_SCHEMA_VERSION)) {
    throw new Error(
      `Schema version mismatch: database is at "${applied}", this code expects `
      + `"${EXPECTED_SCHEMA_VERSION}". Run "npx supabase db push" before starting.`
    );
  }
}

async function initializeDatabase() {
  const connectionString = process.env.DATABASE_URL;
  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', (error) => {
    console.error('[DATABASE POOL ERROR]', error.message);
  });

  await pool.query('SELECT 1');
  const host = new URL(connectionString).host;
  console.log('Connected to Supabase Postgres:', host);

  await assertSchemaVersion();
  console.log(`✓ Schema version ${EXPECTED_SCHEMA_VERSION} verified`);
}

async function closeDatabase() {
  if (pool) await pool.end();
  pool = undefined;
}

module.exports = {
  initializeDatabase,
  closeDatabase,
  getPool,
  dbRun,
  dbGet,
  dbAll,
  dbTx,
  EXPECTED_SCHEMA_VERSION
};
