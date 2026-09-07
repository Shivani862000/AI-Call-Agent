'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_RETENTION_YEARS, CONTENT_COLUMNS, retentionYears,
  cutoffDate, isDueForPurge, buildPurgeStatement
} = require('../src/retention');

// This file is mostly pure assertions about the SQL, but one test reads the
// live schema. CI has no database, so it guards the same way every other
// database-backed test does rather than failing the run.
require('dotenv').config();
const { resolveDatabaseUrl } = require('../src/config');
const HAS_DB = /^postgres/i.test(resolveDatabaseUrl());

const on = { enabled: true, years: 10 };
const now = new Date('2026-09-06T00:00:00Z');

test('the default is ten years', () => {
  assert.equal(DEFAULT_RETENTION_YEARS, 10);
  assert.equal(retentionYears(undefined), 10);
  assert.equal(retentionYears({ years: 0 }), 10);
  assert.equal(retentionYears({ years: -3 }), 10);
  assert.equal(retentionYears({ years: 'nonsense' }), 10);
  assert.equal(retentionYears({ years: 7 }), 7);
});

test('the cutoff is the retention period before now', () => {
  assert.equal(cutoffDate(on, now).toISOString().slice(0, 10), '2016-09-06');
  assert.equal(cutoffDate({ years: 1 }, now).toISOString().slice(0, 10), '2025-09-06');
});

test('only calls past the period are purged', () => {
  assert.equal(isDueForPurge({ called_at: '2016-09-05T23:59:00Z' }, on, now), true);
  assert.equal(isDueForPurge({ called_at: '2016-09-06T00:00:01Z' }, on, now), false);
  assert.equal(isDueForPurge({ called_at: '2026-09-01' }, on, now), false);
});

// Destroying data is irreversible, so an unknown age is never treated as old.
test('a call with no usable date is kept', () => {
  assert.equal(isDueForPurge({}, on, now), false);
  assert.equal(isDueForPurge({ called_at: null }, on, now), false);
  assert.equal(isDueForPurge({ called_at: 'not a date' }, on, now), false);
});

test('nothing is purged while the policy is switched off', () => {
  assert.equal(isDueForPurge({ called_at: '1999-01-01' }, { enabled: false, years: 10 }, now), false);
  assert.equal(isDueForPurge({ called_at: '1999-01-01' }, undefined, now), false);
});

test('the fallback dates use whatever timestamp the call has', () => {
  assert.equal(isDueForPurge({ ended_at: '2015-01-01' }, on, now), true);
  assert.equal(isDueForPurge({ created_at: '2015-01-01' }, on, now), true);
});

test('the purge empties the content and marks the recording gone', () => {
  const { sql, params } = buildPurgeStatement(42);
  assert.deepEqual(params, [42]);
  assert.match(sql, /recording_status = 'purged'/);
  assert.match(sql, /recording_object_key = NULL/);
  for (const column of CONTENT_COLUMNS) {
    assert.match(sql, new RegExp(`\\b${column} = NULL`), `${column} is not cleared`);
  }
});

// A column named here that does not exist would make the purge fail years from
// now, which is the worst possible time to discover a typo.
test('every column the purge clears exists on calls', { skip: !HAS_DB && 'no Supabase connection configured' }, async () => {
  const { dbAll, initializeDatabase, closeDatabase } = require('../db');
  await initializeDatabase();
  try {
    const rows = await dbAll(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'calls'`
    );
    const actual = new Set(rows.map((row) => row.column_name));
    for (const column of CONTENT_COLUMNS) {
      assert.ok(actual.has(column), `calls has no column named ${column}`);
    }
  } finally {
    await closeDatabase?.();
  }
});

// The row survives so the centre keeps its record that a call happened; what
// was said does not.
test('the purge does not touch the facts of the call', () => {
  const { sql } = buildPurgeStatement(1);
  for (const kept of ['called_at', 'outcome', 'customer_id', 'call_duration', 'sentiment_label']) {
    assert.doesNotMatch(sql, new RegExp(`\\b${kept} = NULL`), `${kept} should be kept`);
  }
});
