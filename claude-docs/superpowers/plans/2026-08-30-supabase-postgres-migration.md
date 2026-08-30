# Supabase Postgres Migration — Implementation Plan (1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all 10 database tables from the local SQLite file to Supabase Postgres, for both local development and production, without rewriting any of the 260 query call sites.

**Architecture:** Every query in the app goes through `dbRun` / `dbGet` / `dbAll` in `db.js`. Those three functions keep their exact signatures and return shapes, absorbing three SQLite-to-Postgres differences behind them: `?` placeholders become `$1`, `INSERT` gets `RETURNING id` so `result.lastID` still works, and `result.changes` maps from `rowCount`. The translation logic lives in a new pure module so it can be unit-tested without a database.

**Tech Stack:** Node 22, `pg` (connection pool), Supabase Postgres via the Supavisor session-mode pooler, `node:test` for tests, Supabase CLI for migrations.

**Spec:** `claude-docs/superpowers/specs/2026-08-30-supabase-migration-design.md`

**Scope:** This is plan 1 of 3. Plan 2 moves call recordings to Supabase Storage. Plan 3 moves the audit log to a `system_logs` table and removes the persistent volumes from the deployment. Volumes stay in place until plan 3, because recordings and logs still write to disk after this plan.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0001_initial_schema.sql` | **Already generated.** Complete Postgres schema: 10 tables, 5 foreign keys, 8 indexes, 4 check constraints, the `calls.status` sync triggers. |
| `src/sql-compat.js` | **New.** Pure functions translating SQLite-flavoured SQL to Postgres. No I/O, no imports — fully unit-testable. |
| `test/sql-compat.test.js` | **New.** Unit tests for the above. |
| `db.js` | **Rewritten.** `pg.Pool` instead of `sqlite3`. Same exports plus `dbTx`. Loses `runMigrations`, `backupDatabase`, `startDatabaseBackupSchedule`. |
| `scripts/seed-admin.js` | **New.** Creates the admin account from env when `users` is empty. Replaces the hardcoded accounts. |
| `src/config.js` | Guard: `DATABASE_URL` must be a `postgres://` URL. |
| `src/call-management.js` | `findCustomerByPhone` becomes one indexed query. |
| `routes/customers.js` | Write `normalized_phone` on insert. |
| `routes/support-tickets.js` | Use `dbTx` instead of loose `BEGIN`/`COMMIT`. |
| `test/database-safety.test.js` | **Deleted.** It tested `runMigrations()` and `backupDatabase()`, both removed. |
| `test/schema-triggers.test.js` | **New.** Verifies the `calls.status` trigger and FK cascades against the dev database. |

---

## Task 1: Provision Supabase and apply the schema

**Files:**
- Review: `supabase/migrations/0001_initial_schema.sql` (already generated, 281 lines)

- [ ] **Step 1: Create two Supabase projects**

In the Supabase dashboard create two projects in the region nearest your application server:

- `ai-call-agent-dev`
- `ai-call-agent-prod`

From each project's **Project Settings → Database → Connection string → Session pooler**, copy the URI. It looks like:

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Do **not** use the "Direct connection" host (`db.<ref>.supabase.co`) — it is IPv6-only and will not resolve from most networks. Do not use port `6543` (transaction mode) — it does not preserve the session state `dbTx` needs.

- [ ] **Step 2: Review the generated schema**

Read `supabase/migrations/0001_initial_schema.sql`. It was generated from the live SQLite schema with these transformations already applied:

- `INTEGER PRIMARY KEY AUTOINCREMENT` → `bigint generated always as identity primary key`
- `TIMESTAMP` columns → `timestamptz`, defaults `CURRENT_TIMESTAMP` → `now()`
- Foreign-key columns (`customer_id`, `call_id`, `linked_customer_id`, `agent_id`, `default_agent_id`) → `bigint`, so they match the identity type
- `calls.recording_local_path` → `calls.recording_object_key` (plan 2 uses it; renaming now avoids a second migration)
- 15 dead columns dropped (7 from `customers`, 8 from `calls`)
- `INTEGER` 0/1 flags deliberately left as `integer` — 17 SQL sites compare them numerically and Postgres rejects `boolean = 1`

Verify the drop list matches the spec, then check the two things the generator could not infer:

