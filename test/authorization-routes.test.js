'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serveAuthorizationApp } = require('./support/authorization-app');

test('anonymous URL variants cannot reach protected API or call handlers', async t => {
  const app = await serveAuthorizationApp(t);
  for (const [method, route] of [
    ['GET', '/api/users'], ['GET', '/API/users'], ['POST', '/API/users/'],
    ['POST', '/call/start'], ['POST', '/call/start/'], ['POST', '/CALL/START'],
    ['GET', '/api/patients/'], ['GET', '/API/calls/recent'],
    ['GET', '/api//users'], ['GET', '/%61pi/users'], ['GET', '/api/auth/session']
  ]) {
    const response = await app.request(method, route);
    assert.ok([400, 401, 404].includes(response.status), `${method} ${route}: ${response.status}`);
  }
  assert.deepEqual(app.reached, []);
});

test('agents cannot bypass ADMIN checks with case, slashes or parameter spelling', async t => {
  const app = await serveAuthorizationApp(t);
  for (const [method, route] of [
    ['GET', '/api/Users'], ['POST', '/api/users/'],
    ['POST', '/api/calls/initiate/42/'], ['POST', '/api/calls/initiate/+42'],
    ['POST', '/api/calls/initiate/%2042%20'], ['POST', '/api/calls/initiate/%2B42'],
    ['POST', '/API/calls/42/ESCALATE/'], ['POST', '/api/calls/+42/escalate'],
    ['POST', '/api/calls/42/analyze/'], ['POST', '/CALL/START/'],
    ['GET', '/API/patients/import/template'], ['DELETE', '/API/patients/42'],
    ['POST', '/API/customers/csv/'], ['PUT', '/API/campaigns/42'],
    ['GET', '/API/support-tickets/'], ['GET', '/API/settings/'],
    ['POST', '/api/icallmate/outgoing-call'], ['GET', '/api/icallmate/config'],
    ['GET', '/ICALLMATE/health/'], ['HEAD', '/api/users']
  ]) {
    const response = await app.request(method, route, 'AGENT');
    assert.equal(response.status, 403, `${method} ${route}`);
  }
  assert.deepEqual(app.reached, []);
});

test('static normalization and encoded filenames cannot expose protected HTML', async t => {
  const app = await serveAuthorizationApp(t);
  for (const route of ['/settings.html', '/Settings.html', '/settings.html/',
    '/set%74ings.html', '/%73ettings.html', '/x/../settings.html', '/x/%2e%2e/settings.html',
    '//settings.html', '/settings.html%2f', '/components/../settings.html', '/admin.html']) {
    const response = await app.request('GET', route);
    assert.ok([302, 400, 401, 403, 404].includes(response.status), `${route}: ${response.status}`);
  }
  const denied = await app.request('GET', '/SETTINGS.html/', 'AGENT');
  assert.equal(denied.status, 403);
});

test('duplicate slashes cannot bypass guards before nested import routers', async t => {
  const app = await serveAuthorizationApp(t);
  for (const route of ['/api/customers//csv', '/api/patients//import/commit',
    '/api/patients//import/preview', '/api//users']) {
    assert.equal((await app.request('POST', route, 'AGENT')).status, 400, route);
  }
  assert.deepEqual(app.reached, []);
});

test('valid agent workflows, admin actions and public provider boundaries remain reachable', async t => {
  const app = await serveAuthorizationApp(t);
  for (const [method, route, role] of [
    ['GET', '/api/patients', 'AGENT'], ['POST', '/api/customers', 'AGENT'],
    ['POST', '/API/support-tickets/', 'AGENT'], ['GET', '/api/campaigns', 'AGENT'],
    ['GET', '/api/calls/recent', 'AGENT'], ['GET', '/api/users', 'ADMIN'],
    ['POST', '/api/calls/initiate/42/', 'ADMIN'], ['POST', '/api/calls/42/escalate', 'ADMIN'],
    ['GET', '/health'], ['GET', '/api/auth/session', 'AGENT'], ['POST', '/api/auth/login'],
    ['POST', '/api/auth/logout'], ['POST', '/api/icallmate/callback'],
    ['GET', '/api/icallmate/config', 'ADMIN'], ['GET', '/icallmate/health', 'ADMIN']
  ]) {
    assert.equal((await app.request(method, route, role)).status, 204, `${method} ${route} (${role})`);
  }
  for (const [route, role] of [['/patients.html', 'AGENT'], ['/admin.html', 'AGENT'], ['/settings.html', 'ADMIN'], ['/login.html'], ['/app-shell.js'], ['/app-shell.css'], ['/components/new-call-modal.html', 'AGENT']]) {
    assert.equal((await app.request('GET', route, role)).status, 200, route);
  }
});

test('public exceptions do not exempt other methods or neighboring paths', async t => {
  const app = await serveAuthorizationApp(t);
  for (const [method, route] of [
    ['POST', '/api/auth/session'], ['GET', '/api/auth/login'],
    ['POST', '/api/auth/change-password'], ['GET', '/api/icallmate/callback'],
    ['POST', '/api/icallmate/callback/extra']
  ]) {
    assert.equal((await app.request(method, route)).status, 401, `${method} ${route}`);
  }
  assert.deepEqual(app.reached, []);
});

test('invalid sensitive operation IDs are rejected after authentication and role checks', async t => {
  const app = await serveAuthorizationApp(t);
  for (const id of ['0', '-42', '+42', '%2042%20', '%2B42', '9007199254740992', 'not-an-id', '%2f']) {
    for (const route of [`/api/calls/initiate/${id}`, `/api/calls/${id}/escalate`]) {
      assert.equal((await app.request('POST', route, 'ADMIN')).status, 400, route);
    }
  }
  assert.deepEqual(app.reached, []);
});
