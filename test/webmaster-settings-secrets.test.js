'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSecretService } = require('../src/webmaster/secret-service');
const {
  INTEGRATION_DEFINITIONS,
  OVERRIDABLE_KEYS,
  SETTING_DEFINITIONS,
  environmentKeyForSecret
} = require('../src/webmaster/settings-registry');
const { createSettingsService } = require('../src/webmaster/settings-service');
const { createEmailService } = require('../src/services/email-service');
const { createSlackSupportNotifier } = require('../services/slack-support');

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

function queryResult(value) {
  return {
    async lean() {
      return value == null ? null : structuredClone(value);
    }
  };
}

function fakeSettingsStores({ global, tenant } = {}) {
  let globalRecord = global == null ? null : structuredClone(global);
  let tenantRecord = tenant == null ? null : structuredClone(tenant);

  return {
    PlatformSettingsModel: {
      findOne() {
        return queryResult(globalRecord);
      },
      findOneAndUpdate(filter, update) {
        if (!globalRecord || globalRecord.__v !== filter.__v) return queryResult(null);
        for (const [path, value] of Object.entries(update.$set || {})) {
          const parts = path.split('.');
          let cursor = globalRecord;
          while (parts.length > 1) {
            const part = parts.shift();
            cursor[part] ||= {};
            cursor = cursor[part];
          }
          cursor[parts[0]] = value;
        }
        globalRecord.__v += update.$inc?.__v || 0;
        return queryResult(globalRecord);
      }
    },
    TenantModel: {
      findOne() {
        return queryResult(tenantRecord);
      },
      findOneAndUpdate(filter, update) {
        if (!tenantRecord || tenantRecord.__v !== filter.__v) return queryResult(null);
        tenantRecord.settingsOverrides = structuredClone(update.$set.settingsOverrides);
        tenantRecord.__v += update.$inc.__v;
        return queryResult(tenantRecord);
      }
    }
  };
}

test('registry covers platform policy areas and all supported runtime integrations', () => {
  // Mutation caught: a required settings area or provider becomes unregistered and silently falls back.
  for (const key of [
    'application.name',
    'application.supportEmail',
    'defaults.timezone',
    'defaults.dailyReportTime',
    'defaults.limits.maxUsers',
    'maintenance.enabled',
    'featureFlags.outboundCalling',
    'policies.password.minLength',
    'policies.session.maxAgeMinutes',
    'policies.rateLimits.apiPerMinute',
    'notificationTemplates.tenantSuspended.subject',
    'retention.calls.archiveAfterDays',
    'providers.supported.ai'
  ]) {
    assert.ok(SETTING_DEFINITIONS[key], `${key} must be registered`);
  }

  for (const integration of ['icallmate', 'gemini', 'deepgram', 'smtp', 'slack', 'webhook']) {
    assert.ok(INTEGRATION_DEFINITIONS[integration], `${integration} must be registered`);
  }

  assert.equal(OVERRIDABLE_KEYS.has('defaults.timezone'), true);
  assert.equal(OVERRIDABLE_KEYS.has('policies.password.minLength'), false);
  assert.equal(OVERRIDABLE_KEYS.has('maintenance.enabled'), false);
});

test('tenant override wins over persisted global and environment fallback', async () => {
  // Mutation caught: resolver applies global/environment after the explicit tenant override.
  const stores = fakeSettingsStores({
    global: {
      singletonKey: 'platform',
      defaults: { timezone: 'UTC', dailyReportTime: '19:00' },
      __v: 4
    },
    tenant: {
      _id: 'tenant-1',
      settingsOverrides: { 'defaults.timezone': 'Asia/Kolkata' },
      __v: 2
    }
  });
  const service = createSettingsService({
    ...stores,
    env: { DEFAULT_TIMEZONE: 'America/New_York', DEFAULT_DAILY_REPORT_TIME: '08:30' }
  });

  const result = await service.getEffectiveForTenant('tenant-1');

  assert.equal(result.global.defaults.timezone, 'UTC');
  assert.equal(result.global.defaults.dailyReportTime, '19:00');
  assert.equal(result.overrides.defaults.timezone, 'Asia/Kolkata');
  assert.equal(result.effective.defaults.timezone, 'Asia/Kolkata');
  assert.equal(result.effective.defaults.dailyReportTime, '19:00');
  assert.equal(result.inherited.defaults.timezone, false);
  assert.equal(result.inherited.defaults.dailyReportTime, true);
  assert.equal(result.version, 2);
});

