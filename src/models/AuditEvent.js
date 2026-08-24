'use strict';

const mongoose = require('mongoose');
const { sanitizeForAudit } = require('../webmaster/redaction');

const immutableString = (options = {}) => ({ type: String, immutable: true, ...options });

const auditEventSchema = new mongoose.Schema({
  actor: immutableString({ required: true, maxlength: 128 }),
  actorAccessLevel: immutableString({ enum: ['OWNER', 'ADMIN', 'SYSTEM'], required: true }),
  action: immutableString({ required: true, maxlength: 128 }),
  targetType: immutableString({ required: true, maxlength: 128 }),
  targetId: immutableString({ default: null, maxlength: 128 }),
  tenantId: immutableString({ default: null, maxlength: 128 }),
  before: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true, set: sanitizeForAudit },
  after: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true, set: sanitizeForAudit },
  requestId: immutableString({ default: null, maxlength: 128 }),
  outcome: immutableString({ enum: ['success', 'failure'], required: true }),
  failureCode: immutableString({ default: null, maxlength: 80 })
}, {
  strict: true,
  minimize: false,
  timestamps: { createdAt: 'created_at', updatedAt: false }
});

module.exports = mongoose.model('AuditEvent', auditEventSchema);
