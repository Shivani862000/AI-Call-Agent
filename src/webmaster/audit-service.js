'use strict';

const { isSafeMachineCode, sanitizeForAudit } = require('./redaction');

function safeIdentifier(value, fallback = null, maxLength = 128) {
  const normalized = value == null ? '' : String(value).trim();
  if (!normalized || normalized.length > maxLength || !/^[a-z0-9._:-]+$/i.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function stableActorId(actor) {
  const persistedId = safeIdentifier(actor?.id || actor?._id);
  if (persistedId) return persistedId;
  if (actor?.source === 'environment') return 'environment-owner';
  return 'system';
}

function actorAccessLevel(actor) {
  const level = String(actor?.platformAccessLevel || '').toUpperCase();
  return level === 'OWNER' || level === 'ADMIN' ? level : 'SYSTEM';
}

function safeFailureCode(value) {
  if (value == null || value === '') return null;
  if (!isSafeMachineCode(value)) {
    const error = new Error('Audit failure code must use safe machine-code vocabulary');
    error.code = 'INVALID_AUDIT_FAILURE_CODE';
    throw error;
  }
  return value;
}

function safeOutcome(value) {
  if (value !== 'success' && value !== 'failure') {
    const error = new Error('Audit outcome must be success or failure');
    error.code = 'INVALID_AUDIT_OUTCOME';
    throw error;
  }
  return value;
}

function createdValue(document) {
  return document && typeof document.toObject === 'function'
    ? document.toObject()
    : document;
}

function createAuditService({ AuditEventModel }) {
  if (!AuditEventModel || typeof AuditEventModel.create !== 'function') {
    throw new TypeError('AuditEventModel with create() is required');
  }

  async function record({
    actor,
    action,
    target,
    tenantId = null,
    before = null,
    after = null,
    requestId = null,
    outcome = 'success',
    failureCode = null
  } = {}) {
    const payload = {
      actor: stableActorId(actor),
      actorAccessLevel: actorAccessLevel(actor),
      action: safeIdentifier(action, 'unknown.action'),
      targetType: safeIdentifier(target?.type || target?.targetType, 'unknown'),
      targetId: safeIdentifier(target?.id || target?.targetId),
      tenantId: safeIdentifier(tenantId),
      before: sanitizeForAudit(before),
      after: sanitizeForAudit(after),
      requestId: safeIdentifier(requestId),
      outcome: safeOutcome(outcome),
      failureCode: safeFailureCode(failureCode)
    };

    const event = await AuditEventModel.create(payload);
    return sanitizeForAudit(createdValue(event));
  }

  return { record };
}

module.exports = { createAuditService };
