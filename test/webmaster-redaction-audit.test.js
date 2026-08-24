'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  OPERATIONAL_FAILURE_CODES,
  isSafeCorrelationId,
  isSafeMachineCode,
  sanitizeForAudit
} = require('../src/webmaster/redaction');
const { createAuditService } = require('../src/webmaster/audit-service');

function enumerableSnapshot(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const snapshot = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
    snapshot[key] = enumerableSnapshot(descriptor.value, seen);
  }
  seen.delete(value);
  return snapshot;
}

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
    customerCount: '[redacted]',
    patientFailureRate: '[redacted]',
    apiKeyConfigured: '[redacted]',
    emailProvider: '[redacted]',
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
    patientCount: '[redacted]'
  });
});

test('redaction deeply serializes registered maps while unknown typed fields remain closed', () => {
  // Mutation caught: Map values collapse or unregistered ObjectId/Buffer/date fields enter retained metadata.
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
    objectId: '[redacted]',
    date: '[redacted]',
    binary: '[redacted]'
  });
  assert.equal(source.metadata.get('details').get('password'), 'map-secret');
  assert.equal(binary.toString('utf8'), 'secret-bytes');
  assert.equal(JSON.stringify(sanitized).includes('"data":['), false);
  assert.equal(JSON.stringify(sanitized).includes('secret-bytes'), false);
});

test('retained data redaction fails closed for root primitives and propagates parent context', () => {
  // Mutation caught: context-free array and Map traversal retains raw free text.
  assert.equal(sanitizeForAudit('patient@example.com'), '[redacted]');
  assert.equal(sanitizeForAudit(42), '[redacted]');
  assert.deepEqual(sanitizeForAudit([
    'patient@example.com',
    42,
    { status: 'failed', message: 'Jane Smith could not be reached' }
  ]), [
    '[redacted]',
    '[redacted]',
    { status: 'failed', message: '[redacted]' }
  ]);

  const nested = sanitizeForAudit({
    responseBody: [new Map([['status', 'private-patient-state']])],
    attempts: [new Map([
      ['provider', 'smtp'],
      ['errorMessage', 'patient@example.com']
    ])]
  });
  assert.deepEqual(nested, {
    responseBody: '[redacted]',
    attempts: [{ provider: 'smtp', errorMessage: '[redacted]' }]
  });
});

test('sensitive semantics win over operational suffixes and current PHI variants', () => {
  // Mutation caught: suffix inference marks passwordStatus or patientStatus as operationally safe.
  const sanitized = sanitizeForAudit({
    status: 'active',
    provider: 'smtp',
    source: 'database',
    passwordStatus: 'reset-by-owner',
    tokenProvider: 'jwt',
    patientStatus: 'critical',
    apiKeySource: 'database',
    outstanding_issues: 'Jane requires a callback',
    outstandingIssueCount: 2,
    pending_follow_ups: ['Call Jane'],
    followUpPending: true,
    service_interest: 'oncology',
    interestedServices: ['radiology'],
    last_visit_date: '2026-08-01',
    previousVisitAt: '2026-07-01'
  });

  assert.deepEqual(sanitized, {
    status: 'active',
    provider: 'smtp',
    source: 'database',
    passwordStatus: '[redacted]',
    tokenProvider: '[redacted]',
    patientStatus: '[redacted]',
    apiKeySource: '[redacted]',
    outstanding_issues: '[redacted]',
    outstandingIssueCount: '[redacted]',
    pending_follow_ups: '[redacted]',
    followUpPending: '[redacted]',
    service_interest: '[redacted]',
    interestedServices: '[redacted]',
    last_visit_date: '[redacted]',
    previousVisitAt: '[redacted]'
  });
});

