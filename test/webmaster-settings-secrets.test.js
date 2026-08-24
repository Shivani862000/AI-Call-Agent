'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecretService } = require('../src/webmaster/secret-service');

const FIXED_DATE = new Date('2026-08-24T10:00:00.000Z');
const OWNER = {
  id: '507f1f77bcf86cd799439012',
  username: 'owner@example.com',
  platformAccessLevel: 'OWNER'
};

function fakeSecretStore(initialRecord = null) {
  let record = initialRecord ? { ...initialRecord } : null;
  const selections = [];
  let writes = 0;

  function query(value) {
    return {
      select(selection) {
        selections.push(selection);
        return this;
      },
      async lean() {
        return value ? { ...value } : null;
      }
    };
  }

  return {
    get record() { return record; },
    get selections() { return [...selections]; },
    get writes() { return writes; },
    findOne(filter) {
      const found = record
        && record.integration === filter.integration
        && record.key === filter.key
        ? record
        : null;
      return query(found);
    },
    async findOneAndUpdate(filter, update, options) {
      assert.deepEqual(options, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true });
      writes += 1;
      record = {
        ...(record || {}),
        ...filter,
        ...update.$set,
        updated_at: FIXED_DATE
      };
      return { ...record };
    }
  };
}

function createService(store, overrides = {}) {
  return createSecretService({
    IntegrationSecretModel: store,
    env: {
      WEBMASTER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
      GEMINI_API_KEY: 'environment-secret'
    },
    randomBytes: (size) => Buffer.alloc(size, 3),
    ...overrides
  });
}

test('secret replacement stores an AES-256-GCM envelope and returns metadata only', async () => {
  // Mutation caught: plaintext/partial/encrypted material appears in write response or stored value.
  const store = fakeSecretStore();
  const service = createService(store);

  const metadata = await service.replaceSecret({
    integration: 'gemini',
    key: 'apiKey',
    value: 'top-secret-value',
    actor: OWNER
  });

  assert.deepEqual(metadata, {
    configured: true,
    source: 'database',
    updatedAt: FIXED_DATE,
    updatedBy: OWNER.id
  });
  assert.equal(store.record.encryptionVersion, 1);
  assert.equal(Buffer.from(store.record.iv, 'base64').length, 12);
  assert.equal(Buffer.from(store.record.authTag, 'base64').length, 16);
  assert.notEqual(store.record.ciphertext, 'top-secret-value');
  assert.equal(JSON.stringify(metadata).includes('top-secret-value'), false);
  assert.equal(JSON.stringify(metadata).includes('value'), false);
  assert.equal(JSON.stringify(metadata).includes(store.record.ciphertext), false);
  assert.equal(JSON.stringify(metadata).includes('owner@example.com'), false);
  assert.equal(await service.resolveSecret('gemini', 'apiKey'), 'top-secret-value');
});

test('metadata queries allowlist replacement metadata and never select envelope fields', async () => {
  // Mutation caught: a metadata read fetches ciphertext, IV, tag, or plaintext-shaped fields.
  const store = fakeSecretStore({
    integration: 'gemini',
    key: 'apiKey',
    ciphertext: 'encrypted',
    iv: 'iv',
    authTag: 'tag',
    encryptionVersion: 1,
    updatedBy: OWNER.id,
    updated_at: FIXED_DATE
  });
  const service = createService(store);

  const metadata = await service.getMetadata('gemini', 'apiKey');

  assert.deepEqual(metadata, {
    configured: true,
    source: 'database',
    updatedAt: FIXED_DATE,
    updatedBy: OWNER.id
  });
  assert.equal(store.selections.length, 1);
  assert.deepEqual(store.selections[0], {
    _id: 0,
    updated_at: 1,
    updatedBy: 1
  });
});

