const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const request = require('supertest');
const { loadRuntimeConfig } = require('../config/runtime-config');
const { createLogger } = require('../logging/logger');
const { createHealthHandler, shutdownRuntime } = require('../runtime/lifecycle');

function validEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    PORT: '3000',
    SUPABASE_DB_URL: 'postgresql://runtime:password@db.example.test:5432/postgres',
    SUPABASE_DB_CA_CERT: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
    COOKIE_SECRET: 'production-cookie-secret-at-least-32-bytes',
    NGROK_URL: 'https://calls.example.test',
    ...overrides
  };
}

test('runtime configuration fails fast with stable codes and does not require the secret key', () => {
  for (const field of ['SUPABASE_DB_URL', 'SUPABASE_DB_CA_CERT', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'COOKIE_SECRET']) {
    const env = validEnv();
    delete env[field];
    assert.throws(
      () => loadRuntimeConfig(env),
      (error) => error.code === `CONFIG_${field}_REQUIRED`
    );
  }
  assert.doesNotThrow(() => loadRuntimeConfig(validEnv({ SUPABASE_SECRET_KEY: '' })));
  assert.throws(
    () => loadRuntimeConfig(validEnv({ COOKIE_SECRET: 'short' })),
    (error) => error.code === 'CONFIG_COOKIE_SECRET_TOO_SHORT'
  );
});

test('test-only TLS override is explicit and cannot weaken production', () => {
  const testConfig = validEnv({
    NODE_ENV: 'test',
    SUPABASE_DB_CA_CERT: '',
    SUPABASE_DB_TLS_INSECURE_TEST_ONLY: 'true'
  });
  assert.equal(loadRuntimeConfig(testConfig).databaseSsl.rejectUnauthorized, false);
  assert.throws(
    () => loadRuntimeConfig(validEnv({ SUPABASE_DB_CA_CERT: '', SUPABASE_DB_TLS_INSECURE_TEST_ONLY: 'true' })),
    (error) => error.code === 'CONFIG_SUPABASE_DB_CA_CERT_REQUIRED'
  );
});

test('structured logger emits one-line JSON and redacts sensitive values', () => {
  const lines = [];
  const logger = createLogger({ sink: { log: (line) => lines.push(line), error: (line) => lines.push(line) }, clock: () => new Date('2026-08-26T00:00:00Z') });
  logger.info('request_completed', {
    database: 'postgresql://user:secret@db.example.test/postgres',
    cookie: 'session=secret-cookie',
    phone: '+919876543210',
    transcript: 'The customer said private medical feedback',
    authorization: 'Bearer private-token'
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('\n'), false);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, 'request_completed');
  const serialized = JSON.stringify(parsed);
  for (const secret of ['secret@', 'secret-cookie', '+919876543210', 'private medical feedback', 'private-token']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('health follows Postgres connectivity', async () => {
  let connected = true;
  const app = express();
  app.get('/health', createHealthHandler({ ping: async () => {
    if (!connected) throw new Error('offline');
    return true;
  }, clock: () => new Date('2026-08-26T00:00:00Z') }));
  await request(app).get('/health').expect(200, { ok: true, database: 'connected', timestamp: '2026-08-26T00:00:00.000Z' });
  connected = false;
  await request(app).get('/health').expect(503, { ok: false, database: 'unavailable', timestamp: '2026-08-26T00:00:00.000Z' });
});

test('graceful shutdown stops scheduling, drains HTTP, and closes Postgres', async () => {
  const calls = [];
  await shutdownRuntime({
    stopScheduler: async () => calls.push('scheduler'),
    server: { listening: true, close(callback) { calls.push('server'); callback(); } },
    postgres: { async close() { calls.push('postgres'); } },
    logger: { info() {}, error() {} }
  });
  assert.deepEqual(calls, ['scheduler', 'server', 'postgres']);
});
