/**
 * src/call-management.js
 * Call and customer CRUD, state hydration, and pre-call intelligence.
 */

'use strict';

const { dbGet, dbRun, dbAll } = require('../db');
const crypto = require('crypto');
const { initiateCall } = require('../services/icallmate');
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
    const existingById = await dbGet('SELECT * FROM customers WHERE id = ?', [customerId]);
    if (existingById) {
      return existingById;
    }
  }

  const existingByPhone = await dbGet('SELECT * FROM customers WHERE phone = ?', [customerPhone]);
  if (existingByPhone) {
    return existingByPhone;
  }

  const result = await dbRun(
    `INSERT INTO customers (name, phone, normalized_phone, preferred_slot, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (normalized_phone) WHERE normalized_phone IS NOT NULL
     DO UPDATE SET name = excluded.name`,
    [
      customerName || 'Customer',
      customerPhone,
      normalizePhoneLookupValue(customerPhone),
      '10:00',
      'pending',
      new Date().toISOString()
    ]
  );

  return dbGet('SELECT * FROM customers WHERE id = ?', [result.lastID]);
}

async function claimCustomerForOutboundCall(customerId) {
  const result = await dbRun(
    `UPDATE customers
        SET status = ?,
            last_called_at = ?
      WHERE id = ?
        AND COALESCE(status, 'pending') != 'calling'`,
    ['calling', new Date().toISOString(), customerId]
  );

  return result.changes > 0;
}

async function releaseCustomerOutboundClaim(customerId, fallbackStatus = 'pending') {
  await dbRun(
    `UPDATE customers
        SET status = ?
      WHERE id = ?
        AND status = 'calling'`,
    [fallbackStatus, customerId]
  );
}

async function ensureCustomerForClientReminder(client) {
  let customer = null;

  if (client.linked_customer_id) {
    customer = await dbGet('SELECT * FROM customers WHERE id = ?', [client.linked_customer_id]);
  }

  if (!customer) {
    customer = await dbGet('SELECT * FROM customers WHERE phone = ?', [client.phone]);
  }

  if (customer) {
    await dbRun(
      `UPDATE customers
          SET name = ?,
              phone = ?,
              preferred_slot = ?,
              service_interest = ?,
              status = CASE WHEN status = 'completed' THEN 'pending' ELSE status END
        WHERE id = ?`,
      [
        client.name,
        client.phone,
        client.annual_reminder_slot || '10:00',
        client.treatment_type || null,
        customer.id
      ]
    );
    await dbRun(
      'UPDATE clients SET linked_customer_id = ?, updated_at = ? WHERE id = ?',
      [customer.id, new Date().toISOString(), client.id]
    );
    return dbGet('SELECT * FROM customers WHERE id = ?', [customer.id]);
  }

  const result = await dbRun(
    `INSERT INTO customers (
      name, phone, normalized_phone, preferred_slot, status, created_at, service_interest
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (normalized_phone) WHERE normalized_phone IS NOT NULL
     DO UPDATE SET name = excluded.name`,
    [
      client.name,
      client.phone,
      normalizePhoneLookupValue(client.phone),
      client.annual_reminder_slot || '10:00',
      'pending',
      new Date().toISOString(),
      client.treatment_type || null
    ]
  );

  await dbRun(
    'UPDATE clients SET linked_customer_id = ?, updated_at = ? WHERE id = ?',
    [result.lastID, new Date().toISOString(), client.id]
  );

  return dbGet('SELECT * FROM customers WHERE id = ?', [result.lastID]);
}

async function findCustomerByPhone(phoneValue) {
  const normalized = normalizePhoneLookupValue(phoneValue);
  if (!normalized) return null;

  const customer = await dbGet(
    'SELECT * FROM customers WHERE normalized_phone = ? LIMIT 1',
    [normalized]
  );
  return customer || null;
}

async function ensureIncomingCustomerForCall(phoneValue, fallbackName = 'Incoming caller') {
  const normalizedPhone = String(phoneValue || '').trim() || `incoming-${Date.now()}`;
  const existing = await findCustomerByPhone(normalizedPhone);
  if (existing) {
    return existing;
  }

  const result = await dbRun(
    `INSERT INTO customers (name, phone, normalized_phone, preferred_slot, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (normalized_phone) WHERE normalized_phone IS NOT NULL
     DO UPDATE SET name = excluded.name`,
    [
      fallbackName || 'Incoming caller',
      normalizedPhone,
      normalizePhoneLookupValue(normalizedPhone),
      getCurrentSlotLabel(new Date()),
      'incoming',
      new Date().toISOString()
    ]
  );

  return dbGet('SELECT * FROM customers WHERE id = ?', [result.lastID]);
}

// ── Call Context & Intelligence ───────────────────────────────────────────────

async function findRecentOutboundCallContextByPhone(phoneValue) {
  const customer = await findCustomerByPhone(phoneValue);
  if (!customer) {
    return null;
  }

  const call = await dbGet(
    `SELECT calls.*, agents.client_name AS agent_client_name
       FROM calls
       LEFT JOIN agents ON agents.id = calls.agent_id
      WHERE calls.customer_id = ?
        AND COALESCE(calls.call_direction, 'outbound') = 'outbound'
        AND calls.called_at >= (now() - interval '30 minutes')
      ORDER BY calls.id DESC
      LIMIT 1`,
    [customer.id]
  );

  if (!call) {
    return null;
  }

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

      console.log(
        `[ICALLMATE] Hydrated outbound context streamId=${message.streamId || session.streamId || ''} ` +
        `phone=${message.callerId || session.callerId || ''} customerId=${session.customerId} ` +
        `callId=${session.callId} callType=${session.callType}`
      );
    } finally {
      session.contextHydrating = false;
    }
  })();

  return session._hydrationPromise;
}

