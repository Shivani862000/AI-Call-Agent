'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

let server;
let baseUrl;
let db;
const patientIds = [];

async function jsonRequest(method, path, body, username = 'import-admin') {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': username },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function previewCsv(csv, username = 'import-admin') {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'patients.csv');
  const response = await fetch(baseUrl + '/api/patients/import/preview', {
    method: 'POST', headers: { 'x-test-user': username }, body: form
  });
  return { status: response.status, body: await response.json() };
}

async function seedPatient(overrides = {}) {
  const marker = randomUUID();
  const phone = overrides.phone || `97${marker.replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`;
  const row = {
    reference_id: `REF-${marker}`,
    first_name: `zztest-${marker}`,
    last_name: 'Kept',
    phone,
    normalized_phone: phone,
    email: 'kept@example.test',
    preferred_call_slot: '14:30',
    preferred_language: 'en',
    date_of_birth: '1990-01-02',
    gender: 'female',
    blood_group: 'O+',
    last_donation_date: '2025-01-03',
    last_test_date: '2025-02-04',
    do_not_call: 1,
    consent_status: 'refused',
    status: 'inactive',
    notes: 'keep these notes',
    ...overrides
  };
  const fields = Object.keys(row);
  const result = await db.dbRun(
    `INSERT INTO patients (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    fields.map((field) => row[field])
  );
  patientIds.push(result.lastID);
  return { ...row, id: result.lastID };
}

test.before(async () => {
  db = require('../db');
  await db.initializeDatabase();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.adminSession = { username: req.get('x-test-user') || 'import-admin', role: 'ADMIN' };
    next();
  });
  app.use('/api/patients', require('../routes/patients'));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: 'test route error' }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const id of patientIds.reverse()) {
    await db.dbRun('DELETE FROM customers WHERE patient_id = ?', [id]);
    await db.dbRun('DELETE FROM patients WHERE id = ?', [id]);
  }
  await new Promise((resolve) => server.close(resolve));
  await db.closeDatabase();
});

test('actual preview and commit preserve omitted and protected patient fields', async () => {
  const patient = await seedPatient();
  const preview = await previewCsv([
    'First Name,Mobile Number,Status,Consent Status,Do Not Call',
    `Updated Name,${patient.phone},active,granted,0`
  ].join('\n'));
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.summary.updates, 1);
  assert.equal(preview.body.summary.total, 1);
  assert.equal(preview.body.preview.length, 1);
  assert.deepEqual(preview.body.preview[0].changes, [{ field: 'first_name', from: patient.first_name, to: 'Updated Name' }]);

  const committed = await jsonRequest('POST', '/api/patients/import/commit', { token: preview.body.token });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const stored = await db.dbGet('SELECT * FROM patients WHERE id = ?', [patient.id]);
  assert.equal(stored.first_name, 'Updated Name');
  for (const field of [
    'last_name', 'email', 'preferred_call_slot', 'preferred_language', 'date_of_birth',
    'gender', 'blood_group', 'last_donation_date', 'last_test_date', 'do_not_call',
    'consent_status', 'status', 'notes'
  ]) assert.deepEqual(stored[field], patient[field], field);
});

test('actual import clears present blank nullable fields', async () => {
  const patient = await seedPatient();
  const preview = await previewCsv([
    'First Name,Mobile Number,Email,Gender,Notes',
    `${patient.first_name},${patient.phone},,,`
  ].join('\n'));
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const clears = preview.body.preview[0].changes.filter((change) => change.clear).map((change) => change.field).sort();
  assert.deepEqual(clears, ['email', 'gender', 'notes']);
  const committed = await jsonRequest('POST', '/api/patients/import/commit', { token: preview.body.token });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  const stored = await db.dbGet('SELECT email, gender, notes, preferred_language FROM patients WHERE id = ?', [patient.id]);
  assert.deepEqual(stored, { email: null, gender: null, notes: null, preferred_language: 'en' });
});

test('reference/phone conflicts and duplicate targets are row-specific preview problems', async () => {
  const byReference = await seedPatient();
  const byPhone = await seedPatient();
  const conflict = await previewCsv([
    'Reference ID,First Name,Mobile Number',
    `${byReference.reference_id},Conflict,${byPhone.phone}`
  ].join('\n'));
  assert.equal(conflict.status, 200);
  assert.equal(conflict.body.summary.updates, 0);
  assert.match(conflict.body.problems[0].messages.join(' '), /different patients/i);

  const duplicate = await previewCsv([
    'First Name,Mobile Number',
    `First,${byPhone.phone}`,
    `Second,${byPhone.phone}`
  ].join('\n'));
  assert.equal(duplicate.body.summary.updates, 1);
  assert.match(duplicate.body.problems[0].messages.join(' '), /patient appears more than once/i);
});

test('stale, foreign, expired and replayed previews cannot write', async () => {
  const patient = await seedPatient();
  const csv = ['First Name,Mobile Number', `Fresh Name,${patient.phone}`].join('\n');

  const foreign = await previewCsv(csv, 'owner-admin');
  const denied = await jsonRequest('POST', '/api/patients/import/commit', { token: foreign.body.token }, 'other-admin');
  assert.equal(denied.status, 403);
  const ownerCommit = await jsonRequest('POST', '/api/patients/import/commit', { token: foreign.body.token }, 'owner-admin');
  assert.equal(ownerCommit.status, 200);
  assert.equal((await jsonRequest('POST', '/api/patients/import/commit', { token: foreign.body.token }, 'owner-admin')).status, 410);

  const stale = await previewCsv(['First Name,Mobile Number', `Stale Name,${patient.phone}`].join('\n'));
  await db.dbRun('UPDATE patients SET notes = ?, updated_at = now() WHERE id = ?', ['changed after preview', patient.id]);
  const staleCommit = await jsonRequest('POST', '/api/patients/import/commit', { token: stale.body.token });
  assert.equal(staleCommit.status, 409);
  assert.match(staleCommit.body.failures[0].message, /preview.*again/i);
  assert.equal((await db.dbGet('SELECT first_name FROM patients WHERE id = ?', [patient.id])).first_name, 'Fresh Name');

  const deleted = await seedPatient();
  const deletedPreview = await previewCsv(['First Name,Mobile Number', `Deleted Name,${deleted.phone}`].join('\n'));
  await db.dbRun('DELETE FROM patients WHERE id = ?', [deleted.id]);
  const deletedCommit = await jsonRequest('POST', '/api/patients/import/commit', { token: deletedPreview.body.token });
  assert.equal(deletedCommit.status, 409);
  assert.match(deletedCommit.body.failures[0].message, /preview.*again/i);

  const realNow = Date.now;
  const expiring = await previewCsv(['First Name,Mobile Number', `Expired Name,${patient.phone}`].join('\n'));
  Date.now = () => realNow() + 16 * 60 * 1000;
  try {
    assert.equal((await jsonRequest('POST', '/api/patients/import/commit', { token: expiring.body.token })).status, 410);
  } finally { Date.now = realNow; }
});

test('a newly conflicting create identity fails safely without becoming an update', async () => {
  const marker = randomUUID();
  const phone = `96${marker.replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`;
  const preview = await previewCsv(['First Name,Mobile Number', `Previewed Create,${phone}`].join('\n'));
  assert.equal(preview.body.summary.new, 1);
  const conflicting = await seedPatient({ phone, normalized_phone: phone, first_name: 'Existing Conflict' });
  const committed = await jsonRequest('POST', '/api/patients/import/commit', { token: preview.body.token });
  assert.equal(committed.status, 409);
  assert.match(committed.body.failures[0].message, /preview.*again/i);
  const rows = await db.dbAll('SELECT first_name FROM patients WHERE normalized_phone = ?', [phone]);
  assert.deepEqual(rows.map((row) => row.first_name), [conflicting.first_name]);

  const updateTarget = await seedPatient();
  const changedPhone = `95${marker.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`;
  const updatePreview = await previewCsv([
    'Reference ID,First Name,Mobile Number',
    `${updateTarget.reference_id},Changed During Commit,${changedPhone}`
  ].join('\n'));
  assert.equal(updatePreview.body.summary.updates, 1);
  await seedPatient({ phone: changedPhone, normalized_phone: changedPhone });
  const updateCommit = await jsonRequest('POST', '/api/patients/import/commit', { token: updatePreview.body.token });
  assert.equal(updateCommit.status, 409);
  const unchanged = await db.dbGet('SELECT first_name, phone FROM patients WHERE id = ?', [updateTarget.id]);
  assert.deepEqual(unchanged, { first_name: updateTarget.first_name, phone: updateTarget.phone });
});
