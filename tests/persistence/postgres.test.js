const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  hasHostedTestDatabase,
  withTestDatabase
} = require('../helpers/postgres-test-context');

const databaseTest = hasHostedTestDatabase() ? test : test.skip;

function loadPostgres() {
  return require('../../persistence/postgres');
}

databaseTest('Postgres lifecycle connects, responds to ping, and closes cleanly', async () => {
  const { closePostgres, createPostgres, pingPostgres } = loadPostgres();
  await withTestDatabase(async ({ connectionString }) => {
    const database = createPostgres({
      connectionString,
      max: 2,
      statementTimeoutMs: 2_000,
      ssl: { rejectUnauthorized: false },
      logger: { info() {}, error() {} }
    });

    assert.equal(await pingPostgres(database.pool), true);
    assert.equal(await database.ping(), true);
    assert.equal((await database.query('select 42::integer as value')).rows[0].value, 42);
    assert.equal(
      (await database.query(
        'select ssl from pg_stat_ssl where pid = pg_backend_pid()'
      )).rows[0].ssl,
      true
    );
    await closePostgres(database.pool);
    await database.close();
    assert.equal(database.pool.ended, true);
  });
});

test('remote Postgres connections default to strict certificate verification', async () => {
  const { createPostgres } = loadPostgres();
  const database = createPostgres({
    connectionString: 'postgresql://user:password@db.example.test:5432/postgres',
    logger: { info() {}, error() {} }
  });

  assert.deepEqual(database.pool.options.ssl, { rejectUnauthorized: true });
  await database.close();
});

databaseTest('transaction rolls back all writes when its operation fails', async () => {
  const { createPostgres } = loadPostgres();
  await withTestDatabase(async ({ connectionString }) => {
    const database = createPostgres({
      connectionString,
      max: 2,
      statementTimeoutMs: 2_000,
      ssl: { rejectUnauthorized: false },
      logger: { info() {}, error() {} }
    });

    await assert.rejects(
      database.transaction(async (client) => {
        await client.query(
          `insert into application_state (client_id, key, value)
           values (null, 'rollback-probe', '{"written":true}'::jsonb)`
        );
        throw new Error('rollback-probe');
      }),
      /rollback-probe/
    );

    const result = await database.query(
      `select count(*)::integer as count
         from application_state
        where client_id is null and key = 'rollback-probe'`
    );
    assert.equal(result.rows[0].count, 0);

    await database.close();
  });
});

databaseTest('withTransaction returns a committed operation result', async () => {
  const { withTransaction } = loadPostgres();
  await withTestDatabase(async ({ pool }) => {
    const result = await withTransaction(pool, async (client) => {
      const inserted = await client.query(
        `insert into clients (slug, name, timezone)
         values ('transaction-client', 'Transaction Client', 'Asia/Kolkata')
         returning id`
      );
      return inserted.rows[0].id;
    });

    assert.equal(typeof result, 'string');
    assert.equal((await pool.query('select count(*)::integer as count from clients')).rows[0].count, 1);
  });
});