1. Every `unique` marker is present: `clients.phone`, `agents.name`, `agents.slug`, `users.username`, `campaign_configs.name`, `support_tickets.ticket_id`.
2. `customers.normalized_phone` still exists — it is dead today but plan Task 8 wires it up.

**One deliberate deviation from the spec:** the spec called for CHECK constraints on `customers.status` and `calls.outcome`. The migration omits those two. Their values are written from several call sites and are not provably enumerable from the code; a wrong CHECK would take writes down in production. CHECKs on `users.role` and the three `support_tickets` columns are included, because those value sets are enforced in code today.

- [ ] **Step 3: Install the CLI and link the dev project**

```bash
npm install --save-dev supabase
npx supabase link --project-ref <dev-project-ref>
```

- [ ] **Step 4: Apply the migration to dev**

```bash
npx supabase db push
```

Expected: `Applying migration 0001_initial_schema.sql...` then `Finished supabase db push.`

- [ ] **Step 5: Verify the schema landed**

In the Supabase SQL editor for the dev project:

```sql
select table_name, count(*) as columns
from information_schema.columns
where table_schema = 'public'
group by table_name order by table_name;
```

Expected 10 rows. `calls` must show **66**, `customers` **44**.

```sql
select conname, contype from pg_constraint
where connamespace = 'public'::regnamespace and contype = 'f';
```

Expected 5 foreign keys.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0001_initial_schema.sql package.json package-lock.json
git commit -m "feat(db): add initial Supabase Postgres schema"
```

---

## Task 2: SQL placeholder translation

`?` placeholders must become `$1`, `$2`. The tricky part is that `?` can legally appear inside a string literal, and blindly replacing those corrupts the query.

**Files:**
- Create: `src/sql-compat.js`
- Test: `test/sql-compat.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/sql-compat.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toPgPlaceholders } = require('../src/sql-compat');

test('numbers placeholders in order', () => {
  assert.strictEqual(
    toPgPlaceholders('SELECT * FROM customers WHERE phone = ? AND status = ?'),
    'SELECT * FROM customers WHERE phone = $1 AND status = $2'
  );
});

test('leaves SQL without placeholders untouched', () => {
  assert.strictEqual(toPgPlaceholders('SELECT 1'), 'SELECT 1');
});

test('does not rewrite a question mark inside a string literal', () => {
  assert.strictEqual(
    toPgPlaceholders("UPDATE calls SET notes = 'why?' WHERE id = ?"),
    "UPDATE calls SET notes = 'why?' WHERE id = $1"
  );
});

