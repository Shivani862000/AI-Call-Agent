'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function runMigrations({ connectionString, migrationsDir, expectedVersion, validateConnection }) {
  if (!connectionString) throw new Error('connectionString is required');
  if (!migrationsDir) throw new Error('migrationsDir is required');
  if (!expectedVersion) throw new Error('expectedVersion is required');
  if (validateConnection) validateConnection(connectionString);

  const { Client } = require('pg');
  const client = new Client({ connectionString, connectionTimeoutMillis: 20000 });
  let applied = 0;
  try {
    await client.connect();
    await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
    await client.query(`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY, statements text[], name text)`);
    const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
    if (files.length === 0) throw new Error('no migrations discovered');
    for (const file of files) {
      const version = file.split('_')[0];
      const name = path.basename(file, '.sql').split('_').slice(1).join('_');
      const seen = await client.query(
        'SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1', [version]
      );
      if (seen.rowCount) continue;
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
        await client.query(
          'INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)',
          [version, name]
        );
        await client.query('COMMIT');
        console.log(`  applied ${version} (${name})`);
        applied += 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${file} failed: ${error.message}`);
      }
    }
    const latest = await client.query(
      'SELECT max(version) AS version FROM supabase_migrations.schema_migrations'
    );
    const version = String(latest.rows[0].version || '');
    if (!version.startsWith(expectedVersion)) {
      throw new Error(`database is at ${version || '(none)'} but this build expects ${expectedVersion}`);
    }
    console.log(`  ${applied} applied, database at ${version}`);
    return { applied, version };
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  require('dotenv').config();
  const { resolveDatabaseUrl, databaseUrlVarName } = require('../src/config');
  const { EXPECTED_SCHEMA_VERSION } = require('../db');
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) throw new Error(`${databaseUrlVarName()} is not set`);
  console.log(`Migrating ${databaseUrlVarName()} -> ${new URL(connectionString).hostname}`);
  await runMigrations({
    connectionString,
    migrationsDir: path.join(__dirname, '..', 'supabase', 'migrations'),
    expectedVersion: EXPECTED_SCHEMA_VERSION
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[MIGRATE FAILED]', error.message);
    process.exitCode = 1;
  });
}

module.exports = { runMigrations, main };
