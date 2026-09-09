'use strict';

const path = require('node:path');
const { assertOwnedTestDatabase } = require('../test/support/database');
const { runMigrations } = require('./migrate');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  assertOwnedTestDatabase(connectionString, process.env, 'migration-owner');
  await runMigrations({
    connectionString,
    migrationsDir: path.join(__dirname, '..', 'supabase', 'migrations'),
    expectedVersion: '0021',
    validateConnection: (target) => assertOwnedTestDatabase(target, process.env, 'migration-owner')
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[TEST MIGRATE FAILED]', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
