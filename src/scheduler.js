/**
 * src/scheduler.js
 * Scheduler for automated outbound calls and owner daily digest.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { dbGet, dbRun, dbAll } = require('../db');
const { CLIENT_NAME, CALL_TYPES } = require('./config');
const { createSettingsStore } = require('./app-settings');
const { selectPatientsToQueue } = require('./queue-rules');
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
  const staleCalls = await dbAll(
    `SELECT calls.id AS call_id,
            calls.customer_id,
            calls.provider_call_id,
            calls.called_at,
            calls.call_type,
            customer_queue.name,
            customer_queue.phone,
            customer_queue.status AS customer_status,
            COALESCE(customer_queue.auto_retry_enabled, 1) AS auto_retry_enabled,
            COALESCE(customer_queue.attempt_count, 0) AS attempt_count,
            EXISTS (
              SELECT 1
                FROM calls newer_call
               WHERE newer_call.customer_id = calls.customer_id
                 AND newer_call.called_at > calls.called_at
            ) AS has_newer_call
       FROM calls
       LEFT JOIN customer_queue ON customer_queue.id = calls.customer_id
      WHERE calls.call_direction = 'outbound'
        AND calls.outcome IN ('initiated', 'scheduled_initiated')
        AND COALESCE(calls.media_packets, 0) = 0
        AND calls.called_at <= ?
      ORDER BY calls.called_at ASC`,
    [cutoffIso]
  );

  for (const call of staleCalls) {
    const failResult = await dbRun(
      `UPDATE calls
          SET outcome = ?,
              outcome_detail = ?,
              ended_at = COALESCE(ended_at, ?),
              last_event = ?,
              notes = ?
        WHERE id = ?
          AND outcome IN ('initiated', 'scheduled_initiated')
          AND COALESCE(media_packets, 0) = 0`,
      [
        'failed',
        `Connection timeout after ${timeoutLabel} (User may not have answered or is out of network)`,
        nowIso,
        'media_timeout',
        'Provider accepted request, but no media stream was received. Assume no-answer or network issue.',
        call.call_id
      ]
    );

    if (!failResult.changes) {
      continue;
    }

    // Finalize every stale attempt, but let only the newest one alter customer retry state.
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

    await dbRun(
      `UPDATE customers
          SET status = ?,
              next_retry_at = ?,
              last_contact_outcome = 'failed',
              retry_count = COALESCE(retry_count, 0) + 1,
              attempt_count = COALESCE(attempt_count, 0) + 1
        WHERE id = ?
          AND status IN ('calling', 'called')`,
      [nextStatus, nextRetryAt, call.customer_id]
    );

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

/**
 * Builds the digest body. Separated from sending so the settings screen can
 * show exactly what would go out, and so it is testable without SMTP.
 *
 * Contains patient names and outcomes by explicit decision -- see the phase 2
 * plan. This is the only path in the system that sends identifiable patient
 * data in the clear, so recipients are an allow-list held in the database
 * rather than anything supplied at send time.
 */
/**
 * Donors who said on a call that they intend to come in.
 *
 * The centre has no appointment system, so this list is the only thing that
 * tells anyone to expect them. Yesterday's calls, because the digest goes out
 * each morning and a visit named on a call is usually days away.
 */
async function buildExpectedVisitors() {
  return dbAll(
    `SELECT p.first_name, p.last_name, c.intended_visit_note, c.redonation_note, cl.called_at
       FROM calls cl
       JOIN customers c ON c.id = cl.customer_id
       JOIN patients p ON p.id = c.patient_id
      WHERE cl.redonation_interest = 'yes'
        AND cl.called_at >= now() - interval '1 day'
      ORDER BY cl.called_at DESC
      LIMIT 50`
  ).catch(() => []);
}

function formatExpectedVisitors(rows) {
  if (!rows.length) return 'Donors expecting to visit: none recorded in the last day';

  const lines = rows.map((row) => {
    const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed patient';
    // The donor's own words. They say "agle mahine ki 5 tareekh", not a date.
    const when = String(row.intended_visit_note || row.redonation_note || '').trim();
    return `- ${name}: ${when || 'said yes but gave no time'}`;
  });

  return [
    `Donors expecting to visit (${rows.length}):`,
    ...lines,
    'No appointment is booked and nobody is calling them back. Expect them as walk-ins.'
  ].join('\n');
}

