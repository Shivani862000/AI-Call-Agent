'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Call = require('../src/models/Call');
const {
  createOutboundCallContextRepository,
  createOutboundCallContextCoordinator
} = require('../src/outbound-call-context');
const { createIcallMateSessionHydrator } = require('../src/call-management');

function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === 'object' && '$ne' in expected) return actual !== expected.$ne;
    if (expected && typeof expected === 'object' && '$gte' in expected) return new Date(actual) >= new Date(expected.$gte);
    if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.includes(actual);
    return String(actual) === String(expected);
  });
}

function createMemoryCallModel({ onCreate, failCreate = false, failNextUpdate = false } = {}) {
  const records = [];
  let rejectNextUpdate = failNextUpdate;

  return {
    records,
    async create(record) {
      onCreate?.(record);
      if (failCreate) throw new Error('Call context persistence unavailable');
      const document = new Call(record);
      await document.validate();
      const stored = document.toObject();
      records.push(stored);
      return { ...stored };
    },
    findOne(filter) {
      return {
        sort() { return this; },
        async lean() {
          const record = [...records].reverse().find((candidate) => matches(candidate, filter));
          return record ? { ...record } : null;
        }
      };
    },
    async updateOne(filter, update) {
      if (rejectNextUpdate) {
        rejectNextUpdate = false;
        throw new Error('Call context finalization unavailable');
      }
      const record = records.find((candidate) => matches(candidate, filter));
      if (!record) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(record, update.$set || {});
      return { matchedCount: 1, modifiedCount: 1 };
    }
  };
}

function createContextBoundary(CallModel, events = []) {
  const repository = createOutboundCallContextRepository({
    CallModel,
    now: () => new Date('2026-08-24T10:00:00.000Z')
  });
  const coordinator = createOutboundCallContextCoordinator({ repository });
  const place = (context, sid) => coordinator.initiate({
    ...context,
    placeProviderCall: async () => {
      events.push(`provider:${sid}`);
      return { sid, status: 'queued' };
    }
  });
  return { repository, coordinator, place };
}