async function getCustomerCallHistory(customerId, limit = 20) {
  if (!customerId) return [];
  return dbAll(
    `SELECT called_at, outcome, sentiment_label, transcript_text, analysis_summary, extracted_review_text
     FROM calls
     WHERE customer_id = ?
     ORDER BY called_at DESC
     LIMIT ?`,
    [customerId, limit]
  );
}

async function hydratePreCallIntelligence(customer) {
  const history = await getCustomerCallHistory(customer.id);
  const intelligence = buildPreCallIntelligence(customer, history);

  await dbRun(
    `UPDATE customers
        SET priority_score = ?,
            ai_score = ?,
            best_call_slot = ?,
            preferred_dialect = ?,
            outstanding_issues = ?,
            last_sentiment_label = ?,
            pickup_rate_score = ?,
            dnd_checked_at = ?
      WHERE id = ?`,
    [
      intelligence.priorityScore,
      intelligence.priorityScore,
      intelligence.bestCallSlot,
      intelligence.preferredDialect,
      intelligence.outstandingIssues.join('\n') || null,
      intelligence.lastSentimentLabel || null,
      intelligence.pickupRateScore,
      new Date().toISOString(),
      customer.id
    ]
  );

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
    const activeCall = await dbGet(
      `SELECT 1 FROM customers WHERE phone = ? AND status IN ('calling', 'in_progress') AND id != ? LIMIT 1`,
      [customer.phone, customer.id]
    );
    if (activeCall) {
      return { code: 'CALL_BLOCKED_ACTIVE_CALL', reason: 'Another call is currently active for this phone number' };
    }
    if (customer.is_manual !== 1) {
      const completedCall = await dbGet(
        `SELECT 1 FROM customers WHERE phone = ? AND call_type = ? AND status = 'completed' AND id != ? LIMIT 1`,
        [customer.phone, customer.call_type, customer.id]
      );
      if (completedCall) {
        return {
          code: 'CALL_AUTO_SCHEDULE_BLOCKED_COMPLETED',
          reason: 'Completed call already exists'
        };
      }
    }

    const callsToday = await dbAll(
      `SELECT called_at 
       FROM calls c
       JOIN customers cu ON cu.id = c.customer_id
       WHERE cu.phone = ? 
         AND DATE(c.called_at, 'localtime') = DATE('now', 'localtime')
         AND COALESCE(c.call_direction, 'outbound') = 'outbound'
       ORDER BY c.called_at DESC`,
      [customer.phone]
    );

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
    const existingCall = await dbGet('SELECT * FROM calls WHERE provider_call_id = ?', [row.stream_id]);
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
      await dbRun(
        `UPDATE calls
            SET customer_id = ?,
                outcome = ?,
                did = ?,
                answered_at = COALESCE(?, answered_at),
                ended_at = COALESCE(?, ended_at),
                media_packets = COALESCE(media_packets, 0) + ?,
                last_event = ?,
                notes = ?,
                provider_payload_json = ?,
                call_direction = ?,
                call_source = ?,
                called_at = COALESCE(called_at, ?)
          WHERE id = ?`,
        [
          customer.id,
          outcome,
          row.did || null,
          row.answered_at,
          row.ended_at,
          Number(patch.media_packets || 0),
          row.last_event || null,
          row.notes || null,
          providerPayload,
          row.call_direction || 'incoming',
          'icallmate',
          row.received_at,
          existingCall.id
        ]
      );
    } else {
      await dbRun(
        `INSERT INTO calls (
          customer_id, outcome, provider_call_id, called_at, call_direction, call_source,
          did, answered_at, ended_at, media_packets, last_event, notes,
          transcript_status, analysis_status, provider_payload_json, uuid
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer.id,
          outcome,
          row.stream_id,
          row.received_at,
          row.call_direction || 'incoming',
          'icallmate',
          row.did || null,
          row.answered_at,
          row.ended_at,
          Number(row.media_packets || 0),
          row.last_event || null,
          row.notes || null,
          'live_stream',
          'pending',
          providerPayload,
          crypto.randomUUID()
        ]
      );
    }
  } catch (error) {
    console.error('[ICALLMATE INCOMING DB ERROR]', error.message);
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

  await dbRun(
    `UPDATE calls
        SET outcome = CASE
              WHEN ? = 'completed' THEN 'completed'
              WHEN ? = 'active' AND (outcome IN ('initiated', 'scheduled_initiated') OR last_event = 'media_timeout') THEN 'active'
              ELSE outcome
            END,
            did = COALESCE(?, did),
            answered_at = COALESCE(?, answered_at),
            ended_at = COALESCE(?, ended_at),
            media_packets = COALESCE(media_packets, 0) + ?,
            last_event = ?,
            notes = ?,
            provider_payload_json = ?
      WHERE id = ?`,
    [
      patch.status || null,
      patch.status || null,
      message.did || session.did || null,
      patch.answered_at || null,
      patch.ended_at || null,
      Number(patch.media_packets || 0),
      eventName || null,
      patch.notes || null,
      providerPayload,
      session.callId
    ]
  );

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
