/**
 * src/call-management.js
 * Call and customer CRUD, state hydration, and pre-call intelligence.
 */

'use strict';

const supabase = require('./supabase');
const crypto = require('crypto');
const { initiateCall } = require('../services/icallmate');
const logger = require('./logger');
const {
  buildPreCallIntelligence,
  getCurrentSlotLabel
} = require('../services/call-orchestration');
const {
  CLIENT_NAME,
  PUBLIC_BASE_URL,
  incomingCallState,
  INCOMING_CALL_RETENTION_MS,
  MIN_RETRY_GAP_MINUTES
} = require('./config');
const {
  toWssUrl,
  normalizeOutboundCallType,
  normalizePhoneLookupValue,
  normalizeCallDirection,
  getIncomingCallKey,
  normalizeIcallTimestamp
} = require('./helpers');
const { buildIcallMateCallbackUrl } = require('./icallmate-webhook');

// ── Call Initiation ────────────────────────────────────────────────────────────

async function placeRealtimeCall({ customerPhone, customerName, customerId, clientName, agentId, callType }) {
  return initiateCall(customerPhone, customerId, {
    baseUrl: PUBLIC_BASE_URL,
    customerName,
    clientName,
    agentId,
    callType: normalizeOutboundCallType(callType),
    wsurl: toWssUrl(PUBLIC_BASE_URL, '/icallmate/media'),
    callbackapi: buildIcallMateCallbackUrl(PUBLIC_BASE_URL)
  });
}

// ── Customer Management ────────────────────────────────────────────────────────

function computeNextAnnualReminderDate(lastVisitDate, referenceDate = new Date()) {
  const parts = String(lastVisitDate || '').split('-').map((value) => Number(value));
  const [, month, day] = parts;
  if (!month || !day) {
    return null;
  }

  const formatDateOnly = (date) => date.toISOString().slice(0, 10);
  const buildAnniversaryDate = (year) => {
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const normalizedDay = Math.min(day, lastDayOfMonth);
    return new Date(Date.UTC(year, month - 1, normalizedDay));
  };

  const currentYear = referenceDate.getUTCFullYear();
  const today = formatDateOnly(referenceDate);
  let candidate = formatDateOnly(buildAnniversaryDate(currentYear));
  if (candidate < today) {
    candidate = formatDateOnly(buildAnniversaryDate(currentYear + 1));
  }

  return candidate;
}

async function ensureCustomerForCall({ customerId, customerName, customerPhone }) {
  if (customerId) {
    const { data: existingById } = await supabase.from('customers').select('*').eq('id', customerId).single();
    if (existingById) {
      return existingById;
    }
  }

  const { data: existingByPhone } = await supabase.from('customers').select('*').eq('phone', customerPhone).single();
  if (existingByPhone) {
    return existingByPhone;
  }

  const { data: result, error } = await supabase.from('customers').insert([{
    name: customerName || 'Customer',
    phone: customerPhone,
    preferred_slot: '10:00',
    status: 'pending',
    created_at: new Date().toISOString()
  }]).select('*').single();

  if (error) {
    logger.error('CUSTOMER_CREATE_FAILED', { error, customerPhone });
    // If unique constraint violated, return existing
    const { data: retry } = await supabase.from('customers').select('*').eq('phone', customerPhone).single();
    if (retry) return retry;
  }
  return result;
}

async function claimCustomerForOutboundCall(customerId) {
  const { data: updated, error } = await supabase
    .from('customers')
    .update({
      status: 'calling',
      last_called_at: new Date().toISOString()
    })
    .eq('id', customerId)
    .neq('status', 'calling')
    .select('id');

  if (error) {
    logger.error('CUSTOMER_UPDATE_FAILED', { error, customerId, action: 'claim_for_call' });
    return false;
  }

  return updated && updated.length > 0;
}

async function releaseCustomerOutboundClaim(customerId, fallbackStatus = 'pending') {
  await supabase
    .from('customers')
    .update({ status: fallbackStatus })
    .eq('id', customerId)
    .eq('status', 'calling');
}

