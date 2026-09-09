'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertOwnedTestDatabase } = require('./support/database');
const { minimalEnvironment, stageAllowedSource } = require('../scripts/test-isolated');

function identityEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-identity-unit-'));
  const file = path.join(dir, 'identity.json');
  const identity = {
    runId: 'owned-run', purpose: 'application', connectionString: 'postgres://owned:secret@127.0.0.1:25432/owned_db',
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

test('omitted migration validator and test CLI still reject before Client construction', () => {
  const owned = identityEnv();
  const identityPath = owned.env.AI_CALL_AGENT_TEST_DB_IDENTITY;
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  identity.purpose = 'migration-owner';
  fs.writeFileSync(identityPath, JSON.stringify(identity), { mode: 0o600 });
  const program = `
    const pg = require('pg'); let clients = 0;
    pg.Client = class { constructor() { clients++; } };
    require('./scripts/migrate').runMigrations({
      connectionString: 'postgres://other:secret@127.0.0.1:25432/other_db',
      migrationsDir: '.', expectedVersion: '0019'
    }).catch(() => process.stdout.write(String(clients)));
  `;
  try {
    const direct = spawnSync(process.execPath, ['-e', program], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { PATH: process.env.PATH, ...owned.env }
    });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout, '0');
    const cli = spawnSync(process.execPath, ['scripts/migrate.js'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_ENV: 'test' }
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Unsafe test database configuration|is not set/);
  } finally { fs.rmSync(owned.dir, { recursive: true, force: true }); }
});

test('an exact private runner identity is accepted', () => {
  const owned = identityEnv();
  try { assert.equal(assertOwnedTestDatabase(owned.env.DATABASE_URL, owned.env).runId, 'owned-run'); }
  finally { fs.rmSync(owned.dir, { recursive: true, force: true }); }
});

test('sanitized staging rejects nested secrets, archives, and symlink escapes', () => {
  for (const sentinel of [
    '.env.local', 'synthetic-service-account.json', 'SYNTHETIC_SERVICE_ACCOUNT.JSON',
    'client_secret-demo.json', 'CLIENT-SECRET-demo.JSON', 'gmail-key.json',
    'GMAIL_KEY.JSON', 'fixture.backup', 'feedback.db.archived-20260830',
    'FEEDBACK.DB.ARCHIVE_20260830'
  ]) {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-source-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-target-'));
    try {
      fs.mkdirSync(path.join(source, 'safe'));
      fs.writeFileSync(path.join(source, 'safe', 'module.js'), 'module.exports = true;');
      fs.writeFileSync(path.join(source, 'safe', sentinel), 'synthetic sentinel');
      assert.throws(() => stageAllowedSource(source, target, [], ['safe']), /staging rejects/);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-source-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-target-'));
  try {
    fs.mkdirSync(path.join(source, 'safe'));
    fs.symlinkSync(os.tmpdir(), path.join(source, 'safe', 'escape'));
    assert.throws(() => stageAllowedSource(source, target, [], ['safe']), /symlink/);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('synthetic startup environment disables the implemented background work', () => {
  const env = minimalEnvironment();
  assert.equal(env.DISABLE_SCHEDULER, 'true');
  assert.equal(env.DISABLE_OWNER_DIGEST, 'true');
  assert.equal(env.DISABLE_INBOUND_CALLS, 'true');
  assert.equal(env.DISABLE_DIGEST, undefined);
  assert.equal(env.DISABLE_OUTBOUND_CALLS, undefined);
});
