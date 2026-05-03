const { dbAll, dbGet } = require('../db');

function getDateRangeForDays(days, endDate = new Date()) {
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

function getTodayDateRange() {
  return getDateRangeForDays(1);
}

function getYesterdayDateRange() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return getDateRangeForDays(1, yesterday);
}

function getCurrentWeekDateRange() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setDate(now.getDate() + diffToMonday);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start: start.toISOString(), end: end.toISOString() };
}

async function buildReportData({ start, end, label = 'today' } = {}) {
  const range = start && end ? { start, end } : getTodayDateRange();
  const publicBaseUrl = process.env.NGROK_URL || process.env.PUBLIC_BASE_URL || '';

  const callStats = await dbGet(`
    SELECT 
      COUNT(*) as total_calls,
      SUM(CASE WHEN outcome IN ('answered', 'completed', 'consent_given', 'interested', 'callback', 'not_interested', 'hot_lead') THEN 1 ELSE 0 END) as answered,
      SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
      SUM(CASE WHEN outcome = 'declined' THEN 1 ELSE 0 END) as declined,
      SUM(CASE WHEN outcome = 'consent_given' THEN 1 ELSE 0 END) as consent_given,
      SUM(CASE WHEN whatsapp_sent = 1 THEN 1 ELSE 0 END) as whatsapp_sent,
      SUM(CASE WHEN fallback_triggered = 1 THEN 1 ELSE 0 END) as fallbacks_triggered,
      SUM(CASE WHEN outcome IN ('interested', 'hot_lead') THEN 1 ELSE 0 END) as hot_leads
    FROM calls
    WHERE called_at >= ? AND called_at <= ?
  `, [range.start, range.end]);

  const feedbackStats = await dbGet(`
    SELECT 
      COUNT(*) as feedback_count,
      ROUND(AVG(CASE WHEN stars IS NOT NULL THEN stars END), 1) as average_rating,
      SUM(CASE WHEN category = 'good' THEN 1 ELSE 0 END) as good_count,
      SUM(CASE WHEN category = 'average' THEN 1 ELSE 0 END) as average_count,
      SUM(CASE WHEN category = 'bad' THEN 1 ELSE 0 END) as bad_count
    FROM feedback
    WHERE submitted_at >= ? AND submitted_at <= ?
  `, [range.start, range.end]);

  const feedbackList = await dbAll(`
    SELECT 
      f.id,
      c.name as customer_name,
      f.category,
      f.stars,
      SUBSTR(f.review_text, 1, 180) as review_excerpt,
      f.submitted_at
    FROM feedback f
    JOIN customers c ON f.customer_id = c.id
    WHERE f.submitted_at >= ? AND f.submitted_at <= ?
    ORDER BY f.submitted_at DESC
    LIMIT 20
  `, [range.start, range.end]);

  const analyzedCalls = await dbAll(`
    SELECT
      calls.id,
      c.name AS customer_name,
      c.phone AS customer_phone,
      calls.called_at,
      calls.outcome,
      calls.outcome_detail,
      calls.recording_status,
      calls.recording_url,
      calls.transcript_status,
      calls.transcript_text,
      calls.analysis_status,
      calls.analysis_summary,
      calls.report_excerpt,
      calls.extracted_rating,
      calls.follow_up_task,
      calls.next_action_at,
      calls.hot_lead_score,
      calls.sentiment_label,
      calls.crm_sync_status,
      calls.whatsapp_summary_sent,
      calls.objections_json,
      calls.competitor_mentions_json,
      calls.live_red_flag,
      calls.supervisor_alert_level
    FROM calls
    JOIN customers c ON c.id = calls.customer_id
    WHERE calls.called_at >= ? AND calls.called_at <= ?
    ORDER BY calls.called_at DESC
    LIMIT 25
  `, [range.start, range.end]);

  const pendingItems = await dbAll(`
    SELECT
      calls.id,
      c.name AS customer_name,
      calls.called_at,
      calls.outcome,
      calls.recording_status,
      calls.transcript_status,
      calls.analysis_status,
      calls.follow_up_task
    FROM calls
    JOIN customers c ON c.id = calls.customer_id
    WHERE calls.called_at >= ? AND calls.called_at <= ?
      AND (
        COALESCE(calls.recording_status, 'pending') != 'completed'
        OR COALESCE(calls.transcript_status, 'pending') != 'completed'
        OR COALESCE(calls.analysis_status, 'pending') != 'completed'
        OR calls.outcome IN ('initiated', 'scheduled_initiated', 'no_answer', 'busy', 'callback')
      )
    ORDER BY calls.called_at DESC
    LIMIT 12
  `, [range.start, range.end]);

  const peakSlots = await dbAll(`
    SELECT SUBSTR(called_at, 12, 5) AS slot, COUNT(*) AS total_calls
    FROM calls
    WHERE called_at >= ? AND called_at <= ?
    GROUP BY SUBSTR(called_at, 12, 5)
    ORDER BY total_calls DESC, slot ASC
    LIMIT 5
  `, [range.start, range.end]);

  const scriptPerformance = await dbAll(`
    SELECT
      COALESCE(call_script_version, 'default') AS script_version,
      COUNT(*) AS total_calls,
      AVG(CASE WHEN extracted_rating IS NOT NULL THEN extracted_rating END) AS avg_rating
    FROM calls
    WHERE called_at >= ? AND called_at <= ?
    GROUP BY COALESCE(call_script_version, 'default')
    ORDER BY avg_rating DESC, total_calls DESC
    LIMIT 5
  `, [range.start, range.end]);

  const safeTotalCalls = Number(callStats?.total_calls) || 0;
  const safeAnswered = Number(callStats?.answered) || 0;
  const safeNoAnswer = Number(callStats?.no_answer) || 0;
  const safeDeclined = Number(callStats?.declined) || 0;
  const safeConsent = Number(callStats?.consent_given) || 0;
  const safeWhatsapp = Number(callStats?.whatsapp_sent) || 0;
  const safeFallbacks = Number(callStats?.fallbacks_triggered) || 0;
  const safeHotLeads = Number(callStats?.hot_leads) || 0;
  const safeFeedbackCount = Number(feedbackStats?.feedback_count) || 0;
  const safeGoodCount = Number(feedbackStats?.good_count) || 0;
  const safeAverageCount = Number(feedbackStats?.average_count) || 0;
  const safeBadCount = Number(feedbackStats?.bad_count) || 0;
  const averageRating = Number(feedbackStats?.average_rating) || 0;
  const successRate = safeTotalCalls > 0 ? Number(((safeAnswered / safeTotalCalls) * 100).toFixed(1)) : 0;

  const objectionCounts = new Map();
  const competitorCounts = new Map();

  analyzedCalls.forEach((call) => {
    const objections = JSON.parse(call.objections_json || '[]');
    const competitors = JSON.parse(call.competitor_mentions_json || '[]');

    objections.forEach((item) => objectionCounts.set(item, (objectionCounts.get(item) || 0) + 1));
    competitors.forEach((item) => competitorCounts.set(item, (competitorCounts.get(item) || 0) + 1));
  });

  const commonObjections = [...objectionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count]) => ({ label, count }));

  const competitorMentions = [...competitorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count]) => ({ label, count }));

  const revenuePipeline = analyzedCalls.reduce((sum, call) => {
    if (['interested', 'hot_lead'].includes(String(call.outcome || '').toLowerCase())) {
      return sum + (Number(call.hot_lead_score) || 0) * 10;
    }
    return sum;
  }, 0);

  const enrichedCalls = analyzedCalls.map((call) => ({
    ...call,
    recording_link: publicBaseUrl ? `${publicBaseUrl}/api/calls/${call.id}/recording` : null,
    transcript_link: publicBaseUrl ? `${publicBaseUrl}/api/calls/${call.id}/transcript` : null,
    dashboard_link: publicBaseUrl ? `${publicBaseUrl}/admin.html` : null
  }));

  return {
    label,
    start: range.start,
    end: range.end,
    date: new Date().toISOString().split('T')[0],
    total_calls: safeTotalCalls,
    answered: safeAnswered,
    no_answer: safeNoAnswer,
    declined: safeDeclined,
    consent_given: safeConsent,
    whatsapp_sent: safeWhatsapp,
    fallbacks_triggered: safeFallbacks,
    hot_leads: safeHotLeads,
    feedback_count: safeFeedbackCount,
    average_rating: averageRating,
    success_rate: successRate,
    good_count: safeGoodCount,
    average_count: safeAverageCount,
    bad_count: safeBadCount,
    feedback: feedbackList,
    analyzed_calls: enrichedCalls,
    pending_items: pendingItems,
    peak_slots: peakSlots,
    script_performance: scriptPerformance,
    common_objections: commonObjections,
    competitor_mentions: competitorMentions,
    revenue_pipeline_estimate: Number(revenuePipeline.toFixed(2)),
    dashboard_link: publicBaseUrl ? `${publicBaseUrl}/admin.html` : null,
    summary_text: `For ${label}, total ${safeTotalCalls} calls, ${safeFeedbackCount} feedback entries, ${safeGoodCount} good reviews, ${safeHotLeads} hot leads, and ${successRate}% answer success.`
  };
}

