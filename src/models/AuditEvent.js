'use strict';

const mongoose = require('mongoose');
const { types: utilTypes } = require('node:util');
const {
  isSafeCorrelationId,
  isSafeMachineCode,
  sanitizeForAudit
} = require('../webmaster/redaction');
const {
  INVALID_RETAINED_VALUE,
  canonicalizeHydratedInsertOptions,
  dataArrayValues,
  isInvalidRetainedValue,
  normalizeBoundedString,
  normalizeEnum,
  normalizeNullableBoundedString,
  ownDataDescriptors,
  valueSafeError
} = require('../webmaster/value-safe-validation');

const ACTOR_ACCESS_LEVELS = new Set(['OWNER', 'ADMIN', 'SYSTEM']);
const AUDIT_OUTCOMES = new Set(['success', 'failure']);
const MACHINE_IDENTIFIER = /^[a-z0-9._:-]+$/i;
const immutableMixed = (options = {}) => ({
  type: mongoose.Schema.Types.Mixed,
  immutable: true,
  ...options
});

function normalizeRequiredIdentifier(value) {
  return normalizeBoundedString(value, { maxLength: 128, pattern: MACHINE_IDENTIFIER });
}

function normalizeOptionalIdentifier(value) {
  return normalizeNullableBoundedString(value, { maxLength: 128, pattern: MACHINE_IDENTIFIER });
}

function normalizeRequestId(value) {
  if (value == null) return null;
  return isSafeCorrelationId(value) ? value : INVALID_RETAINED_VALUE;
}

function normalizeFailureCode(value) {
  if (value == null) return null;
  return isSafeMachineCode(value) ? value : INVALID_RETAINED_VALUE;
}

function assertAuditField(document, field, code, message, { required = false } = {}) {
  const value = document[field];
  if (isInvalidRetainedValue(value) || (required && value == null)) {
    throw valueSafeError(code, message);
  }
}

function assertValidAuditEvent(document) {
  assertAuditField(document, 'actor', 'INVALID_AUDIT_ACTOR', 'Audit actor must be a bounded identifier', { required: true });
  assertAuditField(
    document,
    'actorAccessLevel',
    'INVALID_AUDIT_ACTOR_ACCESS_LEVEL',
    'Audit actor access level must be OWNER, ADMIN, or SYSTEM',
    { required: true }
  );
  assertAuditField(document, 'action', 'INVALID_AUDIT_ACTION', 'Audit action must be a bounded identifier', { required: true });
  assertAuditField(
    document,
    'targetType',
    'INVALID_AUDIT_TARGET_TYPE',
    'Audit target type must be a bounded identifier',
    { required: true }
  );
  assertAuditField(document, 'targetId', 'INVALID_AUDIT_TARGET_ID', 'Audit target ID must be a bounded identifier');
  assertAuditField(document, 'tenantId', 'INVALID_AUDIT_TENANT_ID', 'Audit tenant ID must be a bounded identifier');
  assertAuditField(
    document,
    'requestId',
    'INVALID_AUDIT_REQUEST_ID',
    'Request ID must be a bounded correlation identifier'
  );
  assertAuditField(
    document,
    'outcome',
    'INVALID_AUDIT_OUTCOME',
    'Audit outcome must be success or failure',
    { required: true }
  );
  assertAuditField(
    document,
    'failureCode',
    'INVALID_AUDIT_FAILURE_CODE',
    'Audit failure code must use safe machine-code vocabulary'
  );
}

const auditEventSchema = new mongoose.Schema({
  actor: immutableMixed({ set: normalizeRequiredIdentifier }),
  actorAccessLevel: immutableMixed({ set: (value) => normalizeEnum(value, ACTOR_ACCESS_LEVELS) }),
  action: immutableMixed({ set: normalizeRequiredIdentifier }),
  targetType: immutableMixed({ set: normalizeRequiredIdentifier }),
  targetId: immutableMixed({ default: null, set: normalizeOptionalIdentifier }),
  tenantId: immutableMixed({ default: null, set: normalizeOptionalIdentifier }),
  before: immutableMixed({ default: null, set: sanitizeForAudit }),
  after: immutableMixed({ default: null, set: sanitizeForAudit }),
  requestId: immutableMixed({ default: null, set: normalizeRequestId }),
  outcome: immutableMixed({ set: (value) => normalizeEnum(value, AUDIT_OUTCOMES) }),
  failureCode: immutableMixed({ default: null, set: normalizeFailureCode })
}, {
  strict: true,
  minimize: false,
  timestamps: { createdAt: 'created_at', updatedAt: false }
});

auditEventSchema.pre('validate', function validateAndSanitizeRetainedAuditMetadata() {
  this.before = sanitizeForAudit(this.before);
  this.after = sanitizeForAudit(this.after);
  assertValidAuditEvent(this);
});

auditEventSchema.pre('save', function validateRetainedAuditSave() {
  this.before = sanitizeForAudit(this.before);
  this.after = sanitizeForAudit(this.after);
  assertValidAuditEvent(this);
});

auditEventSchema.pre('insertMany', function rejectUnsafeAuditInsertMany(next, documents, options) {
  try {
    canonicalizeHydratedInsertOptions(options, {
      unsafeCode: 'UNSAFE_AUDIT_INSERT_MANY_OPTIONS',
      unsafeMessage: 'Audit insert options must be plain data',
      leanCode: 'UNSUPPORTED_AUDIT_LEAN_INSERT_MANY',
      leanMessage: 'Lean audit inserts are not supported'
    });
    const documentList = Array.isArray(documents) ? dataArrayValues(documents) : [documents];
    if (!documentList) throw valueSafeError('INVALID_AUDIT_INPUT', 'Audit input must be plain data');
    for (const document of documentList) {
      if (utilTypes.isProxy(document)) {
        throw valueSafeError('INVALID_AUDIT_INPUT', 'Audit input must be plain data');
      }
      if (document instanceof mongoose.Document) continue;
      if (!ownDataDescriptors(document)) {
        throw valueSafeError('INVALID_AUDIT_INPUT', 'Audit input must be plain data');
      }
    }
  } catch (error) {
    return next(error);
  }
  return next();
});

auditEventSchema.pre([
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete'
], function rejectAuditMutation() {
  throw valueSafeError('IMMUTABLE_AUDIT_EVENT', 'Audit events are immutable');
});

auditEventSchema.pre('bulkWrite', function rejectAuditBulkWrite() {
  throw valueSafeError('IMMUTABLE_AUDIT_EVENT', 'Audit events are immutable');
});

auditEventSchema.index({ created_at: -1 });
auditEventSchema.index({ tenantId: 1, created_at: -1 });

module.exports = mongoose.model('AuditEvent', auditEventSchema);
