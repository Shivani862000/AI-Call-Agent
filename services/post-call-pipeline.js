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

function buildTwilioAuthHeader() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

async function downloadRecording(recordingUrl, callSid) {
  if (!recordingUrl) {
    return null;
  }

  await ensureRecordingsDir();
  const response = await fetch(recordingUrl, {
    headers: {
      Authorization: buildTwilioAuthHeader()
    }
  });

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

async function upsertFeedbackFromAnalysis({ repositories, clientId, callRecord, reviewText, stars }) {
  const effectiveReviewText = reviewText || 'Customer shared feedback on the call.';
  const effectiveStars = Number.isInteger(stars) ? stars : 3;
  const categorization = await categorizeFeedback(effectiveReviewText, effectiveStars);
  const existingFeedback = await repositories.feedback.findByCallId(clientId, callRecord.id);
  const saved = await repositories.feedback.upsertForCall(clientId, {
    customer_id: callRecord.customer_id,
    call_id: callRecord.id,
    review_text: effectiveReviewText,
    category: categorization.category,
    stars: effectiveStars,
    submitted_at: new Date().toISOString(),
    source: 'call'
  });
  return { feedbackId: saved.id, category: categorization.category, updated: Boolean(existingFeedback) };
}

async function processCompletedCallPipeline({ repositories, clientId, callSid }) {
  const callRecord = await repositories.calls.findByTwilioSidWithCustomer(clientId, callSid);

  if (!callRecord) {
    return { ok: false, reason: 'call_not_found' };
  }

  await repositories.calls.update(clientId, callRecord.id, {
    transcript_status: 'processing',
    analysis_status: 'processing'
  });

  let recordingLocalPath = callRecord.recording_local_path || null;
  if (!recordingLocalPath && callRecord.recording_url) {
    try {
      recordingLocalPath = await downloadRecording(callRecord.recording_url, callRecord.twilio_sid);
    } catch (error) {
      await repositories.calls.update(clientId, callRecord.id, {
        transcript_status: 'download_failed',
        analysis_status: 'blocked'
      });
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
    await repositories.calls.update(clientId, callRecord.id, {
      transcript_status: 'missing',
      analysis_status: 'blocked'
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

  await repositories.calls.update(clientId, callRecord.id, {
    transcript_text: transcriptText,
    transcript_status: 'completed',
    transcript_source: transcriptSource,
    analysis_status: 'completed',
    analysis_summary: analysis.summary || null,
    analysis,
    key_points: analysis.key_points || [],
    report_excerpt: analysis.report_excerpt || null,
    extracted_rating: mergedRating,
    extracted_review_text: mergedReviewText || null,
    outcome_detail: outcome,
    sentiment_label: sentimentLabel,
    sentiment_score: sentimentScore,
    competitor_mentions: competitors,
    objections,
    callback_requested: outcome === 'callback',
    interest_detected: outcome === 'interested',
    recording_consent_captured: analysis.consent !== false,
    language: analysis.language || heuristicExtraction.language || callRecord.language,
    consent_detected: analysis.consent === null
      ? heuristicExtraction.consentDetected
      : Boolean(analysis.consent),
    analysis_completed_at: new Date().toISOString()
  });

  const feedbackResult = await upsertFeedbackFromAnalysis({
    repositories,
    clientId,
    callRecord,
    reviewText: mergedReviewText,
    stars: mergedRating
  });

  await repositories.calls.update(clientId, callRecord.id, {
    feedback_saved_at: new Date().toISOString(),
    outcome: callRecord.outcome || 'completed'
  });

  const refreshedCall = await repositories.calls.findById(clientId, callRecord.id);
  const refreshedCustomer = await repositories.customers.findById(clientId, callRecord.customer_id);

  const workflowResult = await applyCallOutcomeWorkflow({
    repositories,
    clientId,
    callRecord: refreshedCall,
    customer: refreshedCustomer,
    providerStatus: refreshedCall.outcome,
    inferredOutcome: outcome
  });

  if (sentimentLabel === 'negative' || objections.length > 0) {
    await createSupervisorEvent({
      repositories,
      clientId,
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

  const updatedCall = await repositories.calls.findById(clientId, callRecord.id);
  const updatedCustomer = await repositories.customers.findById(clientId, callRecord.customer_id);

  const currentRevenue = Number(updatedCustomer.revenue_estimate) || 0;
  const attributedRevenue = outcome === 'interested'
    ? Math.max(Number(updatedCall.hot_lead_score) || 0, currentRevenue)
    : currentRevenue;
  await repositories.customers.update(clientId, callRecord.customer_id, {
    last_sentiment_label: sentimentLabel,
    last_sentiment_score: sentimentScore,
    pending_follow_ups: workflowResult.followUpTask || updatedCustomer.pending_follow_ups,
    last_competitor_mention: competitors[0] || null,
    revenue_stage: outcome === 'interested'
      ? 'qualified'
      : outcome === 'callback'
        ? 'follow_up'
        : updatedCustomer.revenue_stage || 'unassigned',
    revenue_estimate: attributedRevenue
  });

  try {
    await syncCallToCrm({ repositories, clientId, callId: updatedCall.id });
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
      await repositories.calls.update(clientId, updatedCall.id, {
        whatsapp_summary_sent: true,
        whatsapp_sent: true
      });
    }
  } catch (error) {
    console.error('[WHATSAPP SUMMARY ERROR]', error.message);
  }

  if (String(updatedCall.outcome || '').toLowerCase() === 'interested') {
    await repositories.calls.update(clientId, updatedCall.id, {
      proposal_triggered: true,
      invoice_triggered: true,
      revenue_attribution_status: 'qualified_pipeline'
    });
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
