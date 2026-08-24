'use strict';

const mongoose = require('mongoose');
const { types: utilTypes } = require('node:util');
const { isSafeMachineCode, sanitizeForAudit } = require('../webmaster/redaction');
const {
  INVALID_RETAINED_VALUE,
  canonicalizeHydratedInsertOptions,
  dataArrayValues,
  dataEntries,
  isInvalidRetainedValue,
  normalizeBoundedString,
  normalizeEnum,
  normalizeNonNegativeInteger,
  normalizeNullableDate,
  normalizeNullableObjectId,
  ownDataDescriptors,
  valueSafeError
} = require('../webmaster/value-safe-validation');

const REDACTED = '[redacted]';
const DELIVERY_STATUSES = new Set(['pending', 'delivered', 'failed']);
const RECIPIENT_CATEGORIES = new Set(['tenant_admin', 'account', 'owner', 'support']);
const MACHINE_IDENTIFIER = /^[a-z0-9._:-]+$/i;
const STATUS_ERROR_MESSAGE = 'Notification status must be pending, delivered, or failed';
const RETRY_COUNT_ERROR_MESSAGE = 'Notification retry count must be a non-negative integer';
const FAILURE_CODE_ERROR_MESSAGE = 'Notification failure code is not in the operational allowlist';

function retainedDataError(code, message) {
  return valueSafeError(code, message);
}

function assertSafeInsertManyOptions(options) {
  canonicalizeHydratedInsertOptions(options, {
    unsafeCode: 'UNSAFE_NOTIFICATION_INSERT_MANY_OPTIONS',
    unsafeMessage: 'Notification insert options must be plain data',
    leanCode: 'UNSUPPORTED_NOTIFICATION_LEAN_INSERT_MANY',
    leanMessage: 'Lean notification inserts are not supported'
  });
}

function sanitizeFailureReason(value) {
  return value == null ? null : REDACTED;
}

function sanitizeMetadataAssignment(value) {
  // Query writes are sanitized path-by-path in query middleware. Applying the
  // root fail-closed setter to a dotted operational value would redact it twice.
  if (this && typeof this.getUpdate === 'function') return value;
  return sanitizeForAudit(value);
}

function preserveStatusInput(value) {
  return normalizeEnum(value, DELIVERY_STATUSES);
}

function preserveRetryCountInput(value) {
  return normalizeNonNegativeInteger(value);
}

function preserveFailureCodeInput(value) {
  if (value == null) return null;
  return isSafeMachineCode(value) ? value : INVALID_RETAINED_VALUE;
}

function preserveObjectIdInput(value) {
  return normalizeNullableObjectId(value, mongoose.Types.ObjectId);
}

function preserveRecipientCategoryInput(value) {
  return normalizeEnum(value, RECIPIENT_CATEGORIES);
}

function preserveMachineIdentifierInput(value) {
  return normalizeBoundedString(value, { maxLength: 128, pattern: MACHINE_IDENTIFIER });
}

const notificationDeliverySchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.Mixed, ref: 'Tenant', default: null, set: preserveObjectIdInput },
  accountId: { type: mongoose.Schema.Types.Mixed, ref: 'User', default: null, set: preserveObjectIdInput },
  recipientCategory: {
    type: mongoose.Schema.Types.Mixed,
    set: preserveRecipientCategoryInput
  },
  template: { type: mongoose.Schema.Types.Mixed, set: preserveMachineIdentifierInput },
  event: { type: mongoose.Schema.Types.Mixed, set: preserveMachineIdentifierInput },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {}, set: sanitizeMetadataAssignment },
  status: {
    type: mongoose.Schema.Types.Mixed,
    default: 'pending',
    set: preserveStatusInput
  },
  retryCount: {
    type: mongoose.Schema.Types.Mixed,
    default: 0,
    set: preserveRetryCountInput
  },
  failureCode: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    set: preserveFailureCodeInput
  },
  failureReason: {
    type: String,
    default: null,
    set: sanitizeFailureReason
  },
  lastAttemptAt: { type: mongoose.Schema.Types.Mixed, default: null, set: normalizeNullableDate },
  sentAt: { type: mongoose.Schema.Types.Mixed, default: null, set: normalizeNullableDate }
}, {
  strict: true,
  minimize: false,
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

notificationDeliverySchema.pre('validate', function validateAndSanitizeRetainedNotificationMetadata() {
  this.metadata = sanitizeForAudit(this.metadata);
  assertValidNotificationDocument(this);
});

function sanitizeMetadataUpdate(update) {
  if (update == null) return update;
  if (Array.isArray(update)) {
    throw retainedDataError(
      'UNSUPPORTED_NOTIFICATION_UPDATE_PIPELINE',
      'Notification update pipelines are not supported'
    );
  }
  const updateEntries = dataEntries(update);
  if (!updateEntries) {
    throw retainedDataError(
      'UNSAFE_NOTIFICATION_UPDATE',
      'Notification updates must be plain data'
    );
  }

  const hasOperators = updateEntries.some(([key]) => key.startsWith('$'));
  if (!hasOperators) {
    for (const [path, value] of updateEntries) {
      update[path] = normalizeNotificationUpdateValue(path, value);
    }
    for (const requiredPath of ['recipientCategory', 'template', 'event']) {
      if (!Object.hasOwn(update, requiredPath)) {
        throw retainedDataError(
          notificationFieldError(requiredPath).code,
          notificationFieldError(requiredPath).message
        );
      }
    }
    return update;
  }

  for (const [operator, values] of updateEntries) {
    if (!operator.startsWith('$')) continue;
    const valueEntries = dataEntries(values);
    if (!valueEntries) {
      throw retainedDataError(
        'UNSUPPORTED_NOTIFICATION_OPERATOR_OPERAND',
        'Notification update operator operands must be plain records'
      );
    }

    if (operator === '$rename') {
      for (const [source, destination] of valueEntries) {
        if (typeof destination !== 'string') {
          throw retainedDataError(
            'UNSUPPORTED_NOTIFICATION_STRUCTURAL_UPDATE',
            'Notification retained and state field renames are not supported'
          );
        }
        if (isRetainedPath(source)
          || isRetainedPath(destination)
          || isNotificationValidatedPath(source)
          || isNotificationValidatedPath(destination)) {
          throw retainedDataError(
            'UNSUPPORTED_NOTIFICATION_STRUCTURAL_UPDATE',
            'Notification retained and state field renames are not supported'
          );
        }
      }
      continue;
    }

    for (const [path, value] of valueEntries) {
      if (isNotificationValidatedPath(path)) {
        values[path] = validateNotificationFieldMutation(operator, path, value);
      }
      if (!isRetainedPath(path)) continue;
      if (operator === '$unset') {
        if (value === 1 || value === true || value === '') continue;
        throw retainedDataError(
          'UNSUPPORTED_NOTIFICATION_STRUCTURAL_UPDATE',
          'Notification retained-field removal uses an unsupported marker'
        );
      }
      if (operator !== '$set' && operator !== '$setOnInsert') {
        throw retainedDataError(
          'UNSUPPORTED_NOTIFICATION_METADATA_UPDATE',
          'Notification retained-field mutation operator is not supported'
        );
      }
      values[path] = sanitizeRetainedUpdateValue(path, value);
    }
  }
  return update;
}

function notificationFieldError(path) {
  const errors = {
    tenantId: ['INVALID_NOTIFICATION_TENANT_ID', 'Notification tenant ID must be a 24-character hexadecimal identifier'],
    accountId: ['INVALID_NOTIFICATION_ACCOUNT_ID', 'Notification account ID must be a 24-character hexadecimal identifier'],
    recipientCategory: ['INVALID_NOTIFICATION_RECIPIENT_CATEGORY', 'Notification recipient category is not supported'],
    template: ['INVALID_NOTIFICATION_TEMPLATE', 'Notification template must be a bounded identifier'],
    event: ['INVALID_NOTIFICATION_EVENT', 'Notification event must be a bounded identifier'],
    status: ['INVALID_NOTIFICATION_STATUS', STATUS_ERROR_MESSAGE],
    retryCount: ['INVALID_NOTIFICATION_RETRY_COUNT', RETRY_COUNT_ERROR_MESSAGE],
    failureCode: ['INVALID_NOTIFICATION_FAILURE_CODE', FAILURE_CODE_ERROR_MESSAGE],
    lastAttemptAt: ['INVALID_NOTIFICATION_LAST_ATTEMPT_AT', 'Notification last attempt timestamp must be a valid UTC date'],
    sentAt: ['INVALID_NOTIFICATION_SENT_AT', 'Notification sent timestamp must be a valid UTC date']
  };
  const [code, message] = errors[path];
  return { code, message };
}

function normalizeNotificationFieldValue(path, value) {
  if (path === 'tenantId' || path === 'accountId') return preserveObjectIdInput(value);
  if (path === 'recipientCategory') return preserveRecipientCategoryInput(value);
  if (path === 'template' || path === 'event') return preserveMachineIdentifierInput(value);
  if (path === 'status') return preserveStatusInput(value);
  if (path === 'retryCount') return preserveRetryCountInput(value);
  if (path === 'failureCode') return preserveFailureCodeInput(value);
  if (path === 'lastAttemptAt' || path === 'sentAt') return normalizeNullableDate(value);
  return value;
}

function normalizeNotificationUpdateValue(path, value) {
  if (path === 'metadata') return sanitizeForAudit(value);
  if (path === 'failureReason') return sanitizeFailureReason(value);
  if (!isNotificationValidatedPath(path)) return value;
  const normalized = normalizeNotificationFieldValue(path, value);
  if (isInvalidRetainedValue(normalized)) {
    const { code, message } = notificationFieldError(path);
    throw retainedDataError(code, message);
  }
  return normalized;
}

function isNotificationValidatedPath(path) {
  return [
    'tenantId',
    'accountId',
    'recipientCategory',
    'template',
    'event',
    'status',
    'retryCount',
    'failureCode',
    'lastAttemptAt',
    'sentAt'
  ].includes(path);
}

function validateNotificationFieldMutation(operator, path, value) {
  if (operator === '$set' || operator === '$setOnInsert') {
    return normalizeNotificationUpdateValue(path, value);
  }
  if (operator === '$inc' && path === 'retryCount') {
    if (isNonNegativeInteger(value)) return value;
    throw retainedDataError(
      'INVALID_NOTIFICATION_RETRY_INCREMENT',
      'Notification retry increments must be non-negative integers'
    );
  }
  if (operator === '$unset' && !['recipientCategory', 'template', 'event', 'status', 'retryCount'].includes(path)) {
    if (value === 1 || value === true || value === '') return value;
  }
  throw retainedDataError(
    'INVALID_NOTIFICATION_STATE_MUTATION',
    'Notification state mutation operator is not supported'
  );
}

function normalizeNotificationFilterId(value) {
  const normalized = preserveObjectIdInput(value);
  return normalized == null || !isInvalidRetainedValue(normalized)
    ? normalized
    : INVALID_RETAINED_VALUE;
}

function defineFilterValue(filter, path, value) {
  Object.defineProperty(filter, path, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

function invalidNotificationFilter() {
  return retainedDataError('INVALID_NOTIFICATION_FILTER', 'Notification filters must be plain data');
}

function normalizeNotificationFilter(filter, seen = new WeakSet()) {
  const filterEntries = dataEntries(filter);
  if (!filterEntries || seen.has(filter)) throw invalidNotificationFilter();

  seen.add(filter);
  const normalizedFilter = {};
  for (const [path, value] of filterEntries) {
    if (path === '$and' || path === '$or' || path === '$nor') {
      const clauses = dataArrayValues(value);
      if (!clauses) throw invalidNotificationFilter();
      defineFilterValue(
        normalizedFilter,
        path,
        clauses.map((clause) => normalizeNotificationFilter(clause, seen))
      );
      continue;
    }
    if (path.startsWith('$')) throw invalidNotificationFilter();

    if (path === '_id' || path === 'tenantId' || path === 'accountId') {
      const normalized = normalizeNotificationFilterId(value);
      if (isInvalidRetainedValue(normalized)) {
        throw retainedDataError(
          'INVALID_NOTIFICATION_FILTER_ID',
          'Notification filter IDs must be 24-character hexadecimal identifiers'
        );
      }
      defineFilterValue(normalizedFilter, path, normalized);
      continue;
    }

    if (isNotificationValidatedPath(path)) {
      defineFilterValue(normalizedFilter, path, normalizeNotificationUpdateValue(path, value));
      continue;
    }

    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      throw invalidNotificationFilter();
    }
    if (typeof value === 'symbol' || typeof value === 'bigint') {
      throw invalidNotificationFilter();
    }
    defineFilterValue(normalizedFilter, path, value);
  }
  seen.delete(filter);
  return normalizedFilter;
}

function assertSafeNotificationFilter(filter) {
  return normalizeNotificationFilter(filter);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function assertNotificationField(document, field, code, message, { required = false } = {}) {
  const value = document[field];
  if (isInvalidRetainedValue(value) || (required && value == null)) {
    throw retainedDataError(code, message);
  }
}

function assertValidNotificationDocument(document) {
  assertNotificationField(
    document,
    'tenantId',
    'INVALID_NOTIFICATION_TENANT_ID',
    'Notification tenant ID must be a 24-character hexadecimal identifier'
  );
  assertNotificationField(
    document,
    'accountId',
    'INVALID_NOTIFICATION_ACCOUNT_ID',
    'Notification account ID must be a 24-character hexadecimal identifier'
  );
  assertNotificationField(
    document,
    'recipientCategory',
    'INVALID_NOTIFICATION_RECIPIENT_CATEGORY',
    'Notification recipient category is not supported',
    { required: true }
  );
  assertNotificationField(
    document,
    'template',
    'INVALID_NOTIFICATION_TEMPLATE',
    'Notification template must be a bounded identifier',
    { required: true }
  );
  assertNotificationField(
    document,
    'event',
    'INVALID_NOTIFICATION_EVENT',
    'Notification event must be a bounded identifier',
    { required: true }
  );
  assertNotificationField(document, 'status', 'INVALID_NOTIFICATION_STATUS', STATUS_ERROR_MESSAGE, { required: true });
  assertNotificationField(
    document,
    'retryCount',
    'INVALID_NOTIFICATION_RETRY_COUNT',
    RETRY_COUNT_ERROR_MESSAGE,
    { required: true }
  );
  assertNotificationField(
    document,
    'failureCode',
    'INVALID_NOTIFICATION_FAILURE_CODE',
    FAILURE_CODE_ERROR_MESSAGE
  );
  assertNotificationField(
    document,
    'lastAttemptAt',
    'INVALID_NOTIFICATION_LAST_ATTEMPT_AT',
    'Notification last attempt timestamp must be a valid UTC date'
  );
  assertNotificationField(
    document,
    'sentAt',
    'INVALID_NOTIFICATION_SENT_AT',
    'Notification sent timestamp must be a valid UTC date'
  );
}

function isRetainedPath(path) {
  return path === 'metadata'
    || path.startsWith('metadata.')
    || path === 'failureCode'
    || path === 'failureReason';
}

function assertSafeFailureCode(value) {
  if (value == null || isSafeMachineCode(value)) return;
  throw retainedDataError(
    'INVALID_NOTIFICATION_FAILURE_CODE',
    FAILURE_CODE_ERROR_MESSAGE
  );
}

function sanitizeRetainedUpdateValue(path, value) {
  if (path === 'failureReason') return sanitizeFailureReason(value);
  if (path === 'failureCode') {
    assertSafeFailureCode(value);
    return value;
  }
  if (path === 'metadata') return sanitizeForAudit(value);

  const relativePath = path.slice('metadata.'.length);
  return sanitizeForAudit({ [relativePath]: value })[relativePath];
}

notificationDeliverySchema.pre([
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne'
], function sanitizeRetainedNotificationUpdate() {
  this.setOptions({ runValidators: true });
  this.setQuery(assertSafeNotificationFilter(this.getFilter()));
  this.setUpdate(sanitizeMetadataUpdate(this.getUpdate()));
});

notificationDeliverySchema.pre('save', function sanitizeRetainedNotificationSave() {
  this.metadata = sanitizeForAudit(this.metadata);
  this.failureReason = sanitizeFailureReason(this.failureReason);
  assertValidNotificationDocument(this);
});

notificationDeliverySchema.pre('bulkWrite', function rejectRetainedNotificationBulkWrites() {
  throw retainedDataError(
    'UNSUPPORTED_NOTIFICATION_BULK_WRITE',
    'Notification bulk writes are not supported'
  );
});

notificationDeliverySchema.pre('insertMany', function guardNotificationInsertMany(next, documents, options) {
  try {
    assertSafeInsertManyOptions(options);
    const documentList = Array.isArray(documents) ? dataArrayValues(documents) : [documents];
    if (!documentList) {
      throw retainedDataError('INVALID_NOTIFICATION_INPUT', 'Notification input must be plain data');
    }
    for (const document of documentList) {
      if (utilTypes.isProxy(document)) {
        throw retainedDataError('INVALID_NOTIFICATION_INPUT', 'Notification input must be plain data');
      }
      if (document instanceof mongoose.Document) continue;
      if (!ownDataDescriptors(document)) {
        throw retainedDataError('INVALID_NOTIFICATION_INPUT', 'Notification input must be plain data');
      }
    }
  } catch (error) {
    return next(error);
  }
  return next();
});

notificationDeliverySchema.index({ tenantId: 1, status: 1, created_at: -1 });
notificationDeliverySchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model('NotificationDelivery', notificationDeliverySchema);
