'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { servePrivacyApp } = require('./support/privacy-app');

test('session endpoint reports the current account role instead of the signed token role', async t => {
  const app = await servePrivacyApp(t);
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  app.account.role = 'AGENT';
  const response = await app.request('GET', '/API/auth/session/', token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { authenticated: true, username: 'operator', role: 'AGENT' });
  assert.deepEqual(app.effects, []);
});

test('deactivated and deleted accounts cannot inspect sessions or dispatch protected actions', async t => {
  const app = await servePrivacyApp(t);
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  for (const remove of [false, true]) {
    app.account.is_active = 0;
    if (remove) app.accounts.clear();
    app.auth.invalidateAccountCache();
    for (const [method, target] of [['GET', '/api/auth/session'], ['POST', '/api/calls/42/escalate']]) {
      const response = await app.request(method, target, token);
      assert.equal(response.status, 401, target);
      assert.match(response.headers['set-cookie'][0], /Max-Age=0/);
    }
  }
  assert.deepEqual(app.effects, []);
});

test('account cache invalidation applies demotion immediately to session and action routes', async t => {
  const app = await servePrivacyApp(t);
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  assert.equal((await app.request('GET', '/api/auth/session', token)).body.role, 'ADMIN');
  app.account.role = 'AGENT';
  app.auth.invalidateAccountCache('OPERATOR');
  assert.equal((await app.request('GET', '/api/auth/session', token)).body.role, 'AGENT');
  assert.equal((await app.request('POST', '/API/calls/42/escalate/', token)).status, 403);
  assert.deepEqual(app.effects, []);
});

test('out-of-process account changes are reflected when the 30-second cache expires', async t => {
  const app = await servePrivacyApp(t);
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  await app.request('GET', '/api/auth/session', token);
  app.account.role = 'AGENT';
  app.advance(29999);
  assert.equal((await app.request('GET', '/api/auth/session', token)).body.role, 'ADMIN');
  app.advance(1);
  assert.equal((await app.request('GET', '/api/auth/session', token)).body.role, 'AGENT');
  assert.deepEqual(app.effects, []);
});

test('password reset invalidates old sessions while freshly issued sessions remain usable', async t => {
  const app = await servePrivacyApp(t);
  const old = app.auth.createAuthToken('operator', 'ADMIN');
  app.advance(2000);
  app.account.password_changed_at = '2026-09-08T10:00:02Z';
  assert.equal((await app.request('GET', '/api/auth/session', old)).status, 401);
  const fresh = app.auth.createAuthToken('operator', 'ADMIN', app.account.password_changed_at);
  assert.equal((await app.request('GET', '/api/auth/session', fresh)).status, 200);
  assert.deepEqual(app.effects, []);
});

test('session endpoint rejects expired or missing cookies without sensitive effects', async t => {
  const app = await servePrivacyApp(t);
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  app.advance(12 * 60 * 60 * 1000);
  assert.equal((await app.request('GET', '/api/auth/session', token)).status, 401);
  assert.equal((await app.request('GET', '/api/auth/session')).status, 401);
  assert.deepEqual(app.effects, []);
});

test('session and protected reads fail closed on an unrecognized stored account role', async t => {
  const app = await servePrivacyApp(t);
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  app.account.role = 'OWNER';
  for (const route of ['/api/auth/session', '/api/calls/recent']) {
    assert.equal((await app.request('GET', route, token)).status, 401, route);
  }
  assert.deepEqual(app.effects, []);
});

test('account lookup failure returns temporary unavailability without protected effects', async t => {
  const errors = [];
  const app = await servePrivacyApp(t, { accountError: true,
    console: { ...console, error: (...args) => errors.push(args) } });
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  assert.equal((await app.request('GET', '/api/auth/session', token)).status, 503);
  assert.equal((await app.request('POST', '/api/calls/42/escalate', token)).status, 503);
  assert.equal(errors.length, 2);
  assert.deepEqual(app.effects, []);
});
