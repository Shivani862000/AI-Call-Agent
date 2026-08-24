'use strict';

const { WebmasterError } = require('./errors');
const {
  INTEGRATION_DEFINITIONS,
  OVERRIDABLE_KEYS,
  SETTING_DEFINITIONS,
  environmentKeyForSecret
} = require('./settings-registry');

const ALL_SAFE_DEFINITIONS = Object.freeze(Object.assign(
  {},
  SETTING_DEFINITIONS,
  ...Object.entries(INTEGRATION_DEFINITIONS).map(([integration, definition]) => Object.fromEntries(
    Object.entries(definition.settings).map(([key, field]) => [`providers.${integration}.${key}`, field])
  ))
));

function settingsError(status, code, message, fieldErrors = {}) {
  return new WebmasterError({ status, code, message, fieldErrors });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(object, key) {
  if (!isPlainObject(object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function getPath(object, path) {
  let cursor = object;
  for (const part of path.split('.')) {
    cursor = ownValue(cursor, part);
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

function setPath(object, path, value) {
  const parts = path.split('.');
  let cursor = object;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[0]] = value;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, 'value')) result[key] = cloneValue(descriptor.value);
  }
  return result;
}

function parseEnvironmentValue(raw, definition) {
  if (raw === undefined || raw === null || raw === '') return cloneValue(definition.fallback);
  if (definition.type === 'boolean') {
    if (/^(1|true|yes|on)$/i.test(String(raw))) return true;
    if (/^(0|false|no|off)$/i.test(String(raw))) return false;
    return undefined;
  }
  if (definition.type === 'integer' || definition.type === 'number') return Number(raw);
  if (definition.type === 'array') {
    return String(raw).split(',').map((item) => item.trim()).filter(Boolean);
  }
  return String(raw);
}

function environmentFallback(definition, env) {
  const key = (definition.env || []).find((candidate) => env[candidate] !== undefined && env[candidate] !== '');
  const candidate = parseEnvironmentValue(key ? env[key] : undefined, definition);
  return valueIsValid(candidate, definition)
    ? candidate
    : cloneValue(definition.fallback);
}

function valueIsValid(value, definition) {
  if (definition.type === 'boolean') return typeof value === 'boolean';
  if (definition.type === 'integer') {
    return Number.isInteger(value)
      && (definition.min === undefined || value >= definition.min)
      && (definition.max === undefined || value <= definition.max);
  }
  if (definition.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      && (definition.min === undefined || value >= definition.min)
      && (definition.max === undefined || value <= definition.max);
  }
  if (definition.type === 'array') {
    return Array.isArray(value)
      && value.every((item) => typeof item === 'string' && (!definition.items || definition.items.includes(item)));
  }
  if (definition.type === 'enum') return definition.values.includes(value);
  if (typeof value !== 'string') return false;
  if (!definition.allowEmpty && definition.minLength !== undefined && value.length < definition.minLength) return false;
  if (!definition.allowEmpty && definition.type === 'url' && !value) return false;
  if (definition.maxLength !== undefined && value.length > definition.maxLength) return false;
  if (definition.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  if (definition.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  if (definition.type === 'timezone') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    } catch (_error) {
      return false;
    }
  }
  if (definition.type === 'url' && value) {
    try {
      const url = new URL(value);
      if (definition.protocols && !definition.protocols.includes(url.protocol)) return false;
      if (!definition.protocols && !['http:', 'https:'].includes(url.protocol)) return false;
    } catch (_error) {
      return false;
    }
  }
  return true;
}

function validateValue(path, value, definition, code = 'INVALID_SETTING_VALUE') {
  if (!valueIsValid(value, definition)) {
    throw settingsError(400, code, 'One or more settings are invalid', { [path]: 'Invalid setting value' });
  }
  return cloneValue(value);
}

function flattenPatch(value, prefix = '') {
  if (!isPlainObject(value)) {
    throw settingsError(400, 'INVALID_SETTING_VALUE', 'Settings patch must be a plain object');
  }
  const result = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || !key || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw settingsError(400, 'INVALID_SETTING_VALUE', 'Settings patch contains an unsafe key');
    }
    const path = prefix ? `${prefix}.${key}` : key;
    const fieldValue = descriptor.value;
    if (isPlainObject(fieldValue) && !ALL_SAFE_DEFINITIONS[path]) {
      Object.assign(result, flattenPatch(fieldValue, path));
    } else {
      result[path] = fieldValue;
    }
  }
  return result;
}

