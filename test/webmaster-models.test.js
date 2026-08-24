'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const PlatformSettings = require('../src/models/PlatformSettings');
const IntegrationSecret = require('../src/models/IntegrationSecret');
const AuditEvent = require('../src/models/AuditEvent');
const NotificationDelivery = require('../src/models/NotificationDelivery');

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

function assertPrivateValidationError(error, marker, expectedCode) {
  assert.equal(error.code, expectedCode);
  const serialized = JSON.stringify(error);
  const enumerable = JSON.stringify(enumerableSnapshot(error));
  const nestedErrors = error.errors || {};
  for (const representation of [error.message, serialized, enumerable, JSON.stringify(nestedErrors)]) {
    assert.equal(representation.includes(marker), false, representation);
  }
  for (const nestedError of Object.values(nestedErrors)) {
    assert.notEqual(nestedError?.value, marker);
    assert.equal(JSON.stringify(enumerableSnapshot(nestedError)).includes(marker), false);
  }
  return true;
}

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

test('audit request ids reject free text and accept bounded correlation identifiers', async () => {
  // Mutation caught: direct model construction retains a request description in the correlation field.
  const base = {
    actor: 'actor-1',
    actorAccessLevel: 'SYSTEM',
    action: 'settings.update',
    targetType: 'platform-settings',
    outcome: 'success'
  };

  await new AuditEvent({ ...base, requestId: 'request-01J60F8M6Q7JQ5Y2DDBF59YQ9N' }).validate();
  await assert.rejects(
    new AuditEvent({ ...base, requestId: 'patient@example.com request details' }).validate(),
    (error) => !error.message.includes('patient@example.com')
  );
});

test('audit request ids reject non-string originals without coercion or value disclosure', async () => {
  // Mutation caught: Mongoose String casting accepts numbers, arrays, boxed values, or attacker coercion.
  const privateMarker = 'private-request-marker-9137';
  let coercionCount = 0;
  const coerciveRequestId = {
    privateMarker,
    toString() {
      coercionCount += 1;
      return 'request-9137';
    },
    valueOf() {
      coercionCount += 1;
      return 'request-9137';
    }
  };
  const base = {
    actor: 'actor-1',
    actorAccessLevel: 'SYSTEM',
    action: 'settings.update',
    targetType: 'platform-settings',
    outcome: 'success'
  };

  for (const requestId of [9137, true, ['request-9137'], new String('request-9137'), {}, coerciveRequestId]) {
    await assert.rejects(
      new AuditEvent({ ...base, requestId }).validate(),
      (error) => {
        assert.equal(error.code, 'INVALID_AUDIT_REQUEST_ID');
        assert.equal(error.message, 'Request ID must be a bounded correlation identifier');
        assert.equal(error.message.includes(privateMarker), false);
        assert.equal(JSON.stringify(error).includes(privateMarker), false);
        assert.equal(JSON.stringify(enumerableSnapshot(error)).includes(privateMarker), false);
        return true;
      }
    );
  }

  await new AuditEvent({ ...base }).validate();
  await new AuditEvent({ ...base, requestId: null }).validate();
  assert.equal(coercionCount, 0);
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

test('notification save sanitizes metadata and failure details before the collection boundary', async () => {
  // Mutation caught: a root primitive array bypasses the Mixed setter and reaches insertOne.
  const originalInsertOne = NotificationDelivery.collection.insertOne;
  const persisted = [];
  NotificationDelivery.collection.insertOne = async (document) => {
    persisted.push(document);
    return { acknowledged: true, insertedId: document._id };
  };

  try {
    await new NotificationDelivery({
      recipientCategory: 'owner',
      template: 'tenant-suspended',
      event: 'tenant.suspended',
      metadata: ['patient@example.com', { status: 'failed', errorMessage: 'Jane Smith' }],
      status: 'failed',
      retryCount: 1,
      failureCode: 'DELIVERY_FAILED',
      failureReason: 'SMTP rejected patient@example.com'
    }).save();
  } finally {
    NotificationDelivery.collection.insertOne = originalInsertOne;
  }

  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].metadata, [
    '[redacted]',
    { status: 'failed', errorMessage: '[redacted]' }
  ]);
  assert.equal(persisted[0].failureReason, '[redacted]');
  assert.equal(JSON.stringify(persisted[0]).includes('patient@example.com'), false);
  assert.equal(JSON.stringify(persisted[0]).includes('Jane Smith'), false);
});

test('notification save remains fail-closed when document validation is explicitly skipped', async () => {
  // Mutation caught: in-place Mixed mutation leaks when save skips the pre-validation hook.
  const originalInsertOne = NotificationDelivery.collection.insertOne;
  const persisted = [];
  NotificationDelivery.collection.insertOne = async (document) => {
    persisted.push(document);
    return { acknowledged: true, insertedId: document._id };
  };

  try {
    const delivery = new NotificationDelivery({
      recipientCategory: 'owner',
      template: 'tenant-suspended',
      event: 'tenant.suspended',
      metadata: { provider: 'smtp', status: 'pending' },
      status: 'pending',
      failureCode: null
    });
    delivery.metadata.responseBody = 'late patient@example.com';
    delivery.failureReason = 'Jane Smith';
    await delivery.save({ validateBeforeSave: false });

    const unsafeCodeDelivery = new NotificationDelivery({
      recipientCategory: 'owner',
      template: 'tenant-suspended',
      event: 'tenant.suspended',
      metadata: {},
      status: 'failed',
      failureCode: 'PATIENT_JANE_SMITH'
    });
    await assert.rejects(
      unsafeCodeDelivery.save({ validateBeforeSave: false }),
      (error) => error.code === 'INVALID_NOTIFICATION_FAILURE_CODE'
        && !error.message.includes('PATIENT_JANE_SMITH')
    );
  } finally {
    NotificationDelivery.collection.insertOne = originalInsertOne;
  }

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].metadata.responseBody, '[redacted]');
  assert.equal(persisted[0].failureReason, '[redacted]');
  assert.equal(JSON.stringify(persisted[0]).includes('patient@example.com'), false);
});

