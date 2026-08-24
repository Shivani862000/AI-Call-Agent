'use strict';

const mongoose = require('mongoose');
const { sanitizeForAudit } = require('../webmaster/redaction');

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
  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  retryCount: { type: Number, min: 0, default: 0 },
  failureCode: { type: String, default: null, maxlength: 80 },
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

module.exports = mongoose.model('NotificationDelivery', notificationDeliverySchema);
