'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertOwnedTestDatabase } = require('./support/database');

function identityEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-identity-unit-'));
  const file = path.join(dir, 'identity.json');
  const identity = {
    runId: 'owned-run', connectionString: 'postgres://owned:secret@127.0.0.1:25432/owned_db',
    host: '127.0.0.1', port: 25432, database: 'owned_db', user: 'owned'
  };
  fs.writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
  return { dir, env: { NODE_ENV: 'test', DATABASE_URL: identity.connectionString,
    AI_CALL_AGENT_TEST_RUN_ID: identity.runId, AI_CALL_AGENT_TEST_DB_IDENTITY: file, ...overrides } };
}

test('missing, remote, alias, and mismatched identities fail closed', () => {
  assert.throws(() => assertOwnedTestDatabase(undefined, { NODE_ENV: 'test' }), /IDENTITY|identity/);
  for (const databaseUrl of [
    'postgres://owned:secret@db:5432/owned_db',
    'postgres://owned:secret@example.com:5432/owned_db',
    'postgres://other:secret@127.0.0.1:25432/owned_db'
  ]) {
    const owned = identityEnv({ DATABASE_URL: databaseUrl });
    try { assert.throws(() => assertOwnedTestDatabase(databaseUrl, owned.env), /Unsafe/); }
    finally { fs.rmSync(owned.dir, { recursive: true, force: true }); }
  }
});

test('db and migration rejection construct zero clients', () => {
  const program = `
    const pg = require('pg'); let pools = 0; let clients = 0;
    pg.Pool = class { constructor() { pools++; } };
    pg.Client = class { constructor() { clients++; } };
    const db = require('./db'); const { runMigrations } = require('./scripts/migrate');
    Promise.allSettled([
      db.initializeDatabase(),
      runMigrations({ connectionString: process.env.DATABASE_URL, migrationsDir: '.', expectedVersion: '0019',
        validateConnection: require('./test/support/database').assertOwnedTestDatabase })
    ]).then(() => process.stdout.write(JSON.stringify({ pools, clients })));
  `;
  const result = spawnSync(process.execPath, ['-e', program], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: 'postgres://x:x@example.com/x' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { pools: 0, clients: 0 });
});

test('an exact private runner identity is accepted', () => {
  const owned = identityEnv();
  try { assert.equal(assertOwnedTestDatabase(owned.env.DATABASE_URL, owned.env).runId, 'owned-run'); }
  finally { fs.rmSync(owned.dir, { recursive: true, force: true }); }
});
