'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Duplex } = require('node:stream');

const { mountTenantScopedRoutes } = require('../src/tenant-route-mounts');
const { createClientsRouter } = require('../routes/clients');
const { createCampaignsRouter } = require('../routes/campaigns');
const { createAgentsRouter } = require('../routes/agents');
const { createCallArchiveRouter } = require('../routes/call-archival');
const { requireTenantAccess } = require('../src/auth');
const Tenant = require('../src/models/Tenant');
const tenantsRouter = require('../routes/tenants');

function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '$ne' in expected) {
      return record[key] !== expected.$ne;
    }
    return String(record[key]) === String(expected);
  });
}

function resolveUpdate(record, update) {
  const stages = Array.isArray(update) ? update : [update];
  for (const stage of stages) {
    const snapshot = { ...record };
    const values = {};
    for (const [key, expression] of Object.entries(stage.$set || {})) {
      if (typeof expression === 'string' && expression.startsWith('$')) {
        values[key] = snapshot[expression.slice(1)];
      } else if (expression && typeof expression === 'object' && '$ifNull' in expression) {
        const [reference, fallback] = expression.$ifNull;
        const resolved = typeof reference === 'string' && reference.startsWith('$')
          ? snapshot[reference.slice(1)]
          : reference;
        const resolvedFallback = typeof fallback === 'string' && fallback.startsWith('$')
          ? snapshot[fallback.slice(1)]
          : fallback;
        values[key] = resolved ?? resolvedFallback;
      } else {
        values[key] = expression;
      }
    }
    Object.assign(record, values);
  }
}

function createMemoryModel(initialRecords) {
  const records = initialRecords.map((record) => ({ ...record }));
  return {
    records,
    async findOneAndUpdate(filter, update) {
      const record = records.find((candidate) => matches(candidate, filter));
      if (!record) return null;
      resolveUpdate(record, update);
      return { ...record };
    },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const record of records) {
        if (!matches(record, filter)) continue;
        resolveUpdate(record, update);
        modifiedCount += 1;
      }
      return { modifiedCount };
    }
  };
}

function tenantMiddleware(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return res.status(403).json({ error: 'tenant required' });
  req.tenantId = tenantId;
  req.adminSession = { username: 'admin@example.com', role: 'CLIENT_ADMIN', tenantId };
  return next();
}

function probeRouter() {
  const router = express.Router();
  router.get('/probe', (req, res) => res.json({ tenantId: req.tenantId }));
  return router;
}