async function buildDigestBody() {
  const digest = await buildOwnerDashboardData();
  const rupees = (value) => `Rs ${Number(value || 0).toFixed(0)}`;
  const expectedVisitors = formatExpectedVisitors(await buildExpectedVisitors());

  const alerts = digest.alerts?.length
    ? `Priority alerts:\n- ${digest.alerts.map((item) => `${item.customer_name}: ${item.headline}`).join('\n- ')}`
    : 'Priority alerts: none';

  return [
    digest.digest_text,
    '',
    `Revenue pipeline: ${rupees(digest.roi_snapshot?.revenue_pipeline_estimate)}`,
    `Estimated AI ops cost: ${rupees(digest.roi_snapshot?.ai_ops_cost_estimate)}`,
    `Estimated staff saving: ${rupees(digest.roi_snapshot?.estimated_saving_vs_staff)}`,
    '',
    alerts,
    '',
    expectedVisitors,
    '',
    'This message contains patient information. Handle accordingly.'
  ].join('\n');
}

/** True once the configured local send time has passed today. */
function digestIsDue(config, now = new Date()) {
  const [hour, minute] = String(config.send_at || '08:00').split(':').map(Number);
  const local = new Date(now.toLocaleString('en-US', { timeZone: config.timezone || 'Asia/Kolkata' }));
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  if (config.last_sent_date === today) return { due: false, today };
  const past = local.getHours() > hour || (local.getHours() === hour && local.getMinutes() >= minute);
  return { due: past, today };
}

async function sendOwnerDigest({ force = false, to = null } = {}) {
  const { sendMail, isMailConfigured } = require('../services/mailer');
  const config = await settings.get('owner_digest');
  const recipients = to || config.recipients || [];

  if (!force && !config.enabled) return { sent: false, reason: 'digest is switched off' };
  if (recipients.length === 0) return { sent: false, reason: 'no recipients configured' };
  if (!isMailConfigured()) return { sent: false, reason: 'SMTP is not configured' };

  const body = await buildDigestBody();
  const result = await sendMail({
    to: recipients,
    subject: `${CLIENT_NAME || 'Path Lab'} — daily call digest`,
    text: body
  });
  logger.info('OWNER_DIGEST_SENT', { recipients: recipients.length, forced: force });
  return { sent: true, ...result };
}

