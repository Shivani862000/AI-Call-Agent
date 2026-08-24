'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { sanitizeForAudit } = require('../src/webmaster/redaction');
const { createAuditService } = require('../src/webmaster/audit-service');

test('deep audit redaction removes credential, identity, patient, and clinical variants', () => {
  // Mutation caught: a renamed or nested sensitive field survives an audit clone.
  const source = {
    status: 'active',
    provider: 'gemini',
    retryCount: 2,
    password_hash: 'hash-value',
    authorizationHeader: 'Bearer token-value',
    nested: {
      apiKey: 'api-secret',
      client_secret: 'client-secret',
      contactEmail: 'person@example.com',
      mobilePhone: '+919999999999',
      patientName: 'Private Person',
      externalIdentifier: 'external-patient-42',
      dateOfBirth: '1980-01-01',
      clinicalNotes: 'private diagnosis',
      callTranscript: 'private words',
      recordingUrl: 'https://example.test/private.wav',
      PHI_payload: { diagnosis: 'private condition' }
    },
    attempts: [
      { outcome: 'failed', credentials: { username: 'private-user', password: 'private-pass' } }
    ]
  };

  const sanitized = sanitizeForAudit(source);

  assert.deepEqual(sanitized, {
    status: 'active',
    provider: 'gemini',
    retryCount: 2,
    password_hash: '[redacted]',
    authorizationHeader: '[redacted]',
    nested: {
      apiKey: '[redacted]',
      client_secret: '[redacted]',
      contactEmail: '[redacted]',
      mobilePhone: '[redacted]',
      patientName: '[redacted]',
      externalIdentifier: '[redacted]',
      dateOfBirth: '[redacted]',
      clinicalNotes: '[redacted]',
      callTranscript: '[redacted]',
      recordingUrl: '[redacted]',
      PHI_payload: '[redacted]'
    },
    attempts: [
      { outcome: 'failed', credentials: '[redacted]' }
    ]
  });
  assert.equal(source.nested.apiKey, 'api-secret');
  assert.notEqual(sanitized, source);
  assert.notEqual(sanitized.nested, source.nested);
});

test('redaction covers encrypted envelopes and free-text customer content while retaining operational fields', () => {
  // Mutation caught: ciphertext, partial secret derivatives, or customer free text enters an audit event.
  const sanitized = sanitizeForAudit({
    integration: 'deepgram',
    configured: true,
    customerCount: 17,
    patientFailureRate: 0.25,
    apiKeyConfigured: true,
    emailProvider: 'smtp',
    encryptionVersion: 1,
    ciphertext: 'encrypted-value',
    iv: 'initialization-vector',
    authTag: 'authentication-tag',
    secretSuffix: 'last-four',
    customerFeedback: 'identifying complaint',
    archiveReason: 'contains a patient name',
    failureCode: 'PROVIDER_TIMEOUT'
  });

  assert.deepEqual(sanitized, {
    integration: 'deepgram',
    configured: true,
    customerCount: 17,
    patientFailureRate: 0.25,
    apiKeyConfigured: true,
    emailProvider: 'smtp',
    encryptionVersion: 1,
    ciphertext: '[redacted]',
    iv: '[redacted]',
    authTag: '[redacted]',
    secretSuffix: '[redacted]',
    customerFeedback: '[redacted]',
    archiveReason: '[redacted]',
    failureCode: 'PROVIDER_TIMEOUT'
  });
});

test('audit service appends one sanitized event using only a stable non-PII actor id', async () => {
  // Mutation caught: audit uses username/email, constructs before redaction, or exposes mutation methods.
  const created = [];
  const AuditEventModel = {
    async create(payload) {
      created.push(payload);
      return { toObject: () => ({ _id: 'audit-1', ...payload }) };
    }
  };
  const service = createAuditService({ AuditEventModel });

  const result = await service.record({
    actor: {
      id: '507f1f77bcf86cd799439012',
      username: 'owner@example.com',
      email: 'owner@example.com',
      platformAccessLevel: 'OWNER'
    },
    action: 'integration.secret.replace',
    target: { type: 'integration-secret', id: 'gemini.apiKey', name: 'Gemini API key' },
    tenantId: '507f1f77bcf86cd799439011',
    before: { configured: false, apiKey: 'old-secret' },
    after: { configured: true, password: 'new-secret', status: 'active' },
    requestId: 'request-123',
    outcome: 'success'
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].actor, '507f1f77bcf86cd799439012');
  assert.equal(created[0].actorAccessLevel, 'OWNER');
  assert.equal('username' in created[0], false);
  assert.equal('email' in created[0], false);
  assert.equal('name' in created[0], false);
  assert.deepEqual(created[0].before, { configured: false, apiKey: '[redacted]' });
  assert.deepEqual(created[0].after, { configured: true, password: '[redacted]', status: 'active' });
  assert.equal(JSON.stringify(result).includes('owner@example.com'), false);
  assert.deepEqual(Object.keys(service), ['record']);
});

test('environment audit actors use a stable synthetic id without copying the configured username', async () => {
  // Mutation caught: the legacy environment Owner's login identifier is persisted as audit identity.
  let payload;
  const service = createAuditService({
    AuditEventModel: {
      async create(value) {
        payload = value;
        return value;
      }
    }
  });

  await service.record({
    actor: { username: 'private-login@example.com', source: 'environment', platformAccessLevel: 'OWNER' },
    action: 'settings.update',
    target: { type: 'platform-settings', id: 'platform' },
    outcome: 'success'
  });

  assert.equal(payload.actor, 'environment-owner');
  assert.equal(JSON.stringify(payload).includes('private-login@example.com'), false);
});

