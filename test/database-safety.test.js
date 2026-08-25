'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('MongoDB adapter rejects deprecated SQLite mutation and backup APIs', async () => {
  const { dbRun, dbGet, dbAll, backupDatabase, getDb } = require('../db');
  for (const operation of [
    () => dbRun('UPDATE records SET status = ?', ['active']),
    () => dbGet('SELECT * FROM records'),
    () => dbAll('SELECT * FROM records'),
    () => backupDatabase()
  ]) {
    await assert.rejects(operation, /deprecated|not supported/i);
  }
  const connection = getDb();
  assert.equal(typeof connection.model, 'function');
  assert.equal(typeof connection.readyState, 'number');
});

test('database adapter is configured for MongoDB and does not import SQLite', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../db.js'), 'utf8');
  assert.match(source, /mongoose\.connect/);
  assert.doesNotMatch(source, /require\(['"]sqlite/);
});
