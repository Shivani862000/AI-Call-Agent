'use strict';

const { WebmasterError } = require('./errors');
const { supabase } = require('../supabase');

function problem(status, code, message) { return new WebmasterError({ status, code, message }); }
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }

function safeDelivery(record) {
  const item = { ...record };
  return { id: String(item?.id || ''), tenantId: item?.tenant_id ? String(item.tenant_id) : null, accountId: item?.account_id ? String(item.account_id) : null, event: item?.event, template: item?.template, status: item?.status, retryCount: Number(item?.retry_count || 0), retryable: item?.status === 'failed', failureCode: item?.failure_code || null, createdAt: item?.created_at || null, updatedAt: item?.updated_at || null };
}

function createNotificationService({ mailer, auditService, templateProvider = async ({ event, scope }) => ({ subject: `${scope === 'account' ? 'Account' : 'Tenant'} ${event}`, body: `Your ${scope === 'account' ? 'user' : 'organization'} account is now ${event}.` }) } = {}) {
  if (!mailer?.send) throw new TypeError('Mailer is required');

  async function deliver({ tenant, user, event, actor, retryCount = 0, scope = 'tenant', delivery = null, claimed = false }) {
    let template;
    const tenantId = String(tenant.id || tenant._id);
    const userId = String(user.id || user._id);
    
    try { template = await templateProvider({ event, scope, tenantId }); }
    catch (_error) { template = { subject: `${scope === 'account' ? 'Account' : 'Tenant'} ${event}`, body: `Your ${scope === 'account' ? 'user' : 'organization'} account is now ${event}.` }; }

    let row = delivery;
    if (!row) {
       const { data: newRow, error: insertError } = await supabase.from('notification_deliveries').insert([{
         tenant_id: tenantId,
         account_id: userId,
         recipient_category: scope === 'account' ? 'account' : 'tenant_admin',
         template: `${scope}.${event}`,
         event,
         metadata: { tenantId },
         status: 'pending',
         retry_count: retryCount,
         last_attempt_at: new Date().toISOString()
       }]).select().single();
       if (insertError) throw insertError;
       row = newRow;
    } else if (!claimed) {
       const { data: updatedRow, error: updateError } = await supabase.from('notification_deliveries').update({
         status: 'pending',
         retry_count: retryCount,
         last_attempt_at: new Date().toISOString(),
         failure_code: null,
         failure_reason: null,
         sent_at: null
       }).eq('id', row.id).select().single();
       if (updateError) throw updateError;
       row = updatedRow;
    }

    try {
      const result = await mailer.send({ to: user.email, subject: template.subject, html: `<p>${escapeHtml(template.body)}</p>`, tenantId });
      if (result?.delivered === false) throw new Error('DELIVERY_UNAVAILABLE');
      
      const { data: deliveredRow, error: updateError } = await supabase.from('notification_deliveries').update({
        status: 'delivered',
        sent_at: new Date().toISOString(),
        failure_code: null
      }).eq('id', row.id).select().single();
      if (updateError) throw updateError;
      row = deliveredRow;
    } catch (_error) { 
      const { data: failedRow, error: updateError } = await supabase.from('notification_deliveries').update({
        status: 'failed',
        failure_code: 'DELIVERY_FAILED',
        failure_reason: 'Provider delivery failed'
      }).eq('id', row.id).select().single();
      if (updateError) throw updateError;
      row = failedRow;
    }

    await auditService?.record({ actor, action: `notification.${row.status}`, target: { type: 'notification', id: String(row.id) }, tenantId, outcome: row.status === 'delivered' ? 'success' : 'failure', failureCode: row.failure_code });
    return safeDelivery(row);
  }

  async function sendLifecycle({ tenant, users = [], event, actor, scope = 'tenant' }) { 
    if (!['suspended', 'archived', 'restored'].includes(event)) throw new TypeError('Unsupported lifecycle event'); 
    return Promise.all(users.filter(user => user?.email).map(user => deliver({ tenant, user, event, actor, scope }))); 
  }

  async function retry(id, actor) {
    const { data: retained, error } = await supabase.from('notification_deliveries')
      .update({ status: 'pending', failure_code: null, failure_reason: null, last_attempt_at: new Date().toISOString(), sent_at: null, retry_count: supabase.rpc('increment_retry_count') }) // We'll just read and update below to avoid RPC if not defined
      .eq('id', id)
      .eq('status', 'failed')
      .select()
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      // Manual increment fallback if RPC is not defined
      const { data: current } = await supabase.from('notification_deliveries').select('*').eq('id', id).eq('status', 'failed').maybeSingle();
      if (!current) throw problem(404, 'NOTIFICATION_NOT_RETRYABLE', 'Failed notification was not found');
      
      const { data: updatedCurrent, error: fallbackError } = await supabase.from('notification_deliveries').update({
         status: 'pending', failure_code: null, failure_reason: null, last_attempt_at: new Date().toISOString(), sent_at: null, retry_count: (current.retry_count || 0) + 1
      }).eq('id', id).select().single();
      if (fallbackError) throw problem(503, 'NOTIFICATION_RETRY_UNAVAILABLE', 'Notification retry is unavailable');
      
      const { data: tenant } = await supabase.from('tenants').select('*').eq('id', updatedCurrent.tenant_id).single();
      const { data: user } = await supabase.from('users').select('*').eq('id', updatedCurrent.account_id).single();
      
      if (!tenant || !user?.email) throw problem(409, 'NOTIFICATION_RECIPIENT_UNAVAILABLE', 'Notification recipient is no longer available');
      const scope = updatedCurrent.recipient_category === 'account' ? 'account' : 'tenant';
      return deliver({ tenant, user, event: updatedCurrent.event, actor, retryCount: Number(updatedCurrent.retry_count || 0), scope, delivery: updatedCurrent, claimed: true });
    }

    if (!retained) throw problem(404, 'NOTIFICATION_NOT_RETRYABLE', 'Failed notification was not found');
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', retained.tenant_id).single();
    const { data: user } = await supabase.from('users').select('*').eq('id', retained.account_id).single();
    
    if (!tenant || !user?.email) throw problem(409, 'NOTIFICATION_RECIPIENT_UNAVAILABLE', 'Notification recipient is no longer available');
    const scope = retained.recipient_category === 'account' ? 'account' : 'tenant';
    return deliver({ tenant, user, event: retained.event, actor, retryCount: Number(retained.retry_count || 0), scope, delivery: retained, claimed: true });
  }
  return { sendLifecycle, retry, safeDelivery };
}
module.exports = { createNotificationService, safeDelivery };
