'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { createWebmasterRouter } = require('../routes/webmaster');

function authorization(access = 'OWNER') {
  return {
    requireWebmaster(req, _res, next) { req.webmasterActor = { id: 'actor-1', username: 'owner', platformAccessLevel: access, source: 'database' }; next(); },
    requireOwner(req, res, next) { if (access !== 'OWNER') return res.status(403).json({ code: 'WEBMASTER_OWNER_REQUIRED' }); req.webmasterActor = { id: 'actor-1', username: 'owner', platformAccessLevel: access, source: 'database' }; next(); }
  };
}

function services(calls) {
  return {
    auditService: { async record() {} },
    secretService: { async getMetadata() { return { configured: false }; }, async replaceSecret() { return { configured: true }; } },
    settingsService: { async getGlobal() { return { global: { providers: {} }, version: 0 }; }, async getEffectiveForTenant() { return { effective: { providers: {} }, overrides: {}, version: 0 }; } },
    tenantService: { async list() { return { items: [] }; } },
    userService: {
      async updateTenantUser(tenantId, userId, patch, version) { calls.push({ operation: 'update-user', tenantId, userId, patch, version }); return { id: userId, ...patch, version: version + 1 }; },
      async createWebmasterAdmin() { calls.push({ operation: 'create-platform-user' }); return { id: 'p1' }; }
    },
    notificationService: { async retry(id) { calls.push({ operation: 'retry', id }); return { id: 'new-delivery', status: 'delivered' }; } },
    dashboardService: { async get() { return {}; } }
  };
}

async function withServer(router, work) {
  const app = express(); app.use(express.json()); app.use('/api/webmaster', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await work(`http://127.0.0.1:${server.address().port}/api/webmaster`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('composed Webmaster HTTP routes execute user edit and notification retry workflows', async () => {
  const calls = [];
  await withServer(createWebmasterRouter({ authorization: authorization(), services: services(calls) }), async base => {
    const edited = await fetch(`${base}/tenants/t1/users/u1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { username: 'agent', email: 'agent@example.test', role: 'CLIENT_AGENT' }, expectedVersion: 2 }) });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).version, 3);
    const retried = await fetch(`${base}/notification-deliveries/d1/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).status, 'delivered');
  });
  assert.deepEqual(calls.map(item => item.operation), ['update-user', 'retry']);
});

test('composed Webmaster HTTP routes enforce Owner-only platform account creation', async () => {
  const calls = [];
  await withServer(createWebmasterRouter({ authorization: authorization('ADMIN'), services: services(calls) }), async base => {
    const response = await fetch(`${base}/platform-users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'WEBMASTER_OWNER_REQUIRED');
  });
  assert.equal(calls.length, 0);
});