async function leanResult(query) {
  if (query && typeof query.lean === 'function') return query.lean();
  return query;
}

function safeVersion(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizedOverrides(record) {
  const raw = record?.settingsOverrides;
  const normalized = raw instanceof Map ? Object.fromEntries(raw.entries()) : raw;
  if (!isPlainObject(normalized)) return {};
  const overrides = {};
  for (const [path, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(normalized))) {
    if (!Object.hasOwn(descriptor, 'value') || !OVERRIDABLE_KEYS.has(path)) continue;
    const definition = ALL_SAFE_DEFINITIONS[path];
    if (definition && valueIsValid(descriptor.value, definition)) overrides[path] = cloneValue(descriptor.value);
  }
  return overrides;
}

function validateSectionInvariants(settings, section, code = 'INVALID_SETTING_VALUE') {
  if (section === 'policies') {
    const minLength = getPath(settings, 'policies.password.minLength');
    const maxLength = getPath(settings, 'policies.password.maxLength');
    if (Number.isInteger(minLength) && Number.isInteger(maxLength) && minLength > maxLength) {
      throw settingsError(400, code, 'One or more settings are invalid', {
        'policies.password.minLength': 'Must not exceed maximum password length',
        'policies.password.maxLength': 'Must not be less than minimum password length'
      });
    }
  }
  if (section === 'defaults') {
    const concurrent = getPath(settings, 'defaults.limits.maxConcurrentCalls');
    const daily = getPath(settings, 'defaults.limits.maxCallsPerDay');
    if (Number.isInteger(concurrent) && Number.isInteger(daily) && concurrent > daily) {
      throw settingsError(400, code, 'One or more settings are invalid', {
        'defaults.limits.maxConcurrentCalls': 'Must not exceed maximum calls per day',
        'defaults.limits.maxCallsPerDay': 'Must not be less than maximum concurrent calls'
      });
    }
  }
}

function validateResolvedSettings(settings) {
  try {
    validateSectionInvariants(settings, 'policies');
    validateSectionInvariants(settings, 'defaults');
  } catch (_error) {
    throw settingsError(500, 'SETTINGS_INVALID', 'Resolved settings are invalid');
  }
  return settings;
}

function safeResolvedGlobal(record, env) {
  const global = {};
  for (const [path, definition] of Object.entries(ALL_SAFE_DEFINITIONS)) {
    const persisted = getPath(record, path);
    const value = persisted !== undefined && valueIsValid(persisted, definition)
      ? persisted
      : environmentFallback(definition, env);
    setPath(global, path, cloneValue(value));
  }
  return validateResolvedSettings(global);
}

function validateExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw settingsError(400, 'INVALID_EXPECTED_VERSION', 'A non-negative integer expected version is required');
  }
}

