/**
 * src/scheduler.js
 * Scheduler for automated outbound calls and owner daily digest.
 */

'use strict';

const supabase = require('./supabase');
const { CLIENT_NAME, CALL_TYPES } = require('./config');
const {
  shouldTriggerOwnerDigest,
  getLocalDateKey,
  normalizePhoneLookupValue,
  normalizeOutboundCallType
} = require('./helpers');
const {
  placeRealtimeCall,
  ensureCustomerForClientReminder,
  hydratePreCallIntelligence,
  shouldBlockCustomerCall,
  computeNextAnnualReminderDate
} = require('./call-management');
const { getAgentConfigById, getDefaultAgentConfig } = require('./prompt-builder');
const { computePriorityScore, getCurrentSlotLabel } = require('../services/call-orchestration');
const { buildOwnerDashboardData } = require('../services/reporting');
const logger = require('../services/system-logger');
const { ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE } = require('../services/icallmate');

let ownerDigestRunning = false;
let schedulerRunning = false;

const SUBMITTED_CALL_GRACE_MS = Number(process.env.SUBMITTED_CALL_GRACE_MS || 6 * 60 * 1000);
const SUBMITTED_CALL_RETRY_MS = Number(process.env.SUBMITTED_CALL_RETRY_MS || 5 * 60 * 60 * 1000);

function formatTimeoutLabel(ms) {
  const minutes = Math.round((Number(ms || 0) / 60000) * 10) / 10;
  return `${minutes || 0} minute${minutes === 1 ? '' : 's'}`;
}

function isProviderAcceptedOnly(call) {
  const reason = String(call?.raw?.reason || call?.raw?.message || '');
  const status = String(call?.status || '').toLowerCase();
  return status === 'queued'
    || status === 'submitted'
    || reason.includes('Total Records Being Inserted');
}

function enforceBusinessHours(isoString) {
  const date = new Date(isoString);
  const hour = date.getHours();
  if (hour >= 21) {
    date.setDate(date.getDate() + 1);
    date.setHours(7, 0, 0, 0);
  } else if (hour < 7) {
    date.setHours(7, 0, 0, 0);
  }
  return date.toISOString();
}

