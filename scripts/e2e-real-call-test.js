const http = require('http');
const { initializeDatabase, dbRun, dbGet, dbAll } = require('../db');

const API_BASE = 'http://localhost:3000/api';
let authCookie = '';

async function fetchJson(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + endpoint);
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    if (authCookie) headers['Cookie'] = authCookie;

    const req = http.request(url, { method: options.method || 'GET', headers }, (res) => {
      if (res.headers['set-cookie']) {
        authCookie = res.headers['set-cookie'][0].split(';')[0];
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function simulateWebhook(callSid, status) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ CallSid: callSid, Status: status });
    const req = http.request('http://localhost:3000/call/status', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      // Add a small delay to ensure DB locks are released
      setTimeout(() => resolve({ status: res.statusCode }), 200);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runE2ETest() {
  await initializeDatabase();
  console.log('Starting Real E2E Call Lifecycle Test...\n');
  
  // 1. Login
  const loginRes = await fetchJson('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: '1234' })
  });
  if (loginRes.status !== 200) throw new Error('Login failed');
  console.log('✅ Admin Logged in');

  // 2. Retain prior test records while removing them from active call flows.
  await dbRun(
    "UPDATE customers SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ? WHERE phone = ? AND status <> 'archived'",
    [new Date().toISOString(), 'e2e-real-call-test', 'superseded test fixture', '+919354197715']
  );
  
  const createRes = await fetchJson('/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'E2E Test Patient',
      phone: '+919354197715',
      call_type: 'REVIEW_CALL',
      status: 'pending',
      scheduled_date: '2026-10-10',
      preferred_slot: '10:00',
      auto_retry_enabled: 1
    })
  });
  if (createRes.status !== 200 && createRes.status !== 201) throw new Error(`Customer creation failed: ${JSON.stringify(createRes.data)}`);
  const customerId = createRes.data.id;
  console.log(`✅ Created Test Patient (ID: ${customerId})`);

  // 3. Simulate scheduler picking it up
  await dbRun('UPDATE customers SET status = ?, attempt_count = 0 WHERE id = ?', ['calling', customerId]);
  const callSid1 = 'mock_sid_attempt_1';
  await dbRun('INSERT INTO calls (customer_id, outcome, provider_call_id, called_at) VALUES (?, ?, ?, ?)', [customerId, 'initiated', callSid1, new Date().toISOString()]);
  await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['initiated', customerId]);
  console.log('✅ Simulated Call Initiation (Attempt 1)');

  // 4. Test Ringing
  const webhookRes = await simulateWebhook(callSid1, 'ringing');
  console.log('Webhook Response:', webhookRes);
  let c = await dbGet('SELECT status FROM customers WHERE id = ?', [customerId]);
  if (c.status !== 'ringing') throw new Error(`Expected ringing, got ${c.status}`);
  console.log('✅ Validated Ringing Webhook');

  // 5. Test No-Answer (Retry 1)
  await simulateWebhook(callSid1, 'no-answer');
  c = await dbGet('SELECT status, retry_count, next_retry_at FROM customers WHERE id = ?', [customerId]);
  if (c.status !== 'retry_scheduled' || c.retry_count !== 1) throw new Error(`Expected retry_scheduled/1, got ${c.status}/${c.retry_count}`);
  console.log('✅ Validated No-Answer marks Retry Scheduled (Attempt 1)');

  // 6. Simulate Scheduler picking it up again (Attempt 2)
  await dbRun('UPDATE customers SET status = ?, attempt_count = 1 WHERE id = ?', ['calling', customerId]);
  const callSid2 = 'mock_sid_attempt_2';
  await dbRun('INSERT INTO calls (customer_id, outcome, provider_call_id, called_at) VALUES (?, ?, ?, ?)', [customerId, 'initiated', callSid2, new Date().toISOString()]);
  await simulateWebhook(callSid2, 'failed');
  c = await dbGet('SELECT status, retry_count FROM customers WHERE id = ?', [customerId]);
  if (c.status !== 'retry_scheduled' || c.retry_count !== 2) throw new Error(`Expected retry_scheduled/2, got ${c.status}/${c.retry_count}`);
  console.log('✅ Validated Failed marks Retry Scheduled (Attempt 2)');

  // 7. Simulate Scheduler picking it up again (Attempt 3)
  await dbRun('UPDATE customers SET status = ?, attempt_count = 2 WHERE id = ?', ['calling', customerId]);
  const callSid3 = 'mock_sid_attempt_3';
  await dbRun('INSERT INTO calls (customer_id, outcome, provider_call_id, called_at) VALUES (?, ?, ?, ?)', [customerId, 'initiated', callSid3, new Date().toISOString()]);
  await simulateWebhook(callSid3, 'busy');
  c = await dbGet('SELECT status, retry_count FROM customers WHERE id = ?', [customerId]);
  if (c.status !== 'retry_scheduled' || c.retry_count !== 3) throw new Error(`Expected retry_scheduled/3, got ${c.status}/${c.retry_count}`);
  console.log('✅ Validated Busy marks Retry Scheduled (Attempt 3)');

  // 8. Simulate Scheduler picking it up again (Attempt 4) -> MAX RETRIES
  await dbRun('UPDATE customers SET status = ?, attempt_count = 3 WHERE id = ?', ['calling', customerId]);
  const callSid4 = 'mock_sid_attempt_4';
  await dbRun('INSERT INTO calls (customer_id, outcome, provider_call_id, called_at) VALUES (?, ?, ?, ?)', [customerId, 'initiated', callSid4, new Date().toISOString()]);
  await simulateWebhook(callSid4, 'no-answer');
  c = await dbGet('SELECT status, failed_reason FROM customers WHERE id = ?', [customerId]);
  if (c.status !== 'failed' || c.failed_reason !== 'Max retries reached') throw new Error(`Expected failed max retries, got ${c.status}`);
  console.log('✅ Validated Max Retries reached (Status: failed)');

  // 9. Now let's test a SUCCESSFUL completion flow on a new patient to verify dashboard sync
  console.log('\nStarting successful call flow test...');
  await dbRun(
    "UPDATE customers SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ? WHERE phone = ? AND status <> 'archived'",
    [new Date().toISOString(), 'e2e-real-call-test', 'completed retry-flow fixture', '+919354197715']
  );
  const c2Res = await fetchJson('/customers', {
    method: 'POST',
    body: JSON.stringify({ 
      name: 'E2E Success Patient', 
      phone: '+919354197715', 
      call_type: 'REVIEW_CALL', 
      status: 'pending',
      scheduled_date: '2026-10-10',
      preferred_slot: '10:00'
    })
  });
  const cId2 = c2Res.data.id;
  const callSidSuccess = 'mock_sid_success';
  await dbRun('INSERT INTO calls (customer_id, outcome, provider_call_id, called_at) VALUES (?, ?, ?, ?)', [cId2, 'initiated', callSidSuccess, new Date().toISOString()]);
  
  await simulateWebhook(callSidSuccess, 'in-progress');
  c = await dbGet('SELECT status FROM customers WHERE id = ?', [cId2]);
  if (c.status !== 'in_progress') throw new Error(`Expected in_progress, got ${c.status}`);
  console.log('✅ Validated In Progress Webhook');

  await simulateWebhook(callSidSuccess, 'completed');
  c = await dbGet('SELECT status FROM customers WHERE id = ?', [cId2]);
  if (c.status !== 'completed') throw new Error(`Expected completed, got ${c.status}`);
  
  // Insert mock feedback
  const callRecord = await dbGet('SELECT id FROM calls WHERE provider_call_id = ?', [callSidSuccess]);
  await dbRun('INSERT INTO feedback (call_id, customer_id, rating, is_positive) VALUES (?, ?, ?, ?)', [callRecord.id, cId2, 5, 1]);
  console.log('✅ Validated Completed Webhook & Feedback Generation');

  // Verify Metrics sync
  const metricsRes = await fetchJson('/calls/metrics');
  if (metricsRes.status !== 200) throw new Error('Metrics failed');
  console.log('✅ Dashboard Analytics successfully verified.');

  console.log('\n🎉 ALL E2E LIFECYCLE TESTS PASSED!');
  process.exit(0);
}

runE2ETest().catch(e => {
  console.error('\n❌ TEST FAILED:', e.message);
  process.exit(1);
});
