'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.AUTH_SIGNING_SECRET = 'test-only-auth-signing-secret-with-more-than-32-bytes';

const {
  AUTH_COOKIE_NAME,
  createAuthToken,
  getAuthConfigurationIssues,
  readAuthSession,
  requireRole
} = require('../src/auth');
const { isAdminOnlyRequest } = require('../src/authorization');

function requestForToken(token) {
  return {
    headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` },
    path: '/api/customers'
  };
}

test('signed sessions preserve a valid role and reject payload tampering', () => {
  const token = createAuthToken('agent1', 'AGENT');
  const session = readAuthSession(requestForToken(token));

  assert.equal(session.username, 'agent1');
  assert.equal(session.role, 'AGENT');

  const [encodedPayload, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  payload.role = 'ADMIN';
  const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

  assert.equal(readAuthSession(requestForToken(`${tamperedPayload}.${signature}`)), null);
  assert.throws(() => createAuthToken('agent1', 'OWNER'), /invalid user or role/);
  assert.throws(() => createAuthToken('agent1'), /invalid user or role/);
  assert.notEqual(createAuthToken('agent1', 'AGENT'), token);
});

test('production auth configuration requires dedicated strong values', () => {
  const missingIssues = getAuthConfigurationIssues({ NODE_ENV: 'production' });
  assert.ok(missingIssues.some((issue) => issue.includes('ADMIN_USERNAME')));
  assert.ok(missingIssues.some((issue) => issue.includes('ADMIN_PASSWORD_HASH')));
  assert.ok(missingIssues.some((issue) => issue.includes('AUTH_SIGNING_SECRET')));

  const reusedSecret = 'provider-secret-that-is-definitely-longer-than-thirty-two-bytes';
  const reusedIssues = getAuthConfigurationIssues({
    NODE_ENV: 'production',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: '$2b$12$Q20g.BM7iK9FvqrVI4U/H.EcP9UeJpUyPnvve7PjU76G4bdE6wd4e',
    AUTH_SIGNING_SECRET: reusedSecret,
    GEMINI_API_KEY: reusedSecret
  });
  assert.ok(reusedIssues.some((issue) => issue.includes('must not reuse')));

  const validIssues = getAuthConfigurationIssues({
    NODE_ENV: 'production',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: '$2b$12$Q20g.BM7iK9FvqrVI4U/H.EcP9UeJpUyPnvve7PjU76G4bdE6wd4e',
    AUTH_SIGNING_SECRET: 'independent-signing-secret-with-at-least-32-bytes'
  });
  assert.deepEqual(validIssues, []);
});

test('admin role middleware denies agents and permits admins', () => {
  const middleware = requireRole('ADMIN');
  let nextCalled = false;
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };

  middleware(
    { path: '/api/feedback', adminSession: { username: 'agent1', role: 'AGENT' } },
    response,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 403);

  middleware(
    { path: '/api/feedback', adminSession: { username: 'admin', role: 'ADMIN' } },
    response,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
});

test('route policy protects sensitive operations while retaining agent workflows', () => {
  const protectedRequests = [
    { method: 'GET', path: '/feedback.html' },
    { method: 'GET', path: '/api/feedback' },
    { method: 'GET', path: '/api/logs' },
    { method: 'POST', path: '/call/start' },
    { method: 'POST', path: '/api/calls/initiate/42' },
    { method: 'DELETE', path: '/api/customers/42' },
    { method: 'POST', path: '/api/customers/csv' },
    { method: 'PUT', path: '/api/campaigns/3' },
    { method: 'GET', path: '/api/icallmate/config' }
  ];
  protectedRequests.forEach((request) => assert.equal(isAdminOnlyRequest(request), true));

  const agentRequests = [
    { method: 'POST', path: '/api/icallmate/callback' },
    { method: 'GET', path: '/admin.html' },
    { method: 'GET', path: '/customers.html' },
    { method: 'GET', path: '/api/customers' },
    { method: 'POST', path: '/api/customers' },
    { method: 'PUT', path: '/api/customers/42' },
    { method: 'POST', path: '/api/customers/42/retry' },
    { method: 'GET', path: '/api/calls/recent' }
  ];
  agentRequests.forEach((request) => assert.equal(isAdminOnlyRequest(request), false));
});
