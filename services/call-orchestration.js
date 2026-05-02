const { sendWhatsAppMessage } = require('./twilio');

const VALUE_SCORES = {
  vip: 95,
  high: 80,
  standard: 55,
  low: 35
};

const URGENCY_SCORES = {
  urgent: 95,
  high: 80,
  normal: 55,
  low: 35
};

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function computePriorityScore(customer = {}) {
  const valueBand = normalizeEnum(customer.customer_value, Object.keys(VALUE_SCORES), 'standard');
  const urgencyBand = normalizeEnum(customer.urgency_level, Object.keys(URGENCY_SCORES), 'normal');
  const consentBonus = customer.consent_status === 'granted' ? 8 : customer.consent_status === 'denied' ? -25 : 0;
  const retryPenalty = Math.min(Number(customer.retry_count) || 0, 4) * 5;
  const reviewPenalty = customer.admin_review_required ? 30 : 0;
  const dndPenalty = customer.do_not_call ? 100 : 0;
  const wrongNumberPenalty = customer.wrong_number_flag ? 100 : 0;
  const score = Math.round(
    VALUE_SCORES[valueBand] * 0.45
      + URGENCY_SCORES[urgencyBand] * 0.45
      + consentBonus
      - retryPenalty
      - reviewPenalty
      - dndPenalty
      - wrongNumberPenalty
  );

  return Math.max(0, Math.min(100, score));
}

function getSmartRetryIso(outcome, now = new Date()) {
  const retryAt = new Date(now);
  const normalizedOutcome = String(outcome || '').toLowerCase();

  if (normalizedOutcome === 'busy') {
    retryAt.setMinutes(retryAt.getMinutes() + 30);
    return retryAt.toISOString();
  }

  if (normalizedOutcome === 'callback') {
    retryAt.setHours(retryAt.getHours() + 2);
    return retryAt.toISOString();
  }

  if (normalizedOutcome === 'no_answer') {
    retryAt.setDate(retryAt.getDate() + 1);
    retryAt.setHours(18, 30, 0, 0);
    return retryAt.toISOString();
  }

  retryAt.setDate(retryAt.getDate() + 1);
  retryAt.setHours(11, 0, 0, 0);
  return retryAt.toISOString();
}

function detectConversationOutcome({ analysisSummary = '', reportExcerpt = '', reviewText = '', transcriptText = '' } = {}) {
  const haystack = `${analysisSummary} ${reportExcerpt} ${reviewText} ${transcriptText}`.toLowerCase();

  if (/\bwrong number|galat number|wrong person|not.*ramesh|number.*galat\b/.test(haystack)) {
    return 'wrong_number';
  }

  if (/\bcall back|callback|baad mein call|later call|busy now|abhi busy\b/.test(haystack)) {
    return 'callback';
  }

  if (/\binterested|very interested|hot lead|follow up|send details|share details\b/.test(haystack)) {
    return 'interested';
  }

  if (/\bnot interested|interest nahin|nahi chahiye|don t call|do not call|no thanks\b/.test(haystack)) {
    return 'not_interested';
  }

  return 'completed';
}

function buildFollowUpTask(outcome, customerName) {
  const safeName = customerName || 'Customer';

  if (outcome === 'interested') {
    return `Create hot lead follow-up task for ${safeName}.`;
  }

  if (outcome === 'callback') {
    return `Schedule callback follow-up for ${safeName}.`;
  }

  if (outcome === 'wrong_number') {
    return `Admin review required for wrong-number flag on ${safeName}.`;
  }

  if (outcome === 'not_interested') {
    return `Add ${safeName} to churn-analysis bucket and avoid aggressive retries.`;
  }

  return null;
}

async function maybeSendBusyFallback({ customer, callId }) {
  if (!customer?.phone || !process.env.GOOGLE_REVIEW_LINK) {
    return false;
  }

  const message = `Namaste ${customer.name || 'Customer'}, humne aapse feedback ke liye call kiya tha. Jab aap free hon, aap apna short feedback yahan de sakte hain: ${process.env.GOOGLE_REVIEW_LINK}`;
  await sendWhatsAppMessage(customer.phone, message);
  return true;
}