test('notification insertMany sanitizes normal documents and rejects lean bypass before collection', async () => {
  // Mutation caught: insertMany lean mode skips hydration, setters, defaults, and validation.
  const originalInsertMany = NotificationDelivery.collection.insertMany;
  const persistedBatches = [];
  NotificationDelivery.collection.insertMany = async (documents) => {
    persistedBatches.push(documents);
    return {
      acknowledged: true,
      insertedCount: documents.length,
      insertedIds: Object.fromEntries(documents.map((document, index) => [index, document._id]))
    };
  };

  try {
    await assert.rejects(
      NotificationDelivery.insertMany([{
        recipientCategory: 'owner',
        template: 'tenant-suspended',
        event: 'tenant.suspended',
        metadata: 'lean patient@example.com',
        status: 'failed',
        retryCount: 0,
        failureCode: 'PATIENT_JANE',
        failureReason: 'Jane Smith'
      }], { lean: true }),
      (error) => error.code === 'UNSUPPORTED_NOTIFICATION_LEAN_INSERT_MANY'
        && !error.message.includes('patient@example.com')
    );

    await assert.rejects(NotificationDelivery.insertMany([{
      recipientCategory: 'owner',
      template: 'tenant-suspended',
      event: 'tenant.suspended',
      metadata: {},
      status: 'sent',
      retryCount: 0
    }]));

    await NotificationDelivery.insertMany([
      {
        recipientCategory: 'owner',
        template: 'tenant-suspended',
        event: 'tenant.suspended',
        metadata: ['patient@example.com', { provider: 'smtp' }],
        status: 'pending',
        retryCount: 0
      },
      {
        recipientCategory: 'support',
        template: 'tenant-restored',
        event: 'tenant.restored',
        metadata: { status: 'failed', responseBody: 'Jane Smith' },
        status: 'failed',
        retryCount: 1,
        failureCode: 'DELIVERY_FAILED',
        failureReason: 'patient@example.com'
      }
    ]);
  } finally {
    NotificationDelivery.collection.insertMany = originalInsertMany;
  }

  assert.equal(persistedBatches.length, 1);
  assert.deepEqual(persistedBatches[0][0].metadata, ['[redacted]', { provider: 'smtp' }]);
  assert.deepEqual(persistedBatches[0][1].metadata, {
    status: 'failed',
    responseBody: '[redacted]'
  });
  assert.equal(persistedBatches[0][1].failureReason, '[redacted]');
  assert.equal(JSON.stringify(persistedBatches).includes('patient@example.com'), false);
  assert.equal(JSON.stringify(persistedBatches).includes('Jane Smith'), false);
});

test('notification insertMany rejects every truthy lean option without coercion before collection', async () => {
  // Mutation caught: checking only `lean === true` lets other truthy values bypass hydration and validation.
  const originalInsertMany = NotificationDelivery.collection.insertMany;
  const persistedBatches = [];
  let coercionCount = 0;
  const coerciveLean = {
    toString() {
      coercionCount += 1;
      return 'true';
    },
    valueOf() {
      coercionCount += 1;
      return true;
    }
  };
  NotificationDelivery.collection.insertMany = async (documents) => {
    persistedBatches.push(documents);
    return {
      acknowledged: true,
      insertedCount: documents.length,
      insertedIds: Object.fromEntries(documents.map((document, index) => [index, document._id]))
    };
  };

  const unsafeDocument = {
    recipientCategory: 'owner',
    template: 'tenant-suspended',
    event: 'tenant.suspended',
    metadata: { responseBody: 'private-lean-marker-9137' },
    status: 'failed',
    retryCount: 0,
    failureCode: 'PATIENT_JANE'
  };

  try {
    for (const lean of [1, 'true', new Boolean(true), new Boolean(false), {}, [], coerciveLean]) {
      await assert.rejects(
        NotificationDelivery.insertMany([unsafeDocument], { lean }),
        (error) => error.code === 'UNSUPPORTED_NOTIFICATION_LEAN_INSERT_MANY'
          && !error.message.includes('private-lean-marker-9137')
      );
    }

    const falsyLeanValues = [undefined, null, false, 0, ''];
    for (const lean of falsyLeanValues) {
      await NotificationDelivery.insertMany([{
        recipientCategory: 'owner',
        template: 'tenant-restored',
        event: 'tenant.restored',
        metadata: { responseBody: 'private-normal-marker-9137', provider: 'smtp' },
        status: 'delivered',
        retryCount: 1
      }], { lean });
    }
    await NotificationDelivery.insertMany([{
      recipientCategory: 'owner',
      template: 'tenant-restored',
      event: 'tenant.restored',
      metadata: { responseBody: 'private-omitted-marker-9137', provider: 'smtp' },
      status: 'delivered',
      retryCount: 1
    }]);
  } finally {
    NotificationDelivery.collection.insertMany = originalInsertMany;
  }

  assert.equal(coercionCount, 0);
  assert.equal(persistedBatches.length, 6);
  for (const batch of persistedBatches) {
    assert.deepEqual(batch[0].metadata, { responseBody: '[redacted]', provider: 'smtp' });
  }
});