test('compact compound PII and PHI keys win over numeric suffix policies without normal-field false positives', () => {
  // Mutation caught: compact sensitive phrases such as `phonenumberCount` fall through to suffix allowlisting.
  const sanitized = sanitizeForAudit({
    phonenumberCount: 2,
    PHONE_NUMBER_RATE: 0.5,
    emailaddressDays: 30,
    AadhaarNumberCount: 1,
    aadharnumberRate: 0.25,
    mrnnumberDays: 90,
    SSN_NUMBER_COUNT: 3,
    patientidentifierRate: 0.1,
    medicalrecordDays: 14,
    clinicalnoteCount: 4,
    healthcareRate: 0.75,
    healthinsuranceDays: 365,
    ehealthCount: 8,
    requestbodyCount: 5,
    requestpayloadRate: 0.2,
    requestmessageDays: 7,
    phonenumberConfigured: true,
    medicalrecordProvider: 'smtp',
    requestmessageStatus: 'active',
    passwordresetCount: 6,
    credentialHealthRate: 0.4,
    requestId: 'request-9137',
    recordCount: 12,
    insuranceRate: 0.6,
    careQueueDepth: 9,
    serviceLatencyRate: 0.03,
    retentionDays: 90
  });

  assert.deepEqual(sanitized, {
    phonenumberCount: '[redacted]',
    PHONE_NUMBER_RATE: '[redacted]',
    emailaddressDays: '[redacted]',
    AadhaarNumberCount: '[redacted]',
    aadharnumberRate: '[redacted]',
    mrnnumberDays: '[redacted]',
    SSN_NUMBER_COUNT: '[redacted]',
    patientidentifierRate: '[redacted]',
    medicalrecordDays: '[redacted]',
    clinicalnoteCount: '[redacted]',
    healthcareRate: '[redacted]',
    healthinsuranceDays: '[redacted]',
    ehealthCount: '[redacted]',
    requestbodyCount: '[redacted]',
    requestpayloadRate: '[redacted]',
    requestmessageDays: '[redacted]',
    phonenumberConfigured: '[redacted]',
    medicalrecordProvider: '[redacted]',
    requestmessageStatus: '[redacted]',
    passwordresetCount: '[redacted]',
    credentialHealthRate: '[redacted]',
    requestId: 'request-9137',
    recordCount: '[redacted]',
    insuranceRate: '[redacted]',
    careQueueDepth: '[redacted]',
    serviceLatencyRate: '[redacted]',
    retentionDays: 90
  });
});

test('unknown compact keys redact regardless of operational-looking suffix or value shape', () => {
  // Mutation caught: an unregistered field becomes retained merely by ending in Count/Rate/Days/Total/etc.
  const cases = [
    ['mobileCount', 1],
    ['secondaryPhoneRate', 0.5],
    ['contactEmailDays', 30],
    ['homeAddressTotal', 2],
    ['passportTotal', 1],
    ['patientQueueDepth', 2],
    ['userIdentifierCount', 3],
    ['clinicalAlertRate', 0.1],
    ['healthMetricDays', 7],
    ['accountIdentifierUsage', 4],
    ['memberTotal', 5],
    ['careQueueDepth', 9],
    ['serviceLatencyRate', 0.03],
    ['recordCount', 12],
    ['insuranceRate', 0.6],
    ['arbitraryVersion', 2],
    ['unknownConfigured', true],
    ['unknownStatus', 'active']
  ];

  for (const [key, value] of cases) {
    assert.deepEqual(sanitizeForAudit({ [key]: value }), { [key]: '[redacted]' }, key);
  }
});

test('unknown compound containers redact as a unit instead of laundering known child fields', () => {
  // Mutation caught: unknown objects survive because their child `total`, `active`, or `status` keys are allowed.
  for (const [key, value] of [
    ['passportMetrics', { total: 1 }],
    ['patientSummary', { active: 2 }],
    ['userIdentifierStats', { status: 'active' }],
    ['clinicalDashboard', { failed: 3 }],
    ['healthBreakdown', { usageRate: 0.5 }],
    ['unregisteredMetrics', { total: 4, status: 'healthy' }]
  ]) {
    assert.deepEqual(sanitizeForAudit({ [key]: value }), { [key]: '[redacted]' }, key);
  }
});

