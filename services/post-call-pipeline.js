const fs = require('fs');
const path = require('path');
const { analyzeCallTranscript, transcribeAudioFile, categorizeFeedback } = require('./openai');
const { extractCallFeedback } = require('./call-feedback');
const {
  detectConversationOutcome,
  detectObjectionsAndCompetitors,
  deriveSentimentScore,
  applyCallOutcomeWorkflow,
  sendCustomerWhatsAppSummary,
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
  const effectiveReviewText = reviewText || 'Customer shared feedback on the call.';
  const effectiveStars = Number.isInteger(stars) ? stars : 3;
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

async function processCompletedCallPipeline({ dbGet, dbRun, callSid }) {
  const callRecord = await dbGet(
    `SELECT calls.*, customers.name AS customer_name, customers.phone AS customer_phone
     FROM calls
     LEFT JOIN customers ON customers.id = calls.customer_id
     WHERE calls.provider_call_id = ?`,
    [callSid]
  );

  if (!callRecord) {
    return { ok: false, reason: 'call_not_found' };
  }

  await dbRun('UPDATE calls SET transcript_status = ?, analysis_status = ? WHERE id = ?', ['processing', 'processing', callRecord.id]);

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
    clientName: process.env.CLIENT_NAME
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
  const sentimentScore = deriveSentimentScore(sentimentLabel);

  const mergedRating = Number.isInteger(analysis.rating) ? analysis.rating : heuristicExtraction.stars;
  const mergedReviewText = analysis.review_text || heuristicExtraction.reviewText || '';

  await dbRun(
    `UPDATE calls
        SET transcript_text = ?,
            transcript_status = ?,
            transcript_source = ?,
            analysis_status = ?,
            analysis_summary = ?,
            analysis_json = ?,
            key_points_json = ?,
            report_excerpt = ?,
            extracted_rating = ?,
            extracted_review_text = ?,
            outcome_detail = ?,
            sentiment_label = ?,
            sentiment_score = ?,
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
      analysis.summary || null,
      JSON.stringify(analysis),
      JSON.stringify(analysis.key_points || []),
      analysis.report_excerpt || null,
      mergedRating,
      mergedReviewText || null,
      outcome,
      sentimentLabel,
      sentimentScore,
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

  try {
    const sent = await sendCustomerWhatsAppSummary({
      customer: updatedCustomer,
      callSummary: analysis.report_excerpt || analysis.summary
    });
    if (sent) {
      await dbRun('UPDATE calls SET whatsapp_summary_sent = ?, whatsapp_sent = ? WHERE id = ?', [1, 1, updatedCall.id]);
    }
  } catch (error) {
    console.error('[WHATSAPP SUMMARY ERROR]', error.message);
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
