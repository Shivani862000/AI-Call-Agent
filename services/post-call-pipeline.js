const fs = require('fs');
const path = require('path');
const supabase = require('../src/supabase');
const { analyzeCallTranscript, transcribeAudioFile, categorizeFeedback } = require('./gemini');
const { extractCallFeedback } = require('./call-feedback');
const { buildCallAnalysis, storeCallAnalysis } = require('./call-analysis');
const logger = require('./system-logger');
const {
  detectConversationOutcome,
  detectObjectionsAndCompetitors,
  deriveSentimentScore,
  applyCallOutcomeWorkflow,
  createSupervisorEvent
} = require('./call-orchestration');
const { syncCallToCrm, sendHotLeadAlert } = require('./crm-sync');

const RECORDINGS_DIR = path.join('/tmp', 'feedback-call-recordings');

async function ensureRecordingsDir() {
  await fs.promises.mkdir(RECORDINGS_DIR, { recursive: true });
}

async function downloadRecording(recordingUrl, callSid) {
  if (!recordingUrl) {
    return null;
  }

  await ensureRecordingsDir();
  const response = await fetch(recordingUrl);

  if (!response.ok) {
    throw new Error(`Recording download failed with status ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const targetPath = path.join(RECORDINGS_DIR, `${callSid || Date.now()}.mp3`);
  await fs.promises.writeFile(targetPath, Buffer.from(arrayBuffer));
  return targetPath;
}

function convertPlainTranscriptToTurns(transcriptText = '') {
  return String(transcriptText || '')
    .split('\n')
    .map((line) => {
      const divider = line.indexOf(':');
      if (divider === -1) {
        return null;
      }

      return {
        role: line.slice(0, divider).trim(),
        text: line.slice(divider + 1).trim()
      };
    })
    .filter((turn) => turn && turn.role && turn.text);
}

function buildTranscriptTextFromAudioTranscript(audioTranscript) {
  return String(audioTranscript || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

async function upsertFeedbackFromAnalysis({ callRecord, reviewText, stars }) {
  const hasReviewText = Boolean(String(reviewText || '').trim());
  const hasStars = Number.isInteger(stars);
  if (!hasReviewText && !hasStars) {
    return { feedbackId: null, category: 'average', skipped: true };
  }

  const effectiveReviewText = hasReviewText ? reviewText : '';
  const effectiveStars = hasStars ? stars : 3;
  const categorization = await categorizeFeedback(effectiveReviewText, effectiveStars);
  const { data: existingFeedback } = await supabase.from('feedback').select('id').eq('call_id', callRecord.id).single();

  if (existingFeedback) {
    await supabase.from('feedback').update({
      review_text: effectiveReviewText,
      category: categorization.category,
      stars: effectiveStars,
      submitted_at: new Date().toISOString(),
      source: 'call'
    }).eq('id', existingFeedback.id);

    return { feedbackId: existingFeedback.id, category: categorization.category, updated: true };
  }

  const { data: result } = await supabase.from('feedback').insert([{
    customer_id: callRecord.customer_id,
    call_id: callRecord.id,
    review_text: effectiveReviewText,
    category: categorization.category,
    stars: effectiveStars,
    submitted_at: new Date().toISOString(),
    source: 'call'
  }]).select('id').single();

  return { feedbackId: result.id, category: categorization.category, updated: false };
}

async function processCompletedCallPipeline({ callSid, callId }) {
  let query = supabase.from('calls').select('*, customers(name, phone)');
  if (callId) {
    query = query.eq('id', callId);
  } else {
    query = query.eq('provider_call_id', callSid);
  }
  const { data: calls } = await query;
  
  let callRecord = null;
  if (calls && calls.length > 0) {
    const sortedCalls = calls.sort((a, b) => {
      const aHasT = (a.transcript_text || '') !== '' ? 0 : 1;
      const bHasT = (b.transcript_text || '') !== '' ? 0 : 1;
      if (aHasT !== bHasT) return aHasT - bHasT;
      const aComp = a.outcome === 'completed' ? 0 : 1;
      const bComp = b.outcome === 'completed' ? 0 : 1;
      if (aComp !== bComp) return aComp - bComp;
      return b.id - a.id;
    });
    callRecord = sortedCalls[0];
    if (callRecord) {
      callRecord.customer_name = callRecord.customers?.name;
      callRecord.customer_phone = callRecord.customers?.phone;
    }
  }

  if (!callRecord) {
    return { ok: false, reason: 'call_not_found' };
  }

  // Idempotency guard: skip if analysis already completed (prevents duplicate processing
  // when multiple completion paths trigger the pipeline, e.g. hangup + ws close)
  if (callRecord.analysis_status === 'completed') {
    return { ok: false, reason: 'already_processed' };
  }

  const { data: checkData } = await supabase.from('calls').select('analysis_status').eq('id', callRecord.id).single();
  if (['processing', 'completed'].includes(checkData?.analysis_status)) {
    return { ok: false, reason: 'already_processing' };
  }
  
  await supabase.from('calls').update({
    transcript_status: 'processing',
    analysis_status: 'processing'
  }).eq('id', callRecord.id);

  logger.info('FEEDBACK_ANALYSIS_STARTED', {
    callId: callRecord.id,
    customerId: callRecord.customer_id,
    patient: callRecord.customer_name,
    phone: callRecord.customer_phone
  });

  let recordingLocalPath = callRecord.recording_local_path || null;
  if (!recordingLocalPath && callRecord.recording_url) {
    try {
      recordingLocalPath = await downloadRecording(callRecord.recording_url, callRecord.provider_call_id);
      await supabase.from('calls').update({ recording_local_path: recordingLocalPath }).eq('id', callRecord.id);
    } catch (error) {
      await supabase.from('calls').update({ transcript_status: 'download_failed', analysis_status: 'blocked' }).eq('id', callRecord.id);
      throw error;
    }
  }

  let transcriptText = callRecord.transcript_text || '';
  let transcriptSource = transcriptText ? 'live_stream' : null;

  if (recordingLocalPath) {
    const audioTranscript = await transcribeAudioFile(recordingLocalPath, {
      language: callRecord.language || 'hi'
    });

    if (audioTranscript && audioTranscript.trim()) {
      transcriptText = buildTranscriptTextFromAudioTranscript(audioTranscript);
      transcriptSource = 'recording_stt';
    }
  }

  if (!transcriptText) {
    await supabase.from('calls').update({ transcript_status: 'missing', analysis_status: 'blocked' }).eq('id', callRecord.id);
    logger.warn('FEEDBACK_PENDING', {
      callId: callRecord.id,
      customerId: callRecord.customer_id,
      patient: callRecord.customer_name,
      phone: callRecord.customer_phone,
      reason: 'no_transcript_available'
    });
    return { ok: false, reason: 'no_transcript_available' };
  }

  const transcriptTurns = convertPlainTranscriptToTurns(transcriptText);
  const heuristicExtraction = transcriptTurns.length ? extractCallFeedback(transcriptTurns) : {
    reviewText: '',
    stars: null,
    consentDetected: false,
    language: null
  };
  const analysis = await analyzeCallTranscript(transcriptText, {
    customerName: callRecord.customer_name,
    clientName: process.env.CLIENT_NAME,
    callType: callRecord.call_type
  });
  const productAnalysis = buildCallAnalysis({
    ...callRecord,
    transcript_text: transcriptText
  });
  const outcome = detectConversationOutcome({
    analysisSummary: analysis.summary,
    reportExcerpt: analysis.report_excerpt,
    reviewText: analysis.review_text,
    transcriptText
  });
  const { objections, competitors } = detectObjectionsAndCompetitors({
    transcriptText,
    analysisSummary: analysis.summary
  });
  const sentimentLabel = analysis.customer_sentiment || 'neutral';
  const sentimentScore = Number(productAnalysis.sentiment_score || 0) || deriveSentimentScore(sentimentLabel);

  const mergedRating = Number.isInteger(analysis.rating) ? analysis.rating : heuristicExtraction.stars;
  const mergedReviewText = analysis.review_text || heuristicExtraction.reviewText || '';

  await supabase.from('calls').update({
    transcript_text: transcriptText,
    transcript_status: 'completed',
    transcript_source: transcriptSource,
    analysis_status: 'completed',
    summary: productAnalysis.summary || analysis.summary || null,
    analysis_summary: productAnalysis.summary || analysis.summary || null,
    analysis_json: JSON.stringify({ ...analysis, product_analysis: productAnalysis }),
    key_points_json: JSON.stringify(analysis.key_points || []),
    report_excerpt: analysis.report_excerpt || null,
    extracted_rating: mergedRating,
    extracted_review_text: mergedReviewText || null,
    outcome_detail: outcome,
    sentiment: productAnalysis.sentiment || sentimentLabel,
    sentiment_label: productAnalysis.sentiment || sentimentLabel,
    sentiment_score: sentimentScore,
    call_duration: productAnalysis.metrics.total_duration,
    ai_talk_time: productAnalysis.metrics.ai_talk_time,
    patient_talk_time: productAnalysis.metrics.patient_talk_time,
    quality_score: productAnalysis.quality_score,
    timeline_events: JSON.stringify(productAnalysis.timeline_events || []),
    extracted_entities: JSON.stringify(productAnalysis.entities || {}),
    competitor_mentions_json: JSON.stringify(competitors),
    objections_json: JSON.stringify(objections),
    callback_requested: outcome === 'callback' ? 1 : 0,
    interest_detected: outcome === 'interested' ? 1 : 0,
    recording_consent_captured: analysis.consent === false ? 0 : 1,
    language: analysis.language || heuristicExtraction.language || callRecord.language,
    consent_detected: analysis.consent === null ? (heuristicExtraction.consentDetected ? 1 : 0) : (analysis.consent ? 1 : 0),
    analysis_completed_at: new Date().toISOString()
  }).eq('id', callRecord.id);

  await storeCallAnalysis({
    callId: callRecord.id,
    analysis: {
      ...analysis,
      ...productAnalysis,
      sentiment: productAnalysis.sentiment || sentimentLabel,
      sentiment_score: sentimentScore,
      product_analysis: productAnalysis
    }
  });

  const feedbackResult = await upsertFeedbackFromAnalysis({
    callRecord,
    reviewText: mergedReviewText,
    stars: mergedRating
  });

  const { data: currentCall } = await supabase.from('calls').select('outcome').eq('id', callRecord.id).single();
  await supabase.from('calls').update({
    feedback_saved_at: new Date().toISOString(),
    outcome: currentCall?.outcome || 'completed'
  }).eq('id', callRecord.id);

  const finalSentimentLabel = productAnalysis.sentiment || sentimentLabel || 'neutral';
  const normalizedFinalSentiment = String(finalSentimentLabel || '').toLowerCase();
  const feedbackEvent = (Number(mergedRating || 0) >= 4 || normalizedFinalSentiment === 'positive')
    ? 'FEEDBACK_POSITIVE'
    : ((Number(mergedRating || 0) > 0 && Number(mergedRating || 0) <= 2) || normalizedFinalSentiment === 'negative')
      ? 'FEEDBACK_NEGATIVE'
      : 'FEEDBACK_PENDING';
  const feedbackDetails = {
    callId: callRecord.id,
    customerId: callRecord.customer_id,
    patient: callRecord.customer_name,
    phone: callRecord.customer_phone,
    sentiment: finalSentimentLabel,
    rating: Number(mergedRating || 0) ? `${mergedRating}/5` : '',
    feedbackId: feedbackResult.feedbackId
  };
  logger.info('FEEDBACK_ANALYSIS_COMPLETED', feedbackDetails);
  logger.info(feedbackEvent, feedbackDetails);

  const { data: refreshedCall } = await supabase.from('calls').select('*').eq('id', callRecord.id).single();
  const { data: refreshedCustomer } = await supabase.from('customers').select('*').eq('id', callRecord.customer_id).single();

  const workflowResult = await applyCallOutcomeWorkflow({
    callRecord: refreshedCall,
    customer: refreshedCustomer,
    providerStatus: refreshedCall.outcome,
    inferredOutcome: outcome
  });

  if (sentimentLabel === 'negative' || objections.length > 0) {
    await createSupervisorEvent({
      callId: refreshedCall.id,
      eventType: 'negative_signal_detected',
      severity: sentimentLabel === 'negative' ? 'high' : 'medium',
      payload: {
        objections,
        competitors,
        summary: analysis.summary || null
      }
    });
  }

  const { data: updatedCall } = await supabase.from('calls').select('*').eq('id', callRecord.id).single();
  const { data: updatedCustomer } = await supabase.from('customers').select('*').eq('id', callRecord.customer_id).single();

  const newRevenueEstimate = outcome === 'interested' ? Math.max(Number(updatedCall.hot_lead_score) || 0, Number(updatedCustomer.revenue_estimate) || 0) : Number(updatedCustomer.revenue_estimate) || 0;
  await supabase.from('customers').update({
    last_sentiment_label: sentimentLabel,
    last_sentiment_score: sentimentScore,
    pending_follow_ups: workflowResult.followUpTask || updatedCustomer.pending_follow_ups,
    last_competitor_mention: competitors[0] || null,
    revenue_stage: outcome === 'interested' ? 'qualified' : outcome === 'callback' ? 'follow_up' : updatedCustomer.revenue_stage || 'unassigned',
    revenue_estimate: newRevenueEstimate
  }).eq('id', callRecord.customer_id);

  try {
    await syncCallToCrm({ callId: updatedCall.id });
  } catch (error) {
    console.error('[CRM SYNC ERROR]', error.message);
  }

  if (String(updatedCall.outcome || '').toLowerCase() === 'interested') {
    try {
      await sendHotLeadAlert({ customer: updatedCustomer, call: updatedCall });
    } catch (error) {
      console.error('[HOT LEAD ALERT ERROR]', error.message);
    }
  }

  if (String(updatedCall.outcome || '').toLowerCase() === 'interested') {
    await supabase.from('calls').update({
      proposal_triggered: 1,
      invoice_triggered: 1,
      revenue_attribution_status: 'qualified_pipeline'
    }).eq('id', updatedCall.id);
  }

  return {
    ok: true,
    callId: callRecord.id,
    transcriptSource,
    summary: analysis.summary || null,
    feedbackId: feedbackResult.feedbackId,
    workflowResult
  };
}

module.exports = {
  processCompletedCallPipeline
};
