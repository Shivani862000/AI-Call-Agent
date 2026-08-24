'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Duplex } = require('node:stream');

function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === 'object' && '$ne' in expected) return actual !== expected.$ne;
    return String(actual) === String(expected);
  });
}

async function request(app, path, tenantId, body = null) {
  const payload = JSON.stringify(body || {
    phone: '+919876543210',
    customerPhone: '+919876543210',
    customerName: 'Legacy Customer'
  });
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const req = new http.IncomingMessage(socket);
  req.method = 'POST';
  req.url = path;
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    'x-test-tenant': tenantId
  };
  const res = new http.ServerResponse(req);

  return new Promise((resolve, reject) => {
    let responseBody = '';
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    res.write = (chunk, ...args) => {
      if (chunk) responseBody += chunk.toString();
      return originalWrite(chunk, ...args);
    };
    res.end = (chunk, ...args) => {
      if (chunk) responseBody += chunk.toString();
      const result = originalEnd(chunk, ...args);
      setImmediate(() => resolve({ status: res.statusCode, body: responseBody }));
      return result;
    };
    req.on('error', reject);
    req.push(payload);
    req.push(null);
    app.handle(req, res, reject);
  });
}

test('all mounted non-dry-run outbound entrypoints prepare numeric legacy context before provider placement', async () => {
  // Mutation caught: any route that calls its provider directly can place a call before numeric customer context is persistable.
  const tenantId = '64b64c8f0f1e2d3c4b5a6911';
  const customer = {
    id: 42,
    tenant_id: tenantId,
    name: 'Legacy Customer',
    phone: '+919876543210',
    status: 'pending',
    call_type: 'REVIEW_CALL',
    is_manual: 1
  };
  const events = [];
  const preparedContexts = [];

  const db = require('../db');
  db.dbGet = async (sql) => {
    if (/SELECT \* FROM customers/i.test(sql)) return { ...customer };
    if (/COUNT\(\*\)/i.test(sql)) return { count: 0 };
    return null;
  };
  db.dbRun = async () => ({ changes: 1, lastID: 42 });
  db.dbAll = async () => [];

  const callManagement = require('../src/call-management');
  callManagement.ensureCustomerForCall = async () => ({ ...customer });
  callManagement.claimCustomerForOutboundCall = async () => true;
  callManagement.releaseCustomerOutboundClaim = async () => {};
  callManagement.hydratePreCallIntelligence = async (record) => record;
  callManagement.shouldBlockCustomerCall = async () => null;
  callManagement.placeRealtimeCall = async () => {
    events.push('provider:campaign');
    return { sid: `campaign-${events.length}`, status: 'queued' };
  };

  const icallmate = require('../services/icallmate');
  icallmate.initiateCall = async () => {
    events.push('provider:masterpost');
    return { sid: 'masterpost-1', status: 'queued' };
  };

  const promptBuilder = require('../src/prompt-builder');
  promptBuilder.getDefaultAgentConfig = async () => null;
  promptBuilder.getAgentConfigById = async () => null;

  const helpers = require('../src/helpers');
  helpers.schedulePendingCallDiagnostic = () => {};

  const contextModule = require('../src/outbound-call-context');
  contextModule.outboundCallContextRepository.persistInitiatedCall = async () => {
    events.push('legacy:persist-after-provider');
    return { id: 'legacy-call' };
  };
  contextModule.outboundCallContextCoordinator.initiate = async ({ placeProviderCall, ...context }) => {
    preparedContexts.push(context);
    events.push(`prepare:${context.source}`);
    const providerCall = await placeProviderCall();
    return {
      providerCall,
      context: { id: `context-${preparedContexts.length}`, state: 'provider_accepted' },
      persistence: { state: 'provider_accepted', retryable: false }
    };
  };

  const Tenant = require('../src/models/Tenant');
  Tenant.findById = () => ({ lean: async () => ({ _id: tenantId, status: 'active' }) });

  delete require.cache[require.resolve('../src/api-routes')];
  const mountApiRoutes = require('../src/api-routes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminSession = {
      username: 'client-admin',
      role: 'CLIENT_ADMIN',
      tenantId: req.headers['x-test-tenant']
    };
    next();
  });
  mountApiRoutes(app);

  const responses = [];
  responses.push(await request(app, '/call/start', tenantId));
  responses.push(await request(app, '/api/calls/initiate/42', tenantId));
  responses.push(await request(app, '/api/icallmate/outgoing-call', tenantId));

  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  assert.deepEqual(events, [
    'prepare:icallmate', 'provider:campaign',
    'prepare:icallmate', 'provider:campaign',
    'prepare:icallmate-masterpost', 'provider:masterpost'
  ]);
  assert.equal(preparedContexts.length, 3);
  assert.ok(preparedContexts.every((context) => context.customerId === 42));
  assert.ok(preparedContexts.every((context) => context.customerPhone === '+919876543210'));
  assert.ok(preparedContexts.every((context) => context.tenantId === tenantId));
});

