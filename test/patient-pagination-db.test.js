'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

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
    req.adminSession = { username: 'patient-pagination-test', role: 'ADMIN' };
    next();
  });
  app.use('/api/patients', require('../routes/patients'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.closeDatabase();
});

test('patient pagination traverses filtered pages and preserves the legacy response', async () => {
  const marker = randomUUID().replaceAll('-', '').slice(0, 12);
  const ids = [];
  try {
    for (const firstName of ['A', 'B', 'C']) {
      const row = await db.dbRun(
        'INSERT INTO patients (first_name, phone, normalized_phone, status) VALUES (?, ?, ?, ?)',
        [`zzpage-${firstName}-${marker}`, `000${marker}${firstName}`, `000${marker}${firstName}`, 'active']
      );
      ids.push(row.lastID);
    }

    const first = await get('/api/patients?page_size=2&status=active&search=zzpage-');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.patients.length, 2);
    assert.equal(first.body.hasMore, true);
    assert.ok(first.body.nextCursor);

    const second = await get(`/api/patients?page_size=2&status=active&search=zzpage-&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.patients.length, 1);
    assert.equal(second.body.hasMore, false);
    assert.equal(second.body.nextCursor, null);

    const returned = [...first.body.patients, ...second.body.patients].map((row) => Number(row.id));
    assert.deepEqual(new Set(returned), new Set(ids));
    assert.equal(returned.length, ids.length);

    const legacy = await get('/api/patients?search=zzpage-');
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.ok(Array.isArray(legacy.body.patients));
    assert.equal(legacy.body.patients.length, ids.length);

    assert.equal((await get('/api/patients?page_size=101')).status, 400);
    assert.equal((await get('/api/patients?page_size=2&cursor=broken')).status, 400);
  } finally {
    await db.dbRun('DELETE FROM patients WHERE id = ANY(?)', [ids]);
  }
});