test('notification insertMany rejects accessor-bearing options without invoking lean getters', async () => {
  // Mutation caught: reading `options.lean` lets an accessor return false in the hook and true to Mongoose.
  const originalInsertMany = NotificationDelivery.collection.insertMany;
  let collectionCallCount = 0;
  let getterCallCount = 0;
  NotificationDelivery.collection.insertMany = async () => {
    collectionCallCount += 1;
    return { acknowledged: true, insertedCount: 1, insertedIds: { 0: 'unsafe' } };
  };

  const options = { ordered: true };
  Object.defineProperty(options, 'lean', {
    configurable: true,
    enumerable: true,
    get() {
      getterCallCount += 1;
      return getterCallCount > 1;
    }
  });

  try {
    await assert.rejects(
      NotificationDelivery.insertMany([{
        recipientCategory: 'owner',
        template: 'tenant-restored',
        event: 'tenant.restored',
        metadata: { responseBody: 'private-accessor-marker-9137' },
        status: 'failed',
        retryCount: 0,
        failureCode: 'PATIENT_JANE'
      }], options),
      (error) => error.code === 'UNSAFE_NOTIFICATION_INSERT_MANY_OPTIONS'
        && error.message === 'Notification insert options must be plain data'
    );
  } finally {
    NotificationDelivery.collection.insertMany = originalInsertMany;
  }

  assert.equal(getterCallCount, 0);
  assert.equal(collectionCallCount, 0);
});