test('mounted tenant reconciliation accepts only server-attested provider evidence', async () => {
  // Mutation caught: accepting client-supplied disposition/provider IDs lets a tenant activate any prepared context.
  const tenantId = '64b64c8f0f1e2d3c4b5a6911';
  const otherTenantId = '64b64c8f0f1e2d3c4b5a6912';
  const contextId = '64b64c8f0f1e2d3c4b5a6999';
  let state = 'prepared';
  let persistenceOnline = false;
  let providerCalls = 0;
  let reconciliationCalls = 0;
  const { createOutboundCallContextCoordinator } = require('../src/outbound-call-context');
  const outboundCoordinator = createOutboundCallContextCoordinator({
    repository: {
      async prepareInitiatedCall() { return { id: contextId, state }; },
      async readState() { return { id: contextId, state }; },
      async reconcileProviderOutcome(input) {
        reconciliationCalls += 1;
        if (!persistenceOnline) {
          const error = new Error('Primary stepped down');
          error.code = 91;
          throw error;
        }
        assert.deepEqual(input, {
          tenantId,
          contextId,
          disposition: 'accepted',
          providerCallId: 'provider-needs-reconciliation'
        });
        state = 'provider_accepted';
        return { id: contextId, state };
      }
    },
    recoveryTokenSecret: 'round-six-test-recovery-secret-with-32-bytes'
  });
  const placement = await outboundCoordinator.initiate({
    tenantId,
    customerId: 42,
    customerPhone: '+919876543210',
    callType: 'REVIEW_CALL',
    placeProviderCall: async () => {
      providerCalls += 1;
      return { sid: 'provider-needs-reconciliation' };
    }
  });
  persistenceOnline = true;
  const placementReconciliationCalls = reconciliationCalls;

  const Tenant = require('../src/models/Tenant');
  Tenant.findById = (requestedTenantId) => ({
    lean: async () => ({ _id: requestedTenantId, status: 'active' })
  });

  delete require.cache[require.resolve('../src/api-routes')];
  const mountApiRoutes = require('../src/api-routes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminSession = {
      username: 'client-admin',
      role: 'CLIENT_ADMIN',
      tenantId: req.headers['x-test-tenant']
    };
    next();
  });
  mountApiRoutes(app, { outboundCoordinator });
  app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }));

  const legacyProviderFacts = await request(
    app,
    `/api/calls/outbound-context/${contextId}/reconcile`,
    tenantId,
    {
      recoveryToken: placement.recoveryToken,
      disposition: 'accepted',
      providerCallId: 'client-invented-provider-id'
    }
  );
  const forged = await request(app, `/api/calls/outbound-context/${contextId}/reconcile`, tenantId, {
    disposition: 'accepted',
    providerCallId: 'client-invented-provider-id'
  });
  const recoveryBody = { recoveryToken: placement.recoveryToken };
  const first = await request(app, `/api/calls/outbound-context/${contextId}/reconcile`, tenantId, recoveryBody);
  const repeated = await request(app, `/api/calls/outbound-context/${contextId}/reconcile`, tenantId, recoveryBody);
  const wrongTenant = await request(app, `/api/calls/outbound-context/${contextId}/reconcile`, otherTenantId, recoveryBody);
  const tamperedParts = placement.recoveryToken.split('.');
  tamperedParts[2] = `${tamperedParts[2][0] === 'A' ? 'B' : 'A'}${tamperedParts[2].slice(1)}`;
  const tamperedToken = tamperedParts.join('.');
  const tampered = await request(app, `/api/calls/outbound-context/${contextId}/reconcile`, tenantId, {
    recoveryToken: tamperedToken
  });
  const malformedId = await request(app, '/api/calls/outbound-context/not-an-object-id/reconcile', tenantId, recoveryBody);

  assert.equal(legacyProviderFacts.status, 400);
  assert.equal(forged.status, 400);
  assert.equal(first.status, 200);
  assert.equal(repeated.status, 200);
  assert.equal(wrongTenant.status, 404);
  assert.equal(tampered.status, 400);
  assert.equal(malformedId.status, 400);
  assert.deepEqual(JSON.parse(first.body), {
    callId: contextId,
    contextPersistence: 'provider_accepted',
    contextRetryable: false
  });
  assert.equal(state, 'provider_accepted');
  assert.equal(providerCalls, 1);
  assert.equal(reconciliationCalls, placementReconciliationCalls + 2);
});

