const { Pool } = require('pg');

function tlsOptions(connectionString, ssl) {
  if (ssl !== undefined) return ssl;

  const { hostname } = new URL(connectionString);
  if (hostname === 'localhost' || hostname === '127.0.0.1') return false;

  return { rejectUnauthorized: true };
}

async function pingPostgres(pool) {
  await pool.query('select 1');
  return true;
}

async function closePostgres(pool) {
  if (!pool || pool.ended) return;
  await pool.end();
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function createPostgres({
  connectionString,
  max = 10,
  connectionTimeoutMs = 5_000,
  statementTimeoutMs = 15_000,
  idleTimeoutMs = 30_000,
  ssl,
  logger = console
}) {
  if (!connectionString) {
    throw new Error('Postgres connectionString is required');
  }

  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: connectionTimeoutMs,
    idleTimeoutMillis: idleTimeoutMs,
    statement_timeout: statementTimeoutMs,
    ssl: tlsOptions(connectionString, ssl)
  });

  pool.on('error', (error) => {
    logger.error('postgres_pool_error', { code: error.code || 'UNKNOWN' });
  });

  return {
    pool,
    query(text, values) {
      return pool.query(text, values);
    },
    transaction(work) {
      return withTransaction(pool, work);
    },
    ping() {
      return pingPostgres(pool);
    },
    close() {
      return closePostgres(pool);
    }
  };
}

module.exports = {
  closePostgres,
  createPostgres,
  pingPostgres,
  withTransaction
};