test('handles an escaped quote inside a literal', () => {
  assert.strictEqual(
    toPgPlaceholders("UPDATE calls SET notes = 'it''s ok?' WHERE id = ?"),
    "UPDATE calls SET notes = 'it''s ok?' WHERE id = $1"
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --test test/sql-compat.test.js
```

Expected: FAIL — `Cannot find module '../src/sql-compat'`.

- [ ] **Step 3: Write the implementation**

Create `src/sql-compat.js`:

```javascript
'use strict';

/**
 * Rewrites SQLite-style `?` placeholders into Postgres `$1, $2, ...`.
 * Question marks inside single-quoted string literals are left alone.
 */
function toPgPlaceholders(sql) {
  let out = '';
  let index = 0;
  let inLiteral = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (char === "'") {
      // '' inside a literal is an escaped quote, not a terminator.
      if (inLiteral && sql[i + 1] === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inLiteral = !inLiteral;
      out += char;
      continue;
    }

    if (char === '?' && !inLiteral) {
      index += 1;
      out += `$${index}`;
      continue;
    }

    out += char;
  }

  return out;
}

module.exports = { toPgPlaceholders };
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
node --test test/sql-compat.test.js
```

Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/sql-compat.js test/sql-compat.test.js
git commit -m "feat(db): translate SQLite placeholders to Postgres"
```

---

## Task 3: RETURNING id, so `result.lastID` keeps working

15 files read `result.lastID` after an INSERT. Postgres has no equivalent, so `dbRun` appends `RETURNING id`. `app_state` has no `id` column — it is keyed on `key` — so the append is driven by an explicit table allow-list rather than pattern matching.

**Files:**
- Modify: `src/sql-compat.js`
- Modify: `test/sql-compat.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/sql-compat.test.js`:

```javascript
const { withReturningId, ID_TABLES } = require('../src/sql-compat');

test('appends RETURNING id to an insert on an id-bearing table', () => {
  assert.strictEqual(
    withReturningId('INSERT INTO customers (name) VALUES ($1)'),
    'INSERT INTO customers (name) VALUES ($1) RETURNING id'
  );
});

test('leaves app_state alone because it has no id column', () => {
  const sql = 'INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
  assert.strictEqual(withReturningId(sql), sql);
});

test('leaves non-insert statements alone', () => {
  const sql = 'UPDATE calls SET outcome = $1 WHERE id = $2';
  assert.strictEqual(withReturningId(sql), sql);
});

test('does not double-append when RETURNING is already present', () => {
  const sql = 'INSERT INTO calls (customer_id) VALUES ($1) RETURNING id';
  assert.strictEqual(withReturningId(sql), sql);
});

test('id table list covers every table except app_state', () => {
  assert.ok(ID_TABLES.has('customers'));
  assert.ok(ID_TABLES.has('support_tickets'));
  assert.ok(!ID_TABLES.has('app_state'));
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
node --test test/sql-compat.test.js
```

Expected: FAIL — `withReturningId is not a function`.

- [ ] **Step 3: Implement**

Add to `src/sql-compat.js`, above `module.exports`:

```javascript
/** Tables with an `id` identity column. `app_state` is keyed on `key`. */
const ID_TABLES = new Set([
  'customers',
  'clients',
  'agents',
  'users',
  'campaign_configs',
  'calls',
  'feedback',
  'call_supervisor_events',
  'support_tickets'
]);

/**
 * Appends `RETURNING id` to INSERT statements so the pg result can populate
 * `lastID` the way sqlite3 did. Statements targeting a table without an `id`
 * column, and statements that already return something, are left untouched.
 */
function withReturningId(sql) {
  const match = /^\s*INSERT\s+INTO\s+"?([a-z_][a-z0-9_]*)"?/i.exec(sql);
  if (!match) return sql;
  if (!ID_TABLES.has(match[1].toLowerCase())) return sql;
  if (/\bRETURNING\b/i.test(sql)) return sql;
  return `${sql.replace(/;\s*$/, '')} RETURNING id`;
}
```

Update the export line:

```javascript
module.exports = { toPgPlaceholders, withReturningId, ID_TABLES };
```

- [ ] **Step 4: Run and confirm pass**

```bash
node --test test/sql-compat.test.js
```

Expected: `# pass 9`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/sql-compat.js test/sql-compat.test.js
git commit -m "feat(db): append RETURNING id so lastID survives the pg swap"
```

---

## Task 4: Rewrite `db.js` on `pg`

**Files:**
- Modify: `db.js` (full rewrite)
- Modify: `package.json`

- [ ] **Step 1: Install the driver and drop sqlite3**

```bash
npm uninstall sqlite3 && npm install pg
```

- [ ] **Step 2: Replace `db.js` entirely**

```javascript
require('dotenv').config();
const { Pool } = require('pg');
const { toPgPlaceholders, withReturningId } = require('./src/sql-compat');

/** Bump this when a migration is added. Checked against Supabase at boot. */
const EXPECTED_SCHEMA_VERSION = '0001';

let pool;

function getPool() {
  if (!pool) throw new Error('Database is not initialized. Call initializeDatabase() first.');
  return pool;
}

async function query(sql, params = []) {
  const text = withReturningId(toPgPlaceholders(sql));
  return getPool().query(text, params);
}

async function dbRun(sql, params = []) {
  const result = await query(sql, params);
  return {
    lastID: result.rows?.[0]?.id ?? null,
    changes: result.rowCount ?? 0
  };
}

async function dbGet(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0];
}

async function dbAll(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

/**
 * Runs `fn` inside a single transaction on one pooled client.
 *
 * A pool will hand consecutive dbRun('BEGIN') / dbRun('COMMIT') calls to
 * different connections, which silently stops them being one transaction.
 * Anything transactional must go through here.
 *
 * `fn` receives { run, get, all } bound to the checked-out client.
 */
async function dbTx(fn) {
  const client = await getPool().connect();
  const exec = async (sql, params = []) =>
    client.query(withReturningId(toPgPlaceholders(sql)), params);

  try {
    await client.query('BEGIN');
    const result = await fn({
      run: async (sql, params) => {
        const r = await exec(sql, params);
        return { lastID: r.rows?.[0]?.id ?? null, changes: r.rowCount ?? 0 };
      },
      get: async (sql, params) => (await exec(sql, params)).rows[0],
      all: async (sql, params) => (await exec(sql, params)).rows
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function assertSchemaVersion() {
  const row = await dbGet(
    `SELECT version FROM supabase_migrations.schema_migrations
      ORDER BY version DESC LIMIT 1`
  );
  const applied = row?.version || '(none)';
  if (!applied.startsWith(EXPECTED_SCHEMA_VERSION)) {
    throw new Error(
      `Schema version mismatch: database is at "${applied}", this code expects ` +
      `"${EXPECTED_SCHEMA_VERSION}". Run "npx supabase db push" before starting.`
    );
  }
}

async function initializeDatabase() {
  const connectionString = process.env.DATABASE_URL;
  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', (error) => {
    console.error('[DATABASE POOL ERROR]', error.message);
  });

  await pool.query('SELECT 1');
  const host = new URL(connectionString).host;
  console.log('Connected to Supabase Postgres:', host);

  await assertSchemaVersion();
  console.log(`✓ Schema version ${EXPECTED_SCHEMA_VERSION} verified`);
}

async function closeDatabase() {
  if (pool) await pool.end();
  pool = undefined;
}

module.exports = {
  initializeDatabase,
  closeDatabase,
  getPool,
  dbRun,
  dbGet,
  dbAll,
  dbTx,
  EXPECTED_SCHEMA_VERSION
};
```

Note what is gone: `runMigrations`, `addColumnIfMissing`, `fixCorruptedSchemas`, `copyLegacyCallIdsToProviderCallId`, `backupDatabase`, `startDatabaseBackupSchedule`, `getDb`, `getDatabasePath`, `pruneDatabaseBackups`.

- [ ] **Step 3: Find every caller of a removed export**

```bash
grep -rn "getDb\|backupDatabase\|startDatabaseBackupSchedule\|getDatabasePath" \
  src services routes scripts index.js test | grep -v node_modules
```

Delete each call site. `startDatabaseBackupSchedule` is invoked from `src/server.js` — remove that line and its import.

- [ ] **Step 4: Point the local env at the dev project**

In `.env`, replace the SQLite path:

```
DATABASE_URL=postgresql://postgres.<dev-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

- [ ] **Step 5: Boot and confirm the connection**

```bash
node index.js
```

Expected within the first three lines:

```
Connected to Supabase Postgres: aws-0-<region>.pooler.supabase.com:5432
✓ Schema version 0001 verified
```

Stop the server with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add db.js package.json package-lock.json src/server.js
git commit -m "feat(db): replace sqlite3 with pg against Supabase"
```

---

## Task 5: Fail fast on a stale `DATABASE_URL`

`DATABASE_URL` changes meaning from a file path to a connection string. A deploy still carrying `/app/data/feedback.db` must crash, not start.

**Files:**
- Modify: `src/config.js` (inside the `missing` checks, around line 154)
- Test: `test/config-database-url.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/config-database-url.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateDatabaseUrl } = require('../src/config');

test('accepts a postgres connection string', () => {
  assert.strictEqual(
    validateDatabaseUrl('postgresql://user:pw@host.pooler.supabase.com:5432/postgres'),
    null
  );
});

test('accepts the postgres:// scheme', () => {
  assert.strictEqual(validateDatabaseUrl('postgres://user:pw@host:5432/db'), null);
});

test('rejects a leftover SQLite file path', () => {
  const issue = validateDatabaseUrl('/app/data/feedback.db');
  assert.match(issue, /postgres/i);
});

test('rejects an empty value', () => {
  assert.match(validateDatabaseUrl(''), /required/i);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
node --test test/config-database-url.test.js
```

Expected: FAIL — `validateDatabaseUrl is not a function`.

- [ ] **Step 3: Implement**

Add to `src/config.js` above `module.exports`:

```javascript
/**
 * Returns null when the value is a usable Postgres connection string,
 * or a human-readable problem description otherwise.
 */
function validateDatabaseUrl(value) {
  const url = String(value || '').trim();
  if (!url) return 'DATABASE_URL is required (Supabase Postgres connection string)';
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return 'DATABASE_URL must be a postgres:// connection string. It now points at '
      + 'Supabase, not a SQLite file — a leftover path such as /app/data/feedback.db '
      + 'will not work.';
  }
  return null;
}
```

Inside the existing validation function, alongside the other `missing.push(...)` checks:

```javascript
  const databaseUrlIssue = validateDatabaseUrl(process.env.DATABASE_URL);
  if (databaseUrlIssue) {
    missing.push(databaseUrlIssue);
  }
```

Add `validateDatabaseUrl` to the `module.exports` object.

- [ ] **Step 4: Run and confirm pass**

```bash
node --test test/config-database-url.test.js
```

Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config-database-url.test.js
git commit -m "feat(config): reject a non-postgres DATABASE_URL at boot"
```

---

## Task 6: Replace the hardcoded accounts with a seed script

`db.js:247-261` upserted three accounts with committed bcrypt hashes on every boot, then ran `DELETE FROM users WHERE username IN ('admin','agent1')`. All of it went with the `db.js` rewrite. This restores account bootstrapping properly.

**Files:**
- Create: `scripts/seed-admin.js`
- Modify: `test/database-safety.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-admin.js`:

```javascript
require('dotenv').config();
const { initializeDatabase, dbGet, dbRun, closeDatabase } = require('../db');

async function seedAdmin() {
  await initializeDatabase();

  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const passwordHash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();

  if (!username || !passwordHash) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD_HASH must both be set');
  }
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
    throw new Error('ADMIN_PASSWORD_HASH must be a bcrypt hash');
  }

  const existing = await dbGet('SELECT COUNT(*) AS count FROM users');
  if (Number(existing.count) > 0) {
    console.log(`Users table already has ${existing.count} row(s); leaving it alone.`);
    return;
  }

  await dbRun(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
    [username, passwordHash, 'ADMIN']
  );
  console.log(`✓ Seeded admin "${username}"`);
}

seedAdmin()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error('[SEED ADMIN ERROR]', error.message);
    await closeDatabase();
    process.exit(1);
  });
```

Add to `package.json` scripts:

```json
"seed:admin": "node scripts/seed-admin.js"
```

- [ ] **Step 2: Run it against dev**

```bash
npm run seed:admin
```

Expected: `✓ Seeded admin "localadmin"`.

Run it a second time. Expected: `Users table already has 1 row(s); leaving it alone.` — the script must be idempotent and must never overwrite a password.

- [ ] **Step 3: Replace `test/database-safety.test.js`**

This test cannot be patched — it builds a temporary SQLite file and exercises
`runMigrations()` and `backupDatabase()`, both of which this migration deletes.
Its one surviving subject is the `calls.status` / `calls.outcome` sync, which is
now a database trigger and should be verified against the real database.

It is also the only test in the suite that touches a database at all; the other
fourteen are pure unit tests. That makes a dedicated `test` schema (as the spec
suggested) more machinery than this needs — the replacement cleans up its own
rows instead.

```bash
git rm test/database-safety.test.js
```

Create `test/schema-triggers.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const HAS_DB = /^postgres/i.test(String(process.env.DATABASE_URL || ''));

test('calls.status mirrors calls.outcome via trigger', { skip: !HAS_DB && 'DATABASE_URL not set' }, async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();

  const marker = `trigger-test-${Date.now()}`;
  const customer = await dbRun(
    'INSERT INTO customers (name, phone, status) VALUES (?, ?, ?)',
    [marker, marker, 'pending']
  );

  try {
    // Insert with an outcome and no status: the insert trigger fills status in.
    const created = await dbRun(
      'INSERT INTO calls (customer_id, outcome) VALUES (?, ?)',
      [customer.lastID, 'completed']
    );
    let call = await dbGet('SELECT status FROM calls WHERE id = ?', [created.lastID]);
    assert.equal(call.status, 'completed');

    // Changing outcome later must move status with it.
    await dbRun('UPDATE calls SET outcome = ? WHERE id = ?', ['no-answer', created.lastID]);
    call = await dbGet('SELECT status FROM calls WHERE id = ?', [created.lastID]);
    assert.equal(call.status, 'no-answer');
  } finally {
    // Cascade removes the call row with the customer.
    await dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);
    await closeDatabase();
  }
});

test('deleting a customer cascades to calls and feedback', { skip: !HAS_DB && 'DATABASE_URL not set' }, async () => {
  const { initializeDatabase, dbRun, dbGet, closeDatabase } = require('../db');
  await initializeDatabase();

  const marker = `cascade-test-${Date.now()}`;
  const customer = await dbRun(
    'INSERT INTO customers (name, phone, status) VALUES (?, ?, ?)',
    [marker, marker, 'pending']
  );
  const call = await dbRun(
    'INSERT INTO calls (customer_id, outcome) VALUES (?, ?)',
    [customer.lastID, 'completed']
  );
  await dbRun(
    'INSERT INTO feedback (customer_id, call_id, review_text, stars) VALUES (?, ?, ?, ?)',
    [customer.lastID, call.lastID, 'cascade check', 5]
  );

  await dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);

  const orphanCall = await dbGet('SELECT id FROM calls WHERE id = ?', [call.lastID]);
  const orphanFeedback = await dbGet('SELECT id FROM feedback WHERE customer_id = ?', [customer.lastID]);
  assert.equal(orphanCall, undefined);
  assert.equal(orphanFeedback, undefined);

  await closeDatabase();
});
```

The `skip` guard means `npm test` still passes in an environment without
`DATABASE_URL`, rather than failing confusingly.

- [ ] **Step 4: Run the full suite**

```bash
npm test
```

Expected: `# fail 0`. This is the first time the suite has been fully green — it
was 49 of 50 before this change, and the failure was caused by the hardcoded
accounts this task removed.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-admin.js test/schema-triggers.test.js package.json
git rm --cached test/database-safety.test.js 2>/dev/null || true
git commit -m "feat(auth): seed admin from env instead of hardcoded accounts"
```

---

## Task 7: Wire up `normalized_phone`

`findCustomerByPhone` loads the 200 newest customers and filters them in JavaScript, so a returning patient outside that window gets a duplicate record. The column to fix it already exists and has never been written.

**Files:**
- Modify: `src/call-management.js:180`
- Modify: `routes/customers.js` (the INSERT in the `POST /` handler)
- Modify: `src/call-management.js` (the INSERT in `ensureIncomingCustomerForCall`)
- Test: `test/customer-phone-lookup.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/customer-phone-lookup.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizePhoneLookupValue } = require('../src/helpers');

test('normalizes the formats the same customer arrives in', () => {
  const canonical = normalizePhoneLookupValue('+919354197715');
  assert.strictEqual(normalizePhoneLookupValue('919354197715'), canonical);
  assert.strictEqual(normalizePhoneLookupValue('09354197715'), canonical);
  assert.strictEqual(normalizePhoneLookupValue('+91 93541 97715'), canonical);
});

test('returns falsy for an unusable value', () => {
  assert.ok(!normalizePhoneLookupValue(''));
  assert.ok(!normalizePhoneLookupValue(null));
});
```

- [ ] **Step 2: Run it**

```bash
node --test test/customer-phone-lookup.test.js
```

If this passes immediately, `normalizePhoneLookupValue` already handles these cases and no change to `src/helpers.js` is needed — continue to step 3. If it fails, fix `normalizePhoneLookupValue` in `src/helpers.js:65` so all four formats collapse to one value, then re-run until green.

- [ ] **Step 3: Replace the scan with an indexed lookup**

In `src/call-management.js`, replace `findCustomerByPhone` (currently line 179-185):

```javascript
async function findCustomerByPhone(phoneValue) {
  const normalized = normalizePhoneLookupValue(phoneValue);
  if (!normalized) return null;

  return dbGet(
    'SELECT * FROM customers WHERE normalized_phone = ? LIMIT 1',
    [normalized]
  ) || null;
}
```

- [ ] **Step 4: Populate the column on every insert**

Every `INSERT INTO customers` must now set `normalized_phone`. Find them:

```bash
grep -rn "INSERT INTO customers" src services routes scripts | grep -v node_modules
```

For each, add the column and pass `normalizePhoneLookupValue(phone)` as its value. In `src/call-management.js`, `ensureIncomingCustomerForCall` becomes:

```javascript
  const result = await dbRun(
    `INSERT INTO customers (name, phone, normalized_phone, preferred_slot, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      fallbackName,
      normalizedPhone,
      normalizePhoneLookupValue(normalizedPhone),
      '10:00',
      'pending',
      new Date().toISOString()
    ]
  );
```

Apply the same addition in `routes/customers.js` for both the single-customer POST and the CSV import path.

- [ ] **Step 5: Verify the duplicate bug is gone**

```bash
node index.js
```

In a second terminal, log in and create a customer, then attempt to create a second one with the same number in a different format:

```bash
curl -s -c /tmp/ck -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"localadmin","password":"localdev123"}'

curl -s -b /tmp/ck -X POST localhost:3000/api/customers \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dup Test","phone":"+919354197715","scheduled_date":"2026-09-05","scheduled_time":"11:00"}'

curl -s -b /tmp/ck -X POST localhost:3000/api/customers \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dup Test 2","phone":"09354197715","scheduled_date":"2026-09-05","scheduled_time":"11:00"}'
```

Expected: the first returns an id; the second fails on the unique index rather than creating a second record. If the error surfaces as a raw 500, add a friendly duplicate message to the route's catch block.

- [ ] **Step 6: Commit**

```bash
git add src/call-management.js routes/customers.js test/customer-phone-lookup.test.js src/helpers.js
git commit -m "fix(customers): resolve repeat callers by indexed normalized_phone"
```

---

## Task 8: Make the support-ticket insert transactional again

`routes/support-tickets.js` inserts a row with a `PENDING-<uuid>` placeholder, then updates it to the real ticket ID. Under a pool the loose `BEGIN` / `COMMIT` land on different connections, so a failure between the two statements would leave a `PENDING-` ticket committed.

**Files:**
- Modify: `routes/support-tickets.js:9-26`

- [ ] **Step 1: Convert the handler to `dbTx`**

Replace the `router.post('/')` body:

```javascript
  router.post('/', async (req, res, next) => {
    try {
      const payload = validateSubmission(req.body);
      const session = req.adminSession;
      const now = new Date().toISOString();

      const ticket = await dbTx(async (tx) => {
        const insert = await tx.run(
          `INSERT INTO support_tickets (ticket_id,type,description,status,reporter_username,reporter_role,page_url,page_title,context_json,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [`PENDING-${crypto.randomUUID()}`, payload.type, payload.description, TICKET_STATUS.NEW,
           session.username, session.role, payload.context.pageUrl, payload.context.pageTitle,
           JSON.stringify(payload.context), now, now]
        );
        const ticketId = createTicketId(payload.type, insert.lastID + 1000);
        await tx.run('UPDATE support_tickets SET ticket_id = ? WHERE id = ?', [ticketId, insert.lastID]);
        return tx.get(`${select} WHERE ticket_id = ?`, [ticketId]);
      });

      const admin_url = `${payload.context.pageUrl.replace(/\/[^/]*$/, '')}/support-tickets.html?ticket=${encodeURIComponent(ticket.ticket_id)}`;
      notifyNewTicket({ ...ticket, admin_url }).catch(() => {});
      res.status(201).json({ ticket });
    } catch (error) { next(error); }
  });
