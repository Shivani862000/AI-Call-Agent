'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const PlatformSettings = require('../src/models/PlatformSettings');
const IntegrationSecret = require('../src/models/IntegrationSecret');
const AuditEvent = require('../src/models/AuditEvent');
const NotificationDelivery = require('../src/models/NotificationDelivery');

test('webmaster persistence schemas are strict and timestamp every retained record', () => {
  // Mutation caught: allowing undeclared fields or silently omitting creation/update evidence.
  const timestampExpectations = [
    [PlatformSettings, { createdAt: 'created_at', updatedAt: 'updated_at' }],
    [IntegrationSecret, { createdAt: 'created_at', updatedAt: 'updated_at' }],
    [AuditEvent, { createdAt: 'created_at', updatedAt: false }],
    [NotificationDelivery, { createdAt: 'created_at', updatedAt: 'updated_at' }]
  ];

  for (const [Model, timestamps] of timestampExpectations) {
    assert.equal(Model.schema.options.strict, true, Model.modelName);
    assert.deepEqual(Model.schema.options.timestamps, timestamps, Model.modelName);
  }

  const settings = new PlatformSettings({
    singletonKey: 'platform',
    schemaVersion: 1,
    undeclaredSecret: 'must-not-persist'
  }).toObject();
  assert.equal('undeclaredSecret' in settings, false);
});

test('integration envelopes hide encrypted material by default and enforce one record per key', async () => {
  // Mutation caught: a normal query can select ciphertext or duplicate integration/key records can exist.
  for (const path of ['ciphertext', 'iv', 'authTag']) {
    assert.equal(IntegrationSecret.schema.path(path).options.select, false, path);
  }

  const uniqueIndex = IntegrationSecret.schema.indexes().find(([fields, options]) => (
    fields.integration === 1 && fields.key === 1 && options.unique === true
  ));
  assert.ok(uniqueIndex);

  const document = new IntegrationSecret({
    integration: 'gemini',
    key: 'apiKey',
    ciphertext: Buffer.from('ciphertext').toString('base64'),
    iv: Buffer.alloc(12, 1).toString('base64'),
    authTag: Buffer.alloc(16, 2).toString('base64'),
    encryptionVersion: 1,
    updatedBy: 'user-123',
    updatedByAccessLevel: 'OWNER'
  });
  await document.validate();
  assert.equal(document.encryptionVersion, 1);
});

test('audit schema is append-only shaped and does not carry lifecycle deletion fields', () => {
  // Mutation caught: audit records become archivable/mutable application resources.
  const expectedPaths = [
    'actor', 'actorAccessLevel', 'action', 'targetType', 'targetId', 'tenantId',
    'before', 'after', 'requestId', 'outcome', 'failureCode', 'created_at'
  ];
  for (const path of expectedPaths) assert.ok(AuditEvent.schema.path(path), path);
  for (const forbiddenPath of ['status', 'archived_at', 'archived_by', 'archive_reason', 'updated_at']) {
    assert.equal(AuditEvent.schema.path(forbiddenPath), undefined, forbiddenPath);
  }
  for (const immutablePath of expectedPaths.filter((path) => path !== 'created_at')) {
    assert.equal(AuditEvent.schema.path(immutablePath).options.immutable, true, immutablePath);
  }
});

test('notification delivery model redacts unsafe nested metadata before persistence', async () => {
  // Mutation caught: a notification retry record persists credentials or recipient PII.
  const delivery = new NotificationDelivery({
    tenantId: '507f1f77bcf86cd799439011',
    recipientCategory: 'tenant_admin',
    template: 'tenant-suspended',
    event: 'tenant.suspended',
    metadata: {
      provider: 'smtp',
      statusCode: 503,
      nested: { smtpPassword: 'mail-secret', patientName: 'Private Person' }
    },
    status: 'failed',
    retryCount: 1,
    failureCode: 'SMTP_UNAVAILABLE'
  });
  await delivery.validate();

  assert.deepEqual(delivery.metadata, {
    provider: 'smtp',
    statusCode: 503,
    nested: { smtpPassword: '[redacted]', patientName: '[redacted]' }
  });
  assert.equal(JSON.stringify(delivery.toObject()).includes('mail-secret'), false);
  assert.equal(JSON.stringify(delivery.toObject()).includes('Private Person'), false);
});