test('audit redaction never invokes object accessors or proxy traps', () => {
  // Mutation caught: Object.entries() executes attacker getters while cloning retained metadata.
  const marker = 'private-redaction-accessor-marker-7193';
  let observationCount = 0;
  const source = { status: 'active', retryCount: 1 };
  Object.defineProperty(source, 'details', {
    enumerable: true,
    get() {
      observationCount += 1;
      return { message: marker };
    }
  });
  const proxy = new Proxy({ status: 'active' }, {
    get() {
      observationCount += 1;
      return marker;
    },
    getOwnPropertyDescriptor() {
      observationCount += 1;
      return undefined;
    },
    getPrototypeOf() {
      observationCount += 1;
      return Object.prototype;
    },
    ownKeys() {
      observationCount += 1;
      return [];
    }
  });
  class HostileMap extends Map {
    entries() {
      observationCount += 1;
      return super.entries();
    }
  }
  class HostileDate extends Date {
    getTime() {
      observationCount += 1;
      return super.getTime();
    }

    toISOString() {
      observationCount += 1;
      return super.toISOString();
    }
  }
  class HostileBytes extends Uint8Array {
    get byteLength() {
      observationCount += 1;
      return super.byteLength;
    }
  }

  assert.deepEqual(sanitizeForAudit(source), {
    status: 'active',
    retryCount: 1,
    details: '[redacted]'
  });
  assert.equal(sanitizeForAudit(proxy), '[redacted]');
  assert.deepEqual(sanitizeForAudit({
    metadata: new HostileMap([['status', 'active']]),
    createdAt: new HostileDate('2026-08-24T12:00:00.000Z')
  }), {
    metadata: { status: 'active' },
    createdAt: '2026-08-24T12:00:00.000Z'
  });
  assert.deepEqual(sanitizeForAudit([new HostileBytes([1, 2, 3])]), ['[binary:3 bytes]']);
  assert.equal(observationCount, 0);
});

test('unregistered binary and identifier fields redact while registered timestamps stay useful', () => {
  // Mutation caught: unknown typed values bypass exact field registration based on their runtime shape.
  const objectId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
  const bytes = new Uint8Array([112, 97, 116, 105, 101, 110, 116]);
  const view = new DataView(bytes.buffer, 1, 4);
  const sanitized = sanitizeForAudit({
    bytes,
    view,
    raw: bytes.buffer,
    objectId,
    createdAt: new Date('2026-08-24T12:00:00.000Z')
  });

  assert.deepEqual(sanitized, {
    bytes: '[redacted]',
    view: '[redacted]',
    raw: '[redacted]',
    objectId: '[redacted]',
    createdAt: '2026-08-24T12:00:00.000Z'
  });
  assert.equal(JSON.stringify(sanitized).includes('112'), false);
});

test('failure codes come only from an exported operational allowlist', () => {
  // Mutation caught: syntactically machine-like PII and credential labels pass a heuristic validator.
  for (const requiredCode of [
    'DELIVERY_FAILED',
    'NOT_FOUND',
    'VERSION_CONFLICT',
    'VALIDATION_FAILED',
    'INTERNAL_ERROR',
    'SMTP_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'INVALID_SECRET_IDENTIFIER',
    'INVALID_SECRET_VALUE',
    'INVALID_WEBMASTER_SECRETS_KEY',
    'SECRET_ENCRYPTION_FAILED',
    'SECRET_DECRYPTION_FAILED',
    'WEBMASTER_FORBIDDEN',
    'WEBMASTER_OWNER_REQUIRED',
    'WEBMASTER_ACCESS_UNASSIGNED'
  ]) {
    assert.ok(OPERATIONAL_FAILURE_CODES.includes(requiredCode), requiredCode);
    assert.equal(isSafeMachineCode(requiredCode), true, requiredCode);
  }

  for (const unsafeCode of [
    'UNKNOWN_FAILURE',
    'PATIENT_JANE',
    'SSN_123456789',
    'AADHAAR_111122223333',
    'EMAIL_OWNER_EXAMPLE_COM',
    'PHONE_919999999999',
    'MRN_12345',
    'PASSWORDRESET',
    'SECRETTOKEN'
  ]) {
    assert.equal(isSafeMachineCode(unsafeCode), false, unsafeCode);
  }
});

