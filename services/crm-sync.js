
const crypto = require('crypto');
const { getIntegrationRuntimeConfig: defaultRuntimeConfigResolver } = require('../src/webmaster/settings-service');

async function postJson(url, payload, { fetchImpl = global.fetch, timeoutMs = 5000, signingSecret = '' } = {}) {
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (signingSecret) {
    headers['X-Webhook-Signature'] = crypto.createHmac('sha256', signingSecret).update(body).digest('hex');
  }
  let response;
  try {
    response = await fetchImpl(url, {
    method: 'POST',
      headers,
      body,
      signal: controller.signal
    });
  } catch (_error) {
    const error = new Error('CRM webhook delivery failed');
    error.code = 'WEBHOOK_DELIVERY_FAILED';
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    await response.text();
    const error = new Error(`CRM webhook delivery failed with HTTP ${response.status}`);
    error.code = 'WEBHOOK_DELIVERY_FAILED';
    throw error;
  }

  return response;
}

function buildCrmPayload({ customer, call, feedback }) {
  return {
    event: 'call_completed',
    sent_at: new Date().toISOString(),
    customer: {
      id: customer?.id,
      name: customer?.name,
      phone: customer?.phone,
      customer_value: customer?.customer_value,
      urgency_level: customer?.urgency_level,
      priority_score: customer?.priority_score,
      consent_status: customer?.consent_status
    },
    call: {
      id: call?.id,
      provider_call_id: call?.provider_call_id,
      outcome: call?.outcome,
      outcome_detail: call?.outcome_detail,
      recording_status: call?.recording_status,
      recording_url: call?.recording_url,
      transcript_status: call?.transcript_status,
      analysis_status: call?.analysis_status,
      analysis_summary: call?.analysis_summary,
      report_excerpt: call?.report_excerpt,
      sentiment_label: call?.sentiment_label,
      extracted_rating: call?.extracted_rating,
      extracted_review_text: call?.extracted_review_text,
      follow_up_task: call?.follow_up_task,
      next_action_at: call?.next_action_at,
      hot_lead_score: call?.hot_lead_score,
      crm_sync_status: call?.crm_sync_status
    },
    feedback: feedback || null
  };
}

async function syncCallToCrm({
  dbGet,
  dbRun,
  callId,
  tenantId = null,
  getIntegrationRuntimeConfig = defaultRuntimeConfigResolver,
  fetchImpl = global.fetch
}) {
  const call = await dbGet('SELECT * FROM calls WHERE id = ?', [callId]);
  if (!call) {
    return { skipped: true, reason: 'call_not_found' };
  }

  const runtime = await getIntegrationRuntimeConfig('webhook', tenantId ?? call.tenant_id ?? call.tenantId ?? null);
  const endpoint = runtime.settings?.endpoint;
  if (runtime.settings?.enabled === false || !endpoint) {
    return { skipped: true, reason: 'webhook_disabled_or_unconfigured' };
  }

  const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [call.customer_id]);
  const feedback = await dbGet('SELECT * FROM feedback WHERE call_id = ?', [call.id]);

  try {
    await postJson(endpoint, buildCrmPayload({ customer, call, feedback }), {
      fetchImpl,
      timeoutMs: runtime.settings?.timeoutMs ?? 5000,
      signingSecret: runtime.secrets?.signingSecret ?? ''
    });
    await dbRun('UPDATE calls SET crm_sync_status = ? WHERE id = ?', ['completed', call.id]);
    return { ok: true };
  } catch (error) {
    await dbRun('UPDATE calls SET crm_sync_status = ? WHERE id = ?', ['failed', call.id]);
    throw error;
  }
}

async function sendHotLeadAlert({ customer, call }) {
  if (!process.env.OWNER_EMAIL) {
    return { skipped: true, reason: 'missing_owner_email' };
  }

  const subject = `Hot Lead Alert — ${customer?.name || 'Customer'}`;
  const text = [
    `Customer: ${customer?.name || 'Customer'}`,
    `Phone: ${customer?.phone || 'N/A'}`,
    `Outcome: ${call?.outcome || 'N/A'}`,
    `Hot Lead Score: ${call?.hot_lead_score || 'N/A'}`,
    `Summary: ${call?.analysis_summary || call?.report_excerpt || 'No summary available.'}`,
    `Next Action: ${call?.follow_up_task || 'No follow-up task yet.'}`,
    call?.next_action_at ? `Next Action Time: ${call.next_action_at}` : null
  ].filter(Boolean).join('\n');

  console.log('[HOT LEAD]', subject, text);
  return { ok: true };
}

module.exports = {
  buildCrmPayload,
  syncCallToCrm,
  sendHotLeadAlert
};
