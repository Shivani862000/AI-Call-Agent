'use strict';

const mongoose = require('mongoose');
const { isSafeMachineCode, sanitizeForAudit } = require('../webmaster/redaction');

const REDACTED = '[redacted]';
const DELIVERY_STATUSES = new Set(['pending', 'delivered', 'failed']);
const STATUS_ERROR_MESSAGE = 'Notification status must be pending, delivered, or failed';
const RETRY_COUNT_ERROR_MESSAGE = 'Notification retry count must be a non-negative integer';
const FAILURE_CODE_ERROR_MESSAGE = 'Notification failure code is not in the operational allowlist';
const INVALID_NOTIFICATION_VALUE = '[invalid-notification-value]';

function retainedDataError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
  return value === undefined || typeof value === 'string' ? value : INVALID_NOTIFICATION_VALUE;
}

function preserveRetryCountInput(value) {
  return value === undefined || typeof value === 'number' ? value : INVALID_NOTIFICATION_VALUE;
}

function preserveFailureCodeInput(value) {
  return value == null || typeof value === 'string' ? value : INVALID_NOTIFICATION_VALUE;
}

const notificationDeliverySchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  recipientCategory: {
    type: String,
    enum: ['tenant_admin', 'account', 'owner', 'support'],
    required: true
  },
  template: { type: String, required: true, trim: true, maxlength: 128 },
  event: { type: String, required: true, trim: true, maxlength: 128 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {}, set: sanitizeMetadataAssignment },
  status: {
    type: mongoose.Schema.Types.Mixed,
    default: 'pending',
    set: preserveStatusInput,
    validate: {
      validator: isDeliveryStatus,
      message: STATUS_ERROR_MESSAGE
    }
  },
  retryCount: {
    type: mongoose.Schema.Types.Mixed,
    default: 0,
    set: preserveRetryCountInput,
    validate: {
      validator: isNonNegativeInteger,
      message: RETRY_COUNT_ERROR_MESSAGE
    }
  },
  failureCode: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    set: preserveFailureCodeInput,
    validate: {
      validator: (value) => value == null || isSafeMachineCode(value),
      message: FAILURE_CODE_ERROR_MESSAGE
    }
  },
  failureReason: {
    type: String,
    default: null,
    set: sanitizeFailureReason
  },
  lastAttemptAt: { type: Date, default: null },
  sentAt: { type: Date, default: null }
}, {
  strict: true,
  minimize: false,
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

notificationDeliverySchema.pre('validate', function sanitizeRetainedNotificationMetadata() {
  this.metadata = sanitizeForAudit(this.metadata);
});

function sanitizeMetadataUpdate(update) {
  if (!update || typeof update !== 'object') return update;
  if (Array.isArray(update)) {
    throw retainedDataError(
      'UNSUPPORTED_NOTIFICATION_UPDATE_PIPELINE',
      'Notification update pipelines are not supported'
    );
  }

  if (Object.hasOwn(update, 'metadata')) update.metadata = sanitizeForAudit(update.metadata);
  if (Object.hasOwn(update, 'failureReason')) {
    update.failureReason = sanitizeFailureReason(update.failureReason);
  }
  if (Object.hasOwn(update, 'failureCode')) assertSafeFailureCode(update.failureCode);
  if (Object.hasOwn(update, 'status')) assertDeliveryStatus(update.status);
  if (Object.hasOwn(update, 'retryCount')) assertRetryCount(update.retryCount);

  const hasOperators = Object.keys(update).some((key) => key.startsWith('$'));
  if (!hasOperators) return update;

  for (const [operator, values] of Object.entries(update)) {
    if (!operator.startsWith('$')) continue;
    if (!isPlainRecord(values)) {
      throw retainedDataError(
        'UNSUPPORTED_NOTIFICATION_OPERATOR_OPERAND',
        'Notification update operator operands must be plain records'
      );
    }

    if (operator === '$rename') {
      for (const [source, destination] of Object.entries(values)) {
        if (isRetainedPath(source)
          || isRetainedPath(destination)
          || isDeliveryInvariantPath(source)
          || isDeliveryInvariantPath(destination)) {
          throw retainedDataError(
            'UNSUPPORTED_NOTIFICATION_STRUCTURAL_UPDATE',
            'Notification retained and state field renames are not supported'
          );
        }
      }
      continue;
    }

    for (const [path, value] of Object.entries(values)) {
      if (isDeliveryInvariantPath(path)) validateDeliveryInvariantMutation(operator, path, value);
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

function isDeliveryInvariantPath(path) {
  return path === 'retryCount' || path === 'status';
}

function validateDeliveryInvariantMutation(operator, path, value) {
  if (operator === '$set' || operator === '$setOnInsert') {
    if (path === 'status') assertDeliveryStatus(value);
    if (path === 'retryCount') assertRetryCount(value);
    return;
  }
  if (operator === '$inc' && path === 'retryCount') {
    if (isNonNegativeInteger(value)) return;
    throw retainedDataError(
      'INVALID_NOTIFICATION_RETRY_INCREMENT',
      'Notification retry increments must be non-negative integers'
    );
  }
  throw retainedDataError(
    'INVALID_NOTIFICATION_STATE_MUTATION',
    'Notification state mutation operator is not supported'
  );
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch (_error) {
    return false;
  }
}

function isDeliveryStatus(value) {
  return typeof value === 'string' && DELIVERY_STATUSES.has(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function assertDeliveryStatus(value) {
  if (isDeliveryStatus(value)) return;
  throw retainedDataError('INVALID_NOTIFICATION_STATUS', STATUS_ERROR_MESSAGE);
}

function assertRetryCount(value) {
  if (isNonNegativeInteger(value)) return;
  throw retainedDataError('INVALID_NOTIFICATION_RETRY_COUNT', RETRY_COUNT_ERROR_MESSAGE);
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
  this.setUpdate(sanitizeMetadataUpdate(this.getUpdate()));
});

notificationDeliverySchema.pre('save', function sanitizeRetainedNotificationSave() {
  this.metadata = sanitizeForAudit(this.metadata);
  this.failureReason = sanitizeFailureReason(this.failureReason);
  assertDeliveryStatus(this.status);
  assertRetryCount(this.retryCount);
  assertSafeFailureCode(this.failureCode);
});

notificationDeliverySchema.pre('bulkWrite', function rejectRetainedNotificationBulkWrites() {
  throw retainedDataError(
    'UNSUPPORTED_NOTIFICATION_BULK_WRITE',
    'Notification bulk writes are not supported'
  );
});

notificationDeliverySchema.pre('insertMany', function guardNotificationInsertMany(next, _documents, options) {
  if (options?.lean) {
    return next(retainedDataError(
      'UNSUPPORTED_NOTIFICATION_LEAN_INSERT_MANY',
      'Lean notification inserts are not supported'
    ));
  }
  return next();
});

notificationDeliverySchema.index({ tenantId: 1, status: 1, created_at: -1 });
notificationDeliverySchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model('NotificationDelivery', notificationDeliverySchema);
