'use strict';
const { supabase } = require('./supabase');
const { getAgentConfigById, getDefaultAgentConfig } = require('./prompt-builder');
const { placeRealtimeCall, hydratePreCallIntelligence, shouldBlockCustomerCall } = require('./call-management');
const logger = require('../services/system-logger');
const { ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE } = require('../services/icallmate');
const { getCurrentSlotLabel, computePriorityScore } = require('../services/call-orchestration');

let ownerDigestRunning = false;
let schedulerRunning = false;

async function markSubmittedCallsWithoutMediaFailed() {}
async function triggerOwnerDigestIfDue() {}
async function dispatchMissingFeedbackAnalysis() {}
async function dispatchClientReminders() {}

async function dispatchScheduledCalls() {
  const currentSlot = getCurrentSlotLabel(new Date());
  
  // 1. Get active tenants
  const { data: activeTenants } = await supabase.from('tenants').select('id').eq('status', 'active');
  if (!activeTenants || !activeTenants.length) return;
  const activeTenantIds = activeTenants.map(t => t.id);

  // 2. Get due customers
  const lockThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  
  const { data: dueCustomers } = await supabase.from('customers')
    .select('*')
    .in('tenant_id', activeTenantIds)
    .neq('status', 'archived')
    .neq('do_not_call', true)
    .neq('wrong_number_flag', true)
    .neq('admin_review_required', true)
    .neq('consent_status', 'denied')
    .in('status', ['pending', 'scheduled', 'retry_scheduled', 'callback_scheduled'])
    .or(`locked_at.is.null,locked_at.lte.${lockThreshold}`)
    .or(`attempt_count.is.null,attempt_count.lt.3`);

  if (!dueCustomers || !dueCustomers.length) return;

  for (const customer of dueCustomers) {
    if (customer.scheduled_datetime && new Date(customer.scheduled_datetime) > new Date()) continue;
    if (!customer.scheduled_datetime && customer.status === 'pending' && customer.preferred_slot > currentSlot) continue;
    if (customer.next_retry_at && new Date(customer.next_retry_at) > new Date()) continue;

    console.log(`[SCHEDULER] Picking up customer ${customer.id}`);
    
    await supabase.from('customers')
      .update({ locked_at: new Date().toISOString(), status: 'calling' })
      .eq('id', customer.id);

    try {
      const agentConfig = customer.default_agent_id
        ? await getAgentConfigById(customer.default_agent_id, customer.tenant_id)
        : await getDefaultAgentConfig(customer.tenant_id);
        
      const call = await placeRealtimeCall({
        customerPhone: customer.phone,
        customerName: customer.name,
        customerId: customer.id,
        clientName: agentConfig?.client_name || 'AI Call Agent',
        agentId: agentConfig?.id || null,
        tenantId: customer.tenant_id,
        callType: customer.call_type
      });

      const { data: newCall } = await supabase.from('calls')
        .insert([{
          tenant_id: customer.tenant_id,
          customer_id: customer.id,
          agent_id: agentConfig?.id || null,
          status: 'queued',
          outcome: 'scheduled_initiated',
          provider_call_id: call.sid,
          started_at: new Date().toISOString(),
          call_direction: 'outbound',
          call_type: customer.call_type
        }])
        .select()
        .single();

      await supabase.from('customers')
        .update({ 
          status: 'called', 
          last_called_at: new Date().toISOString(), 
          locked_at: null 
        })
        .eq('id', customer.id);
        
      logger.info('CALL_STARTED', { callId: newCall?.id, phone: customer.phone });
    } catch (err) {
      logger.error('CALL_PROVIDER_FAILED', { reason: err.message });
      await supabase.from('customers')
        .update({
          status: 'retry_scheduled',
          next_retry_at: new Date(Date.now() + 60000).toISOString(),
          attempt_count: (customer.attempt_count || 0) + 1,
          locked_at: null
        })
        .eq('id', customer.id);
    }
  }
}

async function runSchedulerTick() {
  if (ownerDigestRunning || schedulerRunning) return;
  try {
    schedulerRunning = true;
    await dispatchScheduledCalls();
  } catch (error) {
    console.error('[SCHEDULER ERROR]', error.message);
  } finally {
    schedulerRunning = false;
  }
}

async function tickSupportNotifier() {}

module.exports = {
  runSchedulerTick,
  runOwnerDigestTick: triggerOwnerDigestIfDue,
  tickSupportNotifier,
  markSubmittedCallsWithoutMediaFailed,
  dispatchScheduledCalls
};
