'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTenantService, toSafeTenant } = require('../src/webmaster/tenant-service');

function query(value) {
  return { lean: async () => value, sort() { return this; }, skip() { return this; }, limit() { return this; } };
}

test('safe tenant DTO exposes management fields without document internals', () => {
  const dto = toSafeTenant({ _id: 't1', name: 'Lab', status: 'active', primaryContact: { email: 'ops@example.test' }, __v: 3, settingsOverrides: { timezone: 'Asia/Kolkata' }, secret: 'hidden' });
  assert.equal(dto.id, 't1');
  assert.equal(dto.version, 3);
  assert.equal(dto.secret, undefined);
});

test('operational snapshot uses aggregates and never customer document reads', async () => {
  const calls = [];
  const service = createTenantService({
    TenantModel: { findById: () => query({ _id: 't1', name: 'Lab', status: 'active', __v: 1 }) },
    CustomerModel: { countDocuments: async () => 12, find: () => { throw new Error('customer documents must not be read'); } },
    CallModel: { countDocuments: async (_filter) => 8, aggregate: async () => [{ _id: 'completed', count: 6 }, { _id: 'failed', count: 2 }] },
    FeedbackModel: { countDocuments: async () => 4, aggregate: async () => [{ _id: 'positive', count: 3 }] },
    NotificationModel: { countDocuments: async (filter) => { calls.push(filter); return 1; } },
    integrationStatus: async () => [{ id: 'gemini', configured: true }]
  });
  const snapshot = await service.getOperationalSnapshot('t1');
  const json = JSON.stringify(snapshot);
  assert.deepEqual(Object.keys(snapshot), ['tenant', 'usage', 'calls', 'feedback', 'integrations', 'notifications']);
  assert.equal(json.includes('phone'), false);
  assert.equal(snapshot.usage.customers, 12);
  assert.equal(snapshot.calls.completed, 6);
  assert.equal(calls[0].status, 'failed');
});

test('tenant lifecycle transition uses optimistic version and never deletes', async () => {
  let update;
  const service = createTenantService({
    TenantModel: {
      findOneAndUpdate(filter, patch) { update = { filter, patch }; return query({ _id: 't1', name: 'Lab', status: 'suspended', __v: 3 }); }
    }
  });
  const result = await service.transition('t1', 'suspend', 2, { username: 'owner' });
  assert.equal(update.filter.__v, 2);
  assert.equal(update.patch.$set.status, 'suspended');
  assert.equal(result.status, 'suspended');
});

test('generic tenant profile writes cannot bypass registered override validation', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/webmaster/tenant-service.js'), 'utf8');
  const safeFields = source.match(/const SAFE_FIELDS = \[([^\]]+)\]/)?.[1] || '';
  assert.doesNotMatch(safeFields, /settingsOverrides/);
});

test('tenant search is applied on the server before pagination', async () => {
  let filter;
  const service = createTenantService({ TenantModel: { find(value) { filter = value; return query([]); }, countDocuments: async () => 0 } });
  await service.list({ search: 'lab.*', page: 3, pageSize: 25 });
  assert.equal(filter.$or[0].name.$regex, 'lab\\.\\*');
});