async function ensureCustomerForClientReminder(client) {
  let customer = null;

  if (client.linked_customer_id) {
    const { data: c1 } = await supabase.from('customers').select('*').eq('id', client.linked_customer_id).single();
    customer = c1;
  }

  if (!customer) {
    const { data: c2 } = await supabase.from('customers').select('*').eq('phone', client.phone).single();
    customer = c2;
  }

  if (customer) {
    await supabase.from('customers').update({
      name: client.name,
      phone: client.phone,
      preferred_slot: client.annual_reminder_slot || '10:00',
      service_interest: client.treatment_type || null,
      status: customer.status === 'completed' ? 'pending' : customer.status
    }).eq('id', customer.id);

    await supabase.from('clients').update({
      linked_customer_id: customer.id,
      updated_at: new Date().toISOString()
    }).eq('id', client.id);

    const { data: finalC } = await supabase.from('customers').select('*').eq('id', customer.id).single();
    return finalC;
  }

  const { data: newCustomer } = await supabase.from('customers').insert([{
    name: client.name,
    phone: client.phone,
    preferred_slot: client.annual_reminder_slot || '10:00',
    status: 'pending',
    created_at: new Date().toISOString(),
    service_interest: client.treatment_type || null
  }]).select('*').single();

  await supabase.from('clients').update({
    linked_customer_id: newCustomer.id,
    updated_at: new Date().toISOString()
  }).eq('id', client.id);

  return newCustomer;
}

async function findCustomerByPhone(phoneValue) {
  const normalized = normalizePhoneLookupValue(phoneValue);
  if (!normalized) return null;

  const { data: customers } = await supabase
    .from('customers')
    .select('*')
    .order('id', { ascending: false })
    .limit(200);
    
  return (customers || []).find((customer) => normalizePhoneLookupValue(customer.phone) === normalized) || null;
}

async function ensureIncomingCustomerForCall(phoneValue, fallbackName = 'Incoming caller') {
  const normalizedPhone = String(phoneValue || '').trim() || `incoming-${Date.now()}`;
  const existing = await findCustomerByPhone(normalizedPhone);
  if (existing) {
    return existing;
  }

  const { data: result } = await supabase.from('customers').insert([{
    name: fallbackName || 'Incoming caller',
    phone: normalizedPhone,
    preferred_slot: getCurrentSlotLabel(new Date()),
    status: 'incoming',
    created_at: new Date().toISOString()
  }]).select('*').single();

  return result;
}

// ── Call Context & Intelligence ───────────────────────────────────────────────

async function findRecentOutboundCallContextByPhone(phoneValue) {
  const customer = await findCustomerByPhone(phoneValue);
  if (!customer) {
    return null;
  }

  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  
  const { data: calls } = await supabase
    .from('calls')
    .select('*, agents(client_name)')
    .eq('customer_id', customer.id)
    .or('call_direction.eq.outbound,call_direction.is.null')
    .gte('called_at', thirtyMinsAgo)
    .order('id', { ascending: false })
    .limit(1);

  const call = calls && calls.length > 0 ? calls[0] : null;
  if (!call) {
    return null;
  }

  call.agent_client_name = call.agents?.client_name;
  return { customer, call };
}

async function hydrateIcallMateSessionContext(session, message = {}, extraParams = {}) {
  if (session.contextHydrated) {
    return;
  }

  // If hydration is already in progress, return the existing promise so callers can await it
  if (session._hydrationPromise) {
    return session._hydrationPromise;
  }

  if (extraParams.callDirection) {
    session.callDirection = normalizeCallDirection(extraParams.callDirection, session.callDirection);
    if (extraParams.callType || extraParams.call_type) {
      session.callType = normalizeOutboundCallType(extraParams.callType || extraParams.call_type);
    }
    session.contextHydrated = true;
    return;
  }

  session.contextHydrating = true;
  session._hydrationPromise = (async () => {
    try {
      const context = await findRecentOutboundCallContextByPhone(message.callerId || session.callerId);
      if (!context) {
        return;
      }

      session.contextHydrated = true;
      session.callDirection = 'outbound';
      session.customerName = context.customer.name || session.customerName || process.env.CUSTOMER_NAME || 'Customer';
      session.clientName = context.call.agent_client_name || session.clientName || CLIENT_NAME;
      session.customerId = context.customer.id;
      session.callId = context.call.id;
      session.providerCallId = context.call.provider_call_id || '';
      session.callType = normalizeOutboundCallType(context.call.call_type || context.customer.call_type);
      session.videoSent = context.customer.video_sent === 1;
      session.lastVisitDate = context.customer.last_visit_date || 'kal';

      logger.debug('CALL_HYDRATED', {
        streamId: message.streamId || session.streamId || '',
        phone: message.callerId || session.callerId || '',
        customerId: session.customerId,
        callId: session.callId,
        callType: session.callType
      });
    } finally {
      session.contextHydrating = false;
    }
  })();

  return session._hydrationPromise;
}

