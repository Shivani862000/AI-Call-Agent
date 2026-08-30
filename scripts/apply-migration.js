require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { resolveDatabaseUrl, databaseUrlVarName } = require('../src/config');

/**
 * Applies one migration file and records it in supabase_migrations.schema_migrations,
 * the same table the Supabase CLI uses, inside a single transaction.
 *
 * Usage: node scripts/apply-migration.js 0002_system_logs.sql
 */
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/apply-migration.js <file.sql>');

  const full = path.join(__dirname, '..', 'supabase', 'migrations', file);
  const sql = fs.readFileSync(full, 'utf8');
  const version = path.basename(file).split('_')[0];
  const name = path.basename(file, '.sql').split('_').slice(1).join('_');

  const client = new Client({ connectionString: resolveDatabaseUrl(), connectionTimeoutMillis: 15000 });
  await client.connect();
  console.log(`Applying ${file} via ${databaseUrlVarName()} -> ${new URL(resolveDatabaseUrl()).hostname}`);

  const already = await client.query(
    'SELECT version FROM supabase_migrations.schema_migrations WHERE version = $1', [version]
  );
  if (already.rowCount > 0) {
    console.log(`  ${version} already applied; nothing to do.`);
    await client.end();
    return;
  }

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)',
      [version, name]
    );
    await client.query('COMMIT');
    console.log(`  ✓ applied ${version} (${name})`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error('[MIGRATION ERROR]', error.message); process.exit(1); });