test('post-provider typed archive conflicts preserve recovery identity and claims for every mounted entrypoint', async () => {
  // Mutation caught: rethrowing a typed NOT_FOUND after provider acceptance returns 500 and releases the customer claim.
  const tenantId = '64b64c8f0f1e2d3c4b5a6911';
  const customer = {
    id: 42,
    tenant_id: tenantId,
    name: 'Legacy Customer',
    phone: '+919876543210',
    status: 'pending',
    call_type: 'REVIEW_CALL',
    is_manual: 1
  };
  const records = [];
  const Call = require('../src/models/Call');
  const CallModel = {
    records,
    async create(input) {
      const document = new Call(input);
      await document.validate();
      const stored = document.toObject();
      records.push(stored);
      return { ...stored };
    },
    findOne(filter) {
      return {
        async lean() {
          const record = [...records].reverse().find((candidate) => matches(candidate, filter));
          return record ? { ...record } : null;
        }
      };
    },
    async updateOne() {
      throw new Error('Archived contexts must not be made active');
    }
  };

  const {
    createOutboundCallContextRepository,
    createOutboundCallContextCoordinator
  } = require('../src/outbound-call-context');
  const outboundCoordinator = createOutboundCallContextCoordinator({
    repository: createOutboundCallContextRepository({ CallModel }),
    recoveryTokenSecret: 'round-seven-test-recovery-secret-with-32-bytes'
  });
  let providerCalls = 0;
  let releases = 0;
  let legacyWrites = 0;

  const archivePreparedContext = () => {
    providerCalls += 1;
    records.at(-1).status = 'archived';
  };

  const db = require('../db');
  db.dbGet = async (sql) => {
    if (/SELECT \* FROM customers/i.test(sql)) return { ...customer };
    if (/COUNT\(\*\)/i.test(sql)) return { count: 0 };
    return null;
  };
  db.dbRun = async () => {
    legacyWrites += 1;
    return { changes: 1, lastID: 42 };
  };
  db.dbAll = async () => [];

  const callManagement = require('../src/call-management');
  callManagement.ensureCustomerForCall = async () => ({ ...customer });
  callManagement.claimCustomerForOutboundCall = async () => true;
  callManagement.releaseCustomerOutboundClaim = async () => { releases += 1; };
  callManagement.hydratePreCallIntelligence = async (record) => record;
  callManagement.shouldBlockCustomerCall = async () => null;
  callManagement.placeRealtimeCall = async () => {
    archivePreparedContext();
    return { sid: `campaign-${providerCalls}`, status: 'queued' };
  };

  const icallmate = require('../services/icallmate');
  icallmate.initiateCall = async () => {
    archivePreparedContext();
    return { sid: `masterpost-${providerCalls}`, status: 'queued' };
  };

  const promptBuilder = require('../src/prompt-builder');
  promptBuilder.getDefaultAgentConfig = async () => null;
  promptBuilder.getAgentConfigById = async () => null;

  const helpers = require('../src/helpers');
  helpers.schedulePendingCallDiagnostic = () => {};

  const Tenant = require('../src/models/Tenant');
  Tenant.findById = () => ({ lean: async () => ({ _id: tenantId, status: 'active' }) });

  delete require.cache[require.resolve('../src/api-routes')];
  const mountApiRoutes = require('../src/api-routes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminSession = {
      username: 'client-admin',
      role: 'CLIENT_ADMIN',
      tenantId: req.headers['x-test-tenant']
    };
    next();
  });
  mountApiRoutes(app, { outboundCoordinator });

  const responses = [
    await request(app, '/call/start', tenantId),
    await request(app, '/api/calls/initiate/42', tenantId),
    await request(app, '/api/icallmate/outgoing-call', tenantId)
  ];

  assert.deepEqual(responses.map(({ status }) => status), [202, 202, 202]);
  for (const [index, response] of responses.entries()) {
    const body = JSON.parse(response.body);
    assert.equal(body.callId, String(records[index]._id));
    assert.match(body.contextRecoveryToken, /^v1\./);
    assert.equal(body.contextPersistence, 'prepared');
    assert.equal(body.contextRetryable, false);
    assert.equal(body.contextErrorCode, 'OUTBOUND_CONTEXT_NOT_FOUND');
    assert.equal(body.providerAccepted, true);
    assert.equal(body.reinitiationRequired, false);
  }
  assert.equal(providerCalls, 3);
  assert.equal(releases, 0);
  assert.equal(legacyWrites, 0);
  assert.ok(records.every((record) => record.status === 'archived'));
});

