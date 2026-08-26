const assert = require('node:assert/strict');
const { test } = require('node:test');
const { withTestDatabase } = require('../helpers/postgres-test-context');
const {
  closePostgres,
  createPostgres,
  pingPostgres
} = require('../../persistence/postgres');

test('Postgres lifecycle connects, responds to ping, and closes cleanly', async () => {
  await withTestDatabase(async ({ connectionString }) => {
    const database = createPostgres({
      connectionString,
      max: 2,
      statementTimeoutMs: 2_000,
      logger: { info() {}, error() {} }
    });

    assert.equal(await pingPostgres(database.pool), true);
    await closePostgres(database.pool);
    assert.equal(database.pool.ended, true);
  });
});