async function getCustomerCallHistory(customerId, limit = 20) {
  if (!customerId) return [];
  const { data: calls } = await supabase
    .from('calls')
    .select('called_at, outcome, sentiment_label, transcript_text, analysis_summary, extracted_review_text')
    .eq('customer_id', customerId)
    .order('called_at', { ascending: false })
    .limit(limit);
    
  return calls || [];
}

async function hydratePreCallIntelligence(customer) {
  const history = await getCustomerCallHistory(customer.id);
  const intelligence = buildPreCallIntelligence(customer, history);

  await supabase.from('customers').update({
    priority_score: intelligence.priorityScore,
    ai_score: intelligence.priorityScore,
    best_call_slot: intelligence.bestCallSlot,
    preferred_dialect: intelligence.preferredDialect,
    outstanding_issues: intelligence.outstandingIssues.join('\n') || null,
    last_sentiment_label: intelligence.lastSentimentLabel || null,
    pickup_rate_score: intelligence.pickupRateScore,
    dnd_checked_at: new Date().toISOString()
  }).eq('id', customer.id);

  return {
    ...customer,
    priority_score: intelligence.priorityScore,
    ai_score: intelligence.priorityScore,
    best_call_slot: intelligence.bestCallSlot,
    preferred_dialect: intelligence.preferredDialect,
    outstanding_issues: intelligence.outstandingIssues.join('\n'),
    pickup_rate_score: intelligence.pickupRateScore
  };
}

async function shouldBlockCustomerCall(customer) {
  if (customer.do_not_call) {
    return { code: 'BLOCKED', reason: 'Customer is on DND / do-not-call' };
  }

  if (customer.wrong_number_flag) {
    return { code: 'BLOCKED', reason: 'Customer is flagged as wrong number' };
  }

  if (String(customer.consent_status || '').toLowerCase() === 'denied') {
    return { code: 'BLOCKED', reason: 'Consent denied for this customer' };
  }

  if (customer.phone) {
    const { data: activeCall } = await supabase
      .from('customers')
      .select('id')
      .eq('phone', customer.phone)
      .in('status', ['calling', 'in_progress'])
      .neq('id', customer.id)
      .limit(1)
      .single();

    if (activeCall) {
      return { code: 'CALL_BLOCKED_ACTIVE_CALL', reason: 'Another call is currently active for this phone number' };
    }
    if (customer.is_manual !== 1) {
      const { data: completedCall } = await supabase
        .from('customers')
        .select('id')
        .eq('phone', customer.phone)
        .eq('call_type', customer.call_type)
        .eq('status', 'completed')
        .neq('id', customer.id)
        .limit(1)
        .single();
        
      if (completedCall) {
        return {
          code: 'CALL_AUTO_SCHEDULE_BLOCKED_COMPLETED',
          reason: 'Completed call already exists'
        };
      }
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: callsToday } = await supabase
      .from('calls')
      .select('called_at, customers!inner(phone)')
      .eq('customers.phone', customer.phone)
      .gte('called_at', todayStart.toISOString())
      .or('call_direction.eq.outbound,call_direction.is.null')
      .order('called_at', { ascending: false });

    if (callsToday && callsToday.length >= 3) {
      return { code: 'CALL_FAILED_MAX_ATTEMPTS', reason: 'Maximum 3 attempts completed for the day' };
    }

    if (callsToday && callsToday.length > 0) {
      const lastCallTime = new Date(callsToday[0].called_at);
      const diffMs = Date.now() - lastCallTime.getTime();
      const gapMs = MIN_RETRY_GAP_MINUTES * 60 * 1000;
      if (diffMs < gapMs) {
        if (customer.is_manual === 1 && customer.status === 'scheduled') {
          // Bypass 3 hour gap because user manually scheduled it
        } else {
          const nextAllowedAt = new Date(lastCallTime.getTime() + gapMs);
          return {
            code: 'CALL_BLOCKED_THREE_HOUR_GAP',
            reason: `Cooldown gap required between attempts`,
            lastAttemptAt: lastCallTime.toISOString(),
            nextAllowedAt: nextAllowedAt.toISOString()
          };
        }
      }
    }
  }

  const now = new Date();
  const hours = now.getHours();
  if (hours < 7 || hours >= 21) {
    return { code: 'CALL_SKIPPED_QUIET_HOURS', reason: 'Calls can only be scheduled between 7:00 AM and 9:00 PM' };
  }

  return null;
}