test('legacy Map overrides are filtered through the registered tenant allowlist', async () => {
  const stores = fakeSettingsStores({
    global: { singletonKey: 'platform', defaults: { timezone: 'UTC' }, __v: 1 },
    tenant: {
      _id: 'tenant-1',
      settingsOverrides: new Map([
        ['defaults.timezone', 'Asia/Kolkata'],
        ['policies.password.minLength', 8],
        ['providers.gemini.temperature', 99]
      ]),
      __v: 1
    }
  });
  const service = createSettingsService({ ...stores, env: {} });

  const result = await service.getEffectiveForTenant('tenant-1');

  assert.equal(result.effective.defaults.timezone, 'Asia/Kolkata');
  assert.equal(result.effective.policies.password.minLength, 12);
  assert.equal(result.effective.providers.gemini.temperature, 0.3);
  assert.equal(result.overrides.policies, undefined);
});

test('invalid environment settings fall back to registry-safe values', async () => {
  const stores = fakeSettingsStores({
    global: { singletonKey: 'platform', __v: 1 },
    tenant: { _id: 'tenant-1', settingsOverrides: {}, __v: 1 }
  });
  const service = createSettingsService({
    ...stores,
    env: {
      GEMINI_TEMPERATURE: '99',
      GEMINI_ENABLED: 'not-a-boolean',
      DEFAULT_TIMEZONE: 'Mars/Olympus_Mons',
      SMTP_PORT: '70000'
    }
  });

  const global = (await service.getGlobal()).global;

  assert.equal(global.providers.gemini.temperature, 0.3);
  assert.equal(global.providers.gemini.enabled, true);
  assert.equal(global.defaults.timezone, 'UTC');
  assert.equal(global.providers.smtp.port, 587);
});

test('settings updates validate section-wide cross-field invariants before writing', async () => {
  const stores = fakeSettingsStores({
    global: {
      singletonKey: 'platform',
      policies: { password: { minLength: 12, maxLength: 128 } },
      __v: 2
    },
    tenant: { _id: 'tenant-1', settingsOverrides: {}, __v: 1 }
  });
  const service = createSettingsService({ ...stores, env: {} });

  await assert.rejects(
    service.updateSection('policies', { password: { minLength: 128, maxLength: 32 } }, 2, OWNER),
    (error) => Boolean(error.code === 'INVALID_SETTING_VALUE'
      && error.fieldErrors['policies.password.minLength']
      && error.fieldErrors['policies.password.maxLength'])
  );
});

test('tenant override patches validate cross-field invariants against inherited values', async () => {
  const stores = fakeSettingsStores({
    global: {
      singletonKey: 'platform',
      defaults: { limits: { maxConcurrentCalls: 5, maxCallsPerDay: 100 } },
      __v: 2
    },
    tenant: { _id: 'tenant-1', settingsOverrides: {}, __v: 1 }
  });
  const service = createSettingsService({ ...stores, env: {} });

  await assert.rejects(
    service.setTenantOverrides('tenant-1', {
      'defaults.limits.maxConcurrentCalls': 101
    }, 1, OWNER),
    (error) => error.code === 'INVALID_OVERRIDE_VALUE'
      && Boolean(error.fieldErrors['defaults.limits.maxConcurrentCalls'])
  );
});

test('registry metadata is deeply immutable and secret environment aliases are scanned', () => {
  assert.equal(Object.isFrozen(INTEGRATION_DEFINITIONS.gemini.secrets.apiKey.env), true);
  const before = INTEGRATION_DEFINITIONS.gemini.secrets.apiKey.env[0];
  assert.throws(() => { INTEGRATION_DEFINITIONS.gemini.secrets.apiKey.env[0] = 'MUTATED'; }, TypeError);
  assert.equal(INTEGRATION_DEFINITIONS.gemini.secrets.apiKey.env[0], before);
  assert.equal(
    environmentKeyForSecret('gemini', 'apiKey', { GOOGLE_API_KEY: 'alias-value' }),
    'GOOGLE_API_KEY'
  );
});

