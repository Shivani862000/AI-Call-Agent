'use strict';

const REDACTED = '[redacted]';

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
  'INVALID_AUDIT_FAILURE_CODE',
  'INVALID_AUDIT_OUTCOME',
  'INVALID_INPUT',
  'INVALID_NOTIFICATION_FAILURE_CODE',
  'INVALID_NOTIFICATION_RETRY_INCREMENT',
  'INVALID_NOTIFICATION_STATE_MUTATION',
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
  'UNSUPPORTED_NOTIFICATION_STRUCTURAL_UPDATE',
  'UNSUPPORTED_NOTIFICATION_UPDATE_PIPELINE',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'WEBMASTER_ACCESS_UNASSIGNED',
  'WEBMASTER_FORBIDDEN',
  'WEBMASTER_OWNER_REQUIRED'
]);

const OPERATIONAL_FAILURE_CODE_SET = new Set(OPERATIONAL_FAILURE_CODES);

const SAFE_MACHINE_STRING_KEYS = new Set([
  'action',
  'actor',
  'actoraccesslevel',
  'event',
  'integration',
  'integrationstatus',
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
  'used',
  'version'
]);
const SAFE_DATE_KEYS = new Set(['createdat', 'created_at', 'updatedat', 'updated_at']);
const SAFE_SLUG_KEYS = new Set([
  'integrationid',
  'model',
  'modelid',
  'plan',
  'providerid',
  'section'
]);
const OPERATIONAL_INTEGER_SUFFIXES = new Set([
  'count',
  'days',
  'depth',
  'limit',
  'minutes',
  'total',
  'usage',
  'version'
]);
const OPERATIONAL_RATE_SUFFIXES = new Set(['percent', 'percentage', 'rate', 'ratio']);

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
  ['source', new Set(['database', 'default', 'environment', 'global', 'inherited', 'runtime', 'tenant'])],
  ['status', STATUS_VALUES]
]);

const PRE_SENSITIVE_EXACT_FIELDS = new Map([
  ['featureflags', sanitizeFeatureFlags],
  ['health', sanitizeHealthValue],
  ['healthstatus', sanitizeHealthValue],
  ['integrationhealth', sanitizeHealthValue],
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
  'apikey',
  'authtag',
  'birthdate',
  'ciphertext',
  'connectionstring',
  'connectionuri',
  'databaseurl',
  'databaseuri',
  'datasourceurl',
  'dburi',
  'dburl',
  'dateofbirth',
  'externalid',
  'externalidentifier',
  'followuppending',
  'freetext',
  'initializationvector',
  'interestedservice',
  'jdbcurl',
  'lastvisit',
  'mongodburl',
  'mongodburi',
  'mongouri',
  'outstandingissue',
  'pendingfollowup',
  'postgresurl',
  'previousvisit',
  'privatekey',
  'redisurl',
  'serviceinterest',
  'sessioncookie',
  'socialsecuritynumber',
  'ukey',
  'visitdate'
];

function keyParts(key) {
  const separated = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const tokens = separated.split(/[^a-z0-9]+/).filter(Boolean);
  return { normalized: tokens.join(''), tokens };
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

function isSensitiveSemantic(parts) {
  if (!parts.normalized) return false;
  if (parts.normalized === 'iv' || parts.normalized === 'dsn') return true;
  if (parts.normalized.endsWith('key')
    || parts.normalized.endsWith('token')
    || parts.normalized.endsWith('name')) {
    return true;
  }
  if (SENSITIVE_COMPACT_PATTERNS.some((pattern) => parts.normalized.includes(pattern))) return true;
  return parts.tokens.some((token) => SENSITIVE_TOKENS.has(token));
}

function isExplicitlySafeOperational(value, parts) {
  const { normalized, tokens } = parts;
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
  if (SAFE_SLUG_KEYS.has(normalized)) return isSafeSlug(value);
  if (normalized === 'timezone') return isSafeTimezone(value);
  const suffix = tokens.at(-1);
  if (OPERATIONAL_INTEGER_SUFFIXES.has(suffix)) return isNonNegativeInteger(value);
  if (OPERATIONAL_RATE_SUFFIXES.has(suffix)) return isNonNegativeNumber(value);
  if (SAFE_DATE_KEYS.has(normalized)) {
    return value instanceof Date
      || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
  }
  if (normalized === 'failurecode') return isSafeMachineCode(value);
  return false;
}

function sanitizeFeatureFlags(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return REDACTED;
  const entries = value instanceof Map ? value.entries() : Object.entries(value);
  const clone = {};
  for (const [rawKey, flagValue] of entries) {
    const key = String(rawKey);
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
  if (!value || typeof value !== 'object') return REDACTED;
  return cloneSanitized(value, seen || new WeakSet());
}

function isObjectId(value) {
  return Boolean(value
    && typeof value === 'object'
    && (value._bsontype === 'ObjectId' || value.constructor?.name === 'ObjectId')
    && typeof value.toHexString === 'function');
}

function binaryByteLength(value) {
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value.byteLength;
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
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

function cloneEntry(key, entry, seen) {
  const parts = keyParts(key);
  const exactSanitizer = PRE_SENSITIVE_EXACT_FIELDS.get(parts.normalized);
  if (exactSanitizer) return exactSanitizer(entry, seen);

  const sensitive = isSensitiveSemantic(parts);
  if (sensitive) return REDACTED;

  if (entry === null) return null;
  if (typeof entry !== 'object') {
    return isExplicitlySafeOperational(entry, parts) ? entry : REDACTED;
  }
  return cloneSanitized(entry, seen);
}

function cloneEntries(entries, seen) {
  const clone = {};
  for (const [rawKey, entry] of entries) {
    const key = String(rawKey);
    setOwn(clone, key, cloneEntry(key, entry, seen));
  }
  return clone;
}

function cloneSanitized(value, seen) {
  if (value === null) return null;
  if (typeof value !== 'object') return REDACTED;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  }

  const byteLength = binaryByteLength(value);
  if (byteLength !== null) return `[binary:${byteLength} bytes]`;

  if (isObjectId(value)) {
    try {
      const hex = value.toHexString();
      return /^[a-f0-9]{24}$/i.test(hex) ? hex.toLowerCase() : '[object-id]';
    } catch (_error) {
      return '[object-id]';
    }
  }
  if (seen.has(value)) return '[circular]';

  seen.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = value.map((entry) => cloneSanitized(entry, seen));
  } else if (value instanceof Map) {
    clone = cloneEntries(value.entries(), seen);
  } else {
    clone = cloneEntries(Object.entries(value), seen);
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