async function runOwnerDigestTick() {
  if (ownerDigestRunning) return;
  ownerDigestRunning = true;

  try {
    const config = await settings.get('owner_digest');
    if (!config.enabled) return;

    const { due, today } = digestIsDue(config);
    if (!due) return;

    const result = await sendOwnerDigest();
    if (result.sent) {
      // Recorded only after a successful send, so a mail outage retries on the
      // next tick instead of silently skipping the day.
      await settings.patch('owner_digest', { last_sent_date: today }, 'scheduler');
    } else {
      logger.warn('OWNER_DIGEST_SKIPPED', { reason: result.reason });
    }
  } catch (error) {
    logger.warn('OWNER_DIGEST_FAILED', { reason: error.message });
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
    console.log('[SCHEDULER] Paused due to recent provider failure (global cooldown)');
    return;
  }

  await markSubmittedCallsWithoutMediaFailed();

  const now = new Date();
  const currentSlot = getCurrentSlotLabel(now);

  const dueCustomers = await dbAll(
    `SELECT c.*
     FROM customer_queue c
     WHERE COALESCE(c.do_not_call, 0) = 0
       AND COALESCE(c.wrong_number_flag, 0) = 0
       AND COALESCE(c.admin_review_required, 0) = 0
       AND COALESCE(c.consent_status, 'unknown') != 'denied'
       AND c.status IN ('pending', 'scheduled', 'retry_scheduled', 'callback_scheduled')
       AND (c.locked_at IS NULL OR c.locked_at <= (now() - interval '10 minutes'))
       AND (
         COALESCE(c.attempt_count, 0) = 0
         OR COALESCE(c.auto_retry_enabled, 0) = 1
       )
       AND COALESCE(c.attempt_count, 0) < 3
       AND (
         (
           c.status IN ('pending', 'scheduled')
           AND (
             (c.scheduled_datetime IS NOT NULL AND c.scheduled_datetime <= now())
             OR (c.scheduled_datetime IS NULL AND COALESCE(c.best_call_slot, c.preferred_slot) <= ?)
           )
         )
         OR (c.status IN ('retry_scheduled', 'callback_scheduled') AND c.next_retry_at IS NOT NULL AND c.next_retry_at <= now())
       )
       AND (
         c.status IN ('retry_scheduled', 'callback_scheduled')
         OR NOT EXISTS (
           SELECT 1
           FROM calls recent_call
           WHERE recent_call.customer_id = c.id
             AND recent_call.called_at >= (now() - interval '45 minutes')
             AND (
               c.scheduled_datetime IS NULL
               OR recent_call.called_at >= c.scheduled_datetime
             )
         )
       )`,
    [currentSlot]
  );

  if (!dueCustomers.length) {
    return;
  }

  const uniqueByPhone = new Map();
  for (const customer of dueCustomers) {
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
  console.log(`[SCHEDULER] Found ${hydratedCustomers.length} eligible customer(s) due at ${currentSlot}`);

  for (const customer of hydratedCustomers) {
    try {
      const agentConfig = customer.default_agent_id ? await getAgentConfigById(customer.default_agent_id) : await getDefaultAgentConfig();
      const blockedReason = await shouldBlockCustomerCall(customer);
      if (blockedReason) {
        console.log(`[SCHEDULER] Skipping customerId=${customer.id}: ${blockedReason.reason}`);
        if (blockedReason.code === 'CALL_SKIPPED_QUIET_HOURS') {
          const nextRetry = new Date();
          nextRetry.setHours(7, 0, 0, 0);
          if (nextRetry < new Date()) {
            nextRetry.setDate(nextRetry.getDate() + 1);
          }
          logger.warn('CALL_SKIPPED_QUIET_HOURS', { phone: customer.phone, scheduledTime: logger.formatHumanDateTime(customer.scheduled_datetime || customer.next_retry_at || ''), reason: blockedReason.reason });
          await dbRun(`UPDATE customers SET status = ?, next_retry_at = ? WHERE id = ?`, ['retry_scheduled', nextRetry.toISOString(), customer.id]);
        } else if (blockedReason.code === 'CALL_FAILED_MAX_ATTEMPTS' || blockedReason.code === 'CALL_BLOCKED_DAILY_LIMIT') {
          logger.error('CALL_FAILED_MAX_ATTEMPTS', { phone: customer.phone, attempts: 3, reason: blockedReason.reason });
          await dbRun(`UPDATE customers SET status = ?, failed_reason = ? WHERE id = ?`, ['failed', blockedReason.reason, customer.id]);
        } else if (blockedReason.code === 'CALL_BLOCKED_THREE_HOUR_GAP') {
          logger.warn('CALL_BLOCKED_THREE_HOUR_GAP', { phone: customer.phone, lastAttemptAt: logger.formatHumanDateTime(blockedReason.lastAttemptAt), nextAllowedAt: logger.formatHumanDateTime(blockedReason.nextAllowedAt) });
          await dbRun(`UPDATE customers SET status = ?, next_retry_at = ? WHERE id = ?`, ['retry_scheduled', blockedReason.nextAllowedAt, customer.id]);
        } else if (blockedReason.code === 'CALL_AUTO_SCHEDULE_BLOCKED_COMPLETED') {
          logger.warn('CALL_AUTO_SCHEDULE_BLOCKED_COMPLETED', { phone: customer.phone, callType: customer.call_type, reason: blockedReason.reason });
          await dbRun(`UPDATE customers SET status = ?, failed_reason = ? WHERE id = ?`, ['cancelled', blockedReason.reason, customer.id]);
        } else if (blockedReason.code === 'CALL_BLOCKED_ACTIVE_CALL') {
          logger.warn('CALL_BLOCKED_ACTIVE_CALL', { phone: customer.phone, reason: blockedReason.reason });
          // Don't update status, just skip for now, it'll be picked up later when the other call is done
        }
        continue;
      }

      const idempotencyKey = `${customer.id}-${customer.attempt_count || 0}-${customer.scheduled_datetime || customer.next_retry_at || 'now'}`;
      const existingCall = await dbGet('SELECT 1 FROM calls WHERE idempotency_key = ?', [idempotencyKey]);
      if (existingCall) {
        logger.warn('CALL_START_BLOCKED_DUPLICATE', { phone: customer.phone, reason: 'Already calling' });
        // Fix: Advance the attempt_count to break out of infinite loop for this idempotency key
        await dbRun('UPDATE customers SET attempt_count = COALESCE(attempt_count, 0) + 1 WHERE id = ?', [customer.id]);
        continue;
      }

      const claimResult = await dbRun(
        `UPDATE customers
            SET status = ?,
                last_called_at = ?,
                locked_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND COALESCE(status, 'pending') IN ('pending', 'scheduled', 'retry_scheduled', 'callback_scheduled')
            AND (locked_at IS NULL OR locked_at <= (now() - interval '10 minutes'))`,
        ['calling', new Date().toISOString(), customer.id]
      );

      if (!claimResult.changes) {
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

        await dbRun(
          `UPDATE customers
              SET status = ?,
                  next_retry_at = ?,
                  attempt_count = COALESCE(attempt_count, 0) + ?,
                  locked_at = NULL
            WHERE id = ?`,
          ['retry_scheduled', nextRetry.toISOString(), mediaEndpointUnavailable ? 0 : 1, customer.id]
        );
        logger.info('CALL_RETRY_SCHEDULED', {
          callId: customer.id,
          nextAttemptAt: logger.formatHumanDateTime(nextRetry),
          attempt: (customer.attempt_count || 0) + (mediaEndpointUnavailable ? 0 : 1),
          reason: mediaEndpointUnavailable ? 'public_media_endpoint_unavailable' : 'provider_failure'
        });
        logger.info('CALL_LOCK_RELEASED', { callId: customer.id });
        continue;
      }

      const insertResult = await dbRun(
        `INSERT INTO calls (
          customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
          consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source, call_type,
          provider_payload_json, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer.id,
          agentConfig?.id || null,
          'scheduled_initiated',
          call.sid,
          new Date().toISOString(),
          customer.priority_score || computePriorityScore(customer),
          1,
          agentConfig?.slug || 'hindi-feedback-v1',
          'normal',
          'outbound',
          'icallmate',
          normalizeOutboundCallType(customer.call_type),
          JSON.stringify({ request: call.requestPayload || null, response: call.raw || null }),
          idempotencyKey
        ]
      );
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);

      const callsTodayRow = await dbGet(
        `SELECT COUNT(*) as count FROM calls c WHERE c.customer_id = ? AND c.called_at::date = current_date AND COALESCE(c.call_direction, 'outbound') = 'outbound'`,
        [customer.id]
      );
      const attempt = callsTodayRow ? callsTodayRow.count : 1;
      logger.info('CALL_ATTEMPT_STARTED', { phone: customer.phone, attempt });

      const insertedCall = { id: insertResult.lastID };
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
      console.log(
        acceptedOnly
          ? `[SCHEDULER] Scheduled call submitted for customerId=${customer.id}; waiting for iCallMate media (${call.sid}) providerStatus=${call.status}`
          : `[SCHEDULER] Scheduled call started for customerId=${customer.id} (${call.sid})`
      );
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
        await dbRun(
          `UPDATE customers
              SET status = ?,
                  next_retry_at = ?,
                  retry_count = COALESCE(retry_count, 0) + 1
            WHERE id = ?
              AND status = 'calling'`,
          ['retry_scheduled', retryAt, customer.id]
        );
      } catch (rollbackError) {
        console.error(`[SCHEDULER] Failed to roll back customer ${customer.id}:`, rollbackError.message);
      }
    }
  }
}

async function retryPendingRecordingUploads() {
  const { uploadObject, isStorageConfigured } = require('../services/supabase-storage');
  if (!isStorageConfigured()) return;

  const pending = await dbAll(
    "SELECT id, recording_object_key FROM calls WHERE recording_status = 'pending_upload' LIMIT 10"
  );

  for (const call of pending) {
    const objectKey = call.recording_object_key;
    const localPath = path.join(
      process.env.RECORDINGS_DIR || path.join(process.cwd(), 'recordings'),
      path.basename(objectKey || '')
    );

    if (!objectKey || !fs.existsSync(localPath)) {
      await dbRun("UPDATE calls SET recording_status = 'upload_lost' WHERE id = ?", [call.id]);
      logger.warn('RECORDING_UPLOAD_LOST', { callId: call.id });
      continue;
    }

    try {
      await uploadObject(objectKey, fs.readFileSync(localPath), 'audio/wav');
      await dbRun("UPDATE calls SET recording_status = 'stored' WHERE id = ?", [call.id]);
      fs.promises.unlink(localPath).catch(() => {});
      logger.info('RECORDING_UPLOAD_RETRIED', { callId: call.id });
    } catch (error) {
      logger.warn('RECORDING_UPLOAD_RETRY_FAILED', { callId: call.id, reason: error.message });
    }
  }
}

const settings = createSettingsStore({ dbGet, dbRun });

/**
 * Queues patients matching the configured rules.
 *
 * Off unless someone switches it on, because this is the path where the system
 * decides by itself to phone somebody. The blocking checks live in
 * queue-rules.js and are shared with the manual path, so a do-not-call patient
 * cannot be reached through either door.
 */
async function queuePatientsFromRules() {
  const config = await settings.get('auto_queue');
  if (!config.enabled) return;

  const rules = (config.rules || []).filter((rule) => rule.enabled !== false);
  if (rules.length === 0) return;

  const patients = await dbAll(
    `SELECT p.id, p.status, p.do_not_call, p.consent_status, p.normalized_phone,
            p.last_donation_date, p.last_test_date
       FROM patients p
      WHERE p.status = 'active'
        AND COALESCE(p.do_not_call, 0) = 0
        AND COALESCE(p.consent_status, 'unknown') <> 'refused'
        AND p.normalized_phone IS NOT NULL
      LIMIT 2000`
  );
  if (patients.length === 0) return;

  const openEntries = await dbAll(
    `SELECT patient_id FROM customers
      WHERE status IN ('pending','scheduled','calling','retry_scheduled','callback_scheduled')`
  );
  const alreadyQueued = new Set(openEntries.map((row) => Number(row.patient_id)));

  const selected = selectPatientsToQueue({
    patients, rules, today: new Date().toISOString(), alreadyQueued
  });

  for (const entry of selected) {
    try {
      await dbRun(
        `INSERT INTO customers (patient_id, scheduled_datetime, status, call_type, is_manual, created_at)
         VALUES (?, now(), 'scheduled', ?, 0, now())
         ON CONFLICT (patient_id) DO UPDATE SET
           scheduled_datetime = now(), status = 'scheduled',
           call_type = excluded.call_type, attempt_count = 0, updated_at = now()`,
        [entry.patientId, entry.rule.call_type || 'REVIEW_CALL']
      );
      logger.info('CALL_AUTO_QUEUED', {
        patientId: entry.patientId, rule: entry.rule.id, daysSince: entry.daysSince
      });
    } catch (error) {
      logger.warn('CALL_AUTO_QUEUE_FAILED', { patientId: entry.patientId, reason: error.message });
    }
  }

  if (selected.length > 0) {
    logger.info('AUTO_QUEUE_TICK', { queued: selected.length, considered: patients.length });
  }
}

async function runSchedulerTick() {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;
  try {
    await queuePatientsFromRules();
    await triggerScheduledCalls();
    await retryPendingRecordingUploads();
  } finally {
    schedulerRunning = false;
  }
}

module.exports = {
  formatExpectedVisitors,
  markSubmittedCallsWithoutMediaFailed,
  buildDigestBody,
  digestIsDue,
  sendOwnerDigest,
  retryPendingRecordingUploads,
  queuePatientsFromRules,
  runOwnerDigestTick,
  triggerScheduledCalls,
  runSchedulerTick
};