async function markSubmittedCallsWithoutMediaFailed() {
  const cutoffIso = new Date(Date.now() - SUBMITTED_CALL_GRACE_MS).toISOString();
  const retryAt = new Date(Date.now() + SUBMITTED_CALL_RETRY_MS).toISOString();
  const nowIso = new Date().toISOString();
  const timeoutLabel = formatTimeoutLabel(SUBMITTED_CALL_GRACE_MS);
  
  const { data: staleCallsRaw } = await supabase
    .from('calls')
    .select('id, customer_id, provider_call_id, called_at, call_type, customers(name, phone, status, auto_retry_enabled, attempt_count)')
    .eq('call_direction', 'outbound')
    .in('outcome', ['initiated', 'scheduled_initiated'])
    .lte('called_at', cutoffIso)
    .or('media_packets.eq.0,media_packets.is.null')
    .order('called_at', { ascending: true });

  const staleCalls = (staleCallsRaw || []).map(row => ({
    call_id: row.id,
    customer_id: row.customer_id,
    provider_call_id: row.provider_call_id,
    called_at: row.called_at,
    call_type: row.call_type,
    name: row.customers?.name,
    phone: row.customers?.phone,
    customer_status: row.customers?.status,
    auto_retry_enabled: row.customers?.auto_retry_enabled !== false ? 1 : 0,
    attempt_count: row.customers?.attempt_count || 0
  }));

  for (const call of staleCalls) {
    const { data: newerCall } = await supabase
      .from('calls')
      .select('id')
      .eq('customer_id', call.customer_id)
      .gt('called_at', call.called_at)
      .limit(1)
      .single();
      
    call.has_newer_call = !!newerCall;

    const { data: failResult, error } = await supabase
      .from('calls')
      .update({
        outcome: 'failed',
        outcome_detail: `Connection timeout after ${timeoutLabel} (User may not have answered or is out of network)`,
        ended_at: nowIso,
        last_event: 'media_timeout',
        notes: 'Provider accepted request, but no media stream was received. Assume no-answer or network issue.'
      })
      .eq('id', call.call_id)
      .in('outcome', ['initiated', 'scheduled_initiated'])
      .or('media_packets.eq.0,media_packets.is.null')
      .select('id');

    if (!failResult || failResult.length === 0) {
      continue;
    }

    if (call.has_newer_call) {
      continue;
    }

    const attempts = call.attempt_count + 1;
    let nextStatus = 'failed';
    let nextRetryAt = null;

    if (call.auto_retry_enabled !== 0 && attempts < 3) {
      nextStatus = 'retry_scheduled';
      let retryDate = new Date(Date.now() + 3 * 60 * 60 * 1000);
      nextRetryAt = enforceBusinessHours(retryDate.toISOString());
    }

    await supabase
      .from('customers')
      .update({
        status: nextStatus,
        next_retry_at: nextRetryAt,
        last_contact_outcome: 'failed',
        retry_count: attempts,
        attempt_count: attempts
      })
      .eq('id', call.customer_id)
      .in('status', ['calling', 'called']);

    logger.error('CALL_FAILED', {
      callId: call.call_id,
      customerId: call.customer_id,
      patient: call.name,
      phone: call.phone,
      type: logger.formatCallType(call.call_type),
      providerCallId: call.provider_call_id,
      reason: `Connection timeout after ${timeoutLabel} (No Answer / Network Issue)`,
      retryAt: nextRetryAt ? logger.formatHumanDateTime(nextRetryAt) : null
    });
    
    if (nextStatus === 'retry_scheduled') {
      logger.warn('CALL_RETRY', {
        callId: call.call_id,
        customerId: call.customer_id,
        patient: call.name,
        phone: call.phone,
        type: logger.formatCallType(call.call_type),
        retryAt: logger.formatHumanDateTime(nextRetryAt),
        delay: '3 hours'
      });
    }
  }
}

// ── Owner Digest ───────────────────────────────────────────────────────────────

async function runOwnerDigestTick() {
  if (ownerDigestRunning || !shouldTriggerOwnerDigest()) {
    return;
  }

  ownerDigestRunning = true;

  try {
    const todayKey = getLocalDateKey();
    const { data: state } = await supabase.from('app_state').select('value').eq('key', 'owner_morning_digest_last_sent').single();
    if (state?.value === todayKey) {
      return;
    }

    const digest = await buildOwnerDashboardData();
    const lines = [
      digest.digest_text,
      '',
      `Revenue pipeline: Rs ${Number(digest.roi_snapshot?.revenue_pipeline_estimate || 0).toFixed(0)}`,
      `Estimated AI ops cost: Rs ${Number(digest.roi_snapshot?.ai_ops_cost_estimate || 0).toFixed(0)}`,
      `Estimated staff saving: Rs ${Number(digest.roi_snapshot?.estimated_saving_vs_staff || 0).toFixed(0)}`,
      '',
      digest.alerts?.length
        ? `Priority alerts:\\n- ${digest.alerts.map((item) => `${item.customer_name}: ${item.headline}`).join('\\n- ')}`
        : 'Priority alerts: none'
    ].join('\\n');



    await supabase
      .from('app_state')
      .upsert({ key: 'owner_morning_digest_last_sent', value: todayKey, updated_at: new Date().toISOString() });

    logger.info('OWNER_DIGEST_SUCCESS');
  } catch (error) {
    logger.error('OWNER_DIGEST_FAILED', { error });
  } finally {
    ownerDigestRunning = false;
  }
}

// ── Outbound Calling Schedulers ────────────────────────────────────────────────

