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
const { hourInCallTimezone } = require('./helpers');
const { resolvePatientId } = require('./patient-link');
const { buildIcallMateCallbackUrl } = require('./icallmate-webhook');
const { canContactPatient } = require('./contact-policy');
const { extractEventIdentity } = require('./call-events');

const ALLOW_IDLESS_CALL_MATCH = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_IDLESS_CALL_MATCH || 'false'));

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
    const existingById = await dbGet('SELECT * FROM customer_queue WHERE id = ?', [customerId]);
    if (existingById) {
      return existingById;
    }
  }

  const existingByPhone = await dbGet('SELECT * FROM customer_queue WHERE phone = ?', [customerPhone]);
  if (existingByPhone) {
    return existingByPhone;
  }

  const patientId = await resolvePatientId({ name: customerName || 'Customer', phone: customerPhone });
  const queueRowId = await ensureQueueRow(patientId, 'pending');
  return dbGet('SELECT * FROM customer_queue WHERE id = ?', [queueRowId]);
}

/**
 * The queue row an ad-hoc call hangs off, reused if one is already open.
 *
 * These two sites wanted "make sure a row exists", and got it from an upsert on
 * a unique patient_id. That uniqueness is gone -- a patient may now have
 * several scheduled calls -- so a plain insert here would add a row for every
 * inbound call. Matched on status so an open entry is reused and a finished one
 * is never resurrected.
 */
