'use strict';

const mongoose = require('mongoose');
const {
  isSafeCorrelationId,
  isSafeMachineCode,
  sanitizeForAudit
} = require('../webmaster/redaction');

const immutableString = (options = {}) => ({ type: String, immutable: true, ...options });
const immutableMixed = (options = {}) => ({
  type: mongoose.Schema.Types.Mixed,
  immutable: true,
  ...options
});
const INVALID_REQUEST_ID_VALUE = '[invalid-request-id]';

function preserveRequestIdInput(value) {
  return value == null || typeof value === 'string' ? value : INVALID_REQUEST_ID_VALUE;
}

const auditEventSchema = new mongoose.Schema({
  actor: immutableString({ required: true, maxlength: 128 }),
  actorAccessLevel: immutableString({ enum: ['OWNER', 'ADMIN', 'SYSTEM'], required: true }),
  action: immutableString({ required: true, maxlength: 128 }),
  targetType: immutableString({ required: true, maxlength: 128 }),
  targetId: immutableString({ default: null, maxlength: 128 }),
  tenantId: immutableString({ default: null, maxlength: 128 }),
  before: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true, set: sanitizeForAudit },
  after: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true, set: sanitizeForAudit },
  requestId: immutableMixed({
    default: null,
    set: preserveRequestIdInput,
    validate: {
      validator: (value) => value == null || isSafeCorrelationId(value),
      message: 'Request ID must be a bounded correlation identifier'
    }
  }),
  outcome: immutableString({ enum: ['success', 'failure'], required: true }),
  failureCode: immutableString({
    default: null,
    validate: {
      validator: (value) => value == null || isSafeMachineCode(value),
      message: 'Failure code must use safe machine-code vocabulary'
    }
  })
}, {
  strict: true,
  minimize: false,
  timestamps: { createdAt: 'created_at', updatedAt: false }
});

auditEventSchema.pre('validate', function sanitizeRetainedAuditMetadata() {
  this.before = sanitizeForAudit(this.before);
  this.after = sanitizeForAudit(this.after);
});

auditEventSchema.index({ created_at: -1 });
auditEventSchema.index({ tenantId: 1, created_at: -1 });

module.exports = mongoose.model('AuditEvent', auditEventSchema);