```

Add `dbTx` to the router factory's destructured parameters, and pass it in from `src/api-routes.js:156` where the router is constructed:

```javascript
app.use('/api/support-tickets', createSupportTicketsRouter({
  dbRun, dbGet, dbAll, dbTx,
  notifyNewTicket: createSlackSupportNotifier({ webhookUrl: process.env.SLACK_SUPPORT_WEBHOOK_URL })
}));
```

Import `dbTx` alongside the other db helpers at the top of `src/api-routes.js`.

- [ ] **Step 2: Verify end to end**

Boot the server, log in, and submit a ticket through the support widget on any admin page. Then confirm no placeholder IDs exist:

```bash
curl -s -b /tmp/ck localhost:3000/api/support-tickets | grep -c 'PENDING-'
```

Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add routes/support-tickets.js src/api-routes.js
git commit -m "fix(support): make ticket creation atomic under connection pooling"
```

---

## Task 9: Full smoke pass

The 260 query sites were never individually tested. This exercises the ones that matter.

**Files:** none modified — this is verification.

- [ ] **Step 1: Boot cleanly**

```bash
npm test && node index.js
```

Expected: all tests pass, then the Supabase connection and schema-version lines, then `[SERVER] Running on port 3000`. No `[SERVER ERROR]` lines.

