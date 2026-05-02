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

module.exports = {
  getTodayDateRange,
  getCurrentWeekDateRange,
  buildReportData,
  buildWeeklySummary
};