// ── Call Upserts ──────────────────────────────────────────────────────────────

async function upsertIncomingCallFromIcall(message = {}, patch = {}) {
  const key = getIncomingCallKey(message);
  const existing = incomingCallState.get(key) || {};
  const eventName = String(message.event || patch.event || '').toLowerCase();
  const nowIso = new Date().toISOString();
  const status = patch.status || (
    eventName === 'hangup-call' ? 'missed' : 'active'
  );

  const row = {
    id: key,
    stream_id: message.streamId || existing.stream_id || key,
    caller_name: patch.caller_name || existing.caller_name || 'Incoming caller',
    phone: message.callerId || existing.phone || '--',
    did: message.did || existing.did || '',
    call_direction: patch.call_direction || message.callDirection || existing.call_direction || 'incoming',
    status,
    received_at: existing.received_at || normalizeIcallTimestamp(message.timestamp),
    updated_at: nowIso,
    notes: patch.notes || existing.notes || 'iCallMate incoming call',
    last_event: eventName || existing.last_event || '',
    answered_at: patch.answered_at || existing.answered_at || null,
    ended_at: patch.ended_at || existing.ended_at || null,
    media_packets: Number(existing.media_packets || 0) + Number(patch.media_packets || 0),
    reverse_media_queue: Number(message.RevMediaQ || existing.reverse_media_queue || 0),
    botid: message.botid || existing.botid || '',
    userrefno: message.userrefno || existing.userrefno || '',
    sysrefno: message.sysrefno || existing.sysrefno || '',
    extra_params: message.extraParams || existing.extra_params || ''
  };

  incomingCallState.set(key, row);

  try {
    const customer = await ensureIncomingCustomerForCall(row.phone, row.caller_name);
    const { data: existingCall } = await supabase.from('calls').select('*').eq('provider_call_id', row.stream_id).single();
    const outcome = row.status === 'active' ? 'active' : row.status;
    const providerPayload = JSON.stringify({
      event: eventName,
      streamId: row.stream_id,
      callerId: row.phone,
      did: row.did,
      ChKey: message.ChKey || null,
      botid: row.botid || null,
      userrefno: row.userrefno || null,
      sysrefno: row.sysrefno || null,
      extraParams: row.extra_params || null
    });

    if (existingCall) {
      await supabase.from('calls').update({
        customer_id: customer.id,
        outcome: outcome,
        did: row.did || null,
        answered_at: row.answered_at || existingCall.answered_at,
        ended_at: row.ended_at || existingCall.ended_at,
        media_packets: (existingCall.media_packets || 0) + Number(patch.media_packets || 0),
        last_event: row.last_event || null,
        notes: row.notes || null,
        provider_payload_json: providerPayload,
        call_direction: row.call_direction || 'incoming',
        call_source: 'icallmate',
        called_at: existingCall.called_at || row.received_at
      }).eq('id', existingCall.id);
    } else {
      await supabase.from('calls').insert([{
        customer_id: customer.id,
        outcome: outcome,
        provider_call_id: row.stream_id,
        called_at: row.received_at,
        call_direction: row.call_direction || 'incoming',
        call_source: 'icallmate',
        did: row.did || null,
        answered_at: row.answered_at,
        ended_at: row.ended_at,
        media_packets: Number(row.media_packets || 0),
        last_event: row.last_event || null,
        notes: row.notes || null,
        transcript_status: 'live_stream',
        analysis_status: 'pending',
        provider_payload_json: providerPayload,
        uuid: crypto.randomUUID()
      }]);
    }
  } catch (error) {
    logger.error('DB_UPSERT_FAILED', { error, table: 'customers', action: 'upsertIncomingCall' });
  }

  return row;
}

