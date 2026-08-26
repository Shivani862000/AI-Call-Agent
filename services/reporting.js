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

async function buildReportData({ repositories, clientId, publicBaseUrl = '', start, end, label = 'today' } = {}) {
  if (!repositories?.reporting) throw new Error('Reporting repository is required');
  const range = start && end ? { start, end } : getTodayDateRange();
  const rangeData = await repositories.reporting.buildRangeData(clientId, range);
  const callStats = rangeData.call_stats;
  const feedbackStats = rangeData.feedback_stats;
  const feedbackList = rangeData.feedback;
  const analyzedCalls = rangeData.analyzed_calls;
  const pendingItems = rangeData.pending_items;
  const peakSlots = rangeData.peak_slots;
  const scriptPerformance = rangeData.script_performance;

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
    const objections = Array.isArray(call.objections_json)
      ? call.objections_json
      : JSON.parse(call.objections_json || '[]');
    const competitors = Array.isArray(call.competitor_mentions_json)
      ? call.competitor_mentions_json
      : JSON.parse(call.competitor_mentions_json || '[]');

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

async function buildWeeklySummary({ repositories, clientId, publicBaseUrl = '' } = {}) {
  const range = getCurrentWeekDateRange();
  const report = await buildReportData({ repositories, clientId, publicBaseUrl, ...range, label: 'this week' });
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
