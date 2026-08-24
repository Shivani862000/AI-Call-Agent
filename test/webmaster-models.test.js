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

test('retained mixed metadata is sanitized again at validation after in-place mutation', async () => {
  // Mutation caught: assignment setters are bypassed by a late mutation before save.
  const audit = new AuditEvent({
    actor: 'actor-1',
    actorAccessLevel: 'OWNER',
    action: 'tenant.update',
    targetType: 'tenant',
    targetId: 'tenant-1',
    before: { status: 'active' },
    after: { status: 'suspended' },
    outcome: 'success'
  });
  audit.after.errorMessage = 'patient@example.com secret response';

  const delivery = new NotificationDelivery({
    recipientCategory: 'tenant_admin',
    template: 'tenant-suspended',
    event: 'tenant.suspended',
    metadata: new Map([
      ['provider', 'smtp'],
      ['details', new Map([['password', 'map-secret'], ['retryCount', 1]])]
    ]),
    status: 'failed',
    retryCount: 1,
    failureCode: 'SMTP_UNAVAILABLE'
  });
  delivery.metadata.errorMessage = 'late secret@example.com';

  await audit.validate();
  await delivery.validate();

  assert.deepEqual(audit.after, { status: 'suspended', errorMessage: '[redacted]' });
  assert.deepEqual(delivery.metadata, {
    provider: 'smtp',
    details: { password: '[redacted]', retryCount: 1 },
    errorMessage: '[redacted]'
  });
});

test('notification delivery uses pending delivered failed states and integer retry counts', async () => {
  // Mutation caught: Task 7 cannot persist delivered state or accepts fractional retry attempts.
  const base = {
    recipientCategory: 'owner',
    template: 'tenant-restored',
    event: 'tenant.restored',
    metadata: {},
    retryCount: 1
  };
  await new NotificationDelivery({ ...base, status: 'delivered' }).validate();
  await assert.rejects(new NotificationDelivery({ ...base, status: 'sent' }).validate());
  await assert.rejects(new NotificationDelivery({ ...base, status: 'failed', retryCount: 1.5 }).validate());
});

test('settings schema version is an integer and retained failure codes use safe machine vocabulary', async () => {
  // Mutation caught: fractional schema versions or secret-like failure metadata pass raw model validation.
  await new PlatformSettings({ schemaVersion: 2 }).validate();
  await assert.rejects(new PlatformSettings({ schemaVersion: 1.5 }).validate());

  const unsafeDelivery = new NotificationDelivery({
    recipientCategory: 'owner',
    template: 'tenant-suspended',
    event: 'tenant.suspended',
    metadata: {},
    status: 'failed',
    retryCount: 0,
    failureCode: 'SECRET_TOKEN'
  });
  await assert.rejects(
    unsafeDelivery.validate(),
    (error) => {
      assert.equal(error.message.includes('SECRET_TOKEN'), false);
      return true;
    }
  );
});

test('audit and notification indexes support created, tenant, and delivery-status views without duplicates', () => {
  // Mutation caught: downstream pagination performs collection scans or repeats index declarations.
  const auditIndexes = AuditEvent.schema.indexes().map(([fields]) => fields);
  const deliveryIndexes = NotificationDelivery.schema.indexes().map(([fields]) => fields);

  assert.ok(auditIndexes.some((fields) => fields.created_at === -1 && Object.keys(fields).length === 1));
  assert.ok(auditIndexes.some((fields) => fields.tenantId === 1 && fields.created_at === -1));
  assert.ok(deliveryIndexes.some((fields) => (
    fields.tenantId === 1 && fields.status === 1 && fields.created_at === -1
  )));
  assert.ok(deliveryIndexes.some((fields) => (
    fields.status === 1 && fields.created_at === -1 && Object.keys(fields).length === 2
  )));

  for (const indexes of [AuditEvent.schema.indexes(), NotificationDelivery.schema.indexes()]) {
    const declarations = indexes.map(([fields]) => JSON.stringify(fields));
    assert.equal(new Set(declarations).size, declarations.length);
  }
});

test('notification query updates sanitize dotted metadata paths before collection persistence', async () => {
  // Mutation caught: a retry path bypasses the metadata setter with `$set: { "metadata.errorMessage": ... }`.
  const originalUpdateOne = NotificationDelivery.collection.updateOne;
  const persistedUpdates = [];
  NotificationDelivery.collection.updateOne = async (_filter, update) => {
    persistedUpdates.push(update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };

  try {
    await NotificationDelivery.updateOne(
      { _id: '507f1f77bcf86cd799439011' },
      {
        $set: {
          'metadata.errorMessage': 'late secret@example.com',
          'metadata.statusCode': 503,
          status: 'failed'
        }
      },
      { runValidators: true }
    );
    await NotificationDelivery.updateOne(
      { _id: '507f1f77bcf86cd799439011' },
      [{
        $set: {
          'metadata.responseBody': 'pipeline secret@example.com',
          'metadata.retryCount': 2
        }
      }],
      { updatePipeline: true }
    );
  } finally {
    NotificationDelivery.collection.updateOne = originalUpdateOne;
  }

  const persistedUpdate = persistedUpdates[0];
  assert.equal(persistedUpdate.$set['metadata.errorMessage'], '[redacted]');
  assert.equal(persistedUpdate.$set['metadata.statusCode'], 503);
  assert.equal(persistedUpdate.$set.status, 'failed');
  assert.ok(persistedUpdate.$set.updated_at instanceof Date);
  assert.equal(persistedUpdates[1][0].$set['metadata.responseBody'], '[redacted]');
  assert.equal(persistedUpdates[1][0].$set['metadata.retryCount'], 2);
});
