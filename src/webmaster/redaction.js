'use strict';

const REDACTED = '[redacted]';
const MAX_MACHINE_CODE_LENGTH = 80;

const SAFE_EXACT_KEYS = new Set([
  'action',
  'actor',
  'actoraccesslevel',
  'after',
  'attempts',
  'before',
  'configured',
  'createdat',
  'created_at',
  'encryptionversion',
  'event',
  'integration',
  'metadata',
  'outcome',
  'provider',
  'requestid',
  'retrycount',
  'schemaversion',
  'source',
  'status',
  'statuscode',
  'targetid',
  'targettype',
  'tenantid',
  'template',
  'updatedat',
  'updatedby'
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
  'freetext',
  'initializationvector',
  'jdbcurl',
  'mongodburl',
  'mongodburi',
  'mongouri',
  'postgresurl',
  'privatekey',
  'redisurl',
  'sessioncookie',
  'socialsecuritynumber',
  'ukey'
];

const UNSAFE_MACHINE_CODE_TOKENS = new Set([
  'BEARER',
  'COOKIE',
  'CREDENTIAL',
  'JWT',
  'PASS',
  'PASSWORD',
  'SECRET',
  'TOKEN'
]);

function keyParts(key) {
  const separated = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const tokens = separated.split(/[^a-z0-9]+/).filter(Boolean);
  return { normalized: tokens.join(''), tokens };
}

function isSafeMachineCode(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_MACHINE_CODE_LENGTH
    || !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(value)) {
    return false;
  }
  return !value.split('_').some((token) => UNSAFE_MACHINE_CODE_TOKENS.has(token));
}

function isSafeScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isExplicitlySafeOperational(_key, value, parts) {
  const { normalized, tokens } = parts;
  if (SAFE_EXACT_KEYS.has(normalized)) return isSafeScalar(value) || value instanceof Date;

  const suffix = tokens.at(-1);
  if (['count', 'total', 'rate', 'ratio'].includes(suffix)) {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (['configured', 'enabled'].includes(suffix)) return typeof value === 'boolean';
  if (['provider', 'model', 'source', 'state', 'status'].includes(suffix)) return isSafeScalar(value);
  if (suffix === 'code') {
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    return isSafeMachineCode(value);
  }
  if (suffix === 'version') return Number.isInteger(value);
  return false;
}

function isSensitiveKey(key, value) {
  const parts = keyParts(key);
  if (!parts.normalized) return false;
  if (isExplicitlySafeOperational(key, value, parts)) return false;
  if (parts.normalized === 'iv' || parts.normalized === 'dsn') return true;
  if (parts.normalized.endsWith('key') || parts.normalized.endsWith('token') || parts.normalized.endsWith('name')) {
    return true;
  }
  if (SENSITIVE_COMPACT_PATTERNS.some((pattern) => parts.normalized.includes(pattern))) return true;
  return parts.tokens.some((token) => SENSITIVE_TOKENS.has(token));
}

function isObjectId(value) {
  return Boolean(value
    && typeof value === 'object'
    && (value._bsontype === 'ObjectId' || value.constructor?.name === 'ObjectId')
    && typeof value.toHexString === 'function');
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

function cloneEntries(entries, seen) {
  const clone = {};
  for (const [rawKey, entry] of entries) {
    const key = String(rawKey);
    setOwn(clone, key, isSensitiveKey(key, entry) ? REDACTED : cloneSanitized(entry, seen));
  }
  return clone;
}

function cloneSanitized(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  }
  if (Buffer.isBuffer(value)) return `[binary:${value.length} bytes]`;
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

module.exports = { isSafeMachineCode, sanitizeForAudit };
