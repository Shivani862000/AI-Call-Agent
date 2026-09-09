'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

let server;
let baseUrl;
let db;

async function request(method, path, body) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  db = require('../db');
  await db.initializeDatabase();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.adminSession = { username: 'route-admin', role: 'ADMIN' }; next(); });
  app.use('/api/customers', require('../routes/customers'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.closeDatabase();
});

test('equivalent schedule instants and unrelated edits preserve queue workflow', async () => {
  const marker = randomUUID();
  const phone = `000${marker.replace(/\D/g, '').padEnd(7, '0').slice(0, 7)}`;
  const patient = await db.dbRun(
    'INSERT INTO patients (first_name, phone, normalized_phone) VALUES (?, ?, ?)',
    [`zztest-${marker}`, phone, phone]
  );
  const scheduled = new Date(Date.now() + 4 * 86400000);
  scheduled.setUTCHours(5, 30, 0, 0);
  const customer = await db.dbRun(
    `INSERT INTO customers (patient_id, scheduled_datetime, status, next_retry_at, attempt_count,
      is_manual, locked_at, customer_value, urgency_level, call_type)
     VALUES (?, ?, 'retry_scheduled', ?, 4, 0, now(), 'standard', 'normal', 'REVIEW_CALL')`,
    [patient.lastID, scheduled.toISOString(), scheduled.toISOString()]
  );
  try {
    const date = scheduled.toISOString().slice(0, 10);
    const response = await request('PUT', `/api/customers/${customer.lastID}`, {
      name: `zztest-${marker}`, patient_id: patient.lastID,
      scheduled_date: date, preferred_slot: '11:00',
      scheduled_datetime: `${date}T11:00:00+05:30`,
      customer_value: 'high', urgency_level: 'normal', call_type: 'REVIEW_CALL'
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = await db.dbGet(
      'SELECT status, next_retry_at, attempt_count, is_manual, locked_at FROM customers WHERE id = ?',
      [customer.lastID]
    );
    assert.equal(row.status, 'retry_scheduled');
    assert.equal(new Date(row.next_retry_at).getTime(), scheduled.getTime());
    assert.equal(row.attempt_count, 4);
    assert.equal(row.is_manual, 0);
    assert.ok(row.locked_at);
  } finally {
    await db.dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);
    await db.dbRun('DELETE FROM patients WHERE id = ?', [patient.lastID]);
  }
});

test('a changed future instant reschedules while invalid and past inputs write nothing', async () => {
  const marker = randomUUID();
  const phone = `001${marker.replace(/\D/g, '').padEnd(7, '0').slice(0, 7)}`;
  const patient = await db.dbRun(
    'INSERT INTO patients (first_name, phone, normalized_phone) VALUES (?, ?, ?)',
    [`zztest-${marker}`, phone, phone]
  );
  const initial = new Date(Date.now() + 4 * 86400000);
  initial.setUTCHours(7, 0, 0, 0);
  const customer = await db.dbRun(
    `INSERT INTO customers (patient_id, scheduled_datetime, status, next_retry_at, attempt_count,
      is_manual, locked_at, customer_value, urgency_level, call_type)
     VALUES (?, ?, 'callback_scheduled', ?, 3, 0, now(), 'standard', 'normal', 'REVIEW_CALL')`,
    [patient.lastID, initial.toISOString(), initial.toISOString()]
  );
  const base = {
    name: `zztest-${marker}`, patient_id: patient.lastID,
    customer_value: 'standard', urgency_level: 'normal', call_type: 'REVIEW_CALL'
  };
  try {
    const invalid = await request('PUT', `/api/customers/${customer.lastID}`, {
      ...base, scheduled_date: '2099-01-01', preferred_slot: '10:00', scheduled_datetime: 'not-a-time'
    });
    assert.equal(invalid.status, 400);
    let row = await db.dbGet('SELECT status, scheduled_datetime, attempt_count FROM customers WHERE id = ?', [customer.lastID]);
    assert.equal(row.status, 'callback_scheduled');
    assert.equal(new Date(row.scheduled_datetime).getTime(), initial.getTime());
    assert.equal(row.attempt_count, 3);

    const past = await request('PUT', `/api/customers/${customer.lastID}`, {
      ...base, scheduled_date: '2020-01-01', preferred_slot: '10:00'
    });
    assert.equal(past.status, 400);

    const future = new Date(Date.now() + 6 * 86400000);
    const futureDate = future.toISOString().slice(0, 10);
    const changed = await request('PUT', `/api/customers/${customer.lastID}`, {
      ...base, scheduled_date: futureDate, preferred_slot: '12:00'
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    row = await db.dbGet(
      'SELECT status, scheduled_datetime, next_retry_at, attempt_count, is_manual, locked_at FROM customers WHERE id = ?',
      [customer.lastID]
    );
    assert.equal(row.status, 'scheduled');
    assert.equal(row.attempt_count, 0);
    assert.equal(row.is_manual, 1);
    assert.equal(row.locked_at, null);
    assert.equal(new Date(row.next_retry_at).getTime(), new Date(row.scheduled_datetime).getTime());
  } finally {
    await db.dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);
    await db.dbRun('DELETE FROM patients WHERE id = ?', [patient.lastID]);
  }
});

test('the canonical persisted instant controls component, past, calendar and calling-hour validation', async () => {
  const marker = randomUUID();
  const phone = `004${marker.replace(/\D/g, '').padEnd(7, '0').slice(0, 7)}`;
  const patient = await db.dbRun(
    'INSERT INTO patients (first_name, phone, normalized_phone) VALUES (?, ?, ?)',
    [`zztest-${marker}`, phone, phone]
  );
  const initial = '2099-01-05T06:30:00.000Z';
  const customer = await db.dbRun(
    `INSERT INTO customers (patient_id, scheduled_datetime, status, next_retry_at, attempt_count,
      is_manual, locked_at, customer_value, urgency_level, call_type)
     VALUES (?, ?, 'retry_scheduled', ?, 6, 0, now(), 'standard', 'normal', 'REVIEW_CALL')`,
    [patient.lastID, initial, initial]
  );
  const selectState = () => db.dbGet(
    `SELECT scheduled_datetime, status, next_retry_at, attempt_count, is_manual, locked_at,
            customer_value, urgency_level, call_type
       FROM customers WHERE id = ?`, [customer.lastID]
  );
  const body = {
    name: `zztest-${marker}`, patient_id: patient.lastID,
    customer_value: 'high', urgency_level: 'normal', call_type: 'REVIEW_CALL'
  };
  try {
    const before = await selectState();
    const rejected = [
      { candidate: {
        scheduled_date: '2099-01-01', preferred_slot: '10:00',
        scheduled_datetime: '2020-01-01T10:00:00Z'
      }, field: 'scheduled_date' },
      { candidate: {
        scheduled_date: '2099-01-01', preferred_slot: '10:00',
        scheduled_datetime: '2099-01-01T00:00:00Z'
      }, field: 'preferred_slot' },
      { candidate: {
        scheduled_date: '2099-03-02', preferred_slot: '15:30',
        scheduled_datetime: '2099-02-30T10:00:00Z'
      }, field: 'scheduled_datetime' }
    ];
    for (const { candidate, field } of rejected) {
      const response = await request('PUT', `/api/customers/${customer.lastID}`, { ...body, ...candidate });
      assert.equal(response.status, 400, JSON.stringify({ candidate, response: response.body }));
      assert.ok(response.body.fieldErrors[field], JSON.stringify({ candidate, response: response.body }));
      assert.deepEqual(await selectState(), before, JSON.stringify(candidate));
    }
  } finally {
    await db.dbRun('DELETE FROM customers WHERE id = ?', [customer.lastID]);
    await db.dbRun('DELETE FROM patients WHERE id = ?', [patient.lastID]);
  }
});
