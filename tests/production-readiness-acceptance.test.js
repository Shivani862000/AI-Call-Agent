const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { withTransaction } = require('../persistence/postgres');
const { createRepositories } = require('../repositories');
const {
  getTestConnectionString,
  hasHostedTestDatabase,
  truncateApplicationTables
} = require('./helpers/postgres-test-context');

const databaseTest = hasHostedTestDatabase() ? test : test.skip;

function repositories(pool) {
  return createRepositories({
    query: pool.query.bind(pool),
    transaction: (work) => withTransaction(pool, work)
  });
}

function createPool() {
  return new Pool({
    connectionString: getTestConnectionString(),
    max: 2,
    ssl: { rejectUnauthorized: false }
  });
}

databaseTest('hosted application data and webmaster authority survive a pool restart', async () => {
  const authUserId = randomUUID();
  let pool = createPool();
  try {
    await truncateApplicationTables(pool);
    const repos = repositories(pool);
    const client = await repos.clients.create({ name: 'Restart Client', slug: 'restart-client' });
    const customer = await repos.customers.create(client.id, { name: 'Persistent Customer', phone: '+919888000111' });
    await pool.query(
      `insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
       values ($1, 'authenticated', 'authenticated', $2, now(), now(), now())`,
      [authUserId, `restart-${authUserId}@example.test`]
    );
    await pool.query(
      `insert into app_users (id, username, username_normalized, email, email_normalized)
       values ($1, 'restart-webmaster', 'restart-webmaster', $2, $2)`,
      [authUserId, `restart-${authUserId}@example.test`]
    );
    await pool.query(`insert into app_user_roles (user_id, role) values ($1, 'webmaster')`, [authUserId]);
    await pool.end();

    pool = createPool();
    const restarted = repositories(pool);
    assert.equal((await restarted.customers.findById(client.id, customer.id)).name, 'Persistent Customer');
    const authority = await restarted.users.findAuthority(authUserId);
    assert.equal(authority.username, 'restart-webmaster');
    assert.deepEqual(authority.roles, ['webmaster']);
  } finally {
    if (pool.ended) pool = createPool();
    await pool.query('delete from auth.users where id = $1', [authUserId]);
    await truncateApplicationTables(pool);
    await pool.end();
  }
});
