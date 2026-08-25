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
  createSealedQueryFacade,
  dataArrayValues,
  dataEntries,
  isInvalidRetainedValue,
  normalizeBoundedString,
  normalizeEnum,
  normalizeNullableBoundedString,
  normalizeNullableDate,
  normalizeNullableObjectId,
  ownDataDescriptors,
  valueSafeError
} = require('../webmaster/value-safe-validation');

const ACTOR_ACCESS_LEVELS = new Set(['OWNER', 'ADMIN', 'SYSTEM']);
const AUDIT_OUTCOMES = new Set(['success', 'failure']);
const MACHINE_IDENTIFIER = /^[a-z0-9._:-]+$/i;
const AUDIT_FILTER_FIELDS = new Set([
  '_id',
  'actor',
  'actorAccessLevel',
  'action',
  'targetType',
  'targetId',
  'tenantId',
  'requestId',
  'outcome',
  'failureCode',
  'created_at'
]);
const AUDIT_PROJECTION_FIELDS = new Set([
  ...AUDIT_FILTER_FIELDS,
  'before',
  'after'
]);
const AUDIT_READ_OPTION_FIELDS = new Set(['lean', 'limit', 'maxTimeMS', 'projection', 'skip', 'sort']);
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

function defineAuditValue(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

function invalidAuditFilter() {
  return valueSafeError('INVALID_AUDIT_FILTER', 'Audit filters must use allowed plain data fields');
}

function invalidAuditProjection() {
  return valueSafeError('INVALID_AUDIT_PROJECTION', 'Audit projections must use allowed plain data fields');
}

function invalidAuditOptions() {
  return valueSafeError('INVALID_AUDIT_OPTIONS', 'Audit query options must use allowed plain data fields');
}

function normalizeAuditFilterScalar(path, value) {
  let normalized;
  if (path === '_id') normalized = normalizeNullableObjectId(value, mongoose.Types.ObjectId);
  else if (path === 'created_at') normalized = normalizeNullableDate(value);
  else if (path === 'actorAccessLevel') normalized = normalizeEnum(value, ACTOR_ACCESS_LEVELS, { nullable: true });
  else if (path === 'outcome') normalized = normalizeEnum(value, AUDIT_OUTCOMES, { nullable: true });
  else if (path === 'requestId') normalized = normalizeRequestId(value);
  else if (path === 'failureCode') normalized = normalizeFailureCode(value);
  else normalized = normalizeNullableBoundedString(value, { maxLength: 128, pattern: MACHINE_IDENTIFIER });
  if (isInvalidRetainedValue(normalized)) throw invalidAuditFilter();
  return normalized;
}

function normalizeAuditFilterValue(path, value) {
  try {
    return normalizeAuditFilterScalar(path, value);
  } catch (_error) {
    const operatorEntries = dataEntries(value);
    if (!operatorEntries || operatorEntries.length === 0) throw invalidAuditFilter();
    const allowedOperators = path === 'created_at'
      ? new Set(['$eq', '$gt', '$gte', '$in', '$lt', '$lte'])
      : new Set(['$eq', '$in']);
    const normalized = {};
    for (const [operator, operand] of operatorEntries) {
      if (!allowedOperators.has(operator)) throw invalidAuditFilter();
      if (operator === '$in') {
        const values = dataArrayValues(operand);
        if (!values) throw invalidAuditFilter();
        defineAuditValue(normalized, operator, values.map((entry) => normalizeAuditFilterScalar(path, entry)));
      } else {
        defineAuditValue(normalized, operator, normalizeAuditFilterScalar(path, operand));
      }
    }
    return normalized;
  }
}

function normalizeAuditFilter(filter, seen = new WeakSet(), { root = true } = {}) {
  if (root && filter == null) return {};
  const entries = dataEntries(filter);
  if (!entries || seen.has(filter)) throw invalidAuditFilter();
  seen.add(filter);
  const normalized = {};
  for (const [path, value] of entries) {
    if (path === '$and' || path === '$or' || path === '$nor') {
      const clauses = dataArrayValues(value);
      if (!clauses) throw invalidAuditFilter();
      defineAuditValue(
        normalized,
        path,
        clauses.map((clause) => normalizeAuditFilter(clause, seen, { root: false }))
      );
      continue;
    }
    if (!AUDIT_FILTER_FIELDS.has(path)) throw invalidAuditFilter();
    defineAuditValue(normalized, path, normalizeAuditFilterValue(path, value));
  }
  seen.delete(filter);
  return normalized;
}

function normalizeAuditProjection(projection) {
  if (projection == null) return projection;
  const entries = dataEntries(projection);
  if (!entries) throw invalidAuditProjection();
  const normalized = {};
  for (const [path, inclusion] of entries) {
    if (!AUDIT_PROJECTION_FIELDS.has(path)
      || ![0, 1, false, true].includes(inclusion)) throw invalidAuditProjection();
    defineAuditValue(normalized, path, inclusion);
  }
  return normalized;
}

function normalizeAuditSort(sort) {
  const entries = dataEntries(sort);
  if (!entries) throw invalidAuditOptions();
  const normalized = {};
  for (const [path, direction] of entries) {
    if (path !== 'created_at' || (direction !== 1 && direction !== -1)) throw invalidAuditOptions();
    defineAuditValue(normalized, path, direction);
  }
  return normalized;
}

function normalizeAuditReadOptions(options) {
  if (options == null) return undefined;
  const entries = dataEntries(options);
  if (!entries) throw invalidAuditOptions();
  const normalized = {};
  for (const [key, value] of entries) {
    if (!AUDIT_READ_OPTION_FIELDS.has(key)) throw invalidAuditOptions();
    if (key === 'projection') defineAuditValue(normalized, key, normalizeAuditProjection(value));
    else if (key === 'sort') defineAuditValue(normalized, key, normalizeAuditSort(value));
    else if (key === 'lean') {
      if (typeof value !== 'boolean') throw invalidAuditOptions();
      defineAuditValue(normalized, key, value);
    } else {
      if (!Number.isInteger(value) || value < 0 || (key === 'maxTimeMS' && value === 0)) {
        throw invalidAuditOptions();
      }
      defineAuditValue(normalized, key, value);
    }
  }
  return normalized;
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
  if (!this.isNew) {
    throw valueSafeError('IMMUTABLE_AUDIT_EVENT', 'Audit events are immutable');
  }
  this.before = sanitizeForAudit(this.before);
  this.after = sanitizeForAudit(this.after);
  assertValidAuditEvent(this);
});