async function request(app, { method = 'GET', path = '/', body, headers = {} }) {
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

test('mounted call and feedback routes reject requests without concrete tenant context', async () => {
  // Mutation caught: mounting call or feedback routes without requireTenantAccess permits undefined tenant queries.
  const app = express();
  const originalFindById = Tenant.findById;
  Tenant.findById = (tenantId) => ({ lean: async () => ({ _id: tenantId, status: 'active' }) });
  app.use((req, _res, next) => {
    if (req.headers['x-tenant-id']) {
      req.adminSession = { username: 'admin@example.com', role: 'CLIENT_ADMIN', tenantId: req.headers['x-tenant-id'] };
    }
    next();
  });
  mountTenantScopedRoutes(app, {
    requireTenantAccess,
    usersRouter: probeRouter(),
    customersRouter: probeRouter(),
    clientsRouter: probeRouter(),
    campaignsRouter: probeRouter(),
    feedbackRouter: probeRouter(),
    agentsRouter: probeRouter(),
    callArchiveRouter: probeRouter()
  });

  try {
    assert.equal((await request(app, { path: '/api/calls/probe' })).status, 401);
    assert.equal((await request(app, { path: '/api/feedback/probe' })).status, 401);
    assert.deepEqual(
      (await request(app, { path: '/api/calls/probe', headers: { 'x-tenant-id': 'tenant-a' } })).body,
      { tenantId: 'tenant-a' }
    );
    assert.deepEqual(
      (await request(app, { path: '/api/feedback/probe', headers: { 'x-tenant-id': 'tenant-a' } })).body,
      { tenantId: 'tenant-a' }
    );
  } finally {
    Tenant.findById = originalFindById;
  }
});

for (const [name, createRouter] of [
  ['client', createClientsRouter],
  ['campaign', createCampaignsRouter],
  ['agent', createAgentsRouter]
]) {
  test(`${name} compatibility DELETE archives and explicit restore recovers only the current tenant`, async () => {
    // Mutation caught: compatibility route calls rejected SQL adapters, removes data, or crosses tenant scope.
    const Model = createMemoryModel([
      { _id: `${name}-a`, tenantId: 'tenant-a', status: name === 'client' ? 'paused' : 'active' },
      { _id: `${name}-b`, tenantId: 'tenant-b', status: 'active' }
    ]);
    const app = express();
    app.use(express.json());
    app.use(tenantMiddleware);
    app.use(`/api/${name === 'campaign' ? 'campaigns' : `${name}s`}`, createRouter({ Model }));
    const base = `/api/${name === 'campaign' ? 'campaigns' : `${name}s`}/${name}-a`;

    const compatibility = await request(app, {
      method: 'DELETE', path: base, headers: { 'x-tenant-id': 'tenant-a' }, body: { reason: 'review test' }
    });
    assert.equal(compatibility.status, 200);
    assert.equal(Model.records.length, 2);
    assert.equal(Model.records[0].status, 'archived');
    assert.equal(Model.records[1].status, 'active');
    assert.equal('archived_by' in compatibility.body.resource, false);

    const restored = await request(app, {
      method: 'POST', path: `${base}/restore`, headers: { 'x-tenant-id': 'tenant-a' }, body: {}
    });
    assert.equal(restored.status, 200);
    assert.equal(Model.records[0].status, name === 'client' ? 'paused' : 'active');

    const explicit = await request(app, {
      method: 'POST', path: `${base}/archive`, headers: { 'x-tenant-id': 'tenant-a' }, body: { reason: 'review test' }
    });
    assert.equal(explicit.status, 200);
    assert.deepEqual(Object.keys(explicit.body).sort(), Object.keys(compatibility.body).sort());
  });
}

test('mounted call bulk archive and restore retain cross-tenant call records and original statuses', async () => {
  // Mutation caught: missing tenant middleware or undefined tenant filter archives/restores every tenant's calls.
  const CallModel = createMemoryModel([
    { _id: 'call-a', tenantId: 'tenant-a', status: 'completed' },
    { _id: 'call-b', tenantId: 'tenant-b', status: 'queued' }
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api/calls', tenantMiddleware, createCallArchiveRouter({ CallModel }));

  const archived = await request(app, {
    method: 'DELETE', path: '/api/calls/bulk', headers: { 'x-tenant-id': 'tenant-a' }, body: {}
  });
  assert.equal(archived.status, 200);
  assert.equal(CallModel.records[0].status, 'archived');
  assert.equal(CallModel.records[1].status, 'queued');

  const restored = await request(app, {
    method: 'POST', path: '/api/calls/bulk/restore', headers: { 'x-tenant-id': 'tenant-a' }, body: {}
  });
  assert.equal(restored.status, 200);
  assert.equal(CallModel.records[0].status, 'completed');
  assert.equal(CallModel.records[1].status, 'queued');
});

test('Tenant and Campaign PUT normalize lifecycle status and reject archived or malformed values before update', async () => {
  // Mutation caught: comparing the raw status lets whitespace-padded archived or malformed values bypass lifecycle validation.
  const originalTenantUpdate = Tenant.findOneAndUpdate;
  let tenantUpdates = 0;
  Tenant.findOneAndUpdate = async () => {
    tenantUpdates += 1;
    return { _id: 'tenant-a', status: 'archived' };
  };
  const CampaignModel = createMemoryModel([
    { _id: 'campaign-a', tenantId: 'tenant-a', name: 'Paused campaign', status: 'paused' }
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminSession = { username: 'webmaster', role: 'WEBMASTER' };
    req.tenantId = 'tenant-a';
    next();
  });
  app.use('/api/tenants', tenantsRouter);
  app.use('/api/campaigns', createCampaignsRouter({ Model: CampaignModel }));

  try {
    const tenant = await request(app, {
      method: 'PUT', path: '/api/tenants/tenant-a', body: { status: ' archived ' }
    });
    const campaign = await request(app, {
      method: 'PUT', path: '/api/campaigns/campaign-a', body: { name: 'Paused campaign', status: ' archived ' }
    });
    const malformedTenant = await request(app, {
      method: 'PUT', path: '/api/tenants/tenant-a', body: { status: 'not-a-status' }
    });
    const malformedCampaign = await request(app, {
      method: 'PUT', path: '/api/campaigns/campaign-a', body: { name: 'Paused campaign', status: 'not-a-status' }
    });

    assert.equal(tenant.status, 400);
    assert.equal(campaign.status, 400);
    assert.equal(malformedTenant.status, 400);
    assert.equal(malformedCampaign.status, 400);
    assert.equal(tenantUpdates, 0);
    assert.equal(CampaignModel.records[0].status, 'paused');
  } finally {
    Tenant.findOneAndUpdate = originalTenantUpdate;
  }
});

test('Agent PUT proves the tenant-scoped target exists before changing existing defaults', async () => {
  // Mutation caught: clearing defaults before a stale/wrong-tenant target lookup leaves the tenant with no default.
  let clearedDefaults = 0;
  const Model = {
    findOne() {
      return { async lean() { return null; } };
    },
    async updateMany() {
      clearedDefaults += 1;
      return { modifiedCount: 1 };
    },
    async findOneAndUpdate() {
      return null;
    }
  };
  const app = express();
  app.use(express.json());
  app.use(tenantMiddleware);
  app.use('/api/agents', createAgentsRouter({ Model }));

  const response = await request(app, {
    method: 'PUT',
    path: '/api/agents/stale-agent',
    headers: { 'x-tenant-id': 'tenant-a' },
    body: {
      name: 'Default Agent',
      language: 'en',
      opening_prompt: 'Hello',
      is_default: true
    }
  });

  assert.equal(response.status, 404);
  assert.equal(clearedDefaults, 0);
});
