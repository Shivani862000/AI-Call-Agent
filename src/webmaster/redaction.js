'use strict';

const mongoose = require('mongoose');
const { types: utilTypes } = require('node:util');
const {
  isInvalidRetainedValue,
  normalizeNullableObjectId
} = require('./value-safe-validation');

const REDACTED = '[redacted]';
const ACCESSOR_VALUE = Symbol('accessor-value');
const NOT_A_DATE = Symbol('not-a-date');
const MAP_BRAND_PROBE = Symbol('map-brand-probe');
const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const SHARED_ARRAY_BUFFER_BYTE_LENGTH = typeof SharedArrayBuffer === 'undefined'
  ? null
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get;
const DATA_VIEW_BYTE_LENGTH = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get;

const OPERATIONAL_FAILURE_CODES = Object.freeze([
  'ACCOUNT_INACTIVE',
  'CONFLICT',
  'DATABASE_UNAVAILABLE',
  'DELIVERY_FAILED',
  'DELIVERY_NOT_FOUND',
  'DELIVERY_RETRY_FAILED',
  'EMAIL_DELIVERY_FAILED',
  'FORBIDDEN',
  'INTEGRATION_NOT_CONFIGURED',
  'INTEGRATION_UNAVAILABLE',
  'INTERNAL_ERROR',
  'IMMUTABLE_AUDIT_EVENT',
  'INVALID_AUDIT_ACTION',
  'INVALID_AUDIT_ACTOR',
  'INVALID_AUDIT_ACTOR_ACCESS_LEVEL',
  'INVALID_AUDIT_FAILURE_CODE',
  'INVALID_AUDIT_INPUT',
  'INVALID_AUDIT_OUTCOME',
  'INVALID_AUDIT_REQUEST_ID',
  'INVALID_AUDIT_TARGET_ID',
  'INVALID_AUDIT_TARGET_TYPE',
  'INVALID_AUDIT_TENANT_ID',
  'INVALID_INPUT',
  'INVALID_NOTIFICATION_ACCOUNT_ID',
  'INVALID_NOTIFICATION_EVENT',
  'INVALID_NOTIFICATION_FILTER',
  'INVALID_NOTIFICATION_FILTER_ID',
  'INVALID_NOTIFICATION_FAILURE_CODE',
  'INVALID_NOTIFICATION_INPUT',
  'INVALID_NOTIFICATION_LAST_ATTEMPT_AT',
  'INVALID_NOTIFICATION_RECIPIENT_CATEGORY',
  'INVALID_NOTIFICATION_RETRY_COUNT',
  'INVALID_NOTIFICATION_RETRY_INCREMENT',
  'INVALID_NOTIFICATION_SENT_AT',
  'INVALID_NOTIFICATION_STATUS',
  'INVALID_NOTIFICATION_STATE_MUTATION',
  'INVALID_NOTIFICATION_TEMPLATE',
  'INVALID_NOTIFICATION_TENANT_ID',
  'INVALID_OVERRIDE_KEY',
  'INVALID_SECRET_IDENTIFIER',
  'INVALID_SECRET_VALUE',
  'INVALID_WEBMASTER_SECRETS_KEY',
  'LAST_OWNER_REQUIRED',
  'MAINTENANCE_MODE',
  'NETWORK_ERROR',
  'NOTIFICATION_NOT_FOUND',
  'NOT_FOUND',
  'OWNER_REQUIRED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'SECRET_DECRYPTION_FAILED',
  'SECRET_ENCRYPTION_FAILED',
  'SETTINGS_CONFLICT',
  'SMTP_AUTH_FAILED',
  'SMTP_TIMEOUT',
  'SMTP_UNAVAILABLE',
  'TENANT_ADMIN_REQUIRED',
  'TENANT_INACTIVE',
  'TIMEOUT',
  'UNAUTHORIZED',
  'UNSUPPORTED_NOTIFICATION_BULK_WRITE',
  'UNSUPPORTED_NOTIFICATION_LEAN_INSERT_MANY',
  'UNSUPPORTED_NOTIFICATION_METADATA_UPDATE',
  'UNSUPPORTED_NOTIFICATION_OPERATOR_OPERAND',
  'UNSUPPORTED_NOTIFICATION_STRUCTURAL_UPDATE',
  'UNSUPPORTED_NOTIFICATION_UPDATE_PIPELINE',
  'UNSUPPORTED_AUDIT_LEAN_INSERT_MANY',
  'UNSAFE_AUDIT_INSERT_MANY_OPTIONS',
  'UNSAFE_NOTIFICATION_INSERT_MANY_OPTIONS',
  'UNSAFE_NOTIFICATION_UPDATE',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'WEBMASTER_ACCESS_UNASSIGNED',
  'WEBMASTER_FORBIDDEN',
  'WEBMASTER_OWNER_REQUIRED'
]);

