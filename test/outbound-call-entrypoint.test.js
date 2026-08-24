'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Duplex } = require('node:stream');

async function request(app, path, tenantId) {
  const payload = JSON.stringify({
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