test('post-provider legacy failures return accepted recovery responses for every mounted entrypoint', async () => {
  // Mutation caught: throwing a legacy write after provider acceptance returns an unidentifiable 500 and releases the call claim.
  const tenantId = '64b64c8f0f1e2d3c4b5a6911';
  const customer = {
    id: 42,
    tenant_id: tenantId,
    name: 'Legacy Customer',
    phone: '+919876543210',
    status: 'pending',
    call_type: 'REVIEW_CALL',
    is_manual: 1
  };
  let providerCalls = 0;
  let releases = 0;
  let contextSequence = 0;

  const db = require('../db');
  db.dbGet = async (sql) => {
    if (/SELECT \* FROM customers/i.test(sql)) return { ...customer };
    return null;
  };
  db.dbRun = async () => {
    throw new Error('Legacy persistence unavailable');
  };
  db.dbAll = async () => [];

  const callManagement = require('../src/call-management');
  callManagement.ensureCustomerForCall = async () => ({ ...customer });
  callManagement.claimCustomerForOutboundCall = async () => true;
  callManagement.releaseCustomerOutboundClaim = async () => { releases += 1; };
  callManagement.hydratePreCallIntelligence = async (record) => record;
  callManagement.shouldBlockCustomerCall = async () => null;
  callManagement.placeRealtimeCall = async () => {
    providerCalls += 1;
    return { sid: `campaign-${providerCalls}`, status: 'queued' };
  };

  const icallmate = require('../services/icallmate');
  icallmate.initiateCall = async () => {
    providerCalls += 1;
    return { sid: `masterpost-${providerCalls}`, status: 'queued' };
  };

  const promptBuilder = require('../src/prompt-builder');
  promptBuilder.getDefaultAgentConfig = async () => null;
  promptBuilder.getAgentConfigById = async () => null;

  const helpers = require('../src/helpers');
  helpers.schedulePendingCallDiagnostic = () => {};

  const outboundCoordinator = {
    async initiate({ placeProviderCall }) {
      const providerCall = await placeProviderCall();
      contextSequence += 1;
      return {
        providerCall,
        context: { id: `64b64c8f0f1e2d3c4b5a69${String(contextSequence).padStart(2, '0')}`, state: 'provider_accepted' },
        persistence: { state: 'provider_accepted', retryable: false },
        recoveryToken: `server-attested-recovery-${contextSequence}`
      };
    },
    async reconcile({ contextId, recoveryToken }) {
      assert.equal(recoveryToken, 'server-attested-recovery-1');
      return {
        context: { id: contextId, state: 'provider_accepted' },
        persistence: { state: 'provider_accepted', retryable: false }
      };
    }
  };

  const Tenant = require('../src/models/Tenant');
  Tenant.findById = () => ({ lean: async () => ({ _id: tenantId, status: 'active' }) });

  delete require.cache[require.resolve('../src/api-routes')];
  const mountApiRoutes = require('../src/api-routes');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminSession = {
      username: 'client-admin',
      role: 'CLIENT_ADMIN',
      tenantId: req.headers['x-test-tenant']
    };
    next();
  });
  mountApiRoutes(app, { outboundCoordinator });

  const responses = [
    await request(app, '/call/start', tenantId),
    await request(app, '/api/calls/initiate/42', tenantId),
    await request(app, '/api/icallmate/outgoing-call', tenantId)
  ];
  const recovery = await request(
    app,
    '/api/calls/outbound-context/64b64c8f0f1e2d3c4b5a6901/reconcile',
    tenantId,
    { recoveryToken: 'server-attested-recovery-1' }
  );

  assert.deepEqual(responses.map(({ status }) => status), [202, 202, 202]);
  for (const [index, response] of responses.entries()) {
    const body = JSON.parse(response.body);
    assert.equal(body.callId, `64b64c8f0f1e2d3c4b5a69${String(index + 1).padStart(2, '0')}`);
    assert.equal(body.contextPersistence, 'provider_accepted');
    assert.equal(body.contextRecoveryToken, `server-attested-recovery-${index + 1}`);
    assert.equal(body.ancillaryPersistence, 'failed');
    assert.equal(body.ancillaryRetryable, true);
    assert.equal(body.providerAccepted, true);
    assert.equal(body.reinitiationRequired, false);
    assert.notEqual(body.success, false);
  }
  assert.equal(recovery.status, 200);
  assert.equal(providerCalls, 3);
  assert.equal(releases, 0);
});
