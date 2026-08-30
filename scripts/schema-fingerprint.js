require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');
const { resolveDatabaseUrl, databaseUrlVarName } = require('../src/config');

/**
 * Prints a stable fingerprint of the database structure.
 *
 * Used to prove that a rebuilt project matches the one it replaces, before the
 * old one is deleted. Compares structure only -- tables, columns, types,
 * defaults, nullability, indexes, constraints, views, functions and applied
 * migrations -- so it is independent of row data.
 *
 *   node scripts/schema-fingerprint.js                 # dev
 *   NODE_ENV=production node scripts/schema-fingerprint.js
 *   ... --verbose   to print the full listing rather than just the hash
 */
const QUERIES = {
  columns: `
    SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default, '')
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, column_name`,

  indexes: `
    SELECT tablename, indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
     ORDER BY tablename, indexname`,

  constraints: `
    SELECT conrelid::regclass::text AS on_table, conname, pg_get_constraintdef(oid)
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace
     ORDER BY 1, 2`,

  views: `
    SELECT table_name, view_definition
      FROM information_schema.views
     WHERE table_schema = 'public'
     ORDER BY table_name`,

  triggers: `
    SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid)
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relnamespace = 'public'::regnamespace
     ORDER BY 1, 2`,

  functions: `
    SELECT proname, pg_get_functiondef(oid)
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
     ORDER BY proname`,

  migrations: `
    SELECT version, coalesce(name, '')
      FROM supabase_migrations.schema_migrations
     ORDER BY version`,

  rls: `
    SELECT c.relname, c.relrowsecurity
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'r'
     ORDER BY c.relname`
};

async function main() {
  const verbose = process.argv.includes('--verbose');
  const connectionString = resolveDatabaseUrl();
  const client = new Client({ connectionString, connectionTimeoutMillis: 15000 });
  await client.connect();

  console.log(`${databaseUrlVarName()} -> ${new URL(connectionString).hostname}\n`);

  const sections = {};
  for (const [name, sql] of Object.entries(QUERIES)) {
    let rows = [];
    try {
      ({ rows } = await client.query(sql));
    } catch (error) {
      console.log(`  ${name}: unavailable (${error.message})`);
    }
    // Normalised to plain lines so the hash is stable across servers.
    sections[name] = rows.map((row) => Object.values(row).map(String).join(' | '));
  }

  for (const [name, lines] of Object.entries(sections)) {
    const digest = crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
    console.log(`  ${name.padEnd(14)} ${String(lines.length).padStart(4)} entries   ${digest}`);
    if (verbose) lines.forEach((line) => console.log(`      ${line}`));
  }

  const overall = crypto.createHash('sha256')
    .update(Object.values(sections).map((lines) => lines.join('\n')).join('\n##\n'))
    .digest('hex');

  console.log(`\n  FINGERPRINT ${overall.slice(0, 24)}`);
  console.log('  Two projects match when this line is identical.');

  await client.end();
}

main().catch((error) => {
  console.error('[FINGERPRINT ERROR]', error.message);
  process.exit(1);
});
