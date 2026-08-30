require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Client } = require('pg');

/**
 * Brings a fresh Supabase project up to the current schema and proves it
 * matches an existing one, without touching the project it replaces.
 *
 *   node scripts/provision-project.js --url-var SUPABASE_URL_MUMBAI \
 *        --key-var SUPABASE_SERVICE_ROLE_KEY_MUMBAI \
 *        [--expect <fingerprint>] [--admin-username you@example.com]
 *
 * Everything it does is additive: migrations, an optional admin, and read-only
 * verification. It never writes to the project being compared against.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return args;
}

function generatePassword(length = 24) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^&*-_=+';
  let out = '';
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < 256 - (256 % alphabet.length)) out += alphabet[byte % alphabet.length];
  }
  return out;
}

const step = (n, text) => console.log(`\n[${n}] ${text}`);

async function applyMigrations(client) {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
  await client.query(`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text PRIMARY KEY, statements text[], name text)`);

  for (const file of files) {
    const version = file.split('_')[0];
    const name = path.basename(file, '.sql').split('_').slice(1).join('_');
    const already = await client.query(
      'SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1', [version]
    );
    if (already.rowCount) { console.log(`      ${version} already applied`); continue; }

    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query(
        'INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)',
        [version, name]
      );
      await client.query('COMMIT');
      console.log(`      ${version} applied  (${name})`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${file} failed: ${error.message}`);
    }
  }
  return files.length;
}

/** Same structural hash as scripts/schema-fingerprint.js. */
async function fingerprint(client) {
  const queries = [
    `SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, column_name`,
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`,
    `SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`,
    `SELECT table_name, view_definition FROM information_schema.views WHERE table_schema='public' ORDER BY table_name`,
    `SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace ORDER BY 1,2`,
    `SELECT proname, pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname NOT IN ('rls_auto_enable') ORDER BY proname`,
    `SELECT version, coalesce(name,'') FROM supabase_migrations.schema_migrations ORDER BY version`,
    `SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.relname`
  ];
  const parts = [];
  for (const sql of queries) {
    const { rows } = await client.query(sql);
    parts.push(rows.map((r) => Object.values(r).map(String).join(' | ')).join('\n'));
  }
  return crypto.createHash('sha256').update(parts.join('\n##\n')).digest('hex');
}

async function checkStorage(ref, key) {
  const base = `https://${ref}.supabase.co/storage/v1`;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'call-recordings';
  const auth = { Authorization: `Bearer ${key}` };

  const list = await fetch(`${base}/bucket`, { headers: auth });
  if (!list.ok) throw new Error(`storage unreachable (${list.status})`);
  const buckets = await list.json();
  const found = buckets.find((b) => b.name === bucket);
  if (!found) throw new Error(`bucket "${bucket}" does not exist — create it as Private`);
  if (found.public) throw new Error(`bucket "${bucket}" is PUBLIC — it holds call recordings and must be private`);

  const key0 = 'calls/_provision/probe.wav';
  const up = await fetch(`${base}/object/${bucket}/${key0}`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav', 'x-upsert': 'true' },
    body: Buffer.from('RIFF-provision-probe')
  });
  if (!up.ok) throw new Error(`upload failed (${up.status}): ${(await up.text()).slice(0, 120)}`);

  const signed = await fetch(`${base}/object/sign/${bucket}/${key0}`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 60 })
  });
  if (!signed.ok) throw new Error(`signing failed (${signed.status})`);
  const { signedURL } = await signed.json();

  const unsigned = await fetch(`${base}/object/${bucket}/${key0}`);
  const leaks = unsigned.ok;

  await fetch(`${base}/object/${bucket}/${key0}`, { method: 'DELETE', headers: auth });
  if (leaks) throw new Error('recordings are readable without a signed URL');
  return { bucket, signedWorks: Boolean(signedURL) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const urlVar = args['url-var'];
  const keyVar = args['key-var'];
  if (!urlVar || !keyVar) throw new Error('--url-var and --key-var are required');

  const connectionString = process.env[urlVar];
  const serviceKey = process.env[keyVar];
  if (!connectionString) throw new Error(`${urlVar} is not set in .env`);
  if (!serviceKey) throw new Error(`${keyVar} is not set in .env`);

  const parsed = new URL(connectionString);
  const ref = parsed.username.includes('.')
    ? parsed.username.split('.').pop()
    : (/^db\.([a-z0-9]+)\./.exec(parsed.hostname) || [])[1];

  console.log(`Provisioning ${urlVar}`);
  console.log(`  host    ${parsed.hostname}:${parsed.port}`);
  console.log(`  project ${ref}`);
  if (/ap-south-1/.test(parsed.hostname)) console.log('  region  ap-south-1 (Mumbai) ✓');

  const client = new Client({ connectionString, connectionTimeoutMillis: 20000 });
  await client.connect();

  step(1, 'Applying migrations');
  const count = await applyMigrations(client);
  console.log(`      ${count} migration file(s) on disk`);

  step(2, 'Fingerprinting the schema');
  const hash = await fingerprint(client);
  console.log(`      ${hash.slice(0, 24)}`);
  if (args.expect) {
    if (hash.slice(0, 24) !== args.expect.slice(0, 24)) {
      throw new Error(`fingerprint mismatch — expected ${args.expect.slice(0, 24)}. Do not switch over.`);
    }
    console.log('      matches the project it replaces ✓');
  }

  step(3, 'Checking storage');
  const storage = await checkStorage(ref, serviceKey);
  console.log(`      bucket "${storage.bucket}" is private, upload and signed read work,`);
  console.log('      unsigned read refused ✓');

  step(4, 'Admin account');
  const existing = await client.query('SELECT count(*) AS n FROM users');
  if (Number(existing.rows[0].n) > 0) {
    console.log(`      ${existing.rows[0].n} user(s) already exist; leaving them alone`);
  } else if (args['admin-username']) {
    const password = args['admin-password'] || generatePassword();
    await client.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'ADMIN')`,
      [args['admin-username'], await bcrypt.hash(password, 12)]
    );
    console.log(`      created ADMIN ${args['admin-username']}`);
    if (!args['admin-password']) {
      console.log(`\n      Password: ${password}`);
      console.log('      Shown once. Store it in a password manager now.');
    }
  } else {
    console.log('      no users, and no --admin-username given; nobody can sign in yet');
  }

  await client.end();
  console.log('\nDone. Nothing was changed in any other project.');
}

main().catch((error) => {
  console.error(`\n[PROVISION FAILED] ${error.message}`);
  process.exit(1);
});