test('numeric legacy customer persists before a real provider boundary and hydrates only in its tenant', async () => {
  // Mutation caught: writing numeric legacy id 42 into Call.customerId casts after the provider has already placed the call.
  const events = [];
  const tenantA = '64b64c8f0f1e2d3c4b5a6911';
  const tenantB = '64b64c8f0f1e2d3c4b5a6912';
  const CallModel = createMemoryCallModel({ onCreate: () => events.push('persist:prepared') });
  const { repository, place } = createContextBoundary(CallModel, events);

  const tenantAPlacement = await place({
    tenantId: tenantA,
    customerId: 42,
    customerPhone: '+91 98765 43210',
    callType: 'REVIEW_CALL',
    source: 'call-start'
  }, 'provider-a');
  const tenantBPlacement = await place({
    tenantId: tenantB,
    customerId: '42',
    customerPhone: '+91 98765 43210',
    callType: 'REVIEW_CALL',
    source: 'calls-initiate'
  }, 'provider-b');
  await place({
    tenantId: tenantA,
    customerId: 43,
    customerPhone: '+91 98765 43210',
    callType: 'REVIEW_CALL',
    source: 'calls-initiate'
  }, 'provider-a-second-customer');

  assert.deepEqual(events.slice(0, 2), ['persist:prepared', 'provider:provider-a']);
  assert.equal(tenantAPlacement.persistence.state, 'provider_accepted');
  assert.equal(tenantAPlacement.persistence.retryable, false);
  assert.equal(CallModel.records[0].customerId, null);
  assert.match(CallModel.records[0].legacy_customer_ref_hash, /^[a-f0-9]{64}$/);
  assert.match(CallModel.records[0].customer_phone_ref_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(CallModel.records[0].legacy_customer_ref_hash, CallModel.records[1].legacy_customer_ref_hash);
  assert.notEqual(CallModel.records[0].customer_phone_ref_hash, CallModel.records[1].customer_phone_ref_hash);

  const contextA = await repository.findRecentByPhone({ phone: '+919876543210', tenantId: tenantA, customerId: 42 });
  const secondContextA = await repository.findRecentByPhone({ phone: '+919876543210', tenantId: tenantA, customerId: 43 });
  const contextB = await repository.findRecentByPhone({ phone: '+919876543210', tenantId: tenantB, customerId: 42 });
  assert.equal(contextA.call.providerCallId, 'provider-a');
  assert.equal(secondContextA.call.providerCallId, 'provider-a-second-customer');
  assert.equal(contextB.call.providerCallId, 'provider-b');
  assert.doesNotMatch(JSON.stringify(contextA), /9876543210|Tenant A|customerId|legacy_customer/i);
  assert.doesNotMatch(JSON.stringify(tenantAPlacement.context), /9876543210|customerId|legacy_customer/i);

  CallModel.records[0].status = 'archived';
  assert.equal(await repository.findRecentByPhone({ phone: '+919876543210', tenantId: tenantA, customerId: 42 }), null);
  assert.equal((await repository.findRecentByPhone({ phone: '+919876543210', tenantId: tenantB, customerId: 42 })).call.providerCallId, 'provider-b');
  assert.equal(tenantBPlacement.context.state, 'provider_accepted');
});

test('Mongoose ObjectId customer keeps the native reference and uses the same opaque hydration key', async () => {
  // Mutation caught: treating every customer as legacy drops existing Mongoose Customer relationships.
  const tenantId = '64b64c8f0f1e2d3c4b5a6911';
  const customerId = '64b64c8f0f1e2d3c4b5a6901';
  const CallModel = createMemoryCallModel();
  const { repository, place } = createContextBoundary(CallModel);

  await place({
    tenantId,
    customerId,
    customerPhone: '+919999999999',
    agentId: '64b64c8f0f1e2d3c4b5a6978',
    callType: 'REVIEW_CALL',
    source: 'scheduler'
  }, 'provider-object-id');

  assert.equal(String(CallModel.records[0].customerId), customerId);
  assert.equal(CallModel.records[0].legacy_customer_ref_hash, null);
  assert.equal(
    (await repository.findRecentByPhone({ phone: '+91 99999 99999', tenantId, customerId })).call.providerCallId,
    'provider-object-id'
  );
});

test('unpersistable context prevents provider side effects and accepted finalization is retry-safe', async () => {
  // Mutation caught: calling the provider before validating/persisting local context creates a provider-call orphan and a 500.
  const tenantId = '64b64c8f0f1e2d3c4b5a6911';
  let providerCalls = 0;
  const failedModel = createMemoryCallModel({ failCreate: true });
  const failedBoundary = createContextBoundary(failedModel);

  await assert.rejects(
    failedBoundary.coordinator.initiate({
      tenantId,
      customerId: 42,
      customerPhone: '+919876543210',
      callType: 'REVIEW_CALL',
      source: 'icallmate-masterpost',
      placeProviderCall: async () => {
        providerCalls += 1;
        return { sid: 'must-not-exist' };
      }
    }),
    /persistence unavailable/
  );
  assert.equal(providerCalls, 0);

  const retryModel = createMemoryCallModel({ failNextUpdate: true });
  const retryBoundary = createContextBoundary(retryModel);
  const placement = await retryBoundary.coordinator.initiate({
    tenantId,
    customerId: 42,
    customerPhone: '+919876543210',
    callType: 'REVIEW_CALL',
    source: 'icallmate-masterpost',
    placeProviderCall: async () => {
      providerCalls += 1;
      return { sid: 'provider-retry-safe' };
    }
  });

  assert.equal(providerCalls, 1);
  assert.deepEqual(placement.persistence, { state: 'prepared', retryable: true });
  const finalized = await retryBoundary.repository.markProviderAccepted({
    tenantId,
    contextId: placement.context.id,
    providerCallId: 'provider-retry-safe'
  });
  const repeated = await retryBoundary.repository.markProviderAccepted({
    tenantId,
    contextId: placement.context.id,
    providerCallId: 'provider-retry-safe'
  });
  assert.equal(finalized.state, 'provider_accepted');
  assert.deepEqual(repeated, finalized);
});

test('provider media hydrates safe persisted context without a separate Mongoose Customer document', async () => {
  // Mutation caught: hydration querying Customer by phone cannot find a legacy SQL customer and leaves context unhydrated.
  const tenantA = '64b64c8f0f1e2d3c4b5a6911';
  const tenantB = '64b64c8f0f1e2d3c4b5a6912';
  const CallModel = createMemoryCallModel();
  const { repository, place } = createContextBoundary(CallModel);
  const placement = await place({
    tenantId: tenantA,
    customerId: 42,
    customerPhone: '+919876543210',
    callType: 'REVIEW_CALL',
    source: 'call-start'
  }, 'provider-a');
  const hydrate = createIcallMateSessionHydrator({ contextRepository: repository });
  const sessionA = { callerId: '+919876543210', contextHydrated: false, callDirection: 'incoming', callId: null };
  const sessionB = { callerId: '+919876543210', contextHydrated: false, callDirection: 'incoming', callId: null };

  await hydrate(sessionA, { callerId: '+919876543210' }, {
    callDirection: 'outbound', tenantId: tenantA, customerId: 42, customerName: 'Existing provider context'
  });
  await hydrate(sessionB, { callerId: '+919876543210' }, {
    callDirection: 'outbound', tenantId: tenantB, customerId: 42, customerName: 'Wrong tenant context'
  });

  assert.equal(sessionA.contextHydrated, true);
  assert.equal(sessionA.tenantId, tenantA);
  assert.equal(sessionA.customerId, 42);
  assert.equal(sessionA.callId, placement.context.id);
  assert.equal(sessionA.providerCallId, 'provider-a');
  assert.equal(sessionB.contextHydrated, false);
  assert.equal(sessionB.callId, null);
});
