/**
 * src/scheduler.js
 * Scheduler for automated outbound calls and owner daily digest.
 */

'use strict';

const { dbGet, dbRun, dbAll } = require('../db');
const crypto = require('crypto');
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

let ownerDigestRunning = false;
let schedulerRunning = false;

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
  const now = new Date();
  const currentSlot = getCurrentSlotLabel(now);

  const dueCalls = await dbAll(
    `SELECT c.*, 
            calls.id AS call_id, 
            calls.status AS call_status, 
            calls.call_type AS call_record_type
     FROM calls
     JOIN customers c ON calls.customer_id = c.id
     WHERE COALESCE(c.do_not_call, 0) = 0
       AND COALESCE(c.wrong_number_flag, 0) = 0
       AND COALESCE(c.admin_review_required, 0) = 0
       AND COALESCE(c.consent_status, 'unknown') != 'denied'
       AND COALESCE(c.status, '') != 'calling'
       AND calls.status IN ('pending', 'scheduled', 'retry_scheduled', 'callback_scheduled')
       AND (
         calls.scheduled_at IS NULL 
         OR DATETIME(calls.scheduled_at) <= DATETIME('now')
         OR COALESCE(c.best_call_slot, c.preferred_slot) <= ?
       )`,
    [currentSlot]
  );

  if (!dueCalls.length) {
    return;
  }

  const uniqueByPhone = new Map();
  for (const callRow of dueCalls) {
    const phoneKey = normalizePhoneLookupValue(callRow.phone) || String(callRow.phone || '').trim();
    if (!phoneKey) {
      continue;
    }

    if (uniqueByPhone.has(phoneKey)) {
      const existing = uniqueByPhone.get(phoneKey);
      console.log(
        `[SCHEDULER] Skipping duplicate call row id=${callRow.call_id} phone=${callRow.phone} ` +
        `because call id=${existing.call_id} already queued for this number`
      );
      continue;
    }

    uniqueByPhone.set(phoneKey, callRow);
  }

  const hydratedCalls = [];
  for (const callRow of uniqueByPhone.values()) {
    const hydratedCustomer = await hydratePreCallIntelligence(callRow);
    hydratedCalls.push({ ...hydratedCustomer, call_id: callRow.call_id, call_record_type: callRow.call_record_type });
  }

  hydratedCalls.sort((a, b) => (Number(b.priority_score) || 0) - (Number(a.priority_score) || 0));
  console.log(`[SCHEDULER] Found ${hydratedCalls.length} eligible call(s) due at ${currentSlot}`);

  for (const callRecord of hydratedCalls) {
    try {
      const agentConfig = callRecord.default_agent_id ? await getAgentConfigById(callRecord.default_agent_id) : await getDefaultAgentConfig();
      const blockedReason = shouldBlockCustomerCall(callRecord);
      if (blockedReason) {
        console.log(`[SCHEDULER] Skipping ${callRecord.name}: ${blockedReason}`);
        continue;
      }

      const claimResult = await dbRun(
        `UPDATE calls
            SET status = ?
          WHERE id = ?
            AND status IN ('pending', 'scheduled', 'retry_scheduled', 'callback_scheduled')`,
        ['calling', callRecord.call_id]
      );

      if (!claimResult.changes) {
        console.log(`[SCHEDULER] Skipping ${callRecord.name}: call already claimed by another run`);
        continue;
      }

      const call = await placeRealtimeCall({
        customerPhone: callRecord.phone,
        customerName: callRecord.name,
        customerId: callRecord.id,
        clientName: agentConfig?.client_name || CLIENT_NAME,
        agentId: agentConfig?.id || null,
        callType: callRecord.call_record_type || callRecord.call_type
      });

      await dbRun(
        `UPDATE calls SET
          agent_id = ?, outcome = ?, provider_call_id = ?, called_at = ?, hot_lead_score = ?,
          consent_message_played = ?, call_script_version = ?, supervisor_alert_level = ?, call_direction = ?, call_source = ?, uuid = ?, status = ?
         WHERE id = ?`,
        [
          agentConfig?.id || null,
          'scheduled_initiated',
          call.sid,
          new Date().toISOString(),
          callRecord.priority_score || computePriorityScore(callRecord),
          1,
          agentConfig?.slug || 'hindi-feedback-v1',
          'normal',
          'outbound',
          'icallmate',
          crypto.randomUUID(),
          'called',
          callRecord.call_id
        ]
      );
      // We update customer.status to 'calling' to lock concurrent calls for this patient
      await dbRun("UPDATE customers SET status = 'calling', last_called_at = ? WHERE id = ?", [new Date().toISOString(), callRecord.id]);
      
      console.log(`[SCHEDULER] Scheduled call started for ${callRecord.name} (${call.sid})`);
    } catch (error) {
      console.error(`[SCHEDULER] Failed to call ${callRecord.name}:`, error.message);
      try {
        await dbRun(
          `UPDATE calls
              SET status = ?
            WHERE id = ?
              AND status = 'calling'`,
          ['pending', callRecord.call_id]
        );
        await dbRun("UPDATE customers SET status = 'pending' WHERE id = ? AND status = 'calling'", [callRecord.id]);
      } catch (rollbackError) {
        console.error(`[SCHEDULER] Failed to roll back call ${callRecord.call_id}:`, rollbackError.message);
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
            AND COALESCE(status, 'pending') IN ('pending', 'scheduled', 'retry_scheduled', 'callback_scheduled', 'called', 'completed')`,
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
          consent_message_played, call_script_version, supervisor_alert_level, call_direction, call_source, call_type, uuid
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          CALL_TYPES.THREE_MONTH_FOLLOWUP,
          crypto.randomUUID()
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
