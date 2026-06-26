const fs = require('fs');
const path = require('path');
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

async function upsertFeedbackFromAnalysis({ dbGet, dbRun, callRecord, reviewText, stars }) {
  const hasReviewText = Boolean(String(reviewText || '').trim());
  const hasStars = Number.isInteger(stars);
  if (!hasReviewText && !hasStars) {
    return { feedbackId: null, category: 'average', skipped: true };
  }

  const effectiveReviewText = hasReviewText ? reviewText : '';
  const effectiveStars = hasStars ? stars : 3;
  const categorization = await categorizeFeedback(effectiveReviewText, effectiveStars);
  const existingFeedback = await dbGet('SELECT id FROM feedback WHERE call_id = ?', [callRecord.id]);

  if (existingFeedback) {
    await dbRun(
      `UPDATE feedback
          SET review_text = ?,
              category = ?,
              stars = ?,
              submitted_at = ?,
              source = ?
        WHERE id = ?`,
      [
        effectiveReviewText,
        categorization.category,
        effectiveStars,
        new Date().toISOString(),
        'call',
        existingFeedback.id
      ]
    );

    return { feedbackId: existingFeedback.id, category: categorization.category, updated: true };
  }

  const result = await dbRun(
    `INSERT INTO feedback (customer_id, call_id, review_text, category, stars, submitted_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      callRecord.customer_id,
      callRecord.id,
      effectiveReviewText,
      categorization.category,
      effectiveStars,
      new Date().toISOString(),
      'call'
    ]
  );

  return { feedbackId: result.lastID, category: categorization.category, updated: false };
}

async function processCompletedCallPipeline({ dbGet, dbRun, callSid, callId }) {
  const callRecord = await dbGet(
    `SELECT calls.*, customers.name AS customer_name, customers.phone AS customer_phone
     FROM calls
     LEFT JOIN customers ON customers.id = calls.customer_id
     WHERE ${callId ? 'calls.id = ?' : 'calls.provider_call_id = ?'}
     ORDER BY
       CASE WHEN COALESCE(calls.transcript_text, '') != '' THEN 0 ELSE 1 END,
       CASE WHEN calls.outcome = 'completed' THEN 0 ELSE 1 END,
       calls.id DESC
     LIMIT 1`,
    [callId || callSid]
  );

  if (!callRecord) {
    return { ok: false, reason: 'call_not_found' };
  }

  // Idempotency guard: skip if analysis already completed (prevents duplicate processing
  // when multiple completion paths trigger the pipeline, e.g. hangup + ws close)
  if (callRecord.analysis_status === 'completed') {
    return { ok: false, reason: 'already_processed' };
  }

  const claimResult = await dbRun(
    `UPDATE calls
        SET transcript_status = ?,
            analysis_status = ?
      WHERE id = ?
        AND COALESCE(analysis_status, 'pending') NOT IN ('processing', 'completed')`,
    ['processing', 'processing', callRecord.id]
  );

  if (!claimResult.changes) {
    return { ok: false, reason: 'already_processing' };
  }

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
      await dbRun('UPDATE calls SET recording_local_path = ? WHERE id = ?', [recordingLocalPath, callRecord.id]);
    } catch (error) {
      await dbRun('UPDATE calls SET transcript_status = ?, analysis_status = ? WHERE id = ?', ['download_failed', 'blocked', callRecord.id]);
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
    await dbRun('UPDATE calls SET transcript_status = ?, analysis_status = ? WHERE id = ?', ['missing', 'blocked', callRecord.id]);
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

  await dbRun(
    `UPDATE calls
        SET transcript_text = ?,
            transcript_status = ?,
            transcript_source = ?,
            analysis_status = ?,
            summary = ?,
            analysis_summary = ?,
            analysis_json = ?,
            key_points_json = ?,
            report_excerpt = ?,
            extracted_rating = ?,
            extracted_review_text = ?,
            outcome_detail = ?,
            sentiment = ?,
            sentiment_label = ?,
            sentiment_score = ?,
            call_duration = ?,
            ai_talk_time = ?,
            patient_talk_time = ?,
            quality_score = ?,
            timeline_events = ?,
            extracted_entities = ?,
            competitor_mentions_json = ?,
            objections_json = ?,
            callback_requested = ?,
            interest_detected = ?,
            recording_consent_captured = ?,
            language = COALESCE(?, language),
            consent_detected = ?,
            analysis_completed_at = ?
      WHERE id = ?`,
    [
      transcriptText,
      'completed',
      transcriptSource,
      'completed',
      productAnalysis.summary || analysis.summary || null,
      productAnalysis.summary || analysis.summary || null,
      JSON.stringify({ ...analysis, product_analysis: productAnalysis }),
      JSON.stringify(analysis.key_points || []),
      analysis.report_excerpt || null,
      mergedRating,
      mergedReviewText || null,
      outcome,
      productAnalysis.sentiment || sentimentLabel,
      productAnalysis.sentiment || sentimentLabel,
      sentimentScore,
      productAnalysis.metrics.total_duration,
      productAnalysis.metrics.ai_talk_time,
      productAnalysis.metrics.patient_talk_time,
      productAnalysis.quality_score,
      JSON.stringify(productAnalysis.timeline_events || []),
      JSON.stringify(productAnalysis.entities || {}),
      JSON.stringify(competitors),
      JSON.stringify(objections),
      outcome === 'callback' ? 1 : 0,
      outcome === 'interested' ? 1 : 0,
      analysis.consent === false ? 0 : 1,
      analysis.language || heuristicExtraction.language,
      analysis.consent === null ? (heuristicExtraction.consentDetected ? 1 : 0) : (analysis.consent ? 1 : 0),
      new Date().toISOString(),
      callRecord.id
    ]
  );

  await storeCallAnalysis({
    dbRun,
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
    dbGet,
    dbRun,
    callRecord,
    reviewText: mergedReviewText,
    stars: mergedRating
  });

  await dbRun('UPDATE calls SET feedback_saved_at = ?, outcome = COALESCE(outcome, ?) WHERE id = ?', [
    new Date().toISOString(),
    'completed',
    callRecord.id
  ]);

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

  const refreshedCall = await dbGet('SELECT * FROM calls WHERE id = ?', [callRecord.id]);
  const refreshedCustomer = await dbGet('SELECT * FROM customers WHERE id = ?', [callRecord.customer_id]);

  const workflowResult = await applyCallOutcomeWorkflow({
    dbGet,
    dbRun,
    callRecord: refreshedCall,
    customer: refreshedCustomer,
    providerStatus: refreshedCall.outcome,
    inferredOutcome: outcome
  });

  if (sentimentLabel === 'negative' || objections.length > 0) {
    await createSupervisorEvent({
      dbRun,
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

  const updatedCall = await dbGet('SELECT * FROM calls WHERE id = ?', [callRecord.id]);
  const updatedCustomer = await dbGet('SELECT * FROM customers WHERE id = ?', [callRecord.customer_id]);

  await dbRun(
    `UPDATE customers
        SET last_sentiment_label = ?,
            last_sentiment_score = ?,
            pending_follow_ups = COALESCE(?, pending_follow_ups),
            last_competitor_mention = ?,
            revenue_stage = ?,
            revenue_estimate = CASE
              WHEN ? > COALESCE(revenue_estimate, 0) THEN ?
              ELSE revenue_estimate
            END
      WHERE id = ?`,
    [
      sentimentLabel,
      sentimentScore,
      workflowResult.followUpTask || null,
      competitors[0] || null,
      outcome === 'interested' ? 'qualified' : outcome === 'callback' ? 'follow_up' : updatedCustomer.revenue_stage || 'unassigned',
      outcome === 'interested' ? Math.max(Number(updatedCall.hot_lead_score) || 0, Number(updatedCustomer.revenue_estimate) || 0) : Number(updatedCustomer.revenue_estimate) || 0,
      outcome === 'interested' ? Math.max(Number(updatedCall.hot_lead_score) || 0, Number(updatedCustomer.revenue_estimate) || 0) : Number(updatedCustomer.revenue_estimate) || 0,
      callRecord.customer_id
    ]
  );

  try {
    await syncCallToCrm({ dbGet, dbRun, callId: updatedCall.id });
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
    await dbRun(
      'UPDATE calls SET proposal_triggered = ?, invoice_triggered = ?, revenue_attribution_status = ? WHERE id = ?',
      [1, 1, 'qualified_pipeline', updatedCall.id]
    );
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