function rejectAuditDocumentMutation() {
  return Promise.reject(valueSafeError('IMMUTABLE_AUDIT_EVENT', 'Audit events are immutable'));
}

auditEventSchema.method('updateOne', rejectAuditDocumentMutation, { suppressWarning: true });
auditEventSchema.method('deleteOne', rejectAuditDocumentMutation, { suppressWarning: true });

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

const AuditEvent = mongoose.model('AuditEvent', auditEventSchema);

const saveNewAuditEvent = AuditEvent.prototype.save;

function guardAuditDocumentSave(...args) {
  if (!this.isNew) {
    return Promise.reject(valueSafeError('IMMUTABLE_AUDIT_EVENT', 'Audit events are immutable'));
  }
  return saveNewAuditEvent.apply(this, args);
}

Object.defineProperty(AuditEvent.prototype, 'save', {
  configurable: true,
  value: guardAuditDocumentSave,
  writable: false
});
Object.defineProperty(AuditEvent.prototype, '$save', {
  configurable: true,
  value: guardAuditDocumentSave,
  writable: false
});

function rejectAuditMutationBoundary() {
  return Promise.reject(valueSafeError('IMMUTABLE_AUDIT_EVENT', 'Audit events are immutable'));
}

function throwAuditMutationBoundary() {
  throw valueSafeError('IMMUTABLE_AUDIT_EVENT', 'Audit events are immutable');
}

function sealAuditReadQuery(query) {
  return createSealedQueryFacade(query, () => (
    valueSafeError('IMMUTABLE_AUDIT_EVENT', 'Audit events are immutable')
  ), mongoose.Types.ObjectId);
}

