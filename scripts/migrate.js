require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { resolveDatabaseUrl, databaseUrlVarName } = require('../src/config');

/**
 * Applies every migration not yet recorded, in order, each in its own
 * transaction.
 *
 * Run before the new image starts: the app refuses to boot when
 * EXPECTED_SCHEMA_VERSION does not match the database, so a failed migration
 * stops a deploy with the previous version still serving.
 *
 *   node scripts/migrate.js                    # whichever database .env selects
 *   NODE_ENV=production node scripts/migrate.js
 *   DATABASE_URL=... node scripts/migrate.js   # explicit target, used by CI
 */
async function main() {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    throw new Error(`${databaseUrlVarName()} is not set`);
  }

  const client = new Client({ connectionString, connectionTimeoutMillis: 20000 });
  await client.connect();
  console.log(`Migrating ${databaseUrlVarName()} -> ${new URL(connectionString).hostname}`);

  await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
  await client.query(`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text PRIMARY KEY, statements text[], name text)`);

  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  let applied = 0;

  for (const file of files) {
    const version = file.split('_')[0];
    const name = path.basename(file, '.sql').split('_').slice(1).join('_');

    const seen = await client.query(
      'SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1', [version]
    );
    if (seen.rowCount) continue;

    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
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
  console.log(`  ${applied} applied, database at ${latest.rows[0].version}`);

  // The deploy is only safe if the database matches what this build expects.
  const { EXPECTED_SCHEMA_VERSION } = require('../db');
  if (!String(latest.rows[0].version || '').startsWith(EXPECTED_SCHEMA_VERSION)) {
    throw new Error(
      `database is at ${latest.rows[0].version} but this build expects ${EXPECTED_SCHEMA_VERSION}`
    );
  }
  console.log(`  matches EXPECTED_SCHEMA_VERSION ${EXPECTED_SCHEMA_VERSION}`);

  await client.end();
}

main().catch((error) => {
  console.error('[MIGRATE FAILED]', error.message);
  process.exit(1);
});
