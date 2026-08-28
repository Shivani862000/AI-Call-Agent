'use strict';

const { supabase } = require('../supabase');
const {
  isSafeCorrelationId,
  isSafeMachineCode,
  sanitizeForAudit
} = require('./redaction');
const { ownDataDescriptors, valueSafeError } = require('./value-safe-validation');

function safeIdentifier(value, fallback = null, maxLength = 128) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !/^[a-z0-9._:-]+$/i.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function plainInputDescriptors(value, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const descriptors = ownDataDescriptors(value);
  if (!descriptors) throw valueSafeError('INVALID_AUDIT_INPUT', 'Audit input must be plain data');
  return descriptors;
}

function field(descriptors, key, fallback = undefined) {
  return descriptors && Object.hasOwn(descriptors, key) ? descriptors[key].value : fallback;
}

function stableActorId(actorDescriptors) {
  const persistedId = safeIdentifier(field(actorDescriptors, 'id') ?? field(actorDescriptors, '_id'));
  if (persistedId) return persistedId;
  if (field(actorDescriptors, 'source') === 'environment') return 'environment-owner';
  return 'system';
}

function safeCorrelationId(value) {
  return isSafeCorrelationId(value) ? value : null;
}

function actorAccessLevel(actorDescriptors) {
  const level = field(actorDescriptors, 'platformAccessLevel');
  return level === 'OWNER' || level === 'ADMIN' ? level : 'SYSTEM';
}

function safeFailureCode(value) {
  if (value == null || value === '') return null;
  if (!isSafeMachineCode(value)) {
    throw valueSafeError(
      'INVALID_AUDIT_FAILURE_CODE',
      'Audit failure code must use safe machine-code vocabulary'
    );
  }
  return value;
}

function safeOutcome(value) {
  if (value !== 'success' && value !== 'failure') {
    throw valueSafeError('INVALID_AUDIT_OUTCOME', 'Audit outcome must be success or failure');
  }
  return value;
}

function createdValue(document) {
  return document && typeof document.toObject === 'function'
    ? document.toObject()
    : document;
}

function createAuditService() {
  async function record(input = {}, options = {}) {
    const inputDescriptors = plainInputDescriptors(input);
    const actorDescriptors = plainInputDescriptors(field(inputDescriptors, 'actor'), { nullable: true });
    const targetDescriptors = plainInputDescriptors(field(inputDescriptors, 'target'), { nullable: true });
    const action = safeIdentifier(field(inputDescriptors, 'action'), 'unknown.action');
    const targetType = safeIdentifier(
      field(targetDescriptors, 'type') ?? field(targetDescriptors, 'targetType'),
      'unknown'
    );
    const targetId = safeIdentifier(field(targetDescriptors, 'id') ?? field(targetDescriptors, 'targetId'));
    const tenantId = safeIdentifier(field(inputDescriptors, 'tenantId', null));
    const requestId = safeCorrelationId(field(inputDescriptors, 'requestId', null));
    const outcome = safeOutcome(field(inputDescriptors, 'outcome', 'success'));
    const failureCode = safeFailureCode(field(inputDescriptors, 'failureCode', null));

    const insertData = {
      actor: stableActorId(actorDescriptors),
      actor_access_level: actorAccessLevel(actorDescriptors),
      action,
      target_type: targetType,
      target_id: targetId,
      tenant_id: tenantId,
      before: sanitizeForAudit(field(inputDescriptors, 'before', null)),
      after: sanitizeForAudit(field(inputDescriptors, 'after', null)),
      request_id: requestId,
      outcome,
      failure_code: failureCode
    };

    const { data: event, error } = await supabase.from('audit_events').insert([insertData]).select().single();
    if (error) {
       console.error("Audit Service Insert Error:", error);
       // Do not throw here since audit logging failure should not break app flow necessarily
       return sanitizeForAudit(createdValue(insertData)); 
    }
    
    return sanitizeForAudit(createdValue(event));
  }

  return { record };
}

module.exports = { createAuditService };