const auditFind = AuditEvent.find;
const auditFindOne = AuditEvent.findOne;
const auditCountDocuments = AuditEvent.countDocuments;
const auditEstimatedDocumentCount = AuditEvent.estimatedDocumentCount;

for (const [method, read] of [['find', auditFind], ['findOne', auditFindOne]]) {
  Object.defineProperty(AuditEvent, method, {
    configurable: true,
    value(filter, projection, options, ...extraArguments) {
      try {
        if (extraArguments.length !== 0) throw invalidAuditOptions();
        return sealAuditReadQuery(read.call(
          this,
          normalizeAuditFilter(filter),
          normalizeAuditProjection(projection),
          normalizeAuditReadOptions(options)
        ));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    writable: false
  });
}

Object.defineProperty(AuditEvent, 'findById', {
  configurable: true,
  value(id, projection, options, ...extraArguments) {
    try {
      if (extraArguments.length !== 0) throw invalidAuditOptions();
      const filter = normalizeAuditFilter({ _id: id });
      return sealAuditReadQuery(auditFindOne.call(
        this,
        filter,
        normalizeAuditProjection(projection),
        normalizeAuditReadOptions(options)
      ));
    } catch (error) {
      return Promise.reject(error);
    }
  },
  writable: false
});

Object.defineProperty(AuditEvent, 'countDocuments', {
  configurable: true,
  value(filter, options, ...extraArguments) {
    try {
      if (extraArguments.length !== 0) throw invalidAuditOptions();
      return sealAuditReadQuery(auditCountDocuments.call(
        this,
        normalizeAuditFilter(filter),
        normalizeAuditReadOptions(options)
      ));
    } catch (error) {
      return Promise.reject(error);
    }
  },
  writable: false
});

Object.defineProperty(AuditEvent, 'estimatedDocumentCount', {
  configurable: true,
  value(options, ...extraArguments) {
    try {
      if (extraArguments.length !== 0) throw invalidAuditOptions();
      return sealAuditReadQuery(auditEstimatedDocumentCount.call(this, normalizeAuditReadOptions(options)));
    } catch (error) {
      return Promise.reject(error);
    }
  },
  writable: false
});

Object.defineProperty(AuditEvent, 'exists', {
  configurable: true,
  value(filter, options, ...extraArguments) {
    try {
      if (extraArguments.length !== 0) throw invalidAuditOptions();
      const normalizedOptions = normalizeAuditReadOptions(options) || {};
      defineAuditValue(normalizedOptions, 'lean', true);
      return sealAuditReadQuery(auditFindOne.call(
        this,
        normalizeAuditFilter(filter),
        { _id: 1 },
        normalizedOptions
      ));
    } catch (error) {
      return Promise.reject(error);
    }
  },
  writable: false
});

Object.defineProperty(AuditEvent, 'distinct', {
  configurable: true,
  value() {
    throw valueSafeError('UNSUPPORTED_AUDIT_DISTINCT', 'Direct audit distinct queries are not supported');
  },
  writable: false
});

for (const method of [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findByIdAndUpdate',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findByIdAndDelete',
  'findOneAndRemove',
  'findByIdAndRemove',
  'bulkWrite',
  'bulkSave'
]) {
  Object.defineProperty(AuditEvent, method, {
    configurable: true,
    value: rejectAuditMutationBoundary,
    writable: false
  });
}

Object.defineProperty(AuditEvent, 'where', {
  configurable: true,
  value: throwAuditMutationBoundary,
  writable: false
});

Object.defineProperty(AuditEvent, 'aggregate', {
  configurable: true,
  value() {
    throw valueSafeError('UNSUPPORTED_AUDIT_AGGREGATION', 'Direct audit aggregation is not supported');
  },
  writable: false
});

for (const method of ['$where', 'watch', 'mapReduce']) {
  Object.defineProperty(AuditEvent, method, {
    configurable: true,
    value() {
      throw valueSafeError(
        'UNSUPPORTED_AUDIT_RUNTIME_QUERY',
        'Direct audit runtime queries are not supported'
      );
    },
    writable: false
  });
}

module.exports = AuditEvent;
