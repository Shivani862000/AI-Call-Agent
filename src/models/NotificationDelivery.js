'use strict';

const mongoose = require('mongoose');
const { isSafeMachineCode, sanitizeForAudit } = require('../webmaster/redaction');

const REDACTED = '[redacted]';

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
  status: { type: String, enum: ['pending', 'delivered', 'failed'], default: 'pending' },
  retryCount: {
    type: Number,
    min: 0,
    default: 0,
    validate: { validator: Number.isInteger, message: 'Retry count must be an integer' }
  },
  failureCode: {
    type: String,
    default: null,
    validate: {
      validator: (value) => value == null || isSafeMachineCode(value),
      message: 'Failure code must use safe machine-code vocabulary'
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

  const hasOperators = Object.keys(update).some((key) => key.startsWith('$'));
  if (!hasOperators) return update;

  for (const [operator, values] of Object.entries(update)) {
    if (!operator.startsWith('$') || !values || typeof values !== 'object') continue;

    if (operator === '$rename') {
      for (const [source, destination] of Object.entries(values)) {
        if (isRetainedPath(source) || isRetainedPath(destination)) {
          throw retainedDataError(
            'UNSUPPORTED_NOTIFICATION_STRUCTURAL_UPDATE',
            'Notification retained-field renames are not supported'
          );
        }
      }
      continue;
    }

    for (const [path, value] of Object.entries(values)) {
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
    'Notification failure code is not in the operational allowlist'
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
  this.setUpdate(sanitizeMetadataUpdate(this.getUpdate()));
});

notificationDeliverySchema.pre('save', function sanitizeRetainedNotificationSave() {
  this.metadata = sanitizeForAudit(this.metadata);
  this.failureReason = sanitizeFailureReason(this.failureReason);
  assertSafeFailureCode(this.failureCode);
});

notificationDeliverySchema.pre('bulkWrite', function rejectRetainedNotificationBulkWrites() {
  throw retainedDataError(
    'UNSUPPORTED_NOTIFICATION_BULK_WRITE',
    'Notification bulk writes are not supported'
  );
});

notificationDeliverySchema.index({ tenantId: 1, status: 1, created_at: -1 });
notificationDeliverySchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model('NotificationDelivery', notificationDeliverySchema);
