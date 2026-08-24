'use strict';
const Customer = require('./models/Customer');
const Call = require('./models/Call');
const Tenant = require('./models/Tenant');
const { getAgentConfigById, getDefaultAgentConfig } = require('./prompt-builder');
const { placeRealtimeCall, hydratePreCallIntelligence, shouldBlockCustomerCall } = require('./call-management');
const logger = require('../services/system-logger');
const { ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE } = require('../services/icallmate');
const { getCurrentSlotLabel, computePriorityScore } = require('../services/call-orchestration');
const { activeOperationalFilter } = require('./webmaster/lifecycle');

let ownerDigestRunning = false;
let schedulerRunning = false;

async function markSubmittedCallsWithoutMediaFailed() {}
async function triggerOwnerDigestIfDue() {}
async function dispatchMissingFeedbackAnalysis() {}
async function dispatchClientReminders() {}

async function dispatchScheduledCalls() {
  const currentSlot = getCurrentSlotLabel(new Date());
  
  // Quick Mongoose port of the logic
  const dueCustomers = await Customer.find(activeOperationalFilter({
    do_not_call: { $ne: true },
    wrong_number_flag: { $ne: true },
    admin_review_required: { $ne: true },
    consent_status: { $ne: 'denied' },
    status: { $in: ['pending', 'scheduled', 'retry_scheduled', 'callback_scheduled'] },
    $and: [
      {
        $or: [
          { locked_at: null },
          { locked_at: { $lte: new Date(Date.now() - 10 * 60 * 1000) } }
        ]
      },
      {
        $or: [
          { attempt_count: { $exists: false } },
          { attempt_count: { $lt: 3 } }
        ]
      }
    ]
  }));

  if (!dueCustomers.length) return;

  for (const customer of dueCustomers) {
    if (customer.scheduled_datetime && new Date(customer.scheduled_datetime) > new Date()) continue;
    if (!customer.scheduled_datetime && customer.status === 'pending' && customer.preferred_slot > currentSlot) continue;
    if (customer.next_retry_at && new Date(customer.next_retry_at) > new Date()) continue;

    console.log(`[SCHEDULER] Picking up customer ${customer.id}`);
    customer.locked_at = new Date();
    customer.status = 'calling';
    await customer.save();

    try {
      const agentConfig = customer.default_agent_id ? await getAgentConfigById(customer.default_agent_id) : await getDefaultAgentConfig();
      const call = await placeRealtimeCall({
        customerPhone: customer.phone,
        customerName: customer.name,
        customerId: customer.id,
        clientName: agentConfig?.client_name || 'AI Call Agent',
        agentId: agentConfig?.id || null,
        callType: customer.call_type
      });

      const newCall = await Call.create({
        tenantId: customer.tenantId,
        customerId: customer._id,
        agentId: agentConfig?._id || null, // Ensure to use _id
        status: 'queued',
        outcome: 'scheduled_initiated',
        provider_call_id: call.sid,
        started_at: new Date(),
        call_direction: 'outbound',
        call_type: customer.call_type
      });



      customer.status = 'called';
      customer.last_called_at = new Date();
      customer.locked_at = null;
      await customer.save();
      logger.info('CALL_STARTED', { callId: newCall._id, phone: customer.phone });
    } catch (err) {
      logger.error('CALL_PROVIDER_FAILED', { reason: err.message });
      customer.status = 'retry_scheduled';
      customer.next_retry_at = new Date(Date.now() + 60000);
      customer.attempt_count = (customer.attempt_count || 0) + 1;
      customer.locked_at = null;
      await customer.save();
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