function createSettingsService({
  PlatformSettingsModel,
  TenantModel,
  auditService = null,
  secretService = null,
  env = process.env
}) {
  if (!PlatformSettingsModel || typeof PlatformSettingsModel.findOne !== 'function' || typeof PlatformSettingsModel.findOneAndUpdate !== 'function') {
    throw new TypeError('PlatformSettingsModel with findOne() and findOneAndUpdate() is required');
  }
  if (!TenantModel || typeof TenantModel.findOne !== 'function' || typeof TenantModel.findOneAndUpdate !== 'function') {
    throw new TypeError('TenantModel with findOne() and findOneAndUpdate() is required');
  }

  async function readGlobalRecord() {
    return leanResult(PlatformSettingsModel.findOne({ singletonKey: 'platform' }));
  }

  async function readTenantRecord(tenantId) {
    const id = String(tenantId || '').trim();
    if (!id) throw settingsError(400, 'INVALID_TENANT_ID', 'A tenant identifier is required');
    const tenant = await leanResult(TenantModel.findOne({ _id: id }));
    if (!tenant) throw settingsError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    return tenant;
  }

  async function getGlobal() {
    const record = await readGlobalRecord();
    return { global: safeResolvedGlobal(record, env), version: safeVersion(record?.__v) };
  }

  async function updateSection(section, patch, expectedVersion, actor) {
    validateExpectedVersion(expectedVersion);
    const normalizedSection = String(section || '').trim();
    const flattened = flattenPatch(patch, normalizedSection);
    if (!Object.keys(flattened).length) {
      throw settingsError(400, 'INVALID_SETTING_VALUE', 'At least one setting is required');
    }
    const validated = {};
    for (const [path, value] of Object.entries(flattened)) {
      const definition = ALL_SAFE_DEFINITIONS[path];
      if (!definition || path.split('.')[0] !== normalizedSection) {
        throw settingsError(400, 'UNKNOWN_SETTING_KEY', 'One or more settings are not registered', { [path]: 'Unknown setting' });
      }
      validated[path] = validateValue(path, value, definition);
    }

    const before = await getGlobal();
    const candidate = cloneValue(before.global);
    for (const [path, value] of Object.entries(validated)) setPath(candidate, path, cloneValue(value));
    validateSectionInvariants(candidate, normalizedSection);
    let updated;
    try {
      updated = await leanResult(PlatformSettingsModel.findOneAndUpdate(
        { singletonKey: 'platform', __v: expectedVersion },
        {
          $set: validated,
          $inc: { __v: 1 },
          ...(expectedVersion === 0 ? { $setOnInsert: { schemaVersion: 1 } } : {})
        },
        {
          new: true,
          runValidators: true,
          ...(expectedVersion === 0 ? { upsert: true, setDefaultsOnInsert: true } : {})
        }
      ));
    } catch (error) {
      if (error?.code === 11000 && expectedVersion === 0) {
        throw settingsError(409, 'SETTINGS_CONFLICT', 'Settings changed; refresh before saving again');
      }
      throw error;
    }
    if (!updated) throw settingsError(409, 'SETTINGS_CONFLICT', 'Settings changed; refresh before saving again');
    const result = { global: safeResolvedGlobal(updated, env), version: safeVersion(updated.__v) };
    if (auditService?.record) {
      await auditService.record({
        actor,
        action: 'settings.update',
        target: { type: 'platform-settings', id: 'platform' },
        before: before.global[normalizedSection] || null,
        after: result.global[normalizedSection] || null,
        outcome: 'success'
      });
    }
    return result;
  }

  async function getEffectiveForTenant(tenantId) {
    const [globalResult, tenant] = await Promise.all([getGlobal(), readTenantRecord(tenantId)]);
    const flatOverrides = normalizedOverrides(tenant);
    const overrides = {};
    const effective = cloneValue(globalResult.global);
    const inherited = {};
    for (const path of Object.keys(ALL_SAFE_DEFINITIONS)) setPath(inherited, path, true);
    for (const [path, value] of Object.entries(flatOverrides)) {
      setPath(overrides, path, cloneValue(value));
      setPath(effective, path, cloneValue(value));
      setPath(inherited, path, false);
    }
    validateResolvedSettings(effective);
    return {
      global: globalResult.global,
      overrides,
      effective,
      inherited,
      version: safeVersion(tenant.__v)
    };
  }

  async function setTenantOverrides(tenantId, overrides, expectedVersion, actor) {
    validateExpectedVersion(expectedVersion);
    if (!isPlainObject(overrides)) {
      throw settingsError(400, 'INVALID_OVERRIDE_KEY', 'Tenant overrides must be a plain object');
    }
    const validated = {};
    for (const [path, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(overrides))) {
      if (!Object.hasOwn(descriptor, 'value') || !OVERRIDABLE_KEYS.has(path)) {
        throw settingsError(400, 'INVALID_OVERRIDE_KEY', 'A tenant override key is not allowed', { [path]: 'Override is not allowed' });
      }
      validated[path] = validateValue(path, descriptor.value, ALL_SAFE_DEFINITIONS[path], 'INVALID_OVERRIDE_VALUE');
    }
    const globalResult = await getGlobal();
    const effectiveCandidate = cloneValue(globalResult.global);
    for (const [path, value] of Object.entries(validated)) setPath(effectiveCandidate, path, cloneValue(value));
    for (const section of new Set(Object.keys(validated).map((path) => path.split('.')[0]))) {
      validateSectionInvariants(effectiveCandidate, section, 'INVALID_OVERRIDE_VALUE');
    }
    const before = await readTenantRecord(tenantId);
    const updated = await leanResult(TenantModel.findOneAndUpdate(
      { _id: String(tenantId), __v: expectedVersion },
      { $set: { settingsOverrides: validated }, $inc: { __v: 1 } },
      { new: true, runValidators: true, strict: false }
    ));
    if (!updated) throw settingsError(409, 'SETTINGS_CONFLICT', 'Tenant settings changed; refresh before saving again');
    if (auditService?.record) {
      await auditService.record({
        actor,
        action: 'tenant.settings.update',
        target: { type: 'tenant', id: String(tenantId) },
        tenantId: String(tenantId),
        before: { settingsOverrides: normalizedOverrides(before) },
        after: { settingsOverrides: validated },
        outcome: 'success'
      });
    }
    return getEffectiveForTenant(tenantId);
  }

  async function getIntegrationRuntimeConfig(integration, tenantId = null) {
    const normalized = String(integration || '').trim().toLowerCase();
    const definition = INTEGRATION_DEFINITIONS[normalized];
    if (!definition) throw settingsError(400, 'UNKNOWN_INTEGRATION', 'Integration is not registered');
    const resolved = tenantId ? await getEffectiveForTenant(tenantId) : await getGlobal();
    const values = tenantId ? resolved.effective : resolved.global;
    const settings = cloneValue(getPath(values, `providers.${normalized}`) || {});
    const secrets = {};
    for (const [key, secretDefinition] of Object.entries(definition.secrets)) {
      let value = secretService?.resolveSecret
        ? await secretService.resolveSecret(normalized, key)
        : null;
      if (value == null) {
        const envKey = secretDefinition.env.find((candidate) => typeof env[candidate] === 'string' && env[candidate].length > 0);
        value = envKey ? env[envKey] : null;
      }
      secrets[key] = value;
    }
    return { settings, secrets };
  }

  return { getGlobal, updateSection, getEffectiveForTenant, setTenantOverrides, getIntegrationRuntimeConfig };
}