async function triggerScheduledCalls() {
  if (String(process.env.DISABLE_SCHEDULER || '').toLowerCase() === 'true') {
    return;
  }

  if (global.providerFailureCooldownUntil && Date.now() < global.providerFailureCooldownUntil) {
    logger.warn('SCHEDULER_PAUSED_COOLDOWN');
    return;
  }

  await markSubmittedCallsWithoutMediaFailed();

  const now = new Date();
  const currentSlot = getCurrentSlotLabel(now);

  const { data: dueCustomers } = await supabase
    .from('customers')
    .select('*')
    .or('do_not_call.is.null,do_not_call.eq.0')
    .or('wrong_number_flag.is.null,wrong_number_flag.eq.0')
    .or('admin_review_required.is.null,admin_review_required.eq.0')
    .neq('consent_status', 'denied')
    .in('status', ['pending', 'scheduled', 'retry_scheduled', 'callback_scheduled'])
    .or('attempt_count.is.null,attempt_count.eq.0,auto_retry_enabled.eq.1')
    .lt('attempt_count', 3);

  // Filter the rest in memory since the query would be too complex
  const filteredCustomers = (dueCustomers || []).filter(c => {
    const lockedAtDate = c.locked_at ? new Date(c.locked_at) : null;
    if (lockedAtDate && Date.now() - lockedAtDate.getTime() < 10 * 60 * 1000) return false;
    
    let timeConditionMet = false;
    if (['pending', 'scheduled'].includes(c.status)) {
      if (c.scheduled_datetime && new Date(c.scheduled_datetime) <= now) {
        timeConditionMet = true;
      } else if (!c.scheduled_datetime && (c.best_call_slot || c.preferred_slot || '') <= currentSlot) {
        timeConditionMet = true;
      }
    } else if (['retry_scheduled', 'callback_scheduled'].includes(c.status) && c.next_retry_at && new Date(c.next_retry_at) <= now) {
      timeConditionMet = true;
    }

    return timeConditionMet;
  });

  if (!filteredCustomers.length) {
    return;
  }
  
  // Further filter by checking recent calls
  const verifiedDueCustomers = [];
  for (const c of filteredCustomers) {
    if (['retry_scheduled', 'callback_scheduled'].includes(c.status)) {
      verifiedDueCustomers.push(c);
      continue;
    }
    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const { data: recentCall } = await supabase
      .from('calls')
      .select('id')
      .eq('customer_id', c.id)
      .gte('called_at', fortyFiveMinsAgo)
      .limit(1)
      .single();
    if (!recentCall) {
      verifiedDueCustomers.push(c);
    }
  }

  if (!verifiedDueCustomers.length) {
    return;
  }

  const uniqueByPhone = new Map();
  for (const customer of verifiedDueCustomers) {
    const phoneKey = normalizePhoneLookupValue(customer.phone) || String(customer.phone || '').trim();
    if (!phoneKey) {
      continue;
    }

    if (uniqueByPhone.has(phoneKey)) {
      const existing = uniqueByPhone.get(phoneKey);
      console.log(
        `[SCHEDULER] Skipping duplicate customer row id=${customer.id} ` +
        `because row id=${existing.id} already queued`
      );
      continue;
    }

    uniqueByPhone.set(phoneKey, customer);
  }

  const hydratedCustomers = [];
  for (const customer of uniqueByPhone.values()) {
    hydratedCustomers.push(await hydratePreCallIntelligence(customer));
  }

  hydratedCustomers.sort((a, b) => (Number(b.priority_score) || 0) - (Number(a.priority_score) || 0));
  if (hydratedCustomers.length > 0) {
    logger.info('SCHEDULER_FOUND_CUSTOMERS', { count: hydratedCustomers.length, slot: currentSlot });
  }

  for (const customer of hydratedCustomers) {
    try {
      const agentConfig = customer.default_agent_id ? await getAgentConfigById(customer.default_agent_id) : await getDefaultAgentConfig();
      const blockedReason = await shouldBlockCustomerCall(customer);
      if (blockedReason) {
        logger.debug('SCHEDULER_SKIP_CUSTOMER', { customerId: customer.id, reason: blockedReason.reason });
        if (blockedReason.code === 'CALL_SKIPPED_QUIET_HOURS') {
          const nextRetry = new Date();
          nextRetry.setHours(7, 0, 0, 0);
          if (nextRetry < new Date()) {
            nextRetry.setDate(nextRetry.getDate() + 1);
          }
          logger.warn('CALL_SKIPPED_QUIET_HOURS', { phone: customer.phone, scheduledTime: logger.formatHumanDateTime(customer.scheduled_datetime || customer.next_retry_at || ''), reason: blockedReason.reason });
          await supabase.from('customers').update({ status: 'retry_scheduled', next_retry_at: nextRetry.toISOString() }).eq('id', customer.id);
        } else if (blockedReason.code === 'CALL_FAILED_MAX_ATTEMPTS' || blockedReason.code === 'CALL_BLOCKED_DAILY_LIMIT') {
          logger.error('CALL_FAILED_MAX_ATTEMPTS', { phone: customer.phone, attempts: 3, reason: blockedReason.reason });
          await supabase.from('customers').update({ status: 'failed', failed_reason: blockedReason.reason }).eq('id', customer.id);
        } else if (blockedReason.code === 'CALL_BLOCKED_THREE_HOUR_GAP') {
          logger.warn('CALL_BLOCKED_THREE_HOUR_GAP', { phone: customer.phone, lastAttemptAt: logger.formatHumanDateTime(blockedReason.lastAttemptAt), nextAllowedAt: logger.formatHumanDateTime(blockedReason.nextAllowedAt) });
          await supabase.from('customers').update({ status: 'retry_scheduled', next_retry_at: blockedReason.nextAllowedAt }).eq('id', customer.id);
        } else if (blockedReason.code === 'CALL_AUTO_SCHEDULE_BLOCKED_COMPLETED') {
          logger.warn('CALL_AUTO_SCHEDULE_BLOCKED_COMPLETED', { phone: customer.phone, callType: customer.call_type, reason: blockedReason.reason });
          await supabase.from('customers').update({ status: 'cancelled', failed_reason: blockedReason.reason }).eq('id', customer.id);
        } else if (blockedReason.code === 'CALL_BLOCKED_ACTIVE_CALL') {
          logger.warn('CALL_BLOCKED_ACTIVE_CALL', { phone: customer.phone, reason: blockedReason.reason });
          // Don't update status, just skip for now, it'll be picked up later when the other call is done
        }
        continue;
      }

      const idempotencyKey = `${customer.id}-${customer.attempt_count || 0}-${customer.scheduled_datetime || customer.next_retry_at || 'now'}`;
      const { data: existingCall } = await supabase.from('calls').select('id').eq('idempotency_key', idempotencyKey).single();
      if (existingCall) {
        logger.warn('CALL_START_BLOCKED_DUPLICATE', { phone: customer.phone, reason: 'Already calling' });
        // Fix: Advance the attempt_count to break out of infinite loop for this idempotency key
        await supabase.from('customers').update({ attempt_count: (customer.attempt_count || 0) + 1 }).eq('id', customer.id);
        continue;
      }

      const { data: claimResult, error: claimError } = await supabase
        .from('customers')
        .update({
          status: 'calling',
          last_called_at: new Date().toISOString(),
          locked_at: new Date().toISOString()
        })
        .eq('id', customer.id)
        .in('status', ['pending', 'scheduled', 'retry_scheduled', 'callback_scheduled'])
        .or(`locked_at.is.null,locked_at.lte.${new Date(Date.now() - 10 * 60 * 1000).toISOString()}`)
        .select('id');

      if (!claimResult || claimResult.length === 0) {
        logger.warn('CALL_START_BLOCKED_DUPLICATE', { phone: customer.phone, reason: 'Already calling or locked' });
        continue;
      }

      logger.info('CALL_LOCK_ACQUIRED', { callId: customer.id, lockedAt: new Date().toISOString() });
      logger.info('CALL_PENDING', {
        customerId: customer.id,
        patient: customer.name,
        phone: customer.phone,
        type: logger.formatCallType(customer.call_type),
        scheduledAt: logger.formatHumanDateTime(customer.scheduled_datetime || customer.next_retry_at),
        status: 'scheduler_picked'
      });

      let call;
      try {
        call = await placeRealtimeCall({
          customerPhone: customer.phone,
          customerName: customer.name,
          customerId: customer.id,
          clientName: agentConfig?.client_name || CLIENT_NAME,
          agentId: agentConfig?.id || null,
          callType: customer.call_type
        });
      } catch (error) {
        logger.error('CALL_PROVIDER_FAILED', { callId: customer.id, provider: 'icallmate', reason: error.message || 'provider unavailable' });

        const mediaEndpointUnavailable = error.code === ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE;
        const retryDelayMs = mediaEndpointUnavailable
          ? Math.max(Number(process.env.ICALLMATE_PREFLIGHT_RETRY_MS || 60000) || 60000, 10000)
          : require('./config').MIN_RETRY_GAP_MINUTES * 60 * 1000;
        const nextRetry = new Date(Date.now() + retryDelayMs);

        if (!mediaEndpointUnavailable) {
          global.providerFailureCooldownUntil = Date.now() + 15 * 60 * 1000;
          logger.error('SCHEDULER_PAUSED_PROVIDER_DOWN', { reason: 'Provider failed, pausing scheduler for 15 minutes' });
        }

        await supabase.from('customers').update({
          status: 'retry_scheduled',
          next_retry_at: nextRetry.toISOString(),
          attempt_count: (customer.attempt_count || 0) + (mediaEndpointUnavailable ? 0 : 1),
          locked_at: null
        }).eq('id', customer.id);
        
        logger.info('CALL_RETRY_SCHEDULED', {
          callId: customer.id,
          nextAttemptAt: logger.formatHumanDateTime(nextRetry),
          attempt: (customer.attempt_count || 0) + (mediaEndpointUnavailable ? 0 : 1),
          reason: mediaEndpointUnavailable ? 'public_media_endpoint_unavailable' : 'provider_failure'
        });
        logger.info('CALL_LOCK_RELEASED', { callId: customer.id });
        continue;
      }

      const { data: insertResult, error: insertError } = await supabase.from('calls').insert([{
        customer_id: customer.id,
        agent_id: agentConfig?.id || null,
        outcome: 'scheduled_initiated',
        provider_call_id: call.sid,
        called_at: new Date().toISOString(),
        hot_lead_score: customer.priority_score || computePriorityScore(customer),
        consent_message_played: 1,
        call_script_version: agentConfig?.slug || 'hindi-feedback-v1',
        supervisor_alert_level: 'normal',
        call_direction: 'outbound',
        call_source: 'icallmate',
        call_type: normalizeOutboundCallType(customer.call_type),
        provider_payload_json: JSON.stringify({ request: call.requestPayload || null, response: call.raw || null }),
        idempotency_key: idempotencyKey
      }]).select('id').single();
      
      await supabase.from('customers').update({ status: 'called' }).eq('id', customer.id);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const { count: attempt } = await supabase
        .from('calls')
        .select('*', { count: 'exact', head: true })
        .eq('customer_id', customer.id)
        .gte('called_at', todayStart.toISOString())
        .or('call_direction.eq.outbound,call_direction.is.null');

      logger.info('CALL_ATTEMPT_STARTED', { phone: customer.phone, attempt: attempt || 1 });

      const insertedCall = { id: insertResult.id };
      const acceptedOnly = isProviderAcceptedOnly(call);
      logger.info(acceptedOnly ? 'CALL_PENDING' : 'CALL_STARTED', {
        callId: insertedCall?.id,
        customerId: customer.id,
        patient: customer.name,
        phone: customer.phone,
        type: logger.formatCallType(customer.call_type),
        provider: 'icallmate',
        providerCallId: call.sid,
        providerStatus: call.status,
        providerReason: call.providerReason || call.raw?.reason || call.raw?.message || '',
        status: acceptedOnly ? 'provider_accepted_waiting_for_media' : 'started'
      });
      logger.info('CALL_SCHEDULED', {
        customerId: customer.id,
        sid: call.sid,
        status: call.status,
        acceptedOnly
      });
    } catch (error) {
      const retryAt = new Date(Date.now() + (5 * 60 * 1000)).toISOString();
      logger.error('CALL_FAILED', {
        customerId: customer.id,
        patient: customer.name,
        phone: customer.phone,
        type: logger.formatCallType(customer.call_type),
        reason: error.message,
        retryAt: logger.formatHumanDateTime(retryAt)
      });
      try {
        await supabase
          .from('customers')
          .update({
            status: 'retry_scheduled',
            next_retry_at: retryAt,
            retry_count: (customer.retry_count || 0) + 1
          })
          .eq('id', customer.id)
          .eq('status', 'calling');
      } catch (rollbackError) {
        logger.error('CUSTOMER_ROLLBACK_FAILED', { error: rollbackError, customerId: customer.id });
      }
    }
  }
}

