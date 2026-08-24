'use strict';

const mongoose = require('mongoose');
const { isSafeMachineCode, sanitizeForAudit } = require('../webmaster/redaction');

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
  metadata: { type: mongoose.Schema.Types.Mixed, default: {}, set: sanitizeForAudit },
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
    set: (value) => value == null ? null : '[redacted]'
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
    for (const stage of update) sanitizeMetadataUpdate(stage);
    return update;
  }
  if (Object.hasOwn(update, 'metadata')) update.metadata = sanitizeForAudit(update.metadata);

  for (const [operator, values] of Object.entries(update)) {
    if (!operator.startsWith('$') || !values || typeof values !== 'object') continue;
    for (const [path, value] of Object.entries(values)) {
      if (path === 'metadata') {
        values[path] = sanitizeForAudit(value);
      } else if (path.startsWith('metadata.')) {
        const relativePath = path.slice('metadata.'.length);
        values[path] = sanitizeForAudit({ [relativePath]: value })[relativePath];
      } else if (operator === '$rename' && typeof value === 'string' && value.startsWith('metadata.')) {
        const error = new Error('Renaming unsanitized values into notification metadata is not permitted');
        error.code = 'UNSAFE_NOTIFICATION_METADATA_UPDATE';
        throw error;
      }
    }
  }
  return update;
}

notificationDeliverySchema.pre([
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne'
], function sanitizeRetainedNotificationUpdate() {
  this.setUpdate(sanitizeMetadataUpdate(this.getUpdate()));
});

notificationDeliverySchema.index({ tenantId: 1, status: 1, created_at: -1 });
notificationDeliverySchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model('NotificationDelivery', notificationDeliverySchema);