let defaultService = null;

function defaultSettingsService() {
  if (defaultService) return defaultService;
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) return null;
  const PlatformSettings = require('../models/PlatformSettings');
  const Tenant = require('../models/Tenant');
  const IntegrationSecret = require('../models/IntegrationSecret');
  const { createSecretService } = require('./secret-service');
  const secretService = createSecretService({
    IntegrationSecretModel: IntegrationSecret,
    environmentKeyFor: (integration, key) => environmentKeyForSecret(integration, key, process.env)
  });
  defaultService = createSettingsService({ PlatformSettingsModel: PlatformSettings, TenantModel: Tenant, secretService });
  return defaultService;
}

async function getIntegrationRuntimeConfig(integration, tenantId = null) {
  const service = defaultSettingsService();
  if (service) return service.getIntegrationRuntimeConfig(integration, tenantId);

  const definition = INTEGRATION_DEFINITIONS[String(integration || '').trim().toLowerCase()];
  if (!definition) throw settingsError(400, 'UNKNOWN_INTEGRATION', 'Integration is not registered');
  const settings = {};
  for (const [key, field] of Object.entries(definition.settings)) {
    settings[key] = environmentFallback(field, process.env);
  }
  const secrets = {};
  for (const [key, field] of Object.entries(definition.secrets)) {
    const envKey = field.env.find((candidate) => typeof process.env[candidate] === 'string' && process.env[candidate].length > 0);
    secrets[key] = envKey ? process.env[envKey] : null;
  }
  return { settings, secrets };
}

module.exports = { createSettingsService, getIntegrationRuntimeConfig };
