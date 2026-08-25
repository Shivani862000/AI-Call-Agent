'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { WebmasterError } = require('../src/webmaster/errors');
const { createUsersRouter } = require('../routes/users');

function serviceDouble(calls) {
  return {
    async listTenantUsers(tenantId, options) {
      calls.push({ operation: 'list', tenantId, options });
      return { items: [], page: options.page, pageSize: options.pageSize, total: 0, totalPages: 0 };
    },
    async createTenantUser(tenantId, body, actor) {
      calls.push({ operation: 'create', tenantId, body, actor });
      return { id: 'u1', ...body, password: undefined, status: 'active', version: 0 };
    },
    async updateTenantUser(tenantId, userId, patch, version, actor) {
      calls.push({ operation: 'update', tenantId, userId, patch, version, actor });
      return { id: userId, ...patch, status: 'active', version: version + 1 };
    },
    async replacePassword(userId, password, version, actor, tenantId) {
      calls.push({ operation: 'password', tenantId, userId, password, version, actor });
      return { id: userId, status: 'active', version: version + 1 };
    },
    async transitionTenantUser(tenantId, userId, transition, version, actor, reason) {
      calls.push({ operation: 'lifecycle', tenantId, userId, transition, version, actor, reason });
      return { id: userId, status: transition === 'suspend' ? 'suspended' : 'active', version: version + 1 };
    }
  };
}

async function withServer(userService, work) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.adminSession = { username: 'tenant-admin', role: req.headers['x-role'] || 'CLIENT_ADMIN' };
    req.tenantId = 'tenant-a';
    next();
  });
  app.use('/api/users', createUsersRouter({ userService }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await work(`http://127.0.0.1:${server.address().port}/api/users`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('tenant user routes compose list, create, edit, password, and lifecycle operations', async () => {
  const calls = [];
  await withServer(serviceDouble(calls), async base => {
    const listed = await fetch(`${base}?page=2&pageSize=10&role=CLIENT_ADMIN&status=active&search=ann`);
    assert.equal(listed.status, 200);

    const created = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ann', email: 'ann@example.test', role: 'CLIENT_ADMIN', password: 'temporary-pass', tenantId: 'foreign' })
    });
    assert.equal(created.status, 201);

    const updated = await fetch(`${base}/u1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { username: 'ann', email: 'ann@example.test', role: 'CLIENT_AGENT' }, expectedVersion: 2 })
    });
    assert.equal(updated.status, 200);

    const password = await fetch(`${base}/u1/password`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'replacement-pass', expectedVersion: 3 })
    });
    assert.equal(password.status, 200);

    const lifecycle = await fetch(`${base}/u1/lifecycle`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transition: 'suspend', expectedVersion: 4, reason: 'Access paused' })
    });
    assert.equal(lifecycle.status, 200);
  });

  assert.deepEqual(calls.map(call => call.operation), ['list', 'create', 'update', 'password', 'lifecycle']);
  assert.ok(calls.every(call => call.tenantId === 'tenant-a'));
  assert.equal(calls[0].options.page, 2);
  assert.equal(calls[0].options.search, 'ann');
  assert.equal(calls[1].body.tenantId, undefined);
});

test('tenant user routes reject client agents before service access', async () => {
  const calls = [];
  await withServer(serviceDouble(calls), async base => {
    const response = await fetch(base, { headers: { 'x-role': 'CLIENT_AGENT' } });
    assert.equal(response.status, 403);
  });
  assert.equal(calls.length, 0);
});

test('tenant user routes retain safe domain error details', async () => {
  const userService = serviceDouble([]);
  userService.updateTenantUser = async () => {
    throw new WebmasterError({
      status: 409,
      code: 'USER_VERSION_CONFLICT',
      message: 'User changed; refresh and retry',
      fieldErrors: { expectedVersion: 'Refresh required' }
    });
  };

  await withServer(userService, async base => {
    const response = await fetch(`${base}/u1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { username: 'ann', email: 'ann@example.test', role: 'CLIENT_AGENT' }, expectedVersion: 2 })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      status: 409,
      code: 'USER_VERSION_CONFLICT',
      message: 'User changed; refresh and retry',
      error: 'User changed; refresh and retry',
      fieldErrors: { expectedVersion: 'Refresh required' }
    });
  });
});
