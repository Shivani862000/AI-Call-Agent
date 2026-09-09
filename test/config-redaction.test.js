'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

function load(relative, dependencies, env = {}, messages = []) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, relative), 'utf8'), {
    module, URL, process: { env },
    console: { log: (...args) => messages.push(args.join(' ')), error: (...args) => messages.push(args.join(' ')) },
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected test import: ${name}`);
      return dependencies[name];
    }
  }, { filename: relative });
  return module.exports;
}

test('configuration snapshots reveal database presence/source without credentials', () => {
  for (const password of ['pw', 'encoded%40pass%3Aword', 'long-synthetic-password-123456789']) {
    const url = `postgresql://synthetic:${password}@database.invalid/app?token=secret-query-token`;
    for (const env of [{ DATABASE_URL: url }, { NODE_ENV: 'production', SUPABASE_URL: url }, { SUPABASE_URL_DEV: url }]) {
      const messages = [];
      const config = load('src/config.js', {}, env, messages);
      config.logConfigSnapshot('TEST');
      const output = messages.join('\n');
      assert.ok(!output.includes(url), 'full connection URL was logged');
      assert.ok(!output.includes(password), 'password was logged');
      assert.ok(!output.includes('secret-query-token'), 'query credential was logged');
      const snapshot = JSON.parse(output.slice(output.indexOf('{')));
      assert.equal(snapshot.DATABASE_URL_PRESENT, true);
      assert.ok(['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_URL_DEV'].includes(snapshot.DATABASE_URL_SOURCE));
    }
  }
});

async function databaseFixture(failure) {
  const messages = [];
  let poolError;
  const url = 'postgresql://synthetic:secret-password@database.invalid/app?token=secret-query-token';
  const dependencies = {
    dotenv: { config() {} },
    pg: {
      types: { builtins: {}, setTypeParser() {} },
      Pool: class {
        on(event, handler) { assert.equal(event, 'error'); poolError = handler; }
        async query(sql) {
          if (failure) throw failure;
          return { rows: sql.includes('schema_migrations') ? [{ version: '0026' }] : [] };
        }
        async end() {}
      }
    },
    './src/config': { resolveDatabaseUrl: () => url },
    './src/sql-compat': require('../src/sql-compat'),
    './src/database-error': load('src/database-error.js', {})
  };
  const db = load('db.js', dependencies, {}, messages);
  return { db, messages, poolError: error => poolError(error) };
}

test('database startup failure exposes a useful safe diagnostic without driver secrets', async () => {
  const error = Object.assign(new Error('connection secret-password secret-query-token rejected'), { code: '28P01' });
  const fixture = await databaseFixture(error);
  await assert.rejects(fixture.db.initializeDatabase(), error => {
    assert.match(error.message, /authentication/i);
    assert.doesNotMatch(error.message, /secret-password|secret-query-token/);
    assert.equal(error.cause, undefined);
    return true;
  });
  await fixture.db.closeDatabase();
});

test('idle pool errors omit raw error messages while healthy initialization still works', async () => {
  const fixture = await databaseFixture();
  await fixture.db.initializeDatabase();
  fixture.poolError(Object.assign(new Error('secret-password secret-query-token'), { code: 'ECONNRESET' }));
  fixture.poolError(Object.assign(new Error('secret-password'), { code: 'secret-query-token' }));
  const output = fixture.messages.join('\n');
  assert.doesNotMatch(output, /secret-password|secret-query-token/);
  assert.match(output, /0026/);
  assert.match(output, /connection reset/i);
  await fixture.db.closeDatabase();
});
