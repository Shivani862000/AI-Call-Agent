/**
 * src/scheduler.js
 * Scheduler for automated outbound calls and owner daily digest.
 */

'use strict';

const { dbGet, dbRun, dbAll } = require('../db');
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

let ownerDigestRunning = false;
let schedulerRunning = false;

const SUBMITTED_CALL_GRACE_MS = Number(process.env.SUBMITTED_CALL_GRACE_MS || 2 * 60 * 1000);
const SUBMITTED_CALL_RETRY_MS = Number(process.env.SUBMITTED_CALL_RETRY_MS || 5 * 60 * 60 * 1000);

function isProviderAcceptedOnly(call) {
  const reason = String(call?.raw?.reason || call?.raw?.message || '');
  const status = String(call?.status || '').toLowerCase();
  return status === 'queued'
    || status === 'submitted'
    || reason.includes('Total Records Being Inserted');
}

async function markSubmittedCallsWithoutMediaFailed() {
  const cutoffIso = new Date(Date.now() - SUBMITTED_CALL_GRACE_MS).toISOString();
  const retryAt = new Date(Date.now() + SUBMITTED_CALL_RETRY_MS).toISOString();
  const nowIso = new Date().toISOString();
  const staleCalls = await dbAll(
    `SELECT calls.id AS call_id,
            calls.customer_id,
            calls.provider_call_id,
            calls.called_at,
            calls.call_type,
            customers.name,
            customers.phone,
            customers.status AS customer_status
       FROM calls
       LEFT JOIN customers ON customers.id = calls.customer_id
      WHERE calls.call_direction = 'outbound'
        AND calls.outcome IN ('initiated', 'scheduled_initiated')
        AND COALESCE(calls.media_packets, 0) = 0
        AND DATETIME(calls.called_at) <= DATETIME(?)
        AND NOT EXISTS (
          SELECT 1
            FROM calls newer_call
           WHERE newer_call.customer_id = calls.customer_id
             AND DATETIME(newer_call.called_at) > DATETIME(calls.called_at)
        )`,
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
        'No iCallMate media stream within 2 minutes of provider acceptance',
        nowIso,
        'media_timeout',
        'Provider accepted request, but no dial/media stream was received in time',
        call.call_id
      ]
    );

    if (!failResult.changes) {
      continue;
    }

    await dbRun(
      `UPDATE customers
          SET status = ?,
              next_retry_at = ?,
              retry_count = COALESCE(retry_count, 0) + 1
        WHERE id = ?
          AND status IN ('calling', 'called')`,
      ['retry_scheduled', retryAt, call.customer_id]
    );

    logger.error('CALL_FAILED', {
      callId: call.call_id,
      customerId: call.customer_id,
      patient: call.name,
      phone: call.phone,
      type: logger.formatCallType(call.call_type),
      providerCallId: call.provider_call_id,
      reason: 'No iCallMate media stream within 2 minutes',
      retryAt: logger.formatHumanDateTime(retryAt)
    });
    logger.warn('CALL_RETRY', {
      callId: call.call_id,
      customerId: call.customer_id,
      patient: call.name,
      phone: call.phone,
      type: logger.formatCallType(call.call_type),
      retryAt: logger.formatHumanDateTime(retryAt),
      delay: '5 hours'
    });
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
    const state = await dbGet('SELECT value FROM app_state WHERE key = ?', ['owner_morning_digest_last_sent']);
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
        ? `Priority alerts:\n- ${digest.alerts.map((item) => `${item.customer_name}: ${item.headline}`).join('\n- ')}`
        : 'Priority alerts: none'
    ].join('\n');



    await dbRun(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ['owner_morning_digest_last_sent', todayKey, new Date().toISOString()]
    );

    console.log('[OWNER DIGEST] Morning digest sent successfully');
  } catch (error) {
    console.error('[OWNER DIGEST ERROR]', error.message);
  } finally {
    ownerDigestRunning = false;
  }
}

// ── Outbound Calling Schedulers ────────────────────────────────────────────────

