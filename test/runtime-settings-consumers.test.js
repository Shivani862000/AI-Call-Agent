'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createSupportTicketsRouter = require('../routes/support-tickets');
const { syncCallToCrm } = require('../services/crm-sync');
const testCallService = require('../services/test-call');
const testAiCallService = require('../services/test-ai-call');

test('CRM sync resolves the tenant webhook at delivery time without exposing provider text', async () => {
  const requests = [];
  const writes = [];
  const echoedSecret = 'webhook-provider-echoed-secret';
  const rows = {
    calls: { id: 7, customer_id: 9, tenant_id: 'tenant-1', outcome: 'completed' },
    customers: { id: 9, name: 'Customer' },
    feedback: null
  };
  const dbGet = async (sql) => rows[sql.match(/FROM (calls|customers|feedback)/)?.[1]] || null;
  const dbRun = async (...args) => { writes.push(args); return { changes: 1 }; };

  await assert.rejects(
    syncCallToCrm({
      dbGet,
      dbRun,
      callId: 7,
      tenantId: 'tenant-1',
      getIntegrationRuntimeConfig: async (integration, tenantId) => {
        assert.deepEqual([integration, tenantId], ['webhook', 'tenant-1']);
        return {
          settings: { enabled: true, endpoint: 'https://crm.database.example/hook', timeoutMs: 250 },
          secrets: { signingSecret: 'signing-secret' }
        };
      },
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: false, status: 502, async text() { return echoedSecret; } };
      }
    }),
    (error) => error.code === 'WEBHOOK_DELIVERY_FAILED' && !error.message.includes(echoedSecret)
  );

  assert.equal(requests[0].url, 'https://crm.database.example/hook');
  assert.equal(requests[0].options.headers['X-Webhook-Signature'].length > 0, true);
  assert.equal(writes.at(-1)[1][0], 'failed');
});

test('CRM sync wraps rejected provider-body reads without returning or logging the marker', async (t) => {
  const marker = 'provider-body-read-secret-marker';
  const logs = [];
  const originalError = console.error;
  console.error = (...values) => logs.push(values);
  t.after(() => { console.error = originalError; });
  const rows = {
    calls: { id: 8, customer_id: 9, tenant_id: 'tenant-1' },
    customers: { id: 9 },
    feedback: null
  };

  await assert.rejects(
    syncCallToCrm({
      dbGet: async (sql) => rows[sql.match(/FROM (calls|customers|feedback)/)?.[1]] || null,
      dbRun: async () => ({ changes: 1 }),
      callId: 8,
      getIntegrationRuntimeConfig: async () => ({
        settings: { enabled: true, endpoint: 'https://crm.database.example/hook', timeoutMs: 250 },
        secrets: { signingSecret: null }
      }),
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        async text() { throw new Error(marker); }
      })
    }),
    (error) => error.code === 'WEBHOOK_DELIVERY_FAILED'
      && error.message === 'CRM webhook delivery failed with HTTP 502'
      && !JSON.stringify(error).includes(marker)
  );

  assert.equal(JSON.stringify(logs).includes(marker), false);
});

test('support ticket creation forwards the authorized tenant to Slack delivery', async () => {
  let notified = null;
  const ticket = {
    ticket_id: 'BUG-1001',
    type: 'BUG',
    description: 'Safe problem description',
    reporter_role: 'CLIENT_ADMIN',
    page_url: 'https://app.example.com/support.html'
  };
  const router = createSupportTicketsRouter({
    dbRun: async (sql) => sql.startsWith('INSERT') ? { lastID: 1 } : { changes: 1 },
    dbGet: async () => ticket,
    dbAll: async () => [],
    notifyNewTicket: async (value) => { notified = value; }
  });
  const handler = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post).route.stack[0].handle;

  await handler({
    body: {
      type: 'BUG',
      description: 'Safe problem description',
      context: { pageUrl: 'https://app.example.com/support.html', pageTitle: 'Support' }
    },
    adminSession: { username: 'admin@example.com', role: 'CLIENT_ADMIN' },
    tenantId: 'tenant-1'
  }, { status() { return this; }, json() {} }, (error) => { throw error; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notified.tenant_id, 'tenant-1');
});

test('test-call Gemini consumers pass the session tenant to runtime resolution', async () => {
  for (const service of [testCallService, testAiCallService]) {
    let options = null;
    const reply = await service._test.generateLlmReply(
      { tenantId: 'tenant-1', systemPrompt: 'Prompt', transcript: [] },
      'Hello',
      async (value) => { options = value; return 'Reply'; }
    );
    assert.equal(reply, 'Reply');
    assert.equal(options.tenantId, 'tenant-1');
  }
});