test('operational string fields retain only controlled value shapes and vocabularies', () => {
  // Mutation caught: identifier-looking free text survives merely because it has no whitespace.
  assert.deepEqual(sanitizeForAudit({
    status: 'active',
    provider: 'smtp',
    source: 'database',
    outcome: 'failure',
    providerStatus: 'degraded',
    unsafeStatus: 'JaneSmith',
    statusCandidate: 'patient42',
    nested: {
      status: 'JaneSmith',
      provider: 'patient-provider',
      source: 'private-record'
    }
  }), {
    status: 'active',
    provider: 'smtp',
    source: 'database',
    outcome: 'failure',
    providerStatus: 'degraded',
    unsafeStatus: '[redacted]',
    statusCandidate: '[redacted]',
    nested: {
      status: '[redacted]',
      provider: '[redacted]',
      source: '[redacted]'
    }
  });
});

test('request ids use an exact correlation-id rule while request payload variants redact', () => {
  // Mutation caught: generic request sensitivity either removes safe correlation IDs or retains request free text.
  for (const safeId of [
    'request-01J60F8M6Q7JQ5Y2DDBF59YQ9N',
    '01J60F8M6Q7JQ5Y2DDBF59YQ9N',
    '550e8400-e29b-41d4-a716-446655440000'
  ]) {
    assert.equal(isSafeCorrelationId(safeId), true, safeId);
    assert.equal(sanitizeForAudit({ requestId: safeId }).requestId, safeId);
  }

  for (const unsafeId of [
    'patient@example.com',
    'request contains patient details',
    'request/../../private',
    'r'.repeat(129)
  ]) {
    assert.equal(isSafeCorrelationId(unsafeId), false, unsafeId);
    assert.equal(sanitizeForAudit({ requestId: unsafeId }).requestId, '[redacted]');
  }

  assert.deepEqual(sanitizeForAudit({
    requestId: 'request-123',
    requestBody: { status: 'active' },
    requestPayload: 'private',
    requestMessage: 'private'
  }), {
    requestId: 'request-123',
    requestBody: '[redacted]',
    requestPayload: '[redacted]',
    requestMessage: '[redacted]'
  });
});

test('audit service drops malformed correlation ids before model construction', async () => {
  // Mutation caught: the service's generic identifier rule permits colon-delimited request content.
  const created = [];
  const service = createAuditService({
    AuditEventModel: {
      async create(payload) {
        created.push(payload);
        return payload;
      }
    }
  });

  await service.record({
    actor: { id: 'actor-1', platformAccessLevel: 'SYSTEM' },
    action: 'dashboard.read',
    target: { type: 'dashboard', id: 'platform' },
    requestId: 'request:private',
    outcome: 'success'
  });
  await service.record({
    actor: { id: 'actor-1', platformAccessLevel: 'SYSTEM' },
    action: 'dashboard.read',
    target: { type: 'dashboard', id: 'platform' },
    requestId: 'request-123',
    outcome: 'success'
  });

  assert.equal(created[0].requestId, null);
  assert.equal(created[1].requestId, 'request-123');
  assert.equal(created[1].actorAccessLevel, 'SYSTEM');
});

test('Task 4 settings audits retain registered operational values and redact arbitrary text', () => {
  // Mutation caught: fail-closed redaction removes all useful settings evidence or suffix rules reopen free text.
  assert.deepEqual(sanitizeForAudit({
    section: 'platform-defaults',
    timezone: 'Asia/Kolkata',
    plan: 'enterprise',
    version: 4,
    provider: 'gemini',
    source: 'database',
    enabled: true,
    maintenanceMode: false,
    retentionDays: 90,
    rateLimit: 120,
    defaults: { timezone: 'Asia/Kolkata', plan: 'enterprise' },
    policies: { retentionDays: 90, rateLimit: 120 },
    maintenance: { maintenanceMode: false, maintenanceMessage: 'Patient Jane is unavailable' },
    providers: { gemini: { provider: 'gemini', configured: true } },
    featureFlags: {
      smartRetry: true,
      beta_dashboard: false,
      patientLookupEnabled: true,
      'invalid flag': true,
      freeform: 'yes'
    },
    maintenanceMessage: 'Patient Jane is unavailable',
    arbitraryLabel: 'JaneSmith',
    passwordMinLength: 12,
    apiKeyEnabled: true
  }), {
    section: 'platform-defaults',
    timezone: 'Asia/Kolkata',
    plan: 'enterprise',
    version: 4,
    provider: 'gemini',
    source: 'database',
    enabled: true,
    maintenanceMode: false,
    retentionDays: 90,
    rateLimit: 120,
    defaults: { timezone: 'Asia/Kolkata', plan: 'enterprise' },
    policies: { retentionDays: 90, rateLimit: 120 },
    maintenance: { maintenanceMode: false, maintenanceMessage: '[redacted]' },
    providers: { gemini: { provider: 'gemini', configured: true } },
    featureFlags: {
      smartRetry: true,
      beta_dashboard: false,
      patientLookupEnabled: '[redacted]',
      'invalid flag': '[redacted]',
      freeform: '[redacted]'
    },
    maintenanceMessage: '[redacted]',
    arbitraryLabel: '[redacted]',
    passwordMinLength: '[redacted]',
    apiKeyEnabled: '[redacted]'
  });
});

