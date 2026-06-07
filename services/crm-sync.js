

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`CRM webhook failed (${response.status}): ${body.slice(0, 200)}`);
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

async function syncCallToCrm({ dbGet, dbRun, callId }) {
  if (!process.env.CRM_WEBHOOK_URL) {
    return { skipped: true, reason: 'missing_crm_webhook_url' };
  }

  const call = await dbGet('SELECT * FROM calls WHERE id = ?', [callId]);
  if (!call) {
    return { skipped: true, reason: 'call_not_found' };
  }

  const customer = await dbGet('SELECT * FROM customers WHERE id = ?', [call.customer_id]);
  const feedback = await dbGet('SELECT * FROM feedback WHERE call_id = ?', [call.id]);

  try {
    await postJson(process.env.CRM_WEBHOOK_URL, buildCrmPayload({ customer, call, feedback }));
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