test('tenant override writes reject unknown and security-sensitive keys', async () => {
  // Mutation caught: arbitrary dotted paths can alter platform security invariants per tenant.
  const stores = fakeSettingsStores({
    global: { singletonKey: 'platform', __v: 1 },
    tenant: { _id: 'tenant-1', settingsOverrides: {}, __v: 3 }
  });
  const service = createSettingsService({ ...stores, env: {} });

  for (const key of ['security.ownerRole', 'policies.password.minLength', 'unknown.value']) {
    await assert.rejects(
      service.setTenantOverrides('tenant-1', { [key]: 'unsafe' }, 3, OWNER),
      (error) => error.code === 'INVALID_OVERRIDE_KEY' && error.status === 400
    );
  }
});

test('settings updates enforce optimistic versions and validate registered values', async () => {
  // Mutation caught: stale writes overwrite a newer settings document or invalid bounds persist.
  const stores = fakeSettingsStores({
    global: { singletonKey: 'platform', defaults: { timezone: 'UTC' }, __v: 7 },
    tenant: { _id: 'tenant-1', settingsOverrides: {}, __v: 1 }
  });
  const service = createSettingsService({ ...stores, env: {} });

  await assert.rejects(
    service.updateSection('defaults', { timezone: 'Asia/Kolkata' }, 6, OWNER),
    (error) => error.code === 'SETTINGS_CONFLICT' && error.status === 409
  );
  await assert.rejects(
    service.updateSection('defaults', { limits: { maxUsers: -1 } }, 7, OWNER),
    (error) => error.code === 'INVALID_SETTING_VALUE' && error.status === 400
  );

  const updated = await service.updateSection('defaults', { timezone: 'Asia/Kolkata' }, 7, OWNER);
  assert.equal(updated.global.defaults.timezone, 'Asia/Kolkata');
  assert.equal(updated.version, 8);
});

test('the first version-zero settings write creates the singleton without weakening later conflicts', async () => {
  // Mutation caught: a fresh deployment can read fallbacks but can never persist its first settings change.
  let record = null;
  const PlatformSettingsModel = {
    findOne() {
      return queryResult(record);
    },
    findOneAndUpdate(filter, update, options) {
      if (!record && options.upsert === true && filter.__v === 0) {
        record = { singletonKey: 'platform', defaults: { timezone: update.$set['defaults.timezone'] }, __v: 1 };
        return queryResult(record);
      }
      return queryResult(null);
    }
  };
  const TenantModel = {
    findOne() { return queryResult({ _id: 'tenant-1', settingsOverrides: {}, __v: 0 }); },
    findOneAndUpdate() { return queryResult(null); }
  };
  const service = createSettingsService({ PlatformSettingsModel, TenantModel, env: {} });

  const created = await service.updateSection('defaults', { timezone: 'Asia/Kolkata' }, 0, OWNER);
  assert.equal(created.global.defaults.timezone, 'Asia/Kolkata');
  assert.equal(created.version, 1);
  await assert.rejects(
    service.updateSection('defaults', { timezone: 'UTC' }, 0, OWNER),
    (error) => error.code === 'SETTINGS_CONFLICT'
  );
});

