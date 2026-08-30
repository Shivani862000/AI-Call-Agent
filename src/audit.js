'use strict';

const supabase = require('./supabase');
const logger = require('./logger');

/**
 * Write a persistent audit record to Supabase.
 * Does not throw; logs internally on failure to avoid disrupting business flows.
 */
async function auditLog(action, details = {}) {
  try {
    const { actorId, tenantId, resourceType, resourceId, ...metadata } = details;
    
    // Also use AsyncLocalStorage context if missing in details
    const context = logger.getContext();
    const resolvedActorId = actorId || context.userId;
    const resolvedTenantId = tenantId || context.tenantId;

    const { error } = await supabase.from('audit_logs').insert([{
      action,
      actor_id: resolvedActorId || null,
      tenant_id: resolvedTenantId || null,
      resource_type: resourceType || null,
      resource_id: resourceId || null,
      metadata: metadata || {}
    }]);

    if (error) {
      logger.error('AUDIT_LOG_FAILED', { action, error });
    }
  } catch (error) {
    logger.error('AUDIT_LOG_EXCEPTION', { action, error });
  }
}

module.exports = {
  auditLog
};