async function triggerScheduledCalls() {
  await markSubmittedCallsWithoutMediaFailed();

  const now = new Date();
  const currentSlot = getCurrentSlotLabel(now);

  const dueCustomers = await dbAll(
    `SELECT c.*
     FROM customers c
     WHERE COALESCE(c.do_not_call, 0) = 0
       AND COALESCE(c.wrong_number_flag, 0) = 0
       AND COALESCE(c.admin_review_required, 0) = 0
       AND COALESCE(c.consent_status, 'unknown') != 'denied'
       AND COALESCE(c.status, 'pending') != 'calling'
       AND (
         (
           c.status IN ('pending', 'scheduled')
           AND (
             (c.scheduled_datetime IS NOT NULL AND DATETIME(c.scheduled_datetime) <= DATETIME('now'))
             OR (c.scheduled_datetime IS NULL AND COALESCE(c.best_call_slot, c.preferred_slot) <= ?)
           )
         )
         OR (c.status IN ('retry_scheduled', 'callback_scheduled') AND c.next_retry_at IS NOT NULL AND DATETIME(c.next_retry_at) <= DATETIME('now'))
       )
       AND (
         c.status IN ('retry_scheduled', 'callback_scheduled')
         OR NOT EXISTS (
           SELECT 1
           FROM calls recent_call
           WHERE recent_call.customer_id = c.id
             AND DATETIME(recent_call.called_at) >= DATETIME('now', '-45 minutes')
             AND (
               c.scheduled_datetime IS NULL
               OR DATETIME(recent_call.called_at) >= DATETIME(c.scheduled_datetime)
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
        `[SCHEDULER] Skipping duplicate customer row id=${customer.id} phone=${customer.phone} ` +
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
      const blockedReason = shouldBlockCustomerCall(customer);
      if (blockedReason) {
        console.log(`[SCHEDULER] Skipping ${customer.name}: ${blockedReason}`);
        continue;
      }

      const claimResult = await dbRun(
        `UPDATE customers
            SET status = ?,
                last_called_at = ?
          WHERE id = ?
            AND COALESCE(status, 'pending') IN ('pending', 'scheduled', 'retry_scheduled', 'callback_scheduled')`,
        ['calling', new Date().toISOString(), customer.id]
      );

      if (!claimResult.changes) {
        console.log(`[SCHEDULER] Skipping ${customer.name}: already claimed by another run`);
        continue;
      }
      logger.info('CALL_PENDING', {
        customerId: customer.id,
        patient: customer.name,
        phone: customer.phone,
        type: logger.formatCallType(customer.call_type),
        scheduledAt: logger.formatHumanDateTime(customer.scheduled_datetime || customer.next_retry_at),
        status: 'scheduler_picked'
      });

      const call = await placeRealtimeCall({
        customerPhone: customer.phone,
        customerName: customer.name,
        customerId: customer.id,
        clientName: agentConfig?.client_name || CLIENT_NAME,
        agentId: agentConfig?.id || null,
        callType: customer.call_type
      });

      const insertResult = await dbRun(
        `INSERT INTO calls (
          customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
          consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source, call_type,
          provider_payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify({ request: call.requestPayload || null, response: call.raw || null })
        ]
      );
      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', customer.id]);
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
          ? `[SCHEDULER] Scheduled call submitted for ${customer.name}; waiting for iCallMate media (${call.sid}) providerStatus=${call.status}`
          : `[SCHEDULER] Scheduled call started for ${customer.name} (${call.sid})`
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

async function triggerAnnualClientReminderCalls() {
  const now = new Date();
  const currentSlot = getCurrentSlotLabel(now);
  const currentYear = now.getUTCFullYear();

  const dueClients = await dbAll(
    `SELECT client.*
     FROM clients client
     LEFT JOIN calls recent_call
       ON recent_call.customer_id = client.linked_customer_id
      AND DATETIME(recent_call.called_at) >= DATETIME('now', '-45 minutes')
     WHERE COALESCE(client.annual_reminder_enabled, 1) = 1
       AND COALESCE(client.status, 'active') = 'active'
       AND client.next_annual_reminder_date IS NOT NULL
       AND DATE(client.next_annual_reminder_date) <= DATE('now')
       AND COALESCE(client.annual_reminder_slot, '10:00') <= ?
       AND COALESCE(client.last_annual_reminder_year, 0) < ?
       AND recent_call.id IS NULL
     ORDER BY client.next_annual_reminder_date ASC, client.annual_reminder_slot ASC`,
    [currentSlot, currentYear]
  );

  if (!dueClients.length) {
    return;
  }

  console.log(`[CLIENT REMINDER] Found ${dueClients.length} annual reminder client(s) due at ${currentSlot}`);

  for (const client of dueClients) {
    try {
      const customer = await ensureCustomerForClientReminder(client);
      const hydratedCustomer = await hydratePreCallIntelligence(customer);
      const blockedReason = shouldBlockCustomerCall(hydratedCustomer);
      if (blockedReason) {
        console.log(`[CLIENT REMINDER] Skipping ${client.name}: ${blockedReason}`);
        continue;
      }

      const agentConfig = hydratedCustomer.default_agent_id
        ? await getAgentConfigById(hydratedCustomer.default_agent_id)
        : await getDefaultAgentConfig();

      const claimResult = await dbRun(
        `UPDATE customers
            SET status = ?,
                last_called_at = ?
          WHERE id = ?
            AND COALESCE(status, 'pending') IN ('pending', 'retry_scheduled', 'callback_scheduled', 'called', 'completed')`,
        ['calling', new Date().toISOString(), hydratedCustomer.id]
      );

      if (!claimResult.changes) {
        console.log(`[CLIENT REMINDER] Skipping ${client.name}: customer row is already in use`);
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

      await dbRun(
        `INSERT INTO calls (
          customer_id, agent_id, outcome, provider_call_id, called_at, hot_lead_score,
          consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source, call_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hydratedCustomer.id,
          agentConfig?.id || null,
          'scheduled_initiated',
          call.sid,
          new Date().toISOString(),
          hydratedCustomer.priority_score || computePriorityScore(hydratedCustomer),
          1,
          `annual-reminder:${client.treatment_type || 'client-care'}`,
          'normal',
          'outbound',
          'icallmate',
          CALL_TYPES.THREE_MONTH_FOLLOWUP
        ]
      );

      await dbRun('UPDATE customers SET status = ? WHERE id = ?', ['called', hydratedCustomer.id]);
      await dbRun(
        `UPDATE clients
            SET last_annual_reminder_at = ?,
                last_annual_reminder_year = ?,
                next_annual_reminder_date = ?,
                updated_at = ?
          WHERE id = ?`,
        [
          new Date().toISOString(),
          currentYear,
          computeNextAnnualReminderDate(client.last_visit_date, new Date(Date.UTC(currentYear + 1, 0, 1))),
          new Date().toISOString(),
          client.id
        ]
      );

      console.log(`[CLIENT REMINDER] Annual reminder call started for ${client.name} (${call.sid})`);
    } catch (error) {
      console.error(`[CLIENT REMINDER ERROR] ${client.name}: ${error.message}`);
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
  runOwnerDigestTick,
  triggerScheduledCalls,
  triggerAnnualClientReminderCalls,
  runSchedulerTick
};