const OPERATIONAL_FAILURE_CODE_SET = new Set(OPERATIONAL_FAILURE_CODES);

const SAFE_MACHINE_STRING_KEYS = new Set([
  'accountid',
  'action',
  'actor',
  'actoraccesslevel',
  'event',
  'integration',
  'integrationstatus',
  'id',
  'deliverystatus',
  'notificationstatus',
  'outcome',
  'provider',
  'providerstatus',
  'requestid',
  'source',
  'status',
  'targetid',
  'targettype',
  'template',
  'tenantid',
  'updatedby'
]);

const SAFE_BOOLEAN_KEYS = new Set(['configured']);
const SAFE_INTEGER_KEYS = new Set([
  'active',
  'archived',
  'attempts',
  'completed',
  'delivered',
  'encryptionversion',
  'failed',
  'inactive',
  'limit',
  'pending',
  'retrycount',
  'schemaversion',
  'statuscode',
  'suspended',
  'total',
  'usage',
  'usagetotal',
  'used',
  'version',
  'queuedepth',
  'ratelimit',
  'retentiondays'
]);
const SAFE_RATE_KEYS = new Set([
  'callcompletionrate',
  'callfailurerate',
  'completionrate',
  'failurerate',
  'quotausagerate',
  'successrate',
  'usagerate'
]);
const SAFE_DATE_KEYS = new Set([
  'createdat',
  'created_at',
  'lastattemptat',
  'sentat',
  'updatedat',
  'updated_at'
]);
const SAFE_SLUG_KEYS = new Set([
  'integrationid',
  'model',
  'modelid',
  'plan',
  'providerid',
  'section'
]);
const SAFE_RECURSIVE_KEYS = new Set([
  'after',
  'application',
  'attentionitems',
  'attempts',
  'before',
  'calls',
  'defaults',
  'details',
  'maintenance',
  'metadata',
  'nested',
  'notificationtemplates',
  'notifications',
  'policies',
  'recentaudit',
  'retention',
  'tenants',
  'usage',
  'users'
]);
const NULLABLE_SAFE_KEYS = new Set([
  'accountid',
  'failurecode',
  'lastattemptat',
  'requestid',
  'sentat',
  'targetid',
  'tenantid',
  'updatedat',
  'updated_at',
  'updatedby'
]);

const PROVIDER_VALUES = new Set(['deepgram', 'gemini', 'icallmate', 'slack', 'smtp', 'webhook']);
const STATUS_VALUES = new Set([
  'active',
  'archived',
  'completed',
  'configured',
  'degraded',
  'delivered',
  'disabled',
  'enabled',
  'failed',
  'failure',
  'healthy',
  'inactive',
  'pending',
  'processing',
  'restored',
  'success',
  'suspended',
  'unconfigured',
  'unhealthy'
]);
const SAFE_ENUM_FIELDS = new Map([
  ['actoraccesslevel', new Set(['ADMIN', 'OWNER', 'SYSTEM'])],
  ['deliverystatus', STATUS_VALUES],
  ['integration', PROVIDER_VALUES],
  ['integrationstatus', STATUS_VALUES],
  ['notificationstatus', STATUS_VALUES],
  ['outcome', new Set(['delivered', 'failed', 'failure', 'success'])],
  ['provider', PROVIDER_VALUES],
  ['providerstatus', STATUS_VALUES],
  ['recipientcategory', new Set(['account', 'owner', 'support', 'tenant_admin'])],
  ['source', new Set(['database', 'default', 'environment', 'global', 'inherited', 'runtime', 'tenant'])],
  ['status', STATUS_VALUES]
]);