async function applyCallOutcomeWorkflow({ dbGet, dbRun, callRecord, customer, providerStatus, inferredOutcome }) {
  const nowIso = new Date().toISOString();
  const currentOutcome = inferredOutcome || providerStatus;
  const normalized = String(currentOutcome || '').toLowerCase();
  const priorityScore = computePriorityScore(customer);

  const customerUpdates = {
    status: customer?.status || 'pending',
    last_contact_outcome: normalized || null,
    last_called_at: nowIso,
    next_retry_at: null,
    retry_count: customer?.retry_count || 0,
    wrong_number_flag: customer?.wrong_number_flag || 0,
    admin_review_required: customer?.admin_review_required || 0,
    callback_requested_at: customer?.callback_requested_at || null,
    consent_status: customer?.consent_status || 'unknown'
  };

  const callUpdates = {
    outcome: normalized || callRecord?.outcome || null,
    outcome_detail: normalized || null,
    fallback_triggered: 0,
    next_action_at: null,
    follow_up_task: buildFollowUpTask(normalized, customer?.name),
    hot_lead_score: normalized === 'interested' ? Math.max(priorityScore, 85) : priorityScore
  };

  if (normalized === 'wrong_number') {
    customerUpdates.status = 'admin_review';
    customerUpdates.wrong_number_flag = 1;
    customerUpdates.admin_review_required = 1;
    customerUpdates.do_not_call = 1;
  } else if (normalized === 'busy') {
    customerUpdates.status = 'busy';
    customerUpdates.next_retry_at = getSmartRetryIso('busy');
    customerUpdates.retry_count = (Number(customer?.retry_count) || 0) + 1;
    callUpdates.next_action_at = customerUpdates.next_retry_at;
    if (customer) {
      try {
        const sent = await maybeSendBusyFallback({ customer, callId: callRecord?.id });
        callUpdates.fallback_triggered = sent ? 1 : 0;
      } catch (error) {
        console.error('[BUSY FALLBACK ERROR]', error.message);
      }
    }
  } else if (normalized === 'no_answer' || normalized === 'failed') {
    customerUpdates.status = 'retry_scheduled';
    customerUpdates.next_retry_at = getSmartRetryIso('no_answer');
    customerUpdates.retry_count = (Number(customer?.retry_count) || 0) + 1;
    callUpdates.next_action_at = customerUpdates.next_retry_at;
    callUpdates.outcome = 'no_answer';
    callUpdates.outcome_detail = normalized;
  } else if (normalized === 'callback') {
    customerUpdates.status = 'callback_scheduled';
    customerUpdates.callback_requested_at = nowIso;
    customerUpdates.next_retry_at = getSmartRetryIso('callback');
    callUpdates.next_action_at = customerUpdates.next_retry_at;
  } else if (normalized === 'interested') {
    customerUpdates.status = 'hot_lead';
  } else if (normalized === 'not_interested') {
    customerUpdates.status = 'churn_watch';
    customerUpdates.do_not_call = 1;
  } else if (normalized === 'completed' || normalized === 'answered' || normalized === 'consent_given') {
    customerUpdates.status = 'completed';
    if (normalized === 'consent_given') {
      customerUpdates.consent_status = 'granted';
    }
  }

  await dbRun(
    `UPDATE customers
        SET status = ?,
            last_contact_outcome = ?,
            last_called_at = ?,
            next_retry_at = ?,
            retry_count = ?,
            wrong_number_flag = ?,
            admin_review_required = ?,
            callback_requested_at = ?,
            consent_status = ?,
            priority_score = ?,
            ai_score = ?
      WHERE id = ?`,
    [
      customerUpdates.status,
      customerUpdates.last_contact_outcome,
      customerUpdates.last_called_at,
      customerUpdates.next_retry_at,
      customerUpdates.retry_count,
      customerUpdates.wrong_number_flag,
      customerUpdates.admin_review_required,
      customerUpdates.callback_requested_at,
      customerUpdates.consent_status,
      priorityScore,
      priorityScore,
      customer.id
    ]
  );

  if (callRecord?.id) {
    await dbRun(
      `UPDATE calls
          SET outcome = ?,
              outcome_detail = ?,
              fallback_triggered = ?,
              next_action_at = ?,
              follow_up_task = ?,
              hot_lead_score = ?
        WHERE id = ?`,
      [
        callUpdates.outcome,
        callUpdates.outcome_detail,
        callUpdates.fallback_triggered,
        callUpdates.next_action_at,
        callUpdates.follow_up_task,
        callUpdates.hot_lead_score,
        callRecord.id
      ]
    );
  }

  return {
    customerStatus: customerUpdates.status,
    nextRetryAt: customerUpdates.next_retry_at,
    followUpTask: callUpdates.follow_up_task
  };
}

module.exports = {
  computePriorityScore,
  getSmartRetryIso,
  detectConversationOutcome,
  buildFollowUpTask,
  applyCallOutcomeWorkflow
};