test('runtime integration resolution keeps secrets internal and prefers database configuration', async () => {
  // Mutation caught: provider use reads environment before persisted settings/secrets or exposes secrets in public DTOs.
  const stores = fakeSettingsStores({
    global: {
      singletonKey: 'platform',
      providers: { gemini: { model: 'database-model', temperature: 0.2 } },
      __v: 5
    },
    tenant: { _id: 'tenant-1', settingsOverrides: {}, __v: 1 }
  });
  const secretService = {
    async resolveSecret(integration, key) {
      assert.equal(integration, 'gemini');
      assert.equal(key, 'apiKey');
      return 'database-api-key';
    }
  };
  const service = createSettingsService({
    ...stores,
    secretService,
    env: { GEMINI_MODEL: 'environment-model', GEMINI_API_KEY: 'environment-api-key' }
  });

  const publicSettings = await service.getGlobal();
  const runtime = await service.getIntegrationRuntimeConfig('gemini', 'tenant-1');

  assert.equal(runtime.settings.model, 'database-model');
  assert.equal(runtime.settings.temperature, 0.2);
  assert.equal(runtime.secrets.apiKey, 'database-api-key');
  assert.equal(JSON.stringify(publicSettings).includes('database-api-key'), false);
  assert.equal(JSON.stringify(publicSettings).includes('environment-api-key'), false);
});

test('SMTP transport resolves managed configuration for each delivery', async () => {
  // Mutation caught: the transporter captures SMTP environment credentials once at module load.
  const transports = [];
  const mail = [];
  const service = createEmailService({
    nodemailerImpl: {
      createTransport(options) {
        transports.push(options);
        return { async sendMail(message) { mail.push(message); return { messageId: 'mail-1' }; } };
      }
    },
    getIntegrationRuntimeConfig: async (integration, tenantId) => {
      assert.equal(integration, 'smtp');
      assert.equal(tenantId, 'tenant-1');
      return {
        settings: {
          enabled: true,
          host: 'smtp.database.example',
          port: 465,
          secure: true,
          user: 'database-user',
          fromName: 'Database Sender',
          fromAddress: 'sender@example.com'
        },
        secrets: { password: 'database-password' }
      };
    },
    logger: { info() {}, warn() {}, error() {} }
  });

  const result = await service.sendDailyReportToAdmin(
    'admin@example.com',
    'Tenant',
    { totalCalls: 4, successful: 3, failed: 1 },
    { tenantId: 'tenant-1' }
  );

  assert.deepEqual(transports, [{
    host: 'smtp.database.example',
    port: 465,
    secure: true,
    auth: { user: 'database-user', pass: 'database-password' }
  }]);
  assert.equal(mail[0].from, '"Database Sender" <sender@example.com>');
  assert.deepEqual(result, { delivered: true, messageId: 'mail-1' });
  assert.equal(JSON.stringify(result).includes('database-password'), false);
});

test('Slack notifier resolves the write-only webhook immediately before delivery', async () => {
  // Mutation caught: notifier captures an environment webhook URL during router construction.
  const requests = [];
  const notify = createSlackSupportNotifier({
    getIntegrationRuntimeConfig: async (integration, tenantId) => {
      assert.equal(integration, 'slack');
      assert.equal(tenantId, 'tenant-1');
      return {
        settings: { enabled: true },
        secrets: { supportWebhookUrl: 'https://hooks.slack.test/database-secret' }
      };
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
    logger: { warn() {} }
  });

  const result = await notify({
    ticket_id: 'BUG-1',
    type: 'BUG',
    description: 'Safe description',
    reporter_role: 'CLIENT_ADMIN',
    page_url: 'https://app.example/support',
    admin_url: 'https://app.example/support/BUG-1',
    tenant_id: 'tenant-1'
  });

  assert.equal(requests[0].url, 'https://hooks.slack.test/database-secret');
  assert.deepEqual(result, { delivered: true });
  assert.equal(JSON.stringify(result).includes('database-secret'), false);
});

test('Slack delivery logs fixed metadata rather than transport errors that may echo secrets', async () => {
  const echoedSecret = 'transport-echoed-slack-webhook-secret';
  const warnings = [];
  const notify = createSlackSupportNotifier({
    getIntegrationRuntimeConfig: async () => ({
      settings: { enabled: true },
      secrets: { supportWebhookUrl: 'https://hooks.slack.test/database-secret' }
    }),
    fetchImpl: async () => { throw new Error(echoedSecret); },
    logger: { warn(...values) { warnings.push(values); } }
  });

  const result = await notify({ ticket_id: 'BUG-2', type: 'BUG', description: 'Safe' });

  assert.deepEqual(result, { delivered: false });
  assert.equal(JSON.stringify(warnings).includes(echoedSecret), false);
});