async function triggerAnnualClientReminderCalls() {
  const now = new Date();
  const currentSlot = getCurrentSlotLabel(now);
  const currentYear = now.getUTCFullYear();
  const todayIso = new Date().toISOString().split('T')[0];

  const { data: clients } = await supabase
    .from('clients')
    .select('*')
    .or('annual_reminder_enabled.is.null,annual_reminder_enabled.eq.1')
    .or('status.is.null,status.eq.active')
    .not('next_annual_reminder_date', 'is', null)
    .lte('next_annual_reminder_date', todayIso)
    .lte('annual_reminder_slot', currentSlot)
    .lt('last_annual_reminder_year', currentYear)
    .order('next_annual_reminder_date', { ascending: true })
    .order('annual_reminder_slot', { ascending: true });

  const dueClients = [];
  for (const client of (clients || [])) {
    if (client.linked_customer_id) {
      const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      const { data: recentCall } = await supabase
        .from('calls')
        .select('id')
        .eq('customer_id', client.linked_customer_id)
        .gte('called_at', fortyFiveMinsAgo)
        .limit(1)
        .single();
      if (!recentCall) {
        dueClients.push(client);
      }
    } else {
      dueClients.push(client);
    }
  }

  if (!dueClients.length) {
    return;
  }

  console.log(`[CLIENT REMINDER] Found ${dueClients.length} annual reminder client(s) due at ${currentSlot}`);

  for (const client of dueClients) {
    try {
      const customer = await ensureCustomerForClientReminder(client);
      const hydratedCustomer = await hydratePreCallIntelligence(customer);
      const blockedReason = await shouldBlockCustomerCall(hydratedCustomer);
      if (blockedReason) {
        console.log(`[CLIENT REMINDER] Skipping clientId=${client.id}: ${blockedReason.reason}`);
        if (blockedReason.code === 'CALL_SKIPPED_QUIET_HOURS') {
          const nextRetry = new Date();
          nextRetry.setHours(7, 0, 0, 0);
          if (nextRetry < new Date()) {
            nextRetry.setDate(nextRetry.getDate() + 1);
          }
          logger.warn('CALL_SKIPPED_QUIET_HOURS', { phone: hydratedCustomer.phone, scheduledTime: 'Annual Reminder', reason: blockedReason.reason });
          await supabase.from('customers').update({ status: 'retry_scheduled', next_retry_at: nextRetry.toISOString() }).eq('id', hydratedCustomer.id);
        } else if (blockedReason.code === 'CALL_FAILED_MAX_ATTEMPTS' || blockedReason.code === 'CALL_BLOCKED_DAILY_LIMIT') {
          logger.error('CALL_FAILED_MAX_ATTEMPTS', { phone: hydratedCustomer.phone, attempts: 3, reason: blockedReason.reason });
          await supabase.from('customers').update({ status: 'failed', failed_reason: blockedReason.reason }).eq('id', hydratedCustomer.id);
        } else if (blockedReason.code === 'CALL_BLOCKED_THREE_HOUR_GAP') {
          logger.warn('CALL_BLOCKED_THREE_HOUR_GAP', { phone: hydratedCustomer.phone, lastAttemptAt: logger.formatHumanDateTime(blockedReason.lastAttemptAt), nextAllowedAt: logger.formatHumanDateTime(blockedReason.nextAllowedAt) });
          await supabase.from('customers').update({ status: 'retry_scheduled', next_retry_at: blockedReason.nextAllowedAt }).eq('id', hydratedCustomer.id);
        }
        continue;
      }

      const agentConfig = hydratedCustomer.default_agent_id
        ? await getAgentConfigById(hydratedCustomer.default_agent_id)
        : await getDefaultAgentConfig();

      const { data: claimResult } = await supabase
        .from('customers')
        .update({
          status: 'calling',
          last_called_at: new Date().toISOString()
        })
        .eq('id', hydratedCustomer.id)
        .in('status', ['pending', 'retry_scheduled', 'callback_scheduled', 'called', 'completed'])
        .select('id');

      if (!claimResult || claimResult.length === 0) {
        console.log(`[CLIENT REMINDER] Skipping clientId=${client.id}: customer row is already in use`);
        continue;
      }

      const call = await placeRealtimeCall({
        customerPhone: hydratedCustomer.phone,
        customerName: hydratedCustomer.name,
        customerId: hydratedCustomer.id,
        clientName: agentConfig?.client_name || CLIENT_NAME,
        agentId: agentConfig?.id || null,
        callType: CALL_TYPES.THREE_MONTH_FOLLOWUP
      });

      await supabase.from('calls').insert([{
        customer_id: hydratedCustomer.id,
        agent_id: agentConfig?.id || null,
        outcome: 'scheduled_initiated',
        provider_call_id: call.sid,
        called_at: new Date().toISOString(),
        hot_lead_score: hydratedCustomer.priority_score || computePriorityScore(hydratedCustomer),
        consent_message_played: 1,
        call_script_version: `annual-reminder:${client.treatment_type || 'client-care'}`,
        supervisor_alert_level: 'normal',
        call_direction: 'outbound',
        call_source: 'icallmate',
        call_type: CALL_TYPES.THREE_MONTH_FOLLOWUP
      }]);

      await supabase.from('customers').update({ status: 'called' }).eq('id', hydratedCustomer.id);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const { count: attempt } = await supabase
        .from('calls')
        .select('*', { count: 'exact', head: true })
        .eq('customer_id', hydratedCustomer.id)
        .gte('called_at', todayStart.toISOString())
        .or('call_direction.eq.outbound,call_direction.is.null');
        
      logger.info('CALL_ATTEMPT_STARTED', { phone: hydratedCustomer.phone, attempt: attempt || 1 });

      await supabase
        .from('clients')
        .update({
          last_annual_reminder_at: new Date().toISOString(),
          last_annual_reminder_year: currentYear,
          next_annual_reminder_date: computeNextAnnualReminderDate(client.last_visit_date, new Date(Date.UTC(currentYear + 1, 0, 1))),
          updated_at: new Date().toISOString()
        })
        .eq('id', client.id);

      console.log(`[CLIENT REMINDER] Annual reminder call started for clientId=${client.id} (${call.sid})`);
    } catch (error) {
      console.error(`[CLIENT REMINDER ERROR] clientId=${client.id}: ${error.message}`);
    }
  }
}

async function runSchedulerTick() {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;
  try {
    await triggerAnnualClientReminderCalls();
    await triggerScheduledCalls();
  } finally {
    schedulerRunning = false;
  }
}

module.exports = {
  markSubmittedCallsWithoutMediaFailed,
  runOwnerDigestTick,
  triggerScheduledCalls,
  triggerAnnualClientReminderCalls,
  runSchedulerTick
};
