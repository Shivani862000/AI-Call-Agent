'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IDENTITY_ENV = 'AI_CALL_AGENT_TEST_DB_IDENTITY';

function fail(message) {
  const error = new Error(`Unsafe test database configuration: ${message}`);
  error.code = 'UNSAFE_TEST_DATABASE';
  throw error;
}

function readOwnedDatabaseIdentity(env = process.env, expectedPurpose) {
  if (env.NODE_ENV !== 'test') fail('NODE_ENV must be test');
  const identityPath = env[IDENTITY_ENV];
  if (!identityPath || !path.isAbsolute(identityPath)) fail(`${IDENTITY_ENV} must be an absolute path`);

  let stat;
  let identity;
  try {
    stat = fs.statSync(identityPath);
    identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  } catch {
    fail('runner identity is missing or unreadable');
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) fail('runner identity permissions are not private');
  if (!identity.runId || identity.runId !== env.AI_CALL_AGENT_TEST_RUN_ID) fail('run identity does not match');
  if (!identity.purpose || (expectedPurpose && identity.purpose !== expectedPurpose)) {
    fail(`connection purpose does not match${expectedPurpose ? ` ${expectedPurpose}` : ''}`);
  }
  if (!identity.connectionString || identity.connectionString !== env.DATABASE_URL) fail('DATABASE_URL does not match runner identity');

  let url;
  try { url = new URL(identity.connectionString); } catch { fail('connection URL is invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail('connection is not PostgreSQL');
  const internalContainer = identity.transport === 'docker-internal'
    && identity.internalNetwork === true && identity.containerId && identity.networkId;
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) && !internalContainer) {
    fail('database host is neither loopback nor an owned internal container');
  }
  if (url.hostname !== identity.host || Number(url.port) !== identity.port
      || decodeURIComponent(url.pathname.slice(1)) !== identity.database
      || decodeURIComponent(url.username) !== identity.user) {
    fail('endpoint/database/user does not match runner identity');
  }
  if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith('unix://') && !env.DOCKER_HOST.startsWith('npipe://')) {
    fail('remote Docker targets are unsupported');
  }
  return Object.freeze({ ...identity });
}

function assertOwnedTestDatabase(connectionString, env = process.env, expectedPurpose) {
  const identity = readOwnedDatabaseIdentity(env, expectedPurpose);
  if (connectionString !== identity.connectionString) fail('requested connection does not match runner identity');
  return identity;
}

module.exports = { IDENTITY_ENV, readOwnedDatabaseIdentity, assertOwnedTestDatabase };