const PRE_SENSITIVE_EXACT_FIELDS = new Map([
  ['featureflags', sanitizeFeatureFlags],
  ['health', sanitizeHealthValue],
  ['healthstatus', sanitizeHealthValue],
  ['integrationhealth', sanitizeHealthValue],
  ['integrations', sanitizeIntegrationMap],
  ['providers', sanitizeIntegrationMap],
  ['providerhealth', sanitizeHealthValue],
  ['requestid', (value) => isSafeCorrelationId(value) ? value : REDACTED],
  ['servicehealth', sanitizeHealthValue],
  ['systemhealth', sanitizeHealthValue]
]);

const SENSITIVE_TOKENS = new Set([
  'aadhaar',
  'aadhar',
  'address',
  'answer',
  'auth',
  'authentication',
  'authorization',
  'bearer',
  'birthdate',
  'birthday',
  'body',
  'clinical',
  'comment',
  'connection',
  'content',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'customer',
  'diagnosis',
  'dob',
  'email',
  'error',
  'feedback',
  'health',
  'jwt',
  'medical',
  'message',
  'mobile',
  'mrn',
  'name',
  'note',
  'notes',
  'pass',
  'passphrase',
  'passwd',
  'password',
  'patient',
  'payload',
  'phi',
  'phone',
  'pii',
  'prompt',
  'pwd',
  'question',
  'reason',
  'recording',
  'request',
  'response',
  'secret',
  'ssn',
  'stack',
  'subject',
  'text',
  'token',
  'trace',
  'transcript',
  'user',
  'username'
]);

const SENSITIVE_COMPACT_PATTERNS = [
  'accesskey',
  'aadhaar',
  'aadhar',
  'apikey',
  'authtag',
  'authentication',
  'authorization',
  'birthdate',
  'ciphertext',
  'clinicalnote',
  'connectionstring',
  'connectionuri',
  'credential',
  'customer',
  'databaseurl',
  'databaseuri',
  'datasourceurl',
  'dburi',
  'dburl',
  'dateofbirth',
  'diagnosis',
  'ehealth',
  'emailaddress',
  'externalid',
  'externalidentifier',
  'followuppending',
  'freetext',
  'healthcare',
  'healthinsurance',
  'initializationvector',
  'interestedservice',
  'jdbcurl',
  'lastvisit',
  'medicalrecord',
  'mongodburl',
  'mongodburi',
  'mongouri',
  'mrnnumber',
  'outstandingissue',
  'password',
  'pendingfollowup',
  'patientidentifier',
  'phonenumber',
  'postgresurl',
  'previousvisit',
  'privatekey',
  'recording',
  'redisurl',
  'requestbody',
  'requestmessage',
  'requestpayload',
  'serviceinterest',
  'sessioncookie',
  'socialsecuritynumber',
  'ssnnumber',
  'transcript',
  'ukey',
  'visitdate'
];

function keyParts(key) {
  if (typeof key !== 'string') return { compact: '', normalized: '', tokens: [] };
  const separated = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const tokens = separated.split(/[^a-z0-9]+/).filter(Boolean);
  const compact = key.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return { compact, normalized: tokens.join(''), tokens };
}

function isSafeMachineCode(value) {
  return typeof value === 'string' && OPERATIONAL_FAILURE_CODE_SET.has(value);
}