async function buildWeeklySummary() {
  const range = getCurrentWeekDateRange();
  const report = await buildReportData({ ...range, label: 'this week' });
  const topInsights = (report.analyzed_calls || [])
    .map((call) => call.analysis_summary || call.report_excerpt)
    .filter(Boolean)
    .slice(0, 5);

  const hotLeadNames = (report.analyzed_calls || [])
    .filter((call) => ['interested', 'hot_lead'].includes(String(call.outcome || '').toLowerCase()))
    .map((call) => `${call.customer_name} (${call.hot_lead_score || 'n/a'})`)
    .slice(0, 8);

  const pending = (report.pending_items || [])
    .map((item) => `${item.customer_name}: ${item.outcome || 'pending'}${item.follow_up_task ? ` - ${item.follow_up_task}` : ''}`)
    .slice(0, 8);

  const bestScripts = (report.script_performance || [])
    .map((item) => `${item.script_version}: ${Number(item.avg_rating || 0).toFixed(1)}/5 across ${item.total_calls} calls`)
    .slice(0, 5);

  const bestSlots = (report.peak_slots || [])
    .map((item) => `${item.slot}: ${item.total_calls} calls`)
    .slice(0, 5);

  return {
    ...report,
    top_insights: topInsights,
    hot_lead_names: hotLeadNames,
    pending_summary: pending,
    best_scripts: bestScripts,
    best_slots: bestSlots
  };
}