- [ ] **Step 2: Walk every admin page in a browser**

Log in at `http://localhost:3000/login.html`, then visit and confirm each renders without a console error and without an empty-state that should have data:

- `/admin.html` — the four count tiles and the patient directory
- `/customers.html` — outbound queue
- `/feedback.html` — feedback list and the analytics charts
- `/support-tickets.html` — ticket list

- [ ] **Step 3: Exercise the write paths**

```bash
curl -s -b /tmp/ck -X POST localhost:3000/api/customers \
  -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Test","phone":"+919000000123","scheduled_date":"2026-09-10","scheduled_time":"11:00"}'

curl -s -b /tmp/ck -X POST localhost:3000/api/feedback/manual \
  -H 'Content-Type: application/json' \
  -d '{"customer_id":<id from above>,"review_text":"Sample collection was on time.","stars":5}'

curl -s -b /tmp/ck localhost:3000/api/feedback/overview
```

Expected: the customer POST returns an id (proving `RETURNING id` works), the feedback POST returns a category, and the overview reflects both.

- [ ] **Step 4: Confirm cascade deletes work**

Foreign keys are enforced now, unlike in SQLite. Delete the smoke-test customer and verify its feedback went with it:

```bash
curl -s -b /tmp/ck -X DELETE localhost:3000/api/customers/<id>
curl -s -b /tmp/ck localhost:3000/api/feedback/overview
```