function isSafeCorrelationId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isMachineString(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isSafeSlug(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

function isSafeFeatureFlagKey(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && /^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*$/.test(value);
}

function isSafeTimezone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch (_error) {
    return false;
  }
}

function dateTimestamp(value) {
  try {
    return Date.prototype.getTime.call(value);
  } catch (_error) {
    return NOT_A_DATE;
  }
}

function isMapObject(value) {
  try {
    Map.prototype.has.call(value, MAP_BRAND_PROBE);
    return true;
  } catch (_error) {
    return false;
  }
}

function isSensitiveSemantic(parts) {
  if (!parts.normalized) return false;
  if (parts.normalized === 'iv' || parts.normalized === 'dsn') return true;
  if (parts.normalized.endsWith('key')
    || parts.normalized.endsWith('token')
    || parts.normalized.endsWith('name')) {
    return true;
  }
  if (SENSITIVE_COMPACT_PATTERNS.some((pattern) => (
    parts.normalized.includes(pattern) || parts.compact.includes(pattern)
  ))) return true;
  return parts.tokens.some((token) => SENSITIVE_TOKENS.has(token));
}

function isExplicitlySafeOperational(value, parts) {
  const { normalized } = parts;
  const enumValues = SAFE_ENUM_FIELDS.get(normalized);
  if (enumValues) return typeof value === 'string' && enumValues.has(value);
  if (SAFE_MACHINE_STRING_KEYS.has(normalized)) return isMachineString(value);
  if (SAFE_BOOLEAN_KEYS.has(normalized)
    || normalized === 'enabled'
    || normalized === 'inherited'
    || normalized === 'maintenancemode') {
    return typeof value === 'boolean';
  }
  if (SAFE_INTEGER_KEYS.has(normalized)) return isNonNegativeInteger(value);
  if (SAFE_RATE_KEYS.has(normalized)) return isNonNegativeNumber(value);
  if (SAFE_SLUG_KEYS.has(normalized)) return isSafeSlug(value);
  if (normalized === 'timezone') return isSafeTimezone(value);
  if (SAFE_DATE_KEYS.has(normalized)) {
    return dateTimestamp(value) !== NOT_A_DATE
      || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
  }
  if (normalized === 'failurecode') return isSafeMachineCode(value);
  return false;
}

function hasExplicitSafePolicy(normalized) {
  return SAFE_ENUM_FIELDS.has(normalized)
    || SAFE_MACHINE_STRING_KEYS.has(normalized)
    || SAFE_BOOLEAN_KEYS.has(normalized)
    || SAFE_INTEGER_KEYS.has(normalized)
    || SAFE_RATE_KEYS.has(normalized)
    || SAFE_SLUG_KEYS.has(normalized)
    || SAFE_DATE_KEYS.has(normalized)
    || normalized === 'enabled'
    || normalized === 'failurecode'
    || normalized === 'inherited'
    || normalized === 'maintenancemode'
    || normalized === 'timezone';
}

function sanitizeFeatureFlags(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return REDACTED;
  const entries = isMapObject(value) ? Map.prototype.entries.call(value) : dataObjectEntries(value);
  if (!entries) return REDACTED;
  const clone = {};
  for (const [rawKey, flagValue] of entries) {
    const key = typeof rawKey === 'string' ? rawKey : REDACTED;
    const parts = keyParts(key);
    const safe = isSafeFeatureFlagKey(key)
      && !isSensitiveSemantic(parts)
      && typeof flagValue === 'boolean';
    setOwn(clone, key, safe ? flagValue : REDACTED);
  }
  return clone;
}

function sanitizeHealthValue(value, seen) {
  if (typeof value === 'string') return STATUS_VALUES.has(value) ? value : REDACTED;
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return REDACTED;
  return cloneSanitized(value, seen || new WeakSet());
}

function sanitizeIntegrationMap(value, seen) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return REDACTED;
  const entries = isMapObject(value) ? Map.prototype.entries.call(value) : dataObjectEntries(value);
  if (!entries) return REDACTED;
  const clone = {};
  for (const [rawKey, integrationValue] of entries) {
    const key = typeof rawKey === 'string' ? rawKey : REDACTED;
    const safe = PROVIDER_VALUES.has(key)
      && integrationValue
      && typeof integrationValue === 'object';
    setOwn(clone, key, safe ? cloneSanitized(integrationValue, seen || new WeakSet()) : REDACTED);
  }
  return clone;
}

