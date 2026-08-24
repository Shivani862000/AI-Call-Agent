'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOutboundCallContextRepository } = require('../src/outbound-call-context');
const { createIcallMateSessionHydrator } = require('../src/call-management');

function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '$ne' in expected) return record[key] !== expected.$ne;
    if (expected && typeof expected === 'object' && '$gte' in expected) return new Date(record[key]) >= new Date(expected.$gte);
    return String(record[key]) === String(expected);
  });
}

function createMemoryModels() {
  const customers = [
    {
      _id: '64b64c8f0f1e2d3c4b5a6901', tenantId: '64b64c8f0f1e2d3c4b5a6911',
      name: 'Tenant A Customer', phone: '+919876543210', status: 'pending', call_type: 'REVIEW_CALL', video_sent: 1
    },
    {
      _id: '64b64c8f0f1e2d3c4b5a6902', tenantId: '64b64c8f0f1e2d3c4b5a6912',
      name: 'Tenant B Customer', phone: '+919876543210', status: 'pending', call_type: 'REVIEW_CALL', video_sent: 0
    }
  ];
  const calls = [];

  const CustomerModel = {
    find(filter) {
      return {
        limit() { return this; },
        async lean() { return customers.filter((record) => matches(record, filter)).map((record) => ({ ...record })); }
      };
    }
  };
  const CallModel = {
    records: calls,
    async create(record) {
      const stored = { _id: `call-${calls.length + 1}`, ...record };
      calls.push(stored);
      return { ...stored };
    },
    findOne(filter) {
      return {
        sort() { return this; },
        async lean() {
          const record = [...calls].reverse().find((candidate) => matches(candidate, filter));
          return record ? { ...record } : null;
        }
      };
    }
  };
  return { CustomerModel, CallModel };
}

test('persisted outbound call context hydrates only for its authorized tenant', async () => {
  // Mutation caught: omitting tenantId on Call persistence makes the tenant-scoped recent query unable to find it.
  const tenantA = '64b64c8f0f1e2d3c4b5a6911';
  const tenantB = '64b64c8f0f1e2d3c4b5a6912';
  const customerA = '64b64c8f0f1e2d3c4b5a6901';
  const { CustomerModel, CallModel } = createMemoryModels();
  const repository = createOutboundCallContextRepository({
    CallModel,
    CustomerModel,
    now: () => new Date('2026-08-24T10:00:00.000Z')
  });

  const persisted = await repository.persistInitiatedCall({
    tenantId: tenantA,
    customerId: customerA,
    providerCallId: 'provider-a',
    callType: 'REVIEW_CALL',
    clientName: 'Tenant A Clinic',
    source: 'call-start'
  });
  const tenantAContext = await repository.findRecentByPhone({ phone: '+91 98765 43210', tenantId: tenantA });
  const tenantBContext = await repository.findRecentByPhone({ phone: '+91 98765 43210', tenantId: tenantB });

  assert.equal(persisted.tenantId, tenantA);
  assert.equal(CallModel.records[0].tenantId, tenantA);
  assert.equal(tenantAContext.call.provider_call_id, 'provider-a');
  assert.equal(tenantAContext.customer._id, customerA);
  assert.equal(tenantBContext, null);
});

test('provider callDirection media hydrates tenant and call context before marking the session hydrated', async () => {
  // Mutation caught: the callDirection early return sets contextHydrated without tenantId/callId and permits cross-tenant context.
  const tenantA = '64b64c8f0f1e2d3c4b5a6911';
  const tenantB = '64b64c8f0f1e2d3c4b5a6912';
  const { CustomerModel, CallModel } = createMemoryModels();
  const repository = createOutboundCallContextRepository({
    CallModel,
    CustomerModel,
    now: () => new Date('2026-08-24T10:00:00.000Z')
  });
  const persisted = await repository.persistInitiatedCall({
    tenantId: tenantA,
    customerId: '64b64c8f0f1e2d3c4b5a6901',
    providerCallId: 'provider-a',
    callType: 'REVIEW_CALL',
    clientName: 'Tenant A Clinic',
    source: 'call-start'
  });
  const hydrate = createIcallMateSessionHydrator({ contextRepository: repository });
  const sessionA = { callerId: '+919876543210', contextHydrated: false, callDirection: 'incoming', callId: null };
  const sessionB = { callerId: '+919876543210', contextHydrated: false, callDirection: 'incoming', callId: null };
  const missingTenant = { callerId: '+919876543210', contextHydrated: false, callDirection: 'incoming', callId: null };

  await hydrate(sessionA, { callerId: '+919876543210' }, { callDirection: 'outbound', tenantId: tenantA });
  await hydrate(sessionB, { callerId: '+919876543210' }, { callDirection: 'outbound', tenantId: tenantB });
  await hydrate(missingTenant, { callerId: '+919876543210' }, { callDirection: 'outbound' });

  assert.equal(sessionA.contextHydrated, true);
  assert.equal(sessionA.tenantId, tenantA);
  assert.equal(sessionA.callId, persisted.id);
  assert.equal(sessionA.providerCallId, 'provider-a');
  assert.equal(sessionB.contextHydrated, false);
  assert.equal(sessionB.callId, null);
  assert.equal(missingTenant.contextHydrated, false);
  assert.equal(missingTenant.callId, null);
});