async function ensureQueueRow(patientId, status) {
  const existing = await dbGet(
    'SELECT id FROM customers WHERE patient_id = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [patientId, status]
  );
  if (existing) {
    await dbRun('UPDATE customers SET updated_at = now() WHERE id = ?', [existing.id]);
    return existing.id;
  }
  const result = await dbRun(
    'INSERT INTO customers (patient_id, status, created_at) VALUES (?, ?, ?)',
    [patientId, status, new Date().toISOString()]
  );
  return result.lastID;
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

/**
 * Nobody gets rung more than this in one day, however the call is requested.
 * Raised on UAT so testing is not blocked after three attempts; production
 * keeps the default, which is a limit on how often a donor may be disturbed.
 */
const MAX_CALLS_PER_DAY = Math.max(1, Number(process.env.MAX_CALLS_PER_DAY) || 3);

/**
 * Outbound calls placed to this number today, counted in India's day.
 *
 * current_date is UTC, so the counter reset at 05:30 IST rather than midnight:
 * calls made late in the evening counted against the following morning.
 */
async function countOutboundCallsToday(phone) {
  const rows = await dbAll(
    `SELECT c.id
       FROM calls c
       JOIN customer_queue cu ON cu.id = c.customer_id
      WHERE cu.phone = ?
        AND (c.called_at AT TIME ZONE 'Asia/Kolkata')::date
            = (now() AT TIME ZONE 'Asia/Kolkata')::date
        AND COALESCE(c.call_direction, 'outbound') = 'outbound'`,
    [phone]
  );
  return rows.length;
}

async function findCustomerByPhone(phoneValue) {
  const normalized = normalizePhoneLookupValue(phoneValue);
  if (!normalized) return null;

  // A patient may now have several queue entries, so "LIMIT 1" without an order
  // returned whichever one Postgres felt like. Newest wins, deterministically.
  const customer = await dbGet(
    'SELECT * FROM customer_queue WHERE normalized_phone = ? ORDER BY id DESC LIMIT 1',
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

  const incomingPatientId = await resolvePatientId({
    name: fallbackName || 'Incoming caller', phone: normalizedPhone
  });
  const incomingCustomerId = await ensureQueueRow(incomingPatientId, 'incoming');
  return dbGet('SELECT * FROM customer_queue WHERE id = ?', [incomingCustomerId]);
}

// ── Call Context & Intelligence ───────────────────────────────────────────────

/**
 * The call this incoming media stream belongs to, found from the number dialled.
 *
 * It used to pick a queue entry for the number and then look for a call on it.
 * That worked while a patient had exactly one entry; once they could have
 * several, the unordered LIMIT 1 chose an arbitrary one, the call lookup found
 * nothing, and hydration gave up. A hydration failure is silent and total: the
 * session stays "incoming", so the outbound script is never used and the call
 * is never marked completed or given a transcript.
 *
 * The call is now found first, and its own queue entry follows from it.
 */
async function findRecentOutboundCallContextByPhone(phoneValue) {
  const normalized = normalizePhoneLookupValue(phoneValue);
  if (!normalized) return null;

  const call = await dbGet(
    `SELECT calls.*, agents.client_name AS agent_client_name
       FROM calls
       JOIN customer_queue ON customer_queue.id = calls.customer_id
       LEFT JOIN agents ON agents.id = calls.agent_id
      WHERE customer_queue.normalized_phone = ?
        AND COALESCE(calls.call_direction, 'outbound') = 'outbound'
        AND calls.called_at >= (now() - interval '30 minutes')
      ORDER BY calls.called_at DESC, calls.id DESC
      LIMIT 1`,
    [normalized]
  );

  if (!call) {
    return null;
  }

  const customer = await dbGet('SELECT * FROM customer_queue WHERE id = ?', [call.customer_id]);
  if (!customer) {
    return null;
  }

  return { customer, call };
}

async function findOutboundCallContextByIdentity(identity = {}) {
  const clauses = [];
  const params = [];
  if (identity.attemptId && /^\d+$/.test(String(identity.attemptId))) {
    clauses.push('attempts.id = ?');
    params.push(identity.attemptId);
  } else if (identity.requestKey) {
    clauses.push('attempts.request_key = ?');
    params.push(identity.requestKey);
  } else if (identity.providerId) {
    clauses.push('LOWER(attempts.provider_call_id) = LOWER(?)');
    params.push(identity.providerId);
  } else {
    return null;
  }

  return dbGet(
    `SELECT calls.id AS call_id, calls.provider_call_id AS call_provider_call_id,
            calls.call_type AS call_type, calls.agent_id AS call_agent_id,
            attempts.id AS attempt_id, attempts.provider_call_id AS attempt_provider_call_id,
            agents.client_name AS agent_client_name, customer_queue.*
       FROM call_attempts attempts
       LEFT JOIN calls ON calls.attempt_id = attempts.id
       JOIN customer_queue ON customer_queue.id = attempts.customer_id
       LEFT JOIN agents ON agents.id = calls.agent_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY calls.id DESC NULLS LAST
      LIMIT 1`,
    params
  ).then((row) => row ? {
    customer: row,
    call: row.call_id ? {
      id: row.call_id,
      provider_call_id: row.call_provider_call_id,
      call_type: row.call_type,
      agent_id: row.call_agent_id,
      agent_client_name: row.agent_client_name
    } : null,
    attempt: { id: row.attempt_id, provider_call_id: row.attempt_provider_call_id }
  } : null);
}

async function hydrateIcallMateSessionContext(session, message = {}, extraParams = {}) {
  if (session.contextHydrated) {
    return;
  }

  // If hydration is already in progress, return the existing promise so callers can await it
  if (session._hydrationPromise) {
    return session._hydrationPromise;
  }

  const identity = extractEventIdentity({ ...message, ...extraParams });
  if (extraParams.callDirection) {
    session.callDirection = normalizeCallDirection(extraParams.callDirection, session.callDirection);
    if (extraParams.callType || extraParams.call_type) {
      session.callType = normalizeOutboundCallType(extraParams.callType || extraParams.call_type);
    }
    if (session.callDirection !== 'outbound') {
      session.contextHydrated = true;
      return;
    }
  }

  session.contextHydrating = true;
  session._hydrationPromise = (async () => {
    try {
      const context = session.callDirection === 'outbound'
        ? (identity.attemptId || identity.requestKey || identity.providerId
          ? await findOutboundCallContextByIdentity(identity)
          : (ALLOW_IDLESS_CALL_MATCH ? await findRecentOutboundCallContextByPhone(message.callerId || session.callerId) : null))
        : await findRecentOutboundCallContextByPhone(message.callerId || session.callerId);
      if (!context) {
        return;
      }

      session.contextHydrated = true;
      session.callDirection = 'outbound';
      session.customerName = context.customer.name || session.customerName || process.env.CUSTOMER_NAME || 'Customer';
      session.clientName = context.call?.agent_client_name || session.clientName || CLIENT_NAME;
      session.customerId = context.customer.id;
      session.callId = context.call?.id || null;
      session.attemptId = context.attempt?.id || null;
      session.providerCallId = context.call?.provider_call_id || context.attempt?.provider_call_id || '';
      session.callType = normalizeOutboundCallType(context.call?.call_type || context.customer.call_type);
      // The agent chosen when the call was placed. Its saved prompts, if it has
      // any, replace the built-in script.
      session.agentConfig = context.call?.agent_id
        ? await require('./prompt-builder').getAgentConfigById(context.call.agent_id)
        : null;
      // Read once per call rather than per turn: the prompt is rebuilt on every
      // turn and must not hit the database each time.
      session.callScripts = await require('./app-settings')
        .createSettingsStore({ dbGet, dbRun })
        .get('call_scripts')
        .catch(() => null);
      session.videoSent = context.customer.video_sent === 1;
      // Left empty when there is no recorded date, so the prompt says "haal hi
      // mein" rather than asserting "kal" to someone whose donation date the
      // system does not actually know.
      session.lastVisitDate = context.customer.last_visit_date || '';

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
            outstanding_issues = ?,
            last_sentiment_label = ?,
            pickup_rate_score = ?
      WHERE id = ?`,
    [
      intelligence.priorityScore,
      intelligence.priorityScore,
      intelligence.bestCallSlot,
      intelligence.outstandingIssues.join('\n') || null,
      intelligence.lastSentimentLabel || null,
      intelligence.pickupRateScore,
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
  const decision = canContactPatient(customer);
  if (!decision.allowed) {
    return { code: 'BLOCKED', reason: decision.reason === 'do_not_call'
      ? 'Customer is on DND / do-not-call'
      : decision.reason === 'wrong_number'
        ? 'Customer is flagged as wrong number'
        : 'Consent refused for this customer' };
  }

  if (customer.phone) {
    const activeCall = await dbGet(
      `SELECT 1 FROM customer_queue WHERE phone = ? AND status IN ('calling', 'in_progress') AND id != ? LIMIT 1`,
      [customer.phone, customer.id]
    );
    if (activeCall) {
      return { code: 'CALL_BLOCKED_ACTIVE_CALL', reason: 'Another call is currently active for this phone number' };
    }
    if (customer.is_manual !== 1) {
      const completedCall = await dbGet(
        `SELECT 1 FROM customer_queue WHERE phone = ? AND call_type = ? AND status = 'completed' AND id != ? LIMIT 1`,
        [customer.phone, customer.call_type, customer.id]
      );
      if (completedCall) {
        return {
          code: 'CALL_AUTO_SCHEDULE_BLOCKED_COMPLETED',
          reason: 'Completed call already exists'
        };
      }
    }

    const callsToday = await countOutboundCallsToday(customer.phone);

    if (callsToday >= MAX_CALLS_PER_DAY) {
      return {
        code: 'CALL_FAILED_MAX_ATTEMPTS',
        reason: `Already called ${callsToday} times today. The daily limit is ${MAX_CALLS_PER_DAY}.`
      };
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

  // Read in the patients' timezone, not the server's. The container runs UTC,
  // so this rule used to block calls until 12:30 IST and permit them until
  // 2:30 in the morning -- the opposite of what it says.
  const hours = hourInCallTimezone();
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
          transcript_status, analysis_status, provider_payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          providerPayload
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
  MAX_CALLS_PER_DAY,
  countOutboundCallsToday,
  placeRealtimeCall,
  computeNextAnnualReminderDate,
  ensureCustomerForCall,
  claimCustomerForOutboundCall,
  releaseCustomerOutboundClaim,
  findCustomerByPhone,
  ensureIncomingCustomerForCall,
  findRecentOutboundCallContextByPhone,
  findOutboundCallContextByIdentity,
  hydrateIcallMateSessionContext,
  getCustomerCallHistory,
  hydratePreCallIntelligence,
  shouldBlockCustomerCall,
  upsertIncomingCallFromIcall,
  upsertIcallMateCallFromMedia,
  getScriptedCopy
};