function safeObjectIdHex(value) {
  const normalized = normalizeNullableObjectId(value, mongoose.Types.ObjectId);
  if (normalized == null || isInvalidRetainedValue(normalized)) return null;
  try {
    return mongoose.Types.ObjectId.prototype.toHexString.call(normalized).toLowerCase();
  } catch (_error) {
    return null;
  }
}

function binaryByteLength(value) {
  for (const getter of [
    ARRAY_BUFFER_BYTE_LENGTH,
    SHARED_ARRAY_BUFFER_BYTE_LENGTH,
    DATA_VIEW_BYTE_LENGTH,
    TYPED_ARRAY_BYTE_LENGTH
  ]) {
    if (!getter) continue;
    try {
      return getter.call(value);
    } catch (_error) {
      // Try the next built-in binary brand without reading user properties.
    }
  }
  return null;
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

function dataObjectEntries(value) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return null;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (_error) {
    return null;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    entries.push([key, Object.hasOwn(descriptor, 'value') ? descriptor.value : ACCESSOR_VALUE]);
  }
  return entries;
}

function cloneEntry(key, entry, seen) {
  if (entry === ACCESSOR_VALUE) return REDACTED;
  const parts = keyParts(key);
  const exactSanitizer = PRE_SENSITIVE_EXACT_FIELDS.get(parts.normalized);
  if (exactSanitizer) return exactSanitizer(entry, seen);

  const sensitive = isSensitiveSemantic(parts);
  if (sensitive) return REDACTED;

  if (SAFE_RECURSIVE_KEYS.has(parts.normalized)) {
    if (entry === null) return null;
    return entry && typeof entry === 'object' ? cloneSanitized(entry, seen) : REDACTED;
  }

  if (!hasExplicitSafePolicy(parts.normalized)) return REDACTED;
  if (entry === null) return NULLABLE_SAFE_KEYS.has(parts.normalized) ? null : REDACTED;
  if (typeof entry === 'object') {
    if (SAFE_DATE_KEYS.has(parts.normalized) && dateTimestamp(entry) !== NOT_A_DATE) {
      return cloneSanitized(entry, seen);
    }
    if (SAFE_MACHINE_STRING_KEYS.has(parts.normalized)) {
      const hex = safeObjectIdHex(entry);
      if (hex) return hex;
    }
    return REDACTED;
  }
  return isExplicitlySafeOperational(entry, parts) ? entry : REDACTED;
}

function cloneEntries(entries, seen) {
  const clone = {};
  for (const [rawKey, entry] of entries) {
    const key = typeof rawKey === 'string' ? rawKey : REDACTED;
    setOwn(clone, key, cloneEntry(key, entry, seen));
  }
  return clone;
}

function cloneSanitized(value, seen) {
  if (value === null) return null;
  if (typeof value !== 'object') return REDACTED;
  if (utilTypes.isProxy(value)) return REDACTED;
  const timestamp = dateTimestamp(value);
  if (timestamp !== NOT_A_DATE) {
    return Number.isNaN(timestamp) ? '[invalid-date]' : Date.prototype.toISOString.call(value);
  }

  const byteLength = binaryByteLength(value);
  if (byteLength !== null) return `[binary:${byteLength} bytes]`;

  const objectIdHex = safeObjectIdHex(value);
  if (objectIdHex) return objectIdHex;
  if (seen.has(value)) return '[circular]';

  seen.add(value);
  let clone;
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    clone = Array.from({ length: value.length }, (_unused, index) => {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return REDACTED;
      return cloneSanitized(descriptor.value, seen);
    });
  } else if (isMapObject(value)) {
    clone = cloneEntries(Map.prototype.entries.call(value), seen);
  } else {
    const entries = dataObjectEntries(value);
    clone = entries ? cloneEntries(entries, seen) : REDACTED;
  }
  seen.delete(value);
  return clone;
}

function sanitizeForAudit(value) {
  return cloneSanitized(value, new WeakSet());
}

module.exports = {
  OPERATIONAL_FAILURE_CODES,
  isSafeCorrelationId,
  isSafeMachineCode,
  sanitizeForAudit
};
