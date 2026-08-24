'use strict';

const REDACTED = '[redacted]';

const EXACT_SENSITIVE_KEYS = new Set([
  'address',
  'answer',
  'authtag',
  'authorization',
  'body',
  'ciphertext',
  'comment',
  'content',
  'credential',
  'credentials',
  'diagnosis',
  'dob',
  'email',
  'feedback',
  'hash',
  'iv',
  'key',
  'message',
  'mobile',
  'name',
  'note',
  'notes',
  'password',
  'patient',
  'phone',
  'phi',
  'pii',
  'prompt',
  'question',
  'reason',
  'recording',
  'response',
  'salt',
  'secret',
  'signature',
  'subject',
  'text',
  'token',
  'transcript',
  'ukey',
  'username'
]);

const SENSITIVE_FRAGMENTS = [
  'address',
  'apikey',
  'authorization',
  'authtag',
  'bearer',
  'cipher',
  'clinical',
  'contactname',
  'credential',
  'customer',
  'diagnosis',
  'dateofbirth',
  'email',
  'externalidentifier',
  'feedback',
  'freetext',
  'health',
  'medical',
  'mobile',
  'partialsecret',
  'passphrase',
  'passwd',
  'password',
  'patient',
  'phone',
  'privatekey',
  'recording',
  'reason',
  'secret',
  'transcript'
];

const SAFE_OPERATIONAL_SUFFIXES = [
  'configured',
  'count',
  'enabled',
  'provider',
  'rate',
  'ratio',
  'total'
];

function normalizedKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  if (!normalized) return false;
  if (SAFE_OPERATIONAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false;
  if (EXACT_SENSITIVE_KEYS.has(normalized)) return true;
  if (normalized === 'phi' || normalized.startsWith('phi') || normalized.endsWith('phi')) return true;
  if (normalized === 'pii' || normalized.startsWith('pii') || normalized.endsWith('pii')) return true;
  if (normalized.endsWith('name') || normalized.endsWith('token') || normalized.endsWith('key')) return true;
  return SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function cloneSanitized(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (seen.has(value)) return '[circular]';

  seen.add(value);
  if (Array.isArray(value)) {
    const clone = value.map((entry) => cloneSanitized(entry, seen));
    seen.delete(value);
    return clone;
  }

  const clone = {};
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = isSensitiveKey(key) ? REDACTED : cloneSanitized(entry, seen);
  }
  seen.delete(value);
  return clone;
}

function sanitizeForAudit(value) {
  return cloneSanitized(value, new WeakSet());
}

module.exports = { sanitizeForAudit };
