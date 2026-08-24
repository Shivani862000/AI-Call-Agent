'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Duplex } = require('node:stream');

const mountApiRoutes = require('../src/api-routes');
const Tenant = require('../src/models/Tenant');
const {
  createAgentConfigLookup,
  normalizeRequestedAgentId
} = require('../src/prompt-builder');

async function request(app, { method = 'POST', path, body, headers = {} }) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const req = new http.IncomingMessage(socket);
  req.method = method;
  req.url = path;
  req.headers = {
    ...headers,
    ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {})
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
      setImmediate(() => {
        let parsed = responseBody;
        try { parsed = responseBody ? JSON.parse(responseBody) : null; } catch (_error) {}
        resolve({ status: res.statusCode, body: parsed });
      });
      return result;
    };
    req.on('error', reject);
    if (payload) req.push(payload);
    req.push(null);
    app.handle(req, res, reject);
  });
}

function createCallEntryApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'];
    if (role === 'client') {
      req.adminSession = { username: 'client-admin', role: 'CLIENT_ADMIN', tenantId: req.headers['x-session-tenant'] };
    } else if (role === 'webmaster') {
      req.adminSession = { username: 'webmaster', role: 'WEBMASTER' };
    }
    next();
  });
  mountApiRoutes(app);
  return app;
}

test('mounted outgoing entrypoints reject missing authorized tenant context before call work', async () => {
  // Mutation caught: removing requireTenantAccess lets outgoing routes continue with tenantId undefined.
  const app = createCallEntryApp();
  const outgoing = await request(app, {
    path: '/api/icallmate/outgoing-call',
    body: { phone: '+919876543210', dryRun: true }
  });
  const callStart = await request(app, { path: '/call/start', body: {} });

  assert.equal(outgoing.status, 401);
  assert.equal(callStart.status, 401);
});

test('client and Webmaster tenant context reaches the actual outgoing provider payload', async () => {
  // Mutation caught: omitting tenantId from buildMasterPostPayload serializes null and breaks scoped hydration.
  const originalFindById = Tenant.findById;
  Tenant.findById = (tenantId) => ({ lean: async () => ({ _id: tenantId, status: 'active' }) });
  const app = createCallEntryApp();

  try {
    const client = await request(app, {
      path: '/api/icallmate/outgoing-call',
      headers: { 'x-test-role': 'client', 'x-session-tenant': 'tenant-a' },
      body: { phone: '+919876543210', dryRun: true, tenantId: 'tenant-b' }
    });
    const webmasterMissing = await request(app, {
      path: '/api/icallmate/outgoing-call',
      headers: { 'x-test-role': 'webmaster' },
      body: { phone: '+919876543210', dryRun: true }
    });
    const webmaster = await request(app, {
      path: '/api/icallmate/outgoing-call',
      headers: { 'x-test-role': 'webmaster' },
      body: { phone: '+919876543210', dryRun: true, tenantId: 'tenant-c' }
    });

    assert.equal(client.status, 200);
    assert.equal(JSON.parse(client.body.payload.fieldpairs[0].extraparam).tenantId, 'tenant-a');
    assert.equal(webmasterMissing.status, 403);
    assert.equal(webmaster.status, 200);
    assert.equal(JSON.parse(webmaster.body.payload.fieldpairs[0].extraparam).tenantId, 'tenant-c');
  } finally {
    Tenant.findById = originalFindById;
  }
});

function createAgentModel(records) {
  const queries = [];
  return {
    queries,
    findOne(filter) {
      queries.push(filter);
      const record = records.find((candidate) => (
        (!filter._id || String(candidate._id) === String(filter._id))
        && String(candidate.tenantId) === String(filter.tenantId)
        && (!filter.is_default || candidate.is_default)
        && candidate.is_active
        && candidate.status !== 'archived'
      )) || null;
      return {
        sort() { return this; },
        async lean() { return record ? { ...record } : null; }
      };
    }
  };
}

test('agent lookup preserves ObjectId-shaped strings and scopes explicit/default selection by tenant', async () => {
  // Mutation caught: Number(agentId) becomes null/NaN and global default lookup selects another tenant.
  const agentA = '64b64c8f0f1e2d3c4b5a6978';
  const agentB = '64b64c8f0f1e2d3c4b5a6979';
  const Model = createAgentModel([
    { _id: agentA, tenantId: 'tenant-a', status: 'active', is_active: true, is_default: true },
    { _id: agentB, tenantId: 'tenant-b', status: 'active', is_active: true, is_default: true }
  ]);
  const lookup = createAgentConfigLookup({ AgentModel: Model });

  assert.equal(normalizeRequestedAgentId(` ${agentA} `), agentA);
  assert.equal((await lookup.getAgentConfigById(agentA, 'tenant-a'))._id, agentA);
  assert.equal(await lookup.getAgentConfigById(agentB, 'tenant-a'), null);
  assert.equal((await lookup.getDefaultAgentConfig('tenant-a'))._id, agentA);
  assert.ok(Model.queries.every((query) => query.tenantId === 'tenant-a'));
});

test('invalid agent IDs and missing tenant context fail safely without querying Mongo', async () => {
  // Mutation caught: passing malformed IDs to Mongo throws CastError or missing tenant performs a global lookup.
  const Model = createAgentModel([]);
  const lookup = createAgentConfigLookup({ AgentModel: Model });

  assert.equal(normalizeRequestedAgentId('not-an-object-id'), 'not-an-object-id');
  assert.equal(await lookup.getAgentConfigById('not-an-object-id', 'tenant-a'), null);
  await assert.rejects(() => lookup.getAgentConfigById('64b64c8f0f1e2d3c4b5a6978'), /tenant/i);
  await assert.rejects(() => lookup.getDefaultAgentConfig(), /tenant/i);
  assert.equal(Model.queries.length, 0);
});