Expected: the feedback row is gone. If the route's manual delete-in-order logic now conflicts with the cascade, simplify it to a single `DELETE FROM customers WHERE id = ?`.

- [ ] **Step 5: Verify the indexes are actually used**

In the Supabase SQL editor:

```sql
explain analyze select * from customers where normalized_phone = '919354197715';
explain analyze select * from calls where customer_id = 1;
```

Expected: `Index Scan` in both plans, not `Seq Scan`.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(db): smoke-pass corrections after the Postgres migration"
```

---

## Task 10: Point production at the prod project

**Files:**
- Modify: `.env.production.example`
- Modify: `.env.example`

- [ ] **Step 1: Update both example env files**

In `.env.example` and `.env.production.example`, replace the SQLite database block:

```
# Supabase Postgres — session-mode pooler (port 5432), NOT the direct host
# and NOT transaction mode on 6543.
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Delete these, which no longer do anything:

```
DATABASE_BACKUP_ENABLED
DATABASE_BACKUP_DIR
DATABASE_BACKUP_RETENTION
DATABASE_BACKUP_INTERVAL_MS
POSTGRES_URL
REDIS_URL
```

`POSTGRES_URL` and `REDIS_URL` were never read by any code; removing them stops them implying infrastructure that does not exist.

- [ ] **Step 2: Apply the migration to the prod project**