test('notification insertMany rejects inherited accessors and proxies without observing option values', async () => {
  // Mutation caught: inherited or proxied option values bypass own-descriptor validation.
  const originalInsertMany = NotificationDelivery.collection.insertMany;
  let collectionCallCount = 0;
  let observationCount = 0;
  NotificationDelivery.collection.insertMany = async () => {
    collectionCallCount += 1;
    return { acknowledged: true, insertedCount: 1, insertedIds: { 0: 'unsafe' } };
  };

  const inheritedOptions = Object.create(Object.defineProperty({}, 'lean', {
    get() {
      observationCount += 1;
      return true;
    }
  }));
  const proxyOptions = new Proxy({}, {
    get() {
      observationCount += 1;
      return true;
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
  const nonExtensibleOptions = Object.preventExtensions({});

  try {
    for (const options of [inheritedOptions, proxyOptions]) {
      await assert.rejects(
        NotificationDelivery.insertMany([{
          recipientCategory: 'owner',
          template: 'tenant-restored',
          event: 'tenant.restored',
          metadata: { responseBody: 'private-option-marker-9137' },
          status: 'failed',
          retryCount: 0,
          failureCode: 'PATIENT_JANE'
        }], options),
        (error) => error.code === 'UNSAFE_NOTIFICATION_INSERT_MANY_OPTIONS'
          && error.message === 'Notification insert options must be plain data'
      );
    }
    await assert.rejects(
      NotificationDelivery.insertMany([{
        recipientCategory: 'owner',
        template: 'tenant-restored',
        event: 'tenant.restored',
        metadata: {},
        status: 'pending',
        retryCount: 0
      }], nonExtensibleOptions),
      (error) => error.code === 'UNSAFE_NOTIFICATION_INSERT_MANY_OPTIONS'
    );
  } finally {
    NotificationDelivery.collection.insertMany = originalInsertMany;
  }

  assert.equal(observationCount, 0);
  assert.equal(collectionCallCount, 0);
});

test('notification assignment, replacement, and update paths sanitize before collection persistence', async () => {
  // Mutation caught: a retry path bypasses the metadata setter with `$set: { "metadata.errorMessage": ... }`.
  const originalUpdateOne = NotificationDelivery.collection.updateOne;
  const originalReplaceOne = NotificationDelivery.collection.replaceOne;
  const persistedUpdates = [];
  const persistedReplacements = [];
  NotificationDelivery.collection.updateOne = async (_filter, update) => {
    persistedUpdates.push(update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };
  NotificationDelivery.collection.replaceOne = async (_filter, replacement) => {
    persistedReplacements.push(replacement);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };

  try {
    await NotificationDelivery.updateOne(
      { _id: '507f1f77bcf86cd799439011' },
      {
        $set: {
          'metadata.errorMessage': 'late secret@example.com',
          'metadata.statusCode': 503,
          status: 'failed',
          retryCount: 2,
          failureCode: 'DELIVERY_FAILED',
          failureReason: 'Jane Smith delivery failure'
        }
      },
      { runValidators: true }
    );
    await NotificationDelivery.replaceOne(
      { _id: '507f1f77bcf86cd799439011' },
      {
        recipientCategory: 'owner',
        template: 'tenant-restored',
        event: 'tenant.restored',
        metadata: 'replacement patient@example.com',
        status: 'failed',
        retryCount: 2,
        failureCode: 'DELIVERY_FAILED',
        failureReason: 'Jane Smith replacement failure'
      },
      { runValidators: true }
    );
  } finally {
    NotificationDelivery.collection.updateOne = originalUpdateOne;
    NotificationDelivery.collection.replaceOne = originalReplaceOne;
  }

  const persistedUpdate = persistedUpdates[0];
  assert.equal(persistedUpdate.$set['metadata.errorMessage'], '[redacted]');
  assert.equal(persistedUpdate.$set['metadata.statusCode'], 503);
  assert.equal(persistedUpdate.$set.status, 'failed');
  assert.equal(persistedUpdate.$set.retryCount, 2);
  assert.equal(persistedUpdate.$set.failureCode, 'DELIVERY_FAILED');
  assert.equal(persistedUpdate.$set.failureReason, '[redacted]');
  assert.ok(persistedUpdate.$set.updated_at instanceof Date);
  assert.equal(JSON.stringify(persistedUpdate).includes('secret@example.com'), false);

  assert.equal(persistedReplacements.length, 1);
  assert.equal(persistedReplacements[0].metadata, '[redacted]');
  assert.equal(persistedReplacements[0].failureReason, '[redacted]');
  assert.equal(JSON.stringify(persistedReplacements[0]).includes('patient@example.com'), false);
  assert.equal(JSON.stringify(persistedReplacements[0]).includes('Jane Smith'), false);
});

test('findOneAndReplace sanitizes retained notification data before collection persistence', async () => {
  // Mutation caught: findOneAndReplace is omitted from replaceOne query middleware.
  const originalFindOneAndReplace = NotificationDelivery.collection.findOneAndReplace;
  const persisted = [];
  NotificationDelivery.collection.findOneAndReplace = async (_filter, replacement) => {
    persisted.push(replacement);
    return null;
  };

  try {
    await NotificationDelivery.findOneAndReplace(
      { _id: '507f1f77bcf86cd799439011' },
      {
        recipientCategory: 'owner',
        template: 'tenant-restored',
        event: 'tenant.restored',
        metadata: ['patient@example.com'],
        status: 'failed',
        retryCount: 3,
        failureCode: 'DELIVERY_FAILED',
        failureReason: 'Jane Smith'
      },
      { runValidators: true }
    );
  } finally {
    NotificationDelivery.collection.findOneAndReplace = originalFindOneAndReplace;
  }

  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].metadata, ['[redacted]']);
  assert.equal(persisted[0].failureReason, '[redacted]');
  assert.equal(JSON.stringify(persisted[0]).includes('patient@example.com'), false);
});

test('notification structural removals remain intact and unsupported mutation paths fail before collection', async () => {
  // Mutation caught: sanitizer corrupts `$unset`/`$rename`/`$project`, or pipelines and bulk writes bypass it.
  const originalUpdateOne = NotificationDelivery.collection.updateOne;
  const originalBulkWrite = NotificationDelivery.collection.bulkWrite;
  const persistedUpdates = [];
  let bulkWriteCount = 0;
  NotificationDelivery.collection.updateOne = async (_filter, update) => {
    persistedUpdates.push(update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };
  NotificationDelivery.collection.bulkWrite = async () => {
    bulkWriteCount += 1;
    return { acknowledged: true };
  };

  try {
    await NotificationDelivery.updateOne(
      { _id: '507f1f77bcf86cd799439011' },
      { $unset: { 'metadata.errorMessage': 1 }, $inc: { retryCount: 1 } }
    );

    await assert.rejects(
      NotificationDelivery.updateOne(
        { _id: '507f1f77bcf86cd799439011' },
        { $unset: { 'metadata.errorMessage': 'patient@example.com' } }
      ),
      (error) => error.code === 'UNSUPPORTED_NOTIFICATION_STRUCTURAL_UPDATE'
        && !error.message.includes('patient@example.com')
    );

    await assert.rejects(
      NotificationDelivery.updateOne(
        { _id: '507f1f77bcf86cd799439011' },
        { $rename: { 'metadata.errorMessage': 'metadata.archivedMessage' } }
      ),
      (error) => error.code === 'UNSUPPORTED_NOTIFICATION_STRUCTURAL_UPDATE'
        && !error.message.includes('errorMessage')
    );

    await assert.rejects(
      NotificationDelivery.updateOne(
        { _id: '507f1f77bcf86cd799439011' },
        [{ $project: { 'metadata.errorMessage': 0 } }],
        { updatePipeline: true }
      ),
      (error) => error.code === 'UNSUPPORTED_NOTIFICATION_UPDATE_PIPELINE'
        && !error.message.includes('errorMessage')
    );

    await assert.rejects(
      NotificationDelivery.bulkWrite([{
        updateOne: {
          filter: { _id: '507f1f77bcf86cd799439011' },
          update: {
            $set: {
              'metadata.responseBody': 'bulk patient@example.com',
              failureReason: 'Jane Smith bulk failure'
            }
          }
        }
      }]),
      (error) => error.code === 'UNSUPPORTED_NOTIFICATION_BULK_WRITE'
        && !error.message.includes('patient@example.com')
    );
  } finally {
    NotificationDelivery.collection.updateOne = originalUpdateOne;
    NotificationDelivery.collection.bulkWrite = originalBulkWrite;
  }

  assert.equal(persistedUpdates.length, 1);
  assert.equal(persistedUpdates[0].$unset['metadata.errorMessage'], 1);
  assert.equal(persistedUpdates[0].$inc.retryCount, 1);
  assert.equal(bulkWriteCount, 0);
});

test('notification update operators require plain record operands while metadata Map values remain supported', async () => {
  // Mutation caught: Map/Set/class/binary operator operands evade path checks for status, retry, or failure data.
  const originalUpdateOne = NotificationDelivery.collection.updateOne;
  const persistedUpdates = [];
  const privateMarker = 'private-operator-marker-9137';
  class AssignmentOperand {
    constructor() {
      this.failureCode = 'PATIENT_JANE';
      this.privateMarker = privateMarker;
    }
  }
  NotificationDelivery.collection.updateOne = async (_filter, update) => {
    persistedUpdates.push(update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };

  const invalidUpdates = [
    { $set: new Map([['status', 'sent'], ['privateMarker', privateMarker]]) },
    { $set: new Set([['status', 'sent']]) },
    { $setOnInsert: new AssignmentOperand() },
    { $inc: new Uint8Array([1]) },
    { $unset: Buffer.from(privateMarker) },
    { $rename: new DataView(new ArrayBuffer(8)) }
  ];

  try {
    for (const update of invalidUpdates) {
      await assert.rejects(
        NotificationDelivery.updateOne({ _id: '507f1f77bcf86cd799439011' }, update),
        (error) => error.code === 'UNSUPPORTED_NOTIFICATION_OPERATOR_OPERAND'
          && !error.message.includes(privateMarker)
      );
    }

    await NotificationDelivery.updateOne(
      { _id: '507f1f77bcf86cd799439011' },
      {
        $set: {
          metadata: new Map([
            ['provider', 'smtp'],
            ['responseBody', privateMarker]
          ]),
          status: 'failed',
          failureCode: 'DELIVERY_FAILED'
        },
        $unset: { failureReason: 1 },
        $inc: { retryCount: 1 }
      }
    );
  } finally {
    NotificationDelivery.collection.updateOne = originalUpdateOne;
  }

  assert.equal(persistedUpdates.length, 1);
  assert.deepEqual(persistedUpdates[0].$set.metadata, {
    provider: 'smtp',
    responseBody: '[redacted]'
  });
  assert.equal(persistedUpdates[0].$set.status, 'failed');
  assert.equal(persistedUpdates[0].$set.failureCode, 'DELIVERY_FAILED');
  assert.equal(persistedUpdates[0].$unset.failureReason, 1);
  assert.equal(persistedUpdates[0].$inc.retryCount, 1);
  assert.equal(JSON.stringify(persistedUpdates).includes(privateMarker), false);
});

test('unknown notification failure codes are rejected before collection persistence', async () => {
  // Mutation caught: identifier-looking PII reaches a stored failureCode through an update.
  const originalUpdateOne = NotificationDelivery.collection.updateOne;
  let collectionCallCount = 0;
  NotificationDelivery.collection.updateOne = async () => {
    collectionCallCount += 1;
    return { acknowledged: true };
  };

  try {
    await assert.rejects(
      NotificationDelivery.updateOne(
        { _id: '507f1f77bcf86cd799439011' },
        { $set: { failureCode: 'PATIENT_JANE_SMITH' } },
        { runValidators: true }
      ),
      (error) => !error.message.includes('PATIENT_JANE_SMITH')
    );
  } finally {
    NotificationDelivery.collection.updateOne = originalUpdateOne;
  }

  assert.equal(collectionCallCount, 0);
});

test('notification queries enforce status and retry invariants before collection persistence', async () => {
  // Mutation caught: callers disable validators or use fractional $inc to persist invalid delivery state.
  const originalUpdateOne = NotificationDelivery.collection.updateOne;
  const originalReplaceOne = NotificationDelivery.collection.replaceOne;
  const persistedUpdates = [];
  let replacementCallCount = 0;
  NotificationDelivery.collection.updateOne = async (_filter, update) => {
    persistedUpdates.push(update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };
  NotificationDelivery.collection.replaceOne = async () => {
    replacementCallCount += 1;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };

  const filter = { _id: '507f1f77bcf86cd799439011' };
  try {
    await assert.rejects(NotificationDelivery.updateOne(
      filter,
      { $set: { status: 'sent' } },
      { runValidators: false }
    ));
    await assert.rejects(NotificationDelivery.updateOne(
      filter,
      { $set: { retryCount: 1.5 } }
    ));
    for (const invalidIncrement of [0.5, -1]) {
      await assert.rejects(
        NotificationDelivery.updateOne(filter, { $inc: { retryCount: invalidIncrement } }),
        (error) => error.code === 'INVALID_NOTIFICATION_RETRY_INCREMENT'
      );
    }
    await assert.rejects(NotificationDelivery.replaceOne(
      filter,
      {
        recipientCategory: 'owner',
        template: 'tenant-restored',
        event: 'tenant.restored',
        metadata: {},
        status: 'sent',
        retryCount: 1
      },
      { runValidators: false }
    ));

    await NotificationDelivery.updateOne(
      filter,
      { $set: { status: 'delivered' }, $inc: { retryCount: 1 } },
      { runValidators: false }
    );
  } finally {
    NotificationDelivery.collection.updateOne = originalUpdateOne;
    NotificationDelivery.collection.replaceOne = originalReplaceOne;
  }

  assert.equal(persistedUpdates.length, 1);
  assert.equal(persistedUpdates[0].$set.status, 'delivered');
  assert.equal(persistedUpdates[0].$inc.retryCount, 1);
  assert.equal(replacementCallCount, 0);
});

test('notification status retry and failure values reject hostile types with fixed private errors on every write path', async () => {
  // Mutation caught: Mongoose String/Number casts call attacker coercion or echo values on save/insert/update/replace.
  const originalInsertOne = NotificationDelivery.collection.insertOne;
  const originalInsertMany = NotificationDelivery.collection.insertMany;
  const originalUpdateOne = NotificationDelivery.collection.updateOne;
  const originalReplaceOne = NotificationDelivery.collection.replaceOne;
  const privateMarker = 'private-validation-marker-9137';
  let collectionCallCount = 0;
  let coercionCount = 0;
  const coerciveValue = (castValue) => ({
    privateMarker,
    toString() {
      coercionCount += 1;
      return String(castValue);
    },
    valueOf() {
      coercionCount += 1;
      return castValue;
    }
  });
  const base = {
    recipientCategory: 'owner',
    template: 'tenant-restored',
    event: 'tenant.restored',
    metadata: {}
  };
  const spy = async () => {
    collectionCallCount += 1;
    return { acknowledged: true };
  };
  NotificationDelivery.collection.insertOne = spy;
  NotificationDelivery.collection.insertMany = spy;
  NotificationDelivery.collection.updateOne = spy;
  NotificationDelivery.collection.replaceOne = spy;

  const assertPrivateRejection = async (operation) => {
    await assert.rejects(operation, (error) => {
      assert.equal(error.message.includes(privateMarker), false);
      assert.match(error.message, /Notification (status|retry count|failure code)/);
      return true;
    });
  };

  try {
    await assertPrivateRejection(new NotificationDelivery({
      ...base,
      status: privateMarker,
      retryCount: 1
    }).validate());
    await assertPrivateRejection(new NotificationDelivery({
      ...base,
      status: 'pending',
      retryCount: privateMarker
    }).validate());
    await assertPrivateRejection(new NotificationDelivery({
      ...base,
      status: coerciveValue('delivered'),
      retryCount: 1
    }).validate());
    await assertPrivateRejection(new NotificationDelivery({
      ...base,
      status: 'pending',
      retryCount: coerciveValue(1)
    }).save({ validateBeforeSave: false }));
    await assertPrivateRejection(NotificationDelivery.insertMany([{
      ...base,
      status: ['delivered'],
      retryCount: 1
    }]));
    await assertPrivateRejection(NotificationDelivery.updateOne(
      { _id: '507f1f77bcf86cd799439011' },
      { $set: { status: coerciveValue('delivered') } },
      { runValidators: false }
    ));
    await assertPrivateRejection(NotificationDelivery.updateOne(
      { _id: '507f1f77bcf86cd799439011' },
      { $setOnInsert: { retryCount: coerciveValue(1) } },
      { upsert: true, runValidators: false }
    ));
    await assertPrivateRejection(NotificationDelivery.replaceOne(
      { _id: '507f1f77bcf86cd799439011' },
      {
        ...base,
        status: 'pending',
        retryCount: coerciveValue(1),
        failureCode: null
      },
      { runValidators: false }
    ));
    await assertPrivateRejection(new NotificationDelivery({
      ...base,
      status: 'failed',
      retryCount: 1,
      failureCode: coerciveValue('DELIVERY_FAILED')
    }).validate());
  } finally {
    NotificationDelivery.collection.insertOne = originalInsertOne;
    NotificationDelivery.collection.insertMany = originalInsertMany;
    NotificationDelivery.collection.updateOne = originalUpdateOne;
    NotificationDelivery.collection.replaceOne = originalReplaceOne;
  }

  assert.equal(collectionCallCount, 0);
  assert.equal(coercionCount, 0);
});

test('notification direct validation keeps every rejected adjacent field out of the complete error', async () => {
  // Mutation caught: Mongoose CastError/ValidatorError retains a raw ID, enum, count, code, or date value.
  const marker = 'private-adjacent-marker-7193';
  let coercionCount = 0;
  const coerciveValue = {
    marker,
    toString() {
      coercionCount += 1;
      return marker;
    },
    valueOf() {
      coercionCount += 1;
      return marker;
    }
  };
  const base = {
    recipientCategory: 'owner',
    template: 'tenant-restored',
    event: 'tenant.restored',
    metadata: {},
    status: 'pending',
    retryCount: 0
  };
  const cases = [
    ['tenantId', marker, 'INVALID_NOTIFICATION_TENANT_ID'],
    ['accountId', coerciveValue, 'INVALID_NOTIFICATION_ACCOUNT_ID'],
    ['recipientCategory', marker, 'INVALID_NOTIFICATION_RECIPIENT_CATEGORY'],
    ['template', `${marker}${'x'.repeat(128)}`, 'INVALID_NOTIFICATION_TEMPLATE'],
    ['event', [marker], 'INVALID_NOTIFICATION_EVENT'],
    ['status', marker, 'INVALID_NOTIFICATION_STATUS'],
    ['retryCount', coerciveValue, 'INVALID_NOTIFICATION_RETRY_COUNT'],
    ['failureCode', [marker], 'INVALID_NOTIFICATION_FAILURE_CODE'],
    ['lastAttemptAt', coerciveValue, 'INVALID_NOTIFICATION_LAST_ATTEMPT_AT'],
    ['sentAt', [marker], 'INVALID_NOTIFICATION_SENT_AT']
  ];

  for (const [field, value, code] of cases) {
    await assert.rejects(
      new NotificationDelivery({ ...base, [field]: value }).validate(),
      (error) => assertPrivateValidationError(error, marker, code),
      field
    );
  }

  const valid = new NotificationDelivery({
    ...base,
    tenantId: '507f1f77bcf86cd799439011',
    accountId: '507f1f77bcf86cd799439012',
    lastAttemptAt: '2026-08-24T12:00:00.000Z',
    sentAt: new Date('2026-08-24T12:01:00.000Z')
  });
  await valid.validate();
  assert.ok(valid.tenantId instanceof mongoose.Types.ObjectId);
  assert.ok(valid.accountId instanceof mongoose.Types.ObjectId);
  assert.ok(valid.lastAttemptAt instanceof Date);
  assert.ok(valid.sentAt instanceof Date);
  assert.equal(coercionCount, 0);
});

test('notification insert update and replacement reject raw adjacent values before collection access', async () => {
  // Mutation caught: non-document write APIs defer adjacent fields to value-bearing Mongoose casts/validators.
  const originalInsertMany = NotificationDelivery.collection.insertMany;
  const originalUpdateOne = NotificationDelivery.collection.updateOne;
  const originalReplaceOne = NotificationDelivery.collection.replaceOne;
  const marker = 'private-write-marker-7193';
  let collectionCallCount = 0;
  let coercionCount = 0;
  const coerciveDate = {
    marker,
    toString() {
      coercionCount += 1;
      return '2026-08-24T12:00:00.000Z';
    },
    valueOf() {
      coercionCount += 1;
      return Date.now();
    }
  };
  const spy = async () => {
    collectionCallCount += 1;
    return { acknowledged: true };
  };
  NotificationDelivery.collection.insertMany = spy;
  NotificationDelivery.collection.updateOne = spy;
  NotificationDelivery.collection.replaceOne = spy;

  const base = {
    recipientCategory: 'owner',
    template: 'tenant-restored',
    event: 'tenant.restored',
    metadata: {},
    status: 'pending',
    retryCount: 0
  };

  try {
    await assert.rejects(
      NotificationDelivery.insertMany([{ ...base, tenantId: [marker] }]),
      (error) => assertPrivateValidationError(error, marker, 'INVALID_NOTIFICATION_TENANT_ID')
    );
    await assert.rejects(
      NotificationDelivery.updateOne(
        { _id: '507f1f77bcf86cd799439011' },
        { $set: { lastAttemptAt: coerciveDate } },
        { runValidators: false }
      ),
      (error) => assertPrivateValidationError(error, marker, 'INVALID_NOTIFICATION_LAST_ATTEMPT_AT')
    );
    await assert.rejects(
      NotificationDelivery.replaceOne(
        { _id: '507f1f77bcf86cd799439011' },
        { ...base, accountId: { marker } },
        { runValidators: false }
      ),
      (error) => assertPrivateValidationError(error, marker, 'INVALID_NOTIFICATION_ACCOUNT_ID')
    );
  } finally {
    NotificationDelivery.collection.insertMany = originalInsertMany;
    NotificationDelivery.collection.updateOne = originalUpdateOne;
    NotificationDelivery.collection.replaceOne = originalReplaceOne;
  }

  assert.equal(collectionCallCount, 0);
  assert.equal(coercionCount, 0);
});

test('notification raw inserts and query filters reject accessors and hostile IDs before observation', async () => {
  // Mutation caught: Mongoose reads raw document accessors or manufactures a filter CastError before privacy guards.
  const originalInsertMany = NotificationDelivery.collection.insertMany;
  const originalUpdateOne = NotificationDelivery.collection.updateOne;
  const marker = 'private-query-marker-7193';
  let observationCount = 0;
  let collectionCallCount = 0;
  const rawDocument = {
    recipientCategory: 'owner',
    template: 'tenant-restored',
    event: 'tenant.restored',
    metadata: {},
    retryCount: 0
  };
  Object.defineProperty(rawDocument, 'status', {
    enumerable: true,
    get() {
      observationCount += 1;
      return 'pending';
    }
  });
  const coerciveFilterId = {
    marker,
    toString() {
      observationCount += 1;
      return '507f1f77bcf86cd799439011';
    },
    valueOf() {
      observationCount += 1;
      return '507f1f77bcf86cd799439011';
    }
  };
  const persistedUpdates = [];
  NotificationDelivery.collection.insertMany = async () => {
    collectionCallCount += 1;
    return { acknowledged: true };
  };
  NotificationDelivery.collection.updateOne = async (_filter, update) => {
    collectionCallCount += 1;
    persistedUpdates.push(update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };

  try {
    await assert.rejects(
      NotificationDelivery.insertMany([rawDocument]),
      (error) => assertPrivateValidationError(error, marker, 'INVALID_NOTIFICATION_INPUT')
    );
    await assert.rejects(
      NotificationDelivery.updateOne(
        { _id: coerciveFilterId },
        { $set: { status: 'delivered' } }
      ),
      (error) => assertPrivateValidationError(error, marker, 'INVALID_NOTIFICATION_FILTER_ID')
    );
    await assert.rejects(
      NotificationDelivery.updateOne(
        { $or: [{ _id: coerciveFilterId }] },
        { $set: { status: 'delivered' } }
      ),
      (error) => assertPrivateValidationError(error, marker, 'INVALID_NOTIFICATION_FILTER_ID')
    );
    await assert.rejects(
      NotificationDelivery.updateOne(
        { $or: [{ status: [marker] }] },
        { $set: { status: 'delivered' } }
      ),
      (error) => assertPrivateValidationError(error, marker, 'INVALID_NOTIFICATION_STATUS')
    );
    await NotificationDelivery.updateOne(
      { _id: '507f1f77bcf86cd799439011' },
      {
        $set: {
          tenantId: '507f1f77bcf86cd799439012',
          lastAttemptAt: '2026-08-24T12:00:00.000Z'
        }
      }
    );
  } finally {
    NotificationDelivery.collection.insertMany = originalInsertMany;
    NotificationDelivery.collection.updateOne = originalUpdateOne;
  }

  assert.equal(observationCount, 0);
  assert.equal(collectionCallCount, 1);
  assert.ok(persistedUpdates[0].$set.tenantId instanceof mongoose.Types.ObjectId);
  assert.ok(persistedUpdates[0].$set.lastAttemptAt instanceof Date);
});

test('audit direct validation rejects unsafe identity and outcome fields with value-free errors', async () => {
  // Mutation caught: String casts and validators retain rejected audit IDs/outcome/failure values.
  const marker = 'private-audit-marker-7193';
  let coercionCount = 0;
  const coerciveValue = {
    marker,
    toString() {
      coercionCount += 1;
      return marker;
    },
    valueOf() {
      coercionCount += 1;
      return marker;
    }
  };
  const base = {
    actor: 'actor-1',
    actorAccessLevel: 'SYSTEM',
    action: 'settings.update',
    targetType: 'platform-settings',
    targetId: 'platform',
    tenantId: null,
    requestId: 'request-7193',
    outcome: 'success',
    failureCode: null
  };
  const cases = [
    ['actor', coerciveValue, 'INVALID_AUDIT_ACTOR'],
    ['actorAccessLevel', marker, 'INVALID_AUDIT_ACTOR_ACCESS_LEVEL'],
    ['action', [marker], 'INVALID_AUDIT_ACTION'],
    ['targetType', coerciveValue, 'INVALID_AUDIT_TARGET_TYPE'],
    ['targetId', [marker], 'INVALID_AUDIT_TARGET_ID'],
    ['tenantId', coerciveValue, 'INVALID_AUDIT_TENANT_ID'],
    ['requestId', `${marker}@invalid`, 'INVALID_AUDIT_REQUEST_ID'],
    ['outcome', marker, 'INVALID_AUDIT_OUTCOME'],
    ['failureCode', marker, 'INVALID_AUDIT_FAILURE_CODE']
  ];

  for (const [field, value, code] of cases) {
    await assert.rejects(
      new AuditEvent({ ...base, [field]: value }).validate(),
      (error) => assertPrivateValidationError(error, marker, code),
      field
    );
  }
  assert.equal(coercionCount, 0);
});

test('audit insert and immutable mutation APIs fail privately before collection access', async () => {
  // Mutation caught: insert validation leaks raw values or an update/replacement reaches immutable storage.
  const originalInsertMany = AuditEvent.collection.insertMany;
  const originalUpdateOne = AuditEvent.collection.updateOne;
  const originalReplaceOne = AuditEvent.collection.replaceOne;
  const marker = 'private-audit-write-marker-7193';
  let collectionCallCount = 0;
  const spy = async () => {
    collectionCallCount += 1;
    return { acknowledged: true };
  };
  AuditEvent.collection.insertMany = spy;
  AuditEvent.collection.updateOne = spy;
  AuditEvent.collection.replaceOne = spy;
  const base = {
    actor: 'actor-1',
    actorAccessLevel: 'SYSTEM',
    action: 'settings.update',
    targetType: 'platform-settings',
    outcome: 'success'
  };

  try {
    await assert.rejects(
      AuditEvent.insertMany([{ ...base, outcome: marker }]),
      (error) => assertPrivateValidationError(error, marker, 'INVALID_AUDIT_OUTCOME')
    );
    await assert.rejects(
      AuditEvent.updateOne(
        { _id: '507f1f77bcf86cd799439011' },
        { $set: { outcome: marker } }
      ),
      (error) => assertPrivateValidationError(error, marker, 'IMMUTABLE_AUDIT_EVENT')
    );
    await assert.rejects(
      AuditEvent.replaceOne(
        { _id: '507f1f77bcf86cd799439011' },
        { ...base, tenantId: marker }
      ),
      (error) => assertPrivateValidationError(error, marker, 'IMMUTABLE_AUDIT_EVENT')
    );
  } finally {
    AuditEvent.collection.insertMany = originalInsertMany;
    AuditEvent.collection.updateOne = originalUpdateOne;
    AuditEvent.collection.replaceOne = originalReplaceOne;
  }

  assert.equal(collectionCallCount, 0);
});

test('audit insertMany rejects lean accessors without observation and keeps hydrated sanitization', async () => {
  // Mutation caught: lean audit inserts bypass setters, validation, and before/after redaction.
  const originalInsertMany = AuditEvent.collection.insertMany;
  const marker = 'private-audit-lean-marker-7193';
  let getterCallCount = 0;
  const persisted = [];
  AuditEvent.collection.insertMany = async (documents) => {
    persisted.push(documents);
    return {
      acknowledged: true,
      insertedCount: documents.length,
      insertedIds: Object.fromEntries(documents.map((document, index) => [index, document._id]))
    };
  };
  const options = {};
  Object.defineProperty(options, 'lean', {
    configurable: true,
    enumerable: true,
    get() {
      getterCallCount += 1;
      return getterCallCount > 1;
    }
  });
  const base = {
    actor: 'actor-1',
    actorAccessLevel: 'SYSTEM',
    action: 'settings.update',
    targetType: 'platform-settings',
    outcome: 'success'
  };

  try {
    await assert.rejects(
      AuditEvent.insertMany([{ ...base, before: { message: marker } }], options),
      (error) => assertPrivateValidationError(error, marker, 'UNSAFE_AUDIT_INSERT_MANY_OPTIONS')
    );
    await assert.rejects(
      AuditEvent.insertMany([{ ...base, before: { message: marker } }], { lean: true }),
      (error) => assertPrivateValidationError(error, marker, 'UNSUPPORTED_AUDIT_LEAN_INSERT_MANY')
    );
    await AuditEvent.insertMany([{
      ...base,
      before: { status: 'active', message: marker },
      after: { status: 'suspended' }
    }]);
  } finally {
    AuditEvent.collection.insertMany = originalInsertMany;
  }

  assert.equal(getterCallCount, 0);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0][0].before, { status: 'active', message: '[redacted]' });
  assert.equal(JSON.stringify(persisted).includes(marker), false);
});

test('audit save validates fixed fields even when document validation is explicitly skipped', async () => {
  // Mutation caught: validateBeforeSave=false persists an invalid retained audit without a fixed private error.
  const originalInsertOne = AuditEvent.collection.insertOne;
  const marker = 'private-audit-save-marker-7193';
  let collectionCallCount = 0;
  AuditEvent.collection.insertOne = async () => {
    collectionCallCount += 1;
    return { acknowledged: true };
  };

  try {
    await assert.rejects(
      new AuditEvent({
        actor: 'actor-1',
        actorAccessLevel: 'SYSTEM',
        action: 'settings.update',
        targetType: 'platform-settings',
        outcome: marker,
        before: { message: marker }
      }).save({ validateBeforeSave: false }),
      (error) => assertPrivateValidationError(error, marker, 'INVALID_AUDIT_OUTCOME')
    );
  } finally {
    AuditEvent.collection.insertOne = originalInsertOne;
  }

  assert.equal(collectionCallCount, 0);
});

test('hydrated audit documents cannot bypass immutability with document deletion', async () => {
  // Mutation caught: query delete hooks do not automatically protect Document#deleteOne().
  const originalDeleteOne = AuditEvent.collection.deleteOne;
  let collectionCallCount = 0;
  AuditEvent.collection.deleteOne = async () => {
    collectionCallCount += 1;
    return { acknowledged: true, deletedCount: 1 };
  };
  const event = new AuditEvent({
    actor: 'actor-1',
    actorAccessLevel: 'SYSTEM',
    action: 'settings.update',
    targetType: 'platform-settings',
    outcome: 'success'
  });
  event.$isNew = false;

  try {
    await assert.rejects(
      event.deleteOne(),
      (error) => error.code === 'IMMUTABLE_AUDIT_EVENT'
        && error.message === 'Audit events are immutable'
    );
  } finally {
    AuditEvent.collection.deleteOne = originalDeleteOne;
  }

  assert.equal(collectionCallCount, 0);
});
