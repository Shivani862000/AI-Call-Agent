'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.NODE_ENV = 'test';
process.env.AUTH_SIGNING_SECRET = 'test-only-auth-signing-secret-with-more-than-32-bytes';

const {
  AUTH_COOKIE_NAME,
  createAuthToken,
  getAuthConfigurationIssues,
  readAuthSession,
  requireRole,
  verifyCredentials
} = require('../src/auth');
const User = require('../src/models/User');
const Tenant = require('../src/models/Tenant');
const { isAdminOnlyRequest } = require('../src/authorization');

function requestForToken(token) {
  return {
    headers: { cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` },
    path: '/api/customers'
  };
}

test('signed sessions preserve a valid role and reject payload tampering', () => {
  const token = createAuthToken('webmaster1', 'WEBMASTER');
  const session = readAuthSession(requestForToken(token));

  assert.equal(session.username, 'webmaster1');
  assert.equal(session.role, 'WEBMASTER');

  const [encodedPayload, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  payload.role = 'ADMIN';
  const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

  assert.equal(readAuthSession(requestForToken(`${tamperedPayload}.${signature}`)), null);
  assert.throws(() => createAuthToken('webmaster1', 'OWNER'), /invalid user or role/);
  assert.throws(() => createAuthToken('webmaster1'), /invalid user or role/);
  assert.notEqual(createAuthToken('webmaster1', 'WEBMASTER'), token);
});

test('production auth configuration requires a dedicated strong signing secret', () => {
  const missingIssues = getAuthConfigurationIssues({ NODE_ENV: 'production' });
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

test('client administrator middleware denies client agents and permits client administrators', () => {
  const middleware = requireRole('CLIENT_ADMIN');
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
    { path: '/api/feedback', adminSession: { username: 'agent1', role: 'CLIENT_AGENT' } },
    response,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 403);

  middleware(
    { path: '/api/feedback', adminSession: { username: 'admin', role: 'CLIENT_ADMIN' } },
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

test('credential verification rejects suspended accounts', async () => {
  const { verifyCredentials } = require('../src/auth');
  const originalFindOne = User.findOne;
  const passwordHash = await bcrypt.hash('correct-horse-battery-staple', 4);
  User.findOne = async () => ({
    username: 'suspended-wm',
    password_hash: passwordHash,
    role: 'WEBMASTER',
    status: 'suspended',
    platformAccessLevel: 'ADMIN',
    tenantId: null
  });

  try {
    assert.deepEqual(
      await verifyCredentials('suspended-wm', 'correct-horse-battery-staple'),
      { success: false }
    );
  } finally {
    User.findOne = originalFindOne;
  }
});

test('credential verification accepts email only for active users with an active tenant', async () => {
  const originalFindOne = User.findOne;
  const originalFindById = Tenant.findById;
  const passwordHash = await bcrypt.hash('correct-horse-battery-staple', 4);
  User.findOne = async () => ({
    username: 'client-admin',
    password_hash: passwordHash,
    role: 'CLIENT_ADMIN',
    status: 'active',
    tenantId: 'tenant-1'
  });
  Tenant.findById = async () => ({ status: 'suspended' });

  try {
    assert.deepEqual(
      await verifyCredentials('admin@example.com', 'correct-horse-battery-staple'),
      { success: false }
    );
  } finally {
    User.findOne = originalFindOne;
    Tenant.findById = originalFindById;
  }
});

test('reserved environment username never falls through to a database Webmaster credential', async () => {
  const originalFindOne = User.findOne;
  const originalAdminUsername = process.env.ADMIN_USERNAME;
  const originalAdminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
  const databasePasswordHash = await bcrypt.hash('database-password', 4);
  process.env.ADMIN_USERNAME = 'root';
  process.env.ADMIN_PASSWORD_HASH = await bcrypt.hash('environment-password', 4);
  User.findOne = async () => ({
    username: 'root',
    email: 'root@example.com',
    password_hash: databasePasswordHash,
    role: 'WEBMASTER',
    status: 'active',
    platformAccessLevel: 'ADMIN',
    tenantId: null
  });

  try {
    assert.deepEqual(await verifyCredentials('root', 'database-password'), { success: false });
  } finally {
    User.findOne = originalFindOne;
    if (originalAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = originalAdminUsername;
    if (originalAdminPasswordHash === undefined) delete process.env.ADMIN_PASSWORD_HASH;
    else process.env.ADMIN_PASSWORD_HASH = originalAdminPasswordHash;
  }
});

test('credential verification rejects active Webmasters without platform access', async () => {
  const originalFindOne = User.findOne;
  const passwordHash = await bcrypt.hash('database-password', 4);
  User.findOne = async () => ({
    username: 'unassigned-wm',
    email: 'unassigned-wm@example.com',
    password_hash: passwordHash,
    role: 'WEBMASTER',
    status: 'active',
    platformAccessLevel: null,
    tenantId: null
  });

  try {
    assert.deepEqual(await verifyCredentials('unassigned-wm', 'database-password'), { success: false });
  } finally {
    User.findOne = originalFindOne;
  }
});