test('Task 8 dashboard audits retain aggregate operations and system actor metadata', () => {
  // Mutation caught: aggregate snapshots collapse into redaction or health is mistaken for clinical content.
  assert.deepEqual(sanitizeForAudit({
    actorAccessLevel: 'SYSTEM',
    tenants: { total: 12, active: 10, suspended: 1, archived: 1 },
    users: { total: 48, active: 43 },
    usage: { usageTotal: 850, limit: 1000, usageRate: 0.85 },
    calls: { completed: 700, failed: 15, completionRate: 0.98 },
    health: { status: 'healthy', queueDepth: 3 },
    integrations: {
      gemini: { provider: 'gemini', configured: true, health: 'healthy' }
    },
    notifications: { pending: 4, failed: 2 },
    recentAudit: [{ action: 'settings.update', outcome: 'success' }],
    attentionItems: [{ failureCode: 'PROVIDER_TIMEOUT', provider: 'gemini', status: 'degraded' }],
    summary: 'Patient Jane is waiting',
    patientQueueDepth: 2
  }), {
    actorAccessLevel: 'SYSTEM',
    tenants: { total: 12, active: 10, suspended: 1, archived: 1 },
    users: { total: 48, active: 43 },
    usage: { usageTotal: 850, limit: 1000, usageRate: 0.85 },
    calls: { completed: 700, failed: 15, completionRate: 0.98 },
    health: { status: 'healthy', queueDepth: 3 },
    integrations: {
      gemini: { provider: 'gemini', configured: true, health: 'healthy' }
    },
    notifications: { pending: 4, failed: 2 },
    recentAudit: [{ action: 'settings.update', outcome: 'success' }],
    attentionItems: [{ failureCode: 'PROVIDER_TIMEOUT', provider: 'gemini', status: 'degraded' }],
    summary: '[redacted]',
    patientQueueDepth: '[redacted]'
  });
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

test('audit service rejects accessor-bearing and coercive input without observing private values', async () => {
  // Mutation caught: service normalization reads actor/target accessors or calls attacker string coercion.
  const marker = 'private-service-marker-7193';
  let observationCount = 0;
  let createCount = 0;
  const actor = { platformAccessLevel: 'OWNER' };
  Object.defineProperty(actor, 'id', {
    enumerable: true,
    get() {
      observationCount += 1;
      return marker;
    }
  });
  const coerciveOutcome = {
    marker,
    toString() {
      observationCount += 1;
      return 'failure';
    },
    valueOf() {
      observationCount += 1;
      return 'failure';
    }
  };
  const service = createAuditService({
    AuditEventModel: {
      async create() {
        createCount += 1;
      }
    }
  });

  await assert.rejects(
    service.record({
      actor,
      action: 'settings.update',
      target: { type: 'settings', id: ['platform', marker] },
      outcome: coerciveOutcome,
      failureCode: { marker }
    }),
    (error) => {
      assert.equal(error.code, 'INVALID_AUDIT_INPUT');
      for (const representation of [
        error.message,
        JSON.stringify(error),
        JSON.stringify(enumerableSnapshot(error)),
        JSON.stringify(error.errors || {})
      ]) {
        assert.equal(representation.includes(marker), false, representation);
      }
      return true;
    }
  );

  assert.equal(observationCount, 0);
  assert.equal(createCount, 0);
});
