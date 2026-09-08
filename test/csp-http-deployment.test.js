'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serveAuthorizationApp } = require('./support/authorization-app');

test('plain HTTP pages do not force unavailable HTTPS connections', async t => {
  const app = await serveAuthorizationApp(t, 'http://localhost:3000');
  const response = await app.request('GET', '/login.html');
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.headers['content-security-policy'], /upgrade-insecure-requests/);
  assert.equal(response.headers['strict-transport-security'], undefined);
});

test('HTTPS pages retain transport security headers after app extraction', async t => {
  const app = await serveAuthorizationApp(t, 'https://example.test');
  const response = await app.request('GET', '/login.html');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-security-policy'], /upgrade-insecure-requests/);
  assert.ok(response.headers['strict-transport-security']);
});