```bash
npx supabase link --project-ref <prod-project-ref>
npx supabase db push
npx supabase link --project-ref <dev-project-ref>
```

The third command relinks to dev so local work does not accidentally target production.

- [ ] **Step 3: Seed the production admin**

Set `DATABASE_URL`, `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` for prod, then:

```bash
npm run seed:admin
```

Generate the hash first if needed:

```bash
node -e "require('bcrypt').hash(process.argv[1], 12).then(console.log)" -- 'your-password'
```

The three previously hardcoded accounts — `admin@vikitechsolutions.in`, `agent1@vikitechsolutions.in`, `PRASHANTGUPTA74@YAHOO.CO.UK` — no longer exist. Recreate any that are still needed by inserting them with fresh hashes.

- [ ] **Step 4: Archive the old database**

```bash
mv feedback.db feedback.db.archived-$(date +%Y%m%d)
```

Confirm the app still boots — it should, since nothing reads that file any more.

- [ ] **Step 5: Commit**

```bash
git add .env.example .env.production.example
git commit -m "chore(env): document Supabase connection, drop dead backup vars"
```

---

## Definition of done

- `npm test` passes with zero failures
- The app boots against Supabase and every admin page renders with real data
- A customer created twice with differently formatted versions of the same phone number produces one record, not two
- Deleting a customer cascades to their calls and feedback
- `explain analyze` shows index scans on `normalized_phone` and `calls.customer_id`
- No `PENDING-` prefixed support ticket IDs can be committed
- Both Supabase projects are at schema version `0001`
- `feedback.db` is archived and unreferenced

## Not in this plan

- Call recordings still write to the local filesystem — **plan 2**
- The audit log still writes to `logs/system.log` — **plan 3**
- Persistent volumes stay in `docker-compose.yml`, `docker-compose.prod.yml` and `k8s/pvc.yaml` until plan 3, because the two stores above still need them
- In-process session state still pins the deployment to `replicas: 1`