test('redaction fails closed for semantic credential, identity, and free-text variants', () => {
  // Mutation caught: normalized compound variants bypass an exact-key denylist.
  const sanitized = sanitizeForAudit({
    auth: { user: 'database-user', pass: 'database-pass' },
    databaseUrl: 'mongodb://database-user:database-pass@db/private',
    db_uri: 'mongodb://database-user:database-pass@db/private',
    mongoUri: 'mongodb://database-user:database-pass@db/private',
    primaryConnectionString: 'postgres://database-user:database-pass@db/private',
    errorMessage: 'Patient Jane has jane@example.com',
    stackTrace: 'private response body',
    responseHeaders: { setCookie: 'session-secret' },
    responseBody: { jwt: 'signed-token', status: 'rejected' },
    requestPayload: { sessionCookie: 'session-secret' },
    socialSecurityNumber: '123-45-6789',
    birthDate: '1980-01-01',
    DOB: '1980-01-01',
    aadhaarNumber: '1111-2222-3333',
    nested: [{ cookieValue: 'private-cookie', statusCode: 503 }],
    providerStatus: 'degraded',
    patientCount: 4
  });

  assert.deepEqual(sanitized, {
    auth: '[redacted]',
    databaseUrl: '[redacted]',
    db_uri: '[redacted]',
    mongoUri: '[redacted]',
    primaryConnectionString: '[redacted]',
    errorMessage: '[redacted]',
    stackTrace: '[redacted]',
    responseHeaders: '[redacted]',
    responseBody: '[redacted]',
    requestPayload: '[redacted]',
    socialSecurityNumber: '[redacted]',
    birthDate: '[redacted]',
    DOB: '[redacted]',
    aadhaarNumber: '[redacted]',
    nested: [{ cookieValue: '[redacted]', statusCode: 503 }],
    providerStatus: 'degraded',
    patientCount: 4
  });
});

test('redaction deeply serializes maps and BSON values without leaking binary internals', () => {
  // Mutation caught: Map values collapse or ObjectId/Buffer implementation fields enter retained metadata.
  const objectId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
  const date = new Date('2026-08-24T00:00:00.000Z');
  const binary = Buffer.from('secret-bytes');
  const source = {
    metadata: new Map([
      ['status', 'failed'],
      ['retryCount', 2],
      ['details', new Map([
        ['password', 'map-secret'],
        ['provider', 'smtp']
      ])]
    ]),
    objectId,
    date,
    binary
  };

  const sanitized = sanitizeForAudit(source);

  assert.deepEqual(sanitized, {
    metadata: {
      status: 'failed',
      retryCount: 2,
      details: { password: '[redacted]', provider: 'smtp' }
    },
    objectId: '507f1f77bcf86cd799439011',
    date: '2026-08-24T00:00:00.000Z',
    binary: '[binary:12 bytes]'
  });
  assert.equal(source.metadata.get('details').get('password'), 'map-secret');
  assert.equal(binary.toString('utf8'), 'secret-bytes');
  assert.equal(JSON.stringify(sanitized).includes('"data":['), false);
  assert.equal(JSON.stringify(sanitized).includes('secret-bytes'), false);
});

test('audit service rejects invalid outcomes instead of recording a false success', async () => {
  // Mutation caught: `failed` or an unknown outcome is silently converted to success.
  let createCount = 0;
  const service = createAuditService({
    AuditEventModel: { async create() { createCount += 1; } }
  });

  for (const outcome of ['failed', 'SUCCESS', 'unknown']) {
    await assert.rejects(
      service.record({
        actor: { id: 'actor-1', platformAccessLevel: 'OWNER' },
        action: 'settings.update',
        target: { type: 'settings', id: 'platform' },
        outcome
      }),
      (error) => error.code === 'INVALID_AUDIT_OUTCOME'
    );
  }
  assert.equal(createCount, 0);
});

test('audit failure codes accept machine vocabulary and reject unsafe content without echoing it', async () => {
  // Mutation caught: whitespace, emails, or secret-like values are retained as failure metadata.
  const created = [];
  const service = createAuditService({
    AuditEventModel: { async create(payload) { created.push(payload); return payload; } }
  });
  const base = {
    actor: { id: 'actor-1', platformAccessLevel: 'OWNER' },
    action: 'integration.test',
    target: { type: 'integration', id: 'smtp' },
    outcome: 'failure'
  };

  await service.record({ ...base, failureCode: 'PROVIDER_TIMEOUT' });
  assert.equal(created[0].failureCode, 'PROVIDER_TIMEOUT');

  for (const unsafeCode of [
    'SMTP unavailable',
    'OWNER@EXAMPLE.COM',
    'SECRET_TOKEN',
    'JWT_INVALID',
    'BAD__CODE',
    'BAD_',
    'A'.repeat(81)
  ]) {
    await assert.rejects(
      service.record({ ...base, failureCode: unsafeCode }),
      (error) => {
        assert.equal(error.code, 'INVALID_AUDIT_FAILURE_CODE');
        assert.equal(error.message.includes(unsafeCode), false);
        return true;
      }
    );
  }
  assert.equal(created.length, 1);
});