test('database secrets override environment fallback and missing records resolve from environment', async () => {
  // Mutation caught: environment wins over a managed secret or fallback is lost before Task 4 registry wiring.
  const emptyStore = fakeSecretStore();
  const fallbackService = createService(emptyStore);
  assert.equal(await fallbackService.resolveSecret('gemini', 'apiKey'), 'environment-secret');
  assert.deepEqual(await fallbackService.getMetadata('gemini', 'apiKey'), {
    configured: true,
    source: 'environment',
    updatedAt: null,
    updatedBy: null
  });

  const databaseStore = fakeSecretStore();
  const databaseService = createService(databaseStore);
  await databaseService.replaceSecret({
    integration: 'gemini', key: 'apiKey', value: 'database-secret', actor: OWNER
  });
  assert.equal(await databaseService.resolveSecret('gemini', 'apiKey'), 'database-secret');
});

test('blank replacement preserves the current database or environment value', async () => {
  // Mutation caught: an empty form submission erases or overwrites an existing secret.
  const store = fakeSecretStore();
  const service = createService(store);

  const metadata = await service.replaceSecret({
    integration: 'gemini', key: 'apiKey', value: '   ', actor: OWNER
  });

  assert.equal(store.writes, 0);
  assert.deepEqual(metadata, {
    configured: true,
    source: 'environment',
    updatedAt: null,
    updatedBy: null
  });
  assert.equal(await service.resolveSecret('gemini', 'apiKey'), 'environment-secret');
});

test('encryption key must be canonical base64 decoding to exactly 32 bytes', async () => {
  // Mutation caught: AES accepts a truncated, oversized, or ambiguously decoded Webmaster key.
  const invalidKeys = [
    Buffer.alloc(31, 1).toString('base64'),
    Buffer.alloc(33, 1).toString('base64'),
    `${Buffer.alloc(32, 1).toString('base64')}!`,
    ` ${Buffer.alloc(32, 1).toString('base64')}`,
    'not-base64'
  ];

  for (const key of invalidKeys) {
    const store = fakeSecretStore();
    const service = createService(store, { env: { WEBMASTER_SECRETS_KEY: key } });
    await assert.rejects(
      service.replaceSecret({ integration: 'gemini', key: 'apiKey', value: 'secret', actor: OWNER }),
      (error) => error.code === 'INVALID_WEBMASTER_SECRETS_KEY'
    );
    assert.equal(store.writes, 0);
  }
});

test('tampered encrypted records fail closed without putting secret material in the error', async () => {
  // Mutation caught: authentication-tag failures leak envelope fields or return corrupted plaintext.
  const store = fakeSecretStore();
  const service = createService(store);
  await service.replaceSecret({
    integration: 'gemini', key: 'apiKey', value: 'never-leak-this', actor: OWNER
  });
  store.record.authTag = Buffer.alloc(16, 9).toString('base64');

  await assert.rejects(
    service.resolveSecret('gemini', 'apiKey'),
    (error) => {
      assert.equal(error.code, 'SECRET_DECRYPTION_FAILED');
      assert.equal(error.message.includes('never-leak-this'), false);
      assert.equal(error.message.includes(store.record.ciphertext), false);
      return true;
    }
  );
});

test('a different valid encryption key cannot decrypt a database envelope', async () => {
  // Mutation caught: decryption omits GCM key authentication and accepts a wrong valid key.
  const store = fakeSecretStore();
  const writer = createService(store);
  await writer.replaceSecret({
    integration: 'gemini', key: 'apiKey', value: 'database-secret', actor: OWNER
  });
  const reader = createService(store, {
    env: {
      WEBMASTER_SECRETS_KEY: Buffer.alloc(32, 8).toString('base64'),
      GEMINI_API_KEY: 'environment-secret'
    }
  });

  await assert.rejects(
    reader.resolveSecret('gemini', 'apiKey'),
    (error) => error.code === 'SECRET_DECRYPTION_FAILED'
  );
});

test('missing database secret returns an explicit unconfigured result without fallback', async () => {
  // Mutation caught: a missing record is reported configured or returns an unrelated environment value.
  const store = fakeSecretStore();
  const service = createService(store, {
    env: { WEBMASTER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') }
  });

  assert.equal(await service.resolveSecret('gemini', 'apiKey'), null);
  assert.deepEqual(await service.getMetadata('gemini', 'apiKey'), {
    configured: false,
    source: null,
    updatedAt: null,
    updatedBy: null
  });
});