async function upsertIcallMateCallFromMedia(message = {}, session = {}, patch = {}) {
  if (normalizeCallDirection(session.callDirection) !== 'outbound') {
    return upsertIncomingCallFromIcall(message, patch);
  }

  if (!session.callId) {
    return null;
  }

  const eventName = String(message.event || patch.event || '').toLowerCase();
  const providerPayload = JSON.stringify({
    streamId: message.streamId || session.streamId || null,
    callerId: message.callerId || session.callerId || null,
    did: message.did || session.did || null,
    event: eventName || null,
    ChKey: message.ChKey || null
  });

  const { data: call } = await supabase.from('calls').select('outcome, media_packets').eq('id', session.callId).single();
  if (call) {
    let newOutcome = call.outcome;
    const patchStatus = patch.status || null;
    if (patchStatus === 'completed') {
      newOutcome = 'completed';
    } else if (patchStatus === 'active' && (['initiated', 'scheduled_initiated'].includes(call.outcome) || eventName === 'media_timeout')) {
      newOutcome = 'active';
    }

    await supabase.from('calls').update({
      outcome: newOutcome,
      did: message.did || session.did || null,
      answered_at: patch.answered_at || null,
      ended_at: patch.ended_at || null,
      media_packets: (call.media_packets || 0) + Number(patch.media_packets || 0),
      last_event: eventName || null,
      notes: patch.notes || null,
      provider_payload_json: providerPayload
    }).eq('id', session.callId);
  }

  return null;
}

// ── Scripted IVR Copy ──────────────────────────────────────────────────────────

function getScriptedCopy(language, customerName = process.env.CUSTOMER_NAME, clientName = CLIENT_NAME) {
  if (language === 'en') {
    return {
      intro: `Hello, am I speaking with ${customerName}? This is Priya calling from Apna Blood Centre, Palwal. To continue in English, say English or press 2. Hindi mein baat karne ke liye Hindi boliye ya 1 dabaiye.`,
      noLanguageResponse: 'We did not receive your language preference. Thank you for your time. Goodbye.',
      consent: `Thank you. You donated blood some time ago. It has been around 3 months since your donation. Would you like to donate blood again? Please say yes or press 1 if you are interested.`,
      decline: 'No problem. Thank you for your time. Goodbye.',
      noConsentResponse: 'We did not receive a response. Thank you for your time. Goodbye.',
      rating: 'Thank you. You can visit Apna Blood Centre, Palwal any day between 9 AM and 5 PM after having food. Did you face any problem after your previous blood donation? Please say yes or no.',
      noRatingResponse: 'We did not receive a response. Thank you for your time. Goodbye.',
      closing: 'Thank you. Your donation can help thalassemia patients, pregnant women, and children in need. Have a good day.'
    };
  }

  return {
    intro: `Namaste. Kya main ${customerName} se baat kar rahi hoon? Main Priya bol rahi hoon, Apna Blood Centre, Palwal se. Hindi mein baat karne ke liye haan boliye ya 1 dabaiye.`,
    noLanguageResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    consent: `Dhanyavaad. Aapne kuch time pehle blood donate kiya tha. Aapke blood donation ko lagbhag 3 months ho gaye hain. Kya aap phir se blood donate karna chahenge?`,
    decline: 'Koi baat nahin. Aapke samay ke liye dhanyavaad. Namaste.',
    noConsentResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    rating: 'Bahut dhanyavaad. Aap kisi bhi din khana khaane ke baad 9 AM se 5 PM ke beech Apna Blood Centre, Palwal aa sakte hain. Blood donate karne ke baad aapko koi problem ya dikkat hui thi?',
    noRatingResponse: 'Humein aapka jawab nahin mila. Dhanyavaad. Namaste.',
    closing: 'Dhanyavaad. Aapka donation thalassemia patients, garbhwati mahilaon, aur zaruratmand bachchon ki madad kar sakta hai. Aapka din shubh ho.'
  };
}

module.exports = {
  placeRealtimeCall,
  computeNextAnnualReminderDate,
  ensureCustomerForCall,
  claimCustomerForOutboundCall,
  releaseCustomerOutboundClaim,
  ensureCustomerForClientReminder,
  findCustomerByPhone,
  ensureIncomingCustomerForCall,
  findRecentOutboundCallContextByPhone,
  hydrateIcallMateSessionContext,
  getCustomerCallHistory,
  hydratePreCallIntelligence,
  shouldBlockCustomerCall,
  upsertIncomingCallFromIcall,
  upsertIcallMateCallFromMedia,
  getScriptedCopy
};
