'use strict';

const crypto = require('node:crypto');

const METADATA_PROJECTION = Object.freeze({ _id: 0, updated_at: 1, updatedBy: 1 });
const ENVELOPE_SELECTION = '+ciphertext +iv +authTag +encryptionVersion';

function secretError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeLookupPart(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 128 || !/^[a-z0-9._:-]+$/i.test(normalized)) {
    throw secretError('INVALID_SECRET_IDENTIFIER', `A valid ${label} identifier is required`);
  }
  return normalized;
}

function decodeEncryptionKey(encoded) {
  const value = String(encoded || '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw secretError('INVALID_WEBMASTER_SECRETS_KEY', 'WEBMASTER_SECRETS_KEY must be canonical base64 for exactly 32 bytes');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw secretError('INVALID_WEBMASTER_SECRETS_KEY', 'WEBMASTER_SECRETS_KEY must be canonical base64 for exactly 32 bytes');
  }
  return decoded;
}

function defaultEnvironmentKeyFor(integration, key) {
  const part = (value) => String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `${part(integration)}_${part(key)}`;
}

function stableActorId(actor) {
  const value = actor?.id || actor?._id;
  const normalized = value == null ? '' : String(value).trim();
  if (normalized && normalized.length <= 128 && /^[a-z0-9._:-]+$/i.test(normalized)) return normalized;
  if (actor?.source === 'environment') return 'environment-owner';
  return 'system';
}

function actorAccessLevel(actor) {
  const level = String(actor?.platformAccessLevel || '').toUpperCase();
  return level === 'OWNER' || level === 'ADMIN' ? level : 'SYSTEM';
}

async function executeLean(query) {
  if (query && typeof query.lean === 'function') return query.lean();
  return query;
}

async function findSelected(Model, filter, selection) {
  let query = Model.findOne(filter);
  if (query && typeof query.select === 'function') query = query.select(selection);
  return executeLean(query);
}

function metadataForDatabase(record) {
  return {
    configured: true,
    source: 'database',
    updatedAt: record?.updated_at || null,
    updatedBy: record?.updatedBy || null
  };
}

function metadataForEnvironment(configured) {
  return {
    configured,
    source: configured ? 'environment' : null,
    updatedAt: null,
    updatedBy: null
  };
}

function createSecretService({
  IntegrationSecretModel,
  env = process.env,
  randomBytes = crypto.randomBytes,
  environmentKeyFor = defaultEnvironmentKeyFor
}) {
  if (!IntegrationSecretModel
    || typeof IntegrationSecretModel.findOne !== 'function'
    || typeof IntegrationSecretModel.findOneAndUpdate !== 'function') {
    throw new TypeError('IntegrationSecretModel with findOne() and findOneAndUpdate() is required');
  }
  if (typeof randomBytes !== 'function' || typeof environmentKeyFor !== 'function') {
    throw new TypeError('randomBytes and environmentKeyFor must be functions');
  }

  function lookup(integration, key) {
    return {
      integration: normalizeLookupPart(integration, 'integration'),
      key: normalizeLookupPart(key, 'secret key')
    };
  }

  function environmentValue(integration, key) {
    const environmentKey = environmentKeyFor(integration, key);
    if (!environmentKey) return null;
    const value = env[environmentKey];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  async function getMetadata(integration, key) {
    const filter = lookup(integration, key);
    const record = await findSelected(IntegrationSecretModel, filter, METADATA_PROJECTION);
    if (record) return metadataForDatabase(record);
    return metadataForEnvironment(environmentValue(filter.integration, filter.key) !== null);
  }

  async function replaceSecret({ integration, key, value, actor } = {}) {
    const filter = lookup(integration, key);
    if (typeof value !== 'string') {
      throw secretError('INVALID_SECRET_VALUE', 'Secret replacement requires a string value');
    }
    if (!value.trim()) return getMetadata(filter.integration, filter.key);

    const encryptionKey = decodeEncryptionKey(env.WEBMASTER_SECRETS_KEY);
    const iv = Buffer.from(randomBytes(12));
    if (iv.length !== 12) {
      throw secretError('SECRET_ENCRYPTION_FAILED', 'Unable to encrypt the integration secret');
    }

    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const updatedBy = stableActorId(actor);
    const updatedByAccessLevel = actorAccessLevel(actor);
    const record = await IntegrationSecretModel.findOneAndUpdate(
      filter,
      {
        $set: {
          ciphertext: ciphertext.toString('base64'),
          iv: iv.toString('base64'),
          authTag: authTag.toString('base64'),
          encryptionVersion: 1,
          updatedBy,
          updatedByAccessLevel
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    return metadataForDatabase(record);
  }

  async function resolveSecret(integration, key) {
    const filter = lookup(integration, key);
    const record = await findSelected(IntegrationSecretModel, filter, ENVELOPE_SELECTION);
    if (!record) return environmentValue(filter.integration, filter.key);

    try {
      if (record.encryptionVersion !== 1) throw new Error('Unsupported envelope version');
      const encryptionKey = decodeEncryptionKey(env.WEBMASTER_SECRETS_KEY);
      const iv = Buffer.from(String(record.iv || ''), 'base64');
      const authTag = Buffer.from(String(record.authTag || ''), 'base64');
      const ciphertext = Buffer.from(String(record.ciphertext || ''), 'base64');
      if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
        throw new Error('Invalid envelope');
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      if (error?.code === 'INVALID_WEBMASTER_SECRETS_KEY') throw error;
      throw secretError('SECRET_DECRYPTION_FAILED', 'Unable to resolve the integration secret');
    }
  }

  return { replaceSecret, getMetadata, resolveSecret };
}

module.exports = { createSecretService };
