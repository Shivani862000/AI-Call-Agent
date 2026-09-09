'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { servePrivacyApp } = require('./support/privacy-app');

const phone = '+919876543210';
const email = 'patient@example.invalid';
const row = {
  id: 42, customer_id: 7, patient_id: 9, customer_name: 'Synthetic Patient',
  customer_phone: phone, phone, normalized_phone: '919876543210', email,
  called_at: '2026-09-08T09:59:00Z', outcome: 'completed', call_type: 'REVIEW_CALL',
  call_duration: 30, sentiment_label: 'positive', extracted_rating: 5,
  provider_call_id: 'provider-42', recording_url: `https://recording.invalid/${phone}`,
  recording_object_key: `audio/${email}`, recording_status: 'stored',
  transcript_text: `PATIENT: Contact me at ${phone} or ${email}`,
  summary: `Call ${phone}`, notes: email, outcome_detail: email,
  analysis_json: JSON.stringify({ entities: { phone }, summary: email }),
  provider_payload_json: JSON.stringify({ callerId: phone }),
  extracted_entities: JSON.stringify({ email }), timeline_events: JSON.stringify([{ text: phone }]),
  patient: { phone, email }, customer_queue: { phone, email },
  future_sensitive_field: { contact: email }
};

function assertPrivate(body) {
  const serialized = JSON.stringify(body);
  for (const secret of [phone, email, '919876543210', 'recording.invalid', 'provider-42']) {
    assert.ok(!serialized.includes(secret), `Response disclosed ${secret}`);
  }
}

test('AGENT recent calls contain operational data and masked contact labels only', async t => {
  const app = await servePrivacyApp(t, { dbAll: () => [row] });
  app.account.role = 'AGENT';
  const response = await app.request('GET', '/api/calls/recent', app.auth.createAuthToken('operator', 'AGENT'));
  assert.equal(response.status, 200);
  assertPrivate(response.body);
  assert.equal(response.body[0].id, 42);
  assert.equal(response.body[0].customer_name, 'Synthetic Patient');
  assert.equal(response.body[0].outcome, 'completed');
  assert.equal(response.body[0].phone_masked, '••••••3210');
  assert.equal(response.body[0].email_masked, 'p•••@•••.invalid');
  assert.equal(response.body[0].transcript_text, undefined);
  assert.equal(response.body[0].future_sensitive_field, undefined);
  assert.equal(row.customer_phone, phone, 'serialization must not mutate shared rows');
});

test('AGENT call details omit raw and derived analysis including nested contact fields', async t => {
  const app = await servePrivacyApp(t, { dbGet: () => row,
    buildCallAnalysis: () => ({ entities: { phone, email }, summary: email }) });
  app.account.role = 'AGENT';
  const response = await app.request('GET', '/API/calls/42/', app.auth.createAuthToken('operator', 'AGENT'));
  assert.equal(response.status, 200);
  assertPrivate(response.body);
  assert.equal(response.body.analysis, undefined);
  assert.equal(response.body.phone_masked, '••••••3210');
  assert.equal(response.body.call_duration, 30);
});

test('ADMIN recent and detail responses retain authorized contacts and analysis', async t => {
  const app = await servePrivacyApp(t, { dbAll: () => [row], dbGet: () => row });
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  const recent = await app.request('GET', '/api/calls/recent', token);
  const detail = await app.request('GET', '/api/calls/42', token);
  assert.equal(recent.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(recent.body[0].customer_phone, phone);
  assert.equal(detail.body.customer_phone, phone);
  assert.equal(detail.body.analysis.entities.email, email);
  assert.equal(detail.body.transcript_text, row.transcript_text);
});

test('incoming calls mask both database results and live-only provider payloads', async t => {
  const app = await servePrivacyApp(t, { dbAll: () => [{ ...row, stream_id: 'provider-42', status: 'completed' }] });
  app.account.role = 'AGENT';
  app.config.incomingCallState.set('incoming-live', { id: 'incoming-live', stream_id: 'incoming-live',
    caller_name: 'Live Patient', phone, extra_params: email, notes: email, status: 'active',
    received_at: '2026-09-08T09:59:00Z', updated_at: '2026-09-08T09:59:30Z' });
  const response = await app.request('GET', '/api/calls/incoming', app.auth.createAuthToken('operator', 'AGENT'));
  assert.equal(response.status, 200);
  assert.equal(response.body.calls.length, 2);
  assert.equal(response.body.active_count, 1);
  assertPrivate(response.body);
  for (const call of response.body.calls) assert.equal(call.phone_masked, '••••••3210');
});

test('live calls omit transcript previews and opaque provider data from both sources', async t => {
  const app = await servePrivacyApp(t, { dbAll: () => [row] });
  app.account.role = 'AGENT';
  app.config.liveCallState.set('memory-call', { call_sid: 'memory-call', call_id: 43,
    customer_name: 'Live Patient', phone, transcript_preview: email, notes: email,
    started_at: '2026-09-08T09:59:00Z', updated_at: '2026-09-08T09:59:30Z', status: 'active' });
  const response = await app.request('GET', '/api/calls/live', app.auth.createAuthToken('operator', 'AGENT'));
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 2);
  assertPrivate(response.body);
  assert.equal(response.body[0].transcript_preview, undefined);
  assert.equal(response.body[1].transcript_preview, undefined);
});

test('AGENT media, transcript, PDF and supervisor payload requests are denied before effects', async t => {
  const app = await servePrivacyApp(t, { dbGet: () => row, dbAll: () => [row], console: { ...console, error() {} } });
  app.account.role = 'AGENT';
  const token = app.auth.createAuthToken('operator', 'AGENT');
  for (const suffix of ['recording', 'transcript?raw=1', 'analysis-pdf', 'supervisor-events']) {
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await app.request(method, `/API/calls/42/${suffix}`, token)).status, 403, suffix);
    }
  }
  assert.deepEqual(app.effects, []);
});

test('invalid and overflowing call IDs never reach read, export or media handlers', async t => {
  const app = await servePrivacyApp(t, { console: { ...console, error() {} } });
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  for (const id of ['0', '-42', '+42', '%2042%20', '9007199254740992']) {
    for (const suffix of ['', '/recording', '/transcript', '/analysis-pdf', '/supervisor-events']) {
      const response = await app.request('GET', `/api/calls/${id}${suffix}`, token);
      assert.ok([400, 404].includes(response.status), `${id}${suffix}: ${response.status}`);
    }
  }
  assert.deepEqual(app.effects, []);
});

test('ADMIN transcript remains available and private responses cannot be cached', async t => {
  const app = await servePrivacyApp(t, { dbGet: () => row });
  const response = await app.request('GET', '/api/calls/42/transcript?raw=1', app.auth.createAuthToken('operator', 'ADMIN'));
  assert.equal(response.status, 200);
  assert.equal(response.body, row.transcript_text);
  assert.match(response.headers['cache-control'], /no-store/);
});
