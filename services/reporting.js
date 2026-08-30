const supabase = require('../src/supabase');

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

  const { data: callsData } = await supabase
    .from('calls')
    .select('outcome, fallback_triggered, called_at, call_script_version, extracted_rating, id, call_type, outcome_detail, recording_status, recording_url, transcript_status, transcript_text, analysis_status, analysis_summary, report_excerpt, follow_up_task, next_action_at, hot_lead_score, sentiment_label, crm_sync_status, objections_json, competitor_mentions_json, live_red_flag, supervisor_alert_level, customers(name, phone)')
    .gte('called_at', range.start)
    .lte('called_at', range.end);
    
  const allCallsInRange = callsData || [];

  const callStats = {
    total_calls: 0, completed_calls: 0, callbacks_requested: 0,
    failed_calls: 0, answered: 0, no_answer: 0, declined: 0,
    consent_given: 0, fallbacks_triggered: 0, hot_leads: 0
  };
  
  const analyzedCalls = [];
  const pendingItems = [];
  const peakSlotsMap = new Map();
  const scriptPerfMap = new Map();

  allCallsInRange.forEach(c => {
    callStats.total_calls++;
    if (c.outcome === 'completed') callStats.completed_calls++;
    if (c.outcome === 'callback') callStats.callbacks_requested++;
    if (['failed', 'busy', 'no_answer', 'declined'].includes(c.outcome)) callStats.failed_calls++;
    if (['answered', 'completed', 'consent_given', 'interested', 'callback', 'not_interested', 'hot_lead'].includes(c.outcome)) callStats.answered++;
    if (c.outcome === 'no_answer') callStats.no_answer++;
    if (c.outcome === 'declined') callStats.declined++;
    if (c.outcome === 'consent_given') callStats.consent_given++;
    if (c.fallback_triggered === 1) callStats.fallbacks_triggered++;
    if (['interested', 'hot_lead'].includes(c.outcome)) callStats.hot_leads++;
    
    analyzedCalls.push({
      ...c,
      customer_name: c.customers?.name,
      customer_phone: c.customers?.phone
    });
    
    const isPending = (c.recording_status !== 'completed' || c.transcript_status !== 'completed' || c.analysis_status !== 'completed' || ['initiated', 'scheduled_initiated', 'no_answer', 'busy', 'callback'].includes(c.outcome));
    if (isPending) {
      pendingItems.push({
        id: c.id,
        customer_name: c.customers?.name,
        called_at: c.called_at,
        outcome: c.outcome,
        recording_status: c.recording_status,
        transcript_status: c.transcript_status,
        analysis_status: c.analysis_status,
        follow_up_task: c.follow_up_task
      });
    }
    
    if (c.called_at) {
      const d = new Date(c.called_at);
      const slot = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      peakSlotsMap.set(slot, (peakSlotsMap.get(slot) || 0) + 1);
    }
    
    const scriptVer = c.call_script_version || 'default';
    if (!scriptPerfMap.has(scriptVer)) scriptPerfMap.set(scriptVer, { total: 0, ratingSum: 0, ratingCount: 0 });
    const stat = scriptPerfMap.get(scriptVer);
    stat.total++;
    if (c.extracted_rating != null) {
      stat.ratingSum += Number(c.extracted_rating);
      stat.ratingCount++;
    }
  });

  const { data: feedbackData } = await supabase
    .from('feedback')
    .select('id, category, stars, review_text, submitted_at, customers(name)')
    .gte('submitted_at', range.start)
    .lte('submitted_at', range.end);
    
  const allFeedback = feedbackData || [];
  
  const feedbackStats = {
    feedback_count: 0, average_rating: 0, good_count: 0, average_count: 0, bad_count: 0
  };
  
  let starsSum = 0, starsCount = 0;
  const feedbackList = [];
  
  allFeedback.forEach(f => {
    feedbackStats.feedback_count++;
    if (f.stars != null) { starsSum += f.stars; starsCount++; }
    if (f.category === 'good') feedbackStats.good_count++;
    if (f.category === 'average') feedbackStats.average_count++;
    if (f.category === 'bad') feedbackStats.bad_count++;
    feedbackList.push({
      id: f.id,
      customer_name: f.customers?.name,
      category: f.category,
      stars: f.stars,
      review_excerpt: f.review_text ? f.review_text.substring(0, 180) : '',
      submitted_at: f.submitted_at
    });
  });
  feedbackStats.average_rating = starsCount ? Number((starsSum / starsCount).toFixed(1)) : 0;
  
  feedbackList.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)).splice(20);
  analyzedCalls.sort((a, b) => new Date(b.called_at) - new Date(a.called_at)).splice(25);
  pendingItems.sort((a, b) => new Date(b.called_at) - new Date(a.called_at)).splice(12);

  const peakSlots = [...peakSlotsMap.entries()]
    .map(([slot, total_calls]) => ({ slot, total_calls }))
    .sort((a, b) => b.total_calls - a.total_calls || a.slot.localeCompare(b.slot))
    .slice(0, 5);
    
  const scriptPerformance = [...scriptPerfMap.entries()]
    .map(([script_version, stats]) => ({
      script_version,
      total_calls: stats.total,
      avg_rating: stats.ratingCount ? stats.ratingSum / stats.ratingCount : null
    }))
    .sort((a, b) => (b.avg_rating || 0) - (a.avg_rating || 0) || b.total_calls - a.total_calls)
    .slice(0, 5);


  const safeTotalCalls = Number(callStats?.total_calls) || 0;
  const safeAnswered = Number(callStats?.answered) || 0;
  const safeCompletedCalls = Number(callStats?.completed_calls) || 0;
  const safeCallbacksRequested = Number(callStats?.callbacks_requested) || 0;
  const safeFailedCalls = Number(callStats?.failed_calls) || 0;
  const safeNoAnswer = Number(callStats?.no_answer) || 0;
  const safeDeclined = Number(callStats?.declined) || 0;
  const safeConsent = Number(callStats?.consent_given) || 0;  const safeFallbacks = Number(callStats?.fallbacks_triggered) || 0;
  const safeHotLeads = Number(callStats?.hot_leads) || 0;
  const safeFeedbackCount = Number(feedbackStats?.feedback_count) || 0;
  const safeGoodCount = Number(feedbackStats?.good_count) || 0;
  const safeAverageCount = Number(feedbackStats?.average_count) || 0;
  const safeBadCount = Number(feedbackStats?.bad_count) || 0;
  const averageRating = Number(feedbackStats?.average_rating) || 0;
  const successRate = safeTotalCalls > 0 ? Number(((safeAnswered / safeTotalCalls) * 100).toFixed(1)) : 0;
  const completionRate = safeTotalCalls > 0 ? Number(((safeCompletedCalls / safeTotalCalls) * 100).toFixed(1)) : 0;

  const objectionCounts = new Map();
  const competitorCounts = new Map();
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };

  analyzedCalls.forEach((call) => {
    let objections = [], competitors = [];
    try { objections = JSON.parse(call.objections_json || '[]'); } catch(e) {}
    try { competitors = JSON.parse(call.competitor_mentions_json || '[]'); } catch(e) {}
    const sentiment = String(call.sentiment_label || '').toLowerCase();

    objections.forEach((item) => objectionCounts.set(item, (objectionCounts.get(item) || 0) + 1));
    competitors.forEach((item) => competitorCounts.set(item, (competitorCounts.get(item) || 0) + 1));

    if (sentiment === 'positive') sentimentCounts.positive += 1;
    else if (sentiment === 'negative') sentimentCounts.negative += 1;
    else if (sentiment === 'neutral') sentimentCounts.neutral += 1;
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

  const hotLeadQueue = analyzedCalls
    .filter((call) => ['interested', 'hot_lead'].includes(String(call.outcome || '').toLowerCase()) || Number(call.hot_lead_score || 0) >= 85)
    .slice(0, 6)
    .map((call) => ({
      customer_name: call.customer_name,
      hot_lead_score: Number(call.hot_lead_score || 0),
      follow_up_task: call.follow_up_task || 'Sales callback recommended',
      called_at: call.called_at
    }));

  const serviceRecoveryQueue = analyzedCalls
    .filter((call) => String(call.sentiment_label || '').toLowerCase() === 'negative' || Number(call.extracted_rating || 0) <= 2)
    .slice(0, 6)
    .map((call) => ({
      customer_name: call.customer_name,
      issue: call.report_excerpt || call.analysis_summary || 'Service recovery recommended',
      follow_up_task: call.follow_up_task || 'Manager callback required',
      called_at: call.called_at
    }));

  const topWins = analyzedCalls
    .filter((call) => Number(call.extracted_rating || 0) >= 4 || String(call.sentiment_label || '').toLowerCase() === 'positive')
    .slice(0, 5)
    .map((call) => ({
      customer_name: call.customer_name,
      summary: call.report_excerpt || call.analysis_summary || 'Positive patient response',
      rating: Number(call.extracted_rating || 0) || null
    }));

  const labelTitle = String(label || 'today')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
  const effectiveHotLeadCount = Math.max(safeHotLeads, hotLeadQueue.length);
  const serviceRecoveryCount = serviceRecoveryQueue.length;
  const callbackBacklogCount = pendingItems.filter((item) => String(item.outcome || '').toLowerCase() === 'callback').length || safeCallbacksRequested;

  const priorityActions = [
    effectiveHotLeadCount
      ? `${effectiveHotLeadCount} commercial lead${effectiveHotLeadCount > 1 ? 's need' : ' needs'} same-day follow-up`
      : null,
    callbackBacklogCount
      ? `${callbackBacklogCount} callback request${callbackBacklogCount > 1 ? 's are' : ' is'} waiting in queue`
      : null,
    serviceRecoveryCount
      ? `${serviceRecoveryCount} patient issue${serviceRecoveryCount > 1 ? 's need' : ' needs'} service recovery attention`
      : null,
    commonObjections[0]
      ? `Top friction point is ${commonObjections[0].label} across ${commonObjections[0].count} calls`
      : null
  ].filter(Boolean);

  const reportHeadline = safeTotalCalls
    ? `${labelTitle} follow-up health: ${safeCompletedCalls}/${safeTotalCalls} calls completed with ${averageRating ? `${averageRating}/5` : 'limited'} patient rating signal.`
    : `${labelTitle} follow-up health: no call activity captured yet.`;

  const summaryText = safeTotalCalls
    ? `${labelTitle} POC snapshot: ${safeCompletedCalls} of ${safeTotalCalls} calls were completed (${completionRate}%), ${safeFeedbackCount} patient reviews were captured at an average rating of ${averageRating || 0}/5, ${effectiveHotLeadCount} revenue-ready lead${effectiveHotLeadCount === 1 ? '' : 's'} surfaced, and ${serviceRecoveryCount} service recovery case${serviceRecoveryCount === 1 ? '' : 's'} need follow-up.`
    : `${labelTitle} POC snapshot: no calls were captured in the selected range.`;

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
    completed_calls: safeCompletedCalls,
    failed_calls: safeFailedCalls,
    callbacks_requested: safeCallbacksRequested,
    answered: safeAnswered,
    no_answer: safeNoAnswer,
    declined: safeDeclined,
    consent_given: safeConsent,
    fallbacks_triggered: safeFallbacks,
    hot_leads: effectiveHotLeadCount,
    feedback_count: safeFeedbackCount,
    average_rating: averageRating,
    success_rate: successRate,
    completion_rate: completionRate,
    good_count: safeGoodCount,
    average_count: safeAverageCount,
    bad_count: safeBadCount,
    positive_sentiment_count: sentimentCounts.positive,
    neutral_sentiment_count: sentimentCounts.neutral,
    negative_sentiment_count: sentimentCounts.negative,
    feedback: feedbackList,
    analyzed_calls: enrichedCalls,
    pending_items: pendingItems,
    peak_slots: peakSlots,
    script_performance: scriptPerformance,
    common_objections: commonObjections,
    competitor_mentions: competitorMentions,
    revenue_pipeline_estimate: Number(revenuePipeline.toFixed(2)),
    callback_backlog_count: callbackBacklogCount,
    service_recovery_count: serviceRecoveryCount,
    report_headline: reportHeadline,
    priority_actions: priorityActions,
    hot_lead_queue: hotLeadQueue,
    service_recovery_queue: serviceRecoveryQueue,
    top_wins: topWins,
    dashboard_link: publicBaseUrl ? `${publicBaseUrl}/admin.html` : null,
    summary_text: summaryText
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
    best_slots: bestSlots,
    executive_summary: report.summary_text
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
  
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data: callsOwnerAlerts } = await supabase
    .from('calls')
    .select('id, customer_id, called_at, outcome, call_type, hot_lead_score, follow_up_task, next_action_at, analysis_summary, report_excerpt, sentiment_label, supervisor_alert_level, live_red_flag, customers(name, phone, admin_review_required, wrong_number_flag, next_retry_at, pending_follow_ups, revenue_estimate)')
    .gte('called_at', sevenDaysAgo.toISOString())
    .order('called_at', { ascending: false })
    .limit(40);
    
  const ownerAlerts = (callsOwnerAlerts || []).map(c => ({
    call_id: c.id,
    customer_id: c.customer_id,
    customer_name: c.customers?.name,
    customer_phone: c.customers?.phone,
    called_at: c.called_at,
    outcome: c.outcome,
    call_type: c.call_type,
    hot_lead_score: c.hot_lead_score,
    follow_up_task: c.follow_up_task,
    next_action_at: c.next_action_at,
    analysis_summary: c.analysis_summary,
    report_excerpt: c.report_excerpt,
    sentiment_label: c.sentiment_label,
    supervisor_alert_level: c.supervisor_alert_level,
    live_red_flag: c.live_red_flag,
    admin_review_required: c.customers?.admin_review_required,
    wrong_number_flag: c.customers?.wrong_number_flag,
    next_retry_at: c.customers?.next_retry_at,
    pending_follow_ups: c.customers?.pending_follow_ups,
    revenue_estimate: c.customers?.revenue_estimate
  }));

  const { data: campaignConfigsData } = await supabase
    .from('campaign_configs')
    .select('name, service_name, monthly_spend_inr, status')
    .or('status.is.null,status.eq.active')
    .order('created_at', { ascending: false })
    .order('name', { ascending: true });
    
  const campaignConfigs = campaignConfigsData || [];

  const { data: customersCampaignData } = await supabase
    .from('customers')
    .select('campaign_name, status, revenue_stage, revenue_estimate');
    
  const campaignPerfMap = new Map();
  (customersCampaignData || []).forEach(c => {
    const cname = c.campaign_name || 'Unassigned';
    if (!campaignPerfMap.has(cname)) campaignPerfMap.set(cname, { total_customers: 0, active_leads: 0, qualified_leads: 0, revenue_pipeline: 0 });
    const cp = campaignPerfMap.get(cname);
    cp.total_customers++;
    if (['hot_lead', 'completed', 'called', 'callback_scheduled'].includes(c.status)) cp.active_leads++;
    if (['qualified', 'follow_up'].includes(c.revenue_stage)) cp.qualified_leads++;
    cp.revenue_pipeline += Number(c.revenue_estimate || 0);
  });
  
  const campaignPerformance = [...campaignPerfMap.entries()].map(([campaign_name, metrics]) => ({ campaign_name, ...metrics })).sort((a, b) => b.revenue_pipeline - a.revenue_pipeline || b.total_customers - a.total_customers);

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
