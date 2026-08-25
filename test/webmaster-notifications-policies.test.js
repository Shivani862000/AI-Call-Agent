'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNotificationService } = require('../src/webmaster/notification-service');
const { createMaintenanceMiddleware, createConfiguredRateLimit, createFeatureFlagMiddleware } = require('../src/webmaster/policy-middleware');
const fs = require('node:fs');
const path = require('node:path');

test('email failure remains retryable and response excludes provider text', async () => {
  const rows = [];
  const DeliveryModel = { async create(input) { const row = { _id: String(rows.length + 1), ...input, async save() { return this; }, toObject() { return { ...this, save: undefined }; } }; rows.push(row); return row; } };
  const service = createNotificationService({ mailer: { send: async () => { throw new Error('smtp-password private'); } }, DeliveryModel });
  const [delivery] = await service.sendLifecycle({ tenant: { id: 't1', name: 'Lab' }, users: [{ id: 'u1', email: 'admin@example.test' }], event: 'suspended', actor: { username: 'owner' } });
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.retryable, true);
  assert.equal(JSON.stringify(delivery).includes('smtp-password'), false);
});

test('failed delivery can be retried using retained account and tenant references', async () => {
  const retained = { _id: 'd1', tenantId: 't1', accountId: 'u1', recipientCategory: 'tenant_admin', event: 'suspended', retryCount: 1, status: 'failed', async save() { return this; }, toObject() { return { ...this }; } };
  const DeliveryModel = {
    findOneAndUpdate: () => ({ exec: async () => { retained.status = 'pending'; retained.retryCount += 1; return retained; } }),
    async create() { throw new Error('retry must not duplicate the retained delivery'); }
  };
  const service = createNotificationService({ mailer: { send: async () => ({ delivered: true }) }, DeliveryModel, UserModel: { findById: () => ({ lean: async () => ({ _id: 'u1', email: 'admin@example.test' }) }) }, TenantModel: { findById: () => ({ lean: async () => ({ _id: 't1', name: 'Lab' }) }) } });
  const delivery = await service.retry('d1', { username: 'owner' });
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.retryCount, 2);
  assert.equal(delivery.id, 'd1');
  assert.equal(retained.status, 'delivered');
});

test('managed lifecycle template is used without exposing HTML from settings', async () => {
  let sent;
  const DeliveryModel = { async create(input) { return { _id: 'd1', ...input, async save() {}, toObject() { return { ...this }; } }; } };
  const service = createNotificationService({ mailer: { async send(message) { sent = message; return { delivered: true }; } }, DeliveryModel, templateProvider: async () => ({ subject: 'Managed subject', body: '<script>unsafe</script>' }) });
  await service.sendLifecycle({ tenant: { id: 't1' }, users: [{ id: 'u1', email: 'admin@example.test' }], event: 'suspended', actor: {} });
  assert.equal(sent.subject, 'Managed subject');
  assert.doesNotMatch(sent.html, /<script>/);
});

test('retry atomically claims one failed delivery before sending', async () => {
  let available = true; let sends = 0;
  const retained = { _id: 'd1', tenantId: 't1', accountId: 'u1', event: 'archived', retryCount: 1, status: 'pending', async save() {}, toObject() { return { ...this }; } };
  const service = createNotificationService({
    mailer: { async send() { sends += 1; return { delivered: true }; } },
    DeliveryModel: { create: async () => retained, findOneAndUpdate: () => ({ exec: async () => { if (!available) return null; available = false; retained.retryCount += 1; return retained; } }) },
    UserModel: { findById: () => ({ lean: async () => ({ _id: 'u1', email: 'admin@example.test' }) }) },
    TenantModel: { findById: () => ({ lean: async () => ({ _id: 't1' }) }) }
  });
  const results = await Promise.allSettled([service.retry('d1', {}), service.retry('d1', {})]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(sends, 1);
});

test('maintenance permits webmaster and safe reads but rejects tenant mutations', async () => {
  const middleware = createMaintenanceMiddleware({ settingsProvider: async () => ({ maintenance: { enabled: true, message: 'Scheduled work' } }) });
  const run = (req) => new Promise(resolve => middleware(req, { status(code) { return { json(body) { resolve({ code, body }); } }; } }, () => resolve({ code: 200 })));
  assert.equal((await run({ method: 'POST', path: '/api/webmaster/settings', webmasterActor: {} })).code, 200);
  assert.equal((await run({ method: 'GET', path: '/api/customers' })).code, 200);
  assert.equal((await run({ method: 'PATCH', path: '/api/customers/1' })).code, 503);
});

test('configured rate limit resolves a validated scope value with fallback', async () => {
  const options = createConfiguredRateLimit({ settingsProvider: async () => ({ rateLimits: { api: 77 } }), scope: 'api', fallback: 60, factory: value => value });
  assert.equal(await options.limit({}), 77);
});

test('disabled managed feature blocks only its mapped operations', async () => {
  const middleware = createFeatureFlagMiddleware({ settingsProvider: async () => ({ featureFlags: { outboundCalling: false } }) });
  const run = req => new Promise(resolve => middleware(req, { status(code) { return { json(body) { resolve({ code, body }); } }; } }, () => resolve({ code: 200 })));
  assert.equal((await run({ method: 'POST', path: '/call/start' })).code, 503);
  assert.equal((await run({ method: 'GET', path: '/api/calls' })).code, 200);
});

test('application entrypoint mounts managed maintenance and rate limits', () => {
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(source, /createMaintenanceMiddleware/);
  assert.match(source, /createConfiguredRateLimit/);
});
