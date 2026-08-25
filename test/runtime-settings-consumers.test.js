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

test('support ticket creation persists the ticket in MongoDB before notifying Slack', async () => {
  let notified = null;
  const storedTickets = [];
  const SupportTicket = {
    async create(value) {
      const ticket = { ...value, created_at: new Date(), updated_at: new Date() };
      storedTickets.push(ticket);
      return ticket;
    }
  };
  const TicketCounter = {
    async findOneAndUpdate() {
      return { sequence: 1 };
    }
  };
  const router = createSupportTicketsRouter({
    SupportTicket,
    TicketCounter,
    notifyNewTicket: async (value) => { notified = value; }
  });
  const handler = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post).route.stack[0].handle;
  const response = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };

  await handler({
    body: {
      type: 'BUG',
      description: 'Safe problem description',
      context: { pageUrl: 'https://app.example.com/support.html', pageTitle: 'Support' }
    },
    adminSession: { username: 'admin@example.com', role: 'CLIENT_ADMIN' },
    tenantId: 'tenant-1'
  }, response, (error) => { throw error; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.ticket.ticket_id, 'BUG-1001');
  assert.equal(storedTickets.length, 1);
  assert.equal(storedTickets[0].tenant_id, 'tenant-1');
  assert.equal(notified.tenant_id, 'tenant-1');
});

test('support ticket list reads MongoDB tickets newest first', async () => {
  const tickets = [{ ticket_id: 'IDEA-1002' }, { ticket_id: 'BUG-1001' }];
  const SupportTicket = {
    find(filter) {
      assert.deepEqual(filter, {});
      return { sort(sort) { assert.deepEqual(sort, { updated_at: -1 }); return { lean: async () => tickets }; } };
    }
  };
  const router = createSupportTicketsRouter({ SupportTicket });
  const handler = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
  const response = { json(value) { this.body = value; } };

  await handler({}, response, (error) => { throw error; });

  assert.deepEqual(response.body, { tickets });
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
