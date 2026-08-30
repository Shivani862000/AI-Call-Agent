'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLogSink } = require('../services/log-sink');

test('push returns immediately without awaiting a write', () => {
  const sink = createLogSink({ write: async () => { throw new Error('should not be awaited'); } });
  sink.push({ level: 'INFO', event: 'X', details: {} });
  assert.strictEqual(sink.pending(), 1);
  sink.stop();
});

test('flushes as one batch', async () => {
  const batches = [];
  const sink = createLogSink({ write: async (rows) => { batches.push(rows.length); } });
  for (let i = 0; i < 3; i += 1) sink.push({ level: 'INFO', event: `E${i}`, details: {} });
  await sink.flush();
  assert.deepStrictEqual(batches, [3]);
  assert.strictEqual(sink.pending(), 0);
  sink.stop();
});

test('flushes automatically once the batch size is reached', async () => {
  const batches = [];
  const sink = createLogSink({ maxBatch: 2, write: async (rows) => { batches.push(rows.length); } });
  sink.push({ level: 'INFO', event: 'A', details: {} });
  sink.push({ level: 'INFO', event: 'B', details: {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(batches, [2]);
  sink.stop();
});

test('drops the oldest rows rather than growing without bound', () => {
  const sink = createLogSink({ maxBuffer: 3, maxBatch: 999, write: async () => {} });
  for (let i = 0; i < 5; i += 1) sink.push({ level: 'INFO', event: `E${i}`, details: {} });
  assert.strictEqual(sink.pending(), 3);
  assert.strictEqual(sink.dropped(), 2);
  sink.stop();
});

test('a failing write never rejects into the caller', async () => {
  const sink = createLogSink({ write: async () => { throw new Error('supabase down'); } });
  sink.push({ level: 'ERROR', event: 'X', details: {} });
  await sink.flush();
  assert.strictEqual(sink.pending(), 0);
  sink.stop();
});

test('stamps each row at push time, not at flush time', async () => {
  let seen = [];
  const sink = createLogSink({ write: async (rows) => { seen = rows; } });
  sink.push({ level: 'INFO', event: 'FIRST', details: {} });
  await new Promise((r) => setTimeout(r, 12));
  sink.push({ level: 'INFO', event: 'SECOND', details: {} });
  await sink.flush();
  assert.strictEqual(seen.length, 2);
  assert.ok(seen[0].ts instanceof Date && seen[1].ts instanceof Date);
  assert.ok(seen[1].ts.getTime() > seen[0].ts.getTime(), 'timestamps must differ within a batch');
  sink.stop();
});
