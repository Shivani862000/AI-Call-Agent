'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { withTestPatient } = require('./support/fixtures');

let server;
let baseUrl;
let db;

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  db = require('../db');
  await db.initializeDatabase();
  const app = express();
  app.use((req, res, next) => {
    req.adminSession = { username: 'pagination-test', role: 'ADMIN' };
    next();
  });
  app.use('/api/customers', require('../routes/customers'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.closeDatabase();
});

test('customer pagination traverses a complete stable set and preserves the legacy response', async () => {
  await withTestPatient(async ({ patientId }) => {
    const priorities = [100, 100, 90, 80, 70];
    const ids = [];
    for (const priority of priorities) {
      const row = await db.dbRun(
        'INSERT INTO customers (patient_id, status, priority_score) VALUES (?, ?, ?)',
        [patientId, 'pending', priority]
      );
      ids.push(row.lastID);
    }

    const filter = `patient_id=${patientId}`;
    const first = await get(`/api/customers?page_size=2&${filter}`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.hasMore, true);
    assert.ok(first.body.nextCursor);

    const second = await get(`/api/customers?page_size=2&${filter}&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.items.length, 2);
    assert.equal(second.body.hasMore, true);
    assert.ok(second.body.nextCursor);

    const third = await get(`/api/customers?page_size=2&${filter}&cursor=${encodeURIComponent(second.body.nextCursor)}`);
    assert.equal(third.status, 200, JSON.stringify(third.body));
    assert.equal(third.body.items.length, 1);
    assert.equal(third.body.hasMore, false);
    assert.equal(third.body.nextCursor, null);

    const returned = [
      ...first.body.items,
      ...second.body.items,
      ...third.body.items
    ].map((row) => Number(row.id));
    assert.deepEqual(new Set(returned), new Set(ids));
    assert.equal(returned.length, ids.length);

    const legacy = await get('/api/customers');
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.ok(Array.isArray(legacy.body));
    const legacyIds = new Set(legacy.body.map((row) => Number(row.id)));
    assert.ok(ids.every((id) => legacyIds.has(id)));
    assert.ok(legacy.body.length >= ids.length);

    const badCursor = await get('/api/customers?page_size=2&cursor=broken');
    assert.equal(badCursor.status, 400);
    const tooLarge = await get('/api/customers?page_size=101');
    assert.equal(tooLarge.status, 400);
    const badPatient = await get('/api/customers?page_size=2&patient_id=nope');
    assert.equal(badPatient.status, 400);
  });
});