function formatInr(value) {
  return `Rs ${Number(value || 0).toFixed(0)}`;
}

async function buildOwnerDashboardData() {
  const today = await buildReportData({ ...getTodayDateRange(), label: 'today' });
  const yesterday = await buildReportData({ ...getYesterdayDateRange(), label: 'yesterday' });
  const weekly = await buildWeeklySummary();

  const estimatedAiCostPerCall = Number(process.env.ESTIMATED_AI_CALL_COST_INR || 8);
  const estimatedStaffCostPerCall = Number(process.env.ESTIMATED_STAFF_CALL_COST_INR || 25);

  const aiOpsCost = Number((today.total_calls || 0) * estimatedAiCostPerCall);
  const staffOpsCost = Number((today.total_calls || 0) * estimatedStaffCostPerCall);
  const roiMultiple = aiOpsCost > 0
    ? Number(((today.revenue_pipeline_estimate || 0) / aiOpsCost).toFixed(1))
    : 0;
  const staffSaving = Math.max(staffOpsCost - aiOpsCost, 0);

  const ownerAlerts = await dbAll(`
    SELECT
      calls.id AS call_id,
      c.id AS customer_id,
      c.name AS customer_name,
      c.phone AS customer_phone,
      calls.called_at,
      calls.outcome,
      calls.hot_lead_score,
      calls.follow_up_task,
      calls.next_action_at,
      calls.analysis_summary,
      calls.report_excerpt,
      calls.sentiment_label,
      calls.supervisor_alert_level,
      calls.live_red_flag,
      c.admin_review_required,
      c.wrong_number_flag,
      c.next_retry_at,
      c.pending_follow_ups,
      c.revenue_estimate
    FROM calls
    JOIN customers c ON c.id = calls.customer_id
    WHERE calls.called_at >= DATETIME('now', '-7 days')
    ORDER BY calls.called_at DESC
    LIMIT 40
  `);

  const campaignConfigs = await dbAll(`
    SELECT name, service_name, monthly_spend_inr, status
    FROM campaign_configs
    WHERE COALESCE(status, 'active') = 'active'
    ORDER BY created_at DESC, name ASC
  `);

  const campaignPerformance = await dbAll(`
    SELECT
      COALESCE(campaign_name, 'Unassigned') AS campaign_name,
      COUNT(*) AS total_customers,
      SUM(CASE WHEN status IN ('hot_lead', 'completed', 'called', 'callback_scheduled') THEN 1 ELSE 0 END) AS active_leads,
      SUM(CASE WHEN revenue_stage IN ('qualified', 'follow_up') THEN 1 ELSE 0 END) AS qualified_leads,
      SUM(COALESCE(revenue_estimate, 0)) AS revenue_pipeline
    FROM customers
    GROUP BY COALESCE(campaign_name, 'Unassigned')
    ORDER BY revenue_pipeline DESC, total_customers DESC
  `);

  const normalizedAlerts = ownerAlerts.map((item) => {
    const outcome = String(item.outcome || '').toLowerCase();
    const isHotLead = ['interested', 'hot_lead'].includes(outcome) || Number(item.hot_lead_score || 0) >= 85;
    const isComplaint = String(item.sentiment_label || '').toLowerCase() === 'negative' || Number(item.live_red_flag || 0) === 1;
    const needsCallback = outcome === 'callback';
    const wrongNumber = Number(item.admin_review_required || 0) === 1 || Number(item.wrong_number_flag || 0) === 1;
    const overdue = item.next_action_at && new Date(item.next_action_at).getTime() < Date.now();

    let type = 'info';
    let severity = 'low';
    let headline = item.report_excerpt || item.analysis_summary || 'Owner attention recommended.';

    if (isHotLead) {
      type = 'hot_lead';
      severity = 'high';
      headline = `${item.customer_name} is showing strong buying intent.`;
    } else if (isComplaint) {
      type = 'reputation';
      severity = 'high';
      headline = `${item.customer_name} may be unhappy or complaint-prone.`;
    } else if (needsCallback) {
      type = 'callback';
      severity = 'medium';
      headline = `${item.customer_name} asked for a callback.`;
    } else if (wrongNumber) {
      type = 'admin_review';
      severity = 'medium';
      headline = `${item.customer_name} is marked for admin review.`;
    } else if (overdue) {
      type = 'stale_followup';
      severity = 'medium';
      headline = `${item.customer_name} has an overdue next action.`;
    }

    return {
      call_id: item.call_id,
      customer_id: item.customer_id,
      customer_name: item.customer_name,
      customer_phone: item.customer_phone,
      type,
      severity,
      called_at: item.called_at,
      next_action_at: item.next_action_at,
      headline,
      follow_up_task: item.follow_up_task,
      summary: item.analysis_summary || item.report_excerpt || item.pending_follow_ups || 'No summary available.',
      revenue_estimate: Number(item.revenue_estimate || 0),
      hot_lead_score: Number(item.hot_lead_score || 0)
    };
  })
    .filter((item) => item.type !== 'info')
    .sort((a, b) => {
      const severityRank = { high: 0, medium: 1, low: 2 };
      const severityDelta = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
      if (severityDelta !== 0) return severityDelta;
      return new Date(b.called_at || 0) - new Date(a.called_at || 0);
    })
    .slice(0, 12);

  const complaintCount = normalizedAlerts.filter((item) => item.type === 'reputation').length;
  const hotLeadCount = normalizedAlerts.filter((item) => item.type === 'hot_lead').length;
  const callbackCount = normalizedAlerts.filter((item) => item.type === 'callback').length;
  const staleLeadCount = normalizedAlerts.filter((item) => item.type === 'stale_followup').length;

  const campaignRoi = campaignPerformance.map((campaign) => {
    const config = campaignConfigs.find((item) => item.name === campaign.campaign_name);
    const spend = Number(config?.monthly_spend_inr || 0);
    const pipeline = Number(campaign.revenue_pipeline || 0);
    return {
      campaign_name: campaign.campaign_name,
      service_name: config?.service_name || null,
      spend_inr: spend,
      active_leads: Number(campaign.active_leads || 0),
      qualified_leads: Number(campaign.qualified_leads || 0),
      revenue_pipeline: pipeline,
      roi_multiple: spend > 0 ? Number((pipeline / spend).toFixed(1)) : 0
    };
  }).slice(0, 8);

  const staleLeads = normalizedAlerts
    .filter((item) => item.type === 'stale_followup' || item.type === 'callback')
    .map((item) => ({
      customer_name: item.customer_name,
      next_action_at: item.next_action_at,
      follow_up_task: item.follow_up_task,
      severity: item.severity,
      type: item.type,
      revenue_estimate: item.revenue_estimate
    }))
    .slice(0, 8);

  const ownerCards = [
    { label: 'Yesterday calls', value: yesterday.total_calls || 0, tone: 'blue' },
    { label: 'Hot leads', value: hotLeadCount || yesterday.hot_leads || 0, tone: 'green' },
    { label: 'Complaint risks', value: complaintCount, tone: 'red' },
    { label: 'Revenue pipeline', value: formatInr(today.revenue_pipeline_estimate || weekly.revenue_pipeline_estimate || 0), tone: 'purple' }
  ];

  const digestText = [
    `Good morning. Yesterday ${yesterday.total_calls || 0} calls were completed.`,
    `${hotLeadCount || yesterday.hot_leads || 0} hot leads need attention.`,
    `Estimated revenue pipeline is ${formatInr(today.revenue_pipeline_estimate || weekly.revenue_pipeline_estimate || 0)}.`,
    complaintCount ? `${complaintCount} complaint or negative-sentiment risk items were detected.` : 'No major complaint risk was detected.',
    callbackCount ? `${callbackCount} callbacks are waiting.` : 'No callback backlog right now.'
  ].join(' ');

  return {
    generated_at: new Date().toISOString(),
    digest_text: digestText,
    yesterday_snapshot: {
      calls: yesterday.total_calls || 0,
      hot_leads: yesterday.hot_leads || 0,
      revenue_pipeline_estimate: yesterday.revenue_pipeline_estimate || 0,
      complaints: complaintCount
    },
    roi_snapshot: {
      ai_ops_cost_estimate: aiOpsCost,
      staff_ops_cost_estimate: staffOpsCost,
      estimated_saving_vs_staff: staffSaving,
      revenue_pipeline_estimate: today.revenue_pipeline_estimate || 0,
      roi_multiple: roiMultiple
    },
    owner_cards: ownerCards,
    alerts: normalizedAlerts,
    critical_alert_count: normalizedAlerts.filter((item) => item.severity === 'high').length,
    campaign_roi: campaignRoi,
    stale_leads: staleLeads,
    weekly_summary: weekly.summary_text,
    weekly_top_insights: weekly.top_insights || [],
    best_slots: weekly.best_slots || [],
    best_scripts: weekly.best_scripts || [],
    common_objections: weekly.common_objections || [],
    competitor_mentions: weekly.competitor_mentions || [],
    callback_count: callbackCount,
    stale_lead_count: staleLeadCount
  };
}

module.exports = {
  getTodayDateRange,
  getYesterdayDateRange,
  getCurrentWeekDateRange,
  buildReportData,
  buildWeeklySummary,
  buildOwnerDashboardData
};
