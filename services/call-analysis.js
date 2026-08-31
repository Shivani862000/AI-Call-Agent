const CALL_TYPES = Object.freeze({
  REVIEW_CALL: 'REVIEW_CALL',
  THREE_MONTH_FOLLOWUP: 'THREE_MONTH_FOLLOWUP'
});

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    // \p{M} keeps Devanagari vowel signs. Without it every matra is stripped
    // as punctuation and Hindi words shatter -- "बुरा" becomes "ब र" -- so no
    // Hindi keyword in this file could ever match. This is a Hindi-first
    // product; the analyser was effectively blind to most of what it heard.
    .replace(/[^\p{L}\p{N}\p{M}\s:]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCallType(value) {
  const normalized = String(value || CALL_TYPES.REVIEW_CALL).trim().toUpperCase();
  return normalized === CALL_TYPES.THREE_MONTH_FOLLOWUP ? CALL_TYPES.THREE_MONTH_FOLLOWUP : CALL_TYPES.REVIEW_CALL;
}

function formatCallType(value) {
  return normalizeCallType(value) === CALL_TYPES.THREE_MONTH_FOLLOWUP ? '3 Month Follow-up' : 'Review Calling';
}

function parseTranscriptTurns(transcriptText = '') {
  return String(transcriptText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\[?([A-Z]+)\]?\s*:\s*(.*)$/);
      if (!match) {
        return { role: 'NOTE', text: line };
      }
      const role = match[1] === 'AGENT' || match[1] === 'AI' ? 'AI' : match[1] === 'CUSTOMER' || match[1] === 'PATIENT' ? 'PATIENT' : match[1];
      return { role, text: match[2] || '' };
    })
    .filter((turn) => turn.text);
}

function formatTranscriptText(turns = []) {
  return turns.map((turn) => `${turn.role === 'AI' ? 'AI' : turn.role === 'PATIENT' ? 'PATIENT' : turn.role}: ${turn.text}`).join('\n');
}

function secondsBetween(start, end) {
  const startMs = start ? new Date(start).getTime() : 0;
  const endMs = end ? new Date(end).getTime() : 0;
  if (!startMs || !endMs || Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return 0;
  }
  return Math.round((endMs - startMs) / 1000);
}

function estimateTalkSeconds(turns, role) {
  const words = turns
    .filter((turn) => turn.role === role)
    .flatMap((turn) => String(turn.text || '').split(/\s+/).filter(Boolean));
  return Math.round(words.length * (role === 'AI' ? 0.34 : 0.42));
}

function boolLabel(value) {
  if (value === true) return 'YES';
  if (value === false) return 'NO';
  return 'UNKNOWN';
}

function findPatientAfter(turns, patterns) {
  const patternList = Array.isArray(patterns) ? patterns : [patterns];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role !== 'AI') continue;
    const normalized = normalizeText(turn.text);
    if (!patternList.some((pattern) => pattern.test(normalized))) continue;
    const nextPatient = turns.slice(index + 1).find(isPatientTurn);
    if (nextPatient) return nextPatient.text;
  }
  return '';
}

function isNo(value) {
  const normalized = normalizeText(value);
  return /\b(nahi|nahin|no|not yet|abhi nahi)\b/.test(normalized) || /नहीं|नही/.test(value || '');
}

function isYes(value) {
  const normalized = normalizeText(value);
  return /\b(haan|han|ha|yes|ji|jee|kiya|donate kiya|done)\b/.test(normalized) || /हाँ|हां|जी/.test(value || '');
}

function extractReviewEntities(turns) {
  const transcript = normalizeText(formatTranscriptText(turns));
  const problemAnswer = findPatientAfter(turns, [/dikkat|problem|issue/]);
  const problemReported = problemAnswer ? !isNo(problemAnswer) : /maaf kijiye|problem hui|issue/.test(transcript);
  const issueDescription = problemReported
    ? (findPatientAfter(turns, [/batayein|bataiye|problem hui/]) || problemAnswer || '')
    : '';

  return {
    problem_reported: problemAnswer ? problemReported : null,
    issue_description: issueDescription,
    social_media_mentioned: /facebook|google|video|subscribe|like|comment|review/.test(transcript),
    call_completed: /din shubh ho|dhanyavaad/.test(transcript)
  };
}

function extractFollowupEntities(turns) {
  const transcript = normalizeText(formatTranscriptText(turns));
  const donatedAnswer = findPatientAfter(turns, [/dobara blood donate|baad dobara|3 mahine/]);
  const donatedAgain = donatedAnswer ? isYes(donatedAnswer) && !isNo(donatedAnswer) : null;
  const donationDate = findPatientAfter(turns, [/kab donate/]);
  const donationPlace = findPatientAfter(turns, [/kahan donate/]);

  return {
    donated_again: donatedAgain,
    donation_date: donatedDateValue(donationDate),
    donation_place: donationPlace || '',
    interested_to_donate_again: donatedAgain === false ? /9 baje|5 baje|aa sakte|free blood|thalassemia/.test(transcript) : donatedAgain,
    donation_invitation_shared: /9 baje|5 baje|aa sakte|free blood|thalassemia/.test(transcript),
    call_completed: /din shubh ho|dhanyavaad/.test(transcript)
  };
}

function donatedDateValue(value) {
  const text = String(value || '').trim();
  return text || '';
}

/**
 * The media bridge labels the caller's turns CUSTOMER; older code and the
 * analyser's own formatter use PATIENT. Treating only one as the patient made
 * every patient turn invisible here, which pinned sentiment to its default.
 */
const PATIENT_ROLES = new Set(['PATIENT', 'CUSTOMER']);

function isPatientTurn(turn) {
  return PATIENT_ROLES.has(String(turn?.role || '').toUpperCase());
}

function detectSentiment(turns, entities, callType) {
  const patientText = normalizeText(turns.filter(isPatientTurn).map((turn) => turn.text).join(' '));
  const allText = normalizeText(formatTranscriptText(turns));
  let label = 'neutral';
  let confidence = 0.76;

  // "koi dikkat nahi hui" means the opposite of "dikkat". Negated complaints
  // are removed before looking for complaint words, or a satisfied patient
  // reads as an unhappy one. Not /g: a global regex keeps lastIndex between
  // .test() calls and would report false on alternate invocations.
  const NEGATED_COMPLAINT = /(?:koi |kuch |any )?(?:dikkat|problem|pareshani|takleef|shikayat|issue)\w*\s*(?:nahi|nahin|nhi|nai)\b|(?:कोई |कुछ )?(?:दिक्कत|परेशानी|समस्या|तकलीफ|शिकायत)\s*(?:नहीं|नही)/;
  const complaintText = patientText.replace(new RegExp(NEGATED_COMPLAINT, 'g'), ' ');

  // "bura" and "kharab" are the words a Hindi speaker reaches for first, and
  // neither appeared here — so the clearest possible complaint scored neutral.
  const negativeSignals = /(problem|dikkat|issue|pain|chakkar|weak|bad|complaint|nahi hua|bura|buri|kharab|kharaab|ganda|pareshani|takleef|slow|late|rude|नहीं ठीक|दिक्कत|बुरा|बुरी|ख़राब|खराब|परेशानी|तकलीफ|गंदा|दर्द)/.test(complaintText);
  // A negated complaint is itself a positive signal.
  const positiveSignals = NEGATED_COMPLAINT.test(patientText)
    || /(theek|achha|accha|acha|badhiya|good|great|haan ji|thank|dhanyavaad|no problem|ठीक|अच्छा|अच्छी|बढ़िया|धन्यवाद)/.test(patientText);

  // Checked before the positive branch: "koi dikkat nahi" contains "dikkat",
  // and "bahut achha" alongside a complaint should not cancel it out.

  if (negativeSignals || entities.problem_reported === true) {
    label = 'negative';
    confidence = 0.86;
  } else if (callType === CALL_TYPES.REVIEW_CALL && entities.problem_reported === false) {
    label = 'positive';
    confidence = 0.9;
  } else if (positiveSignals || /bahut achhi baat|bahut achha/.test(allText)) {
    label = 'positive';
    confidence = 0.82;
  }

  return { label, confidence };
}

function buildSummary(callType, entities, outcome) {
  if (normalizeCallType(callType) === CALL_TYPES.THREE_MONTH_FOLLOWUP) {
    if (entities.donated_again === true) {
      return [
        'Donor was successfully contacted.',
        'Donor confirmed they donated blood again after 3 months.',
        entities.donation_date ? `Donation date was captured as: ${entities.donation_date}.` : 'Donation date was requested.',
        entities.donation_place ? `Donation place was captured as: ${entities.donation_place}.` : 'Donation place was requested.',
        'Call completed successfully.'
      ].join(' ');
    }

    if (entities.donated_again === false) {
      return [
        'Donor was successfully contacted.',
        'Donor has not donated blood again after 3 months.',
        'Donation invitation and 9 AM to 5 PM visit timing were shared.',
        'Call completed successfully.'
      ].join(' ');
    }
  }

  if (entities.problem_reported === true) {
    return [
      'Donor was successfully contacted.',
      'A post-donation issue was reported and captured.',
      'The donor was assured that the concern will be shared with the relevant officer.',
      'Social media and review message was shared.',
      'Call completed successfully.'
    ].join(' ');
  }

  if (entities.problem_reported === false) {
    return [
      'Donor was successfully contacted.',
      'No post-donation issues were reported.',
      'Donor was thanked and informed about social media channels.',
      'Call completed successfully.'
    ].join(' ');
  }

  return outcome === 'completed'
    ? 'Call completed. Limited structured information was available in the transcript.'
    : 'Call did not complete successfully. Analysis is based on available call data.';
}

function buildOutcomeCards(callType, entities) {
  if (normalizeCallType(callType) === CALL_TYPES.THREE_MONTH_FOLLOWUP) {
    return [
      { label: 'Donated Again', value: boolLabel(entities.donated_again), tone: entities.donated_again ? 'positive' : 'neutral' },
      { label: 'Donation Date', value: entities.donation_date || '', tone: 'info' },
      { label: 'Donation Place', value: entities.donation_place || '', tone: 'info' },
      { label: 'Interested To Donate Again', value: boolLabel(entities.interested_to_donate_again), tone: entities.interested_to_donate_again ? 'positive' : 'neutral' }
    ];
  }

  return [
    { label: 'Problem Reported', value: boolLabel(entities.problem_reported), tone: entities.problem_reported ? 'negative' : 'positive' },
    { label: 'Issue Description', value: entities.issue_description || '', tone: entities.issue_description ? 'negative' : 'neutral' },
    { label: 'Social Media Mentioned', value: boolLabel(entities.social_media_mentioned), tone: entities.social_media_mentioned ? 'positive' : 'neutral' },
    { label: 'Call Completed', value: boolLabel(entities.call_completed), tone: entities.call_completed ? 'positive' : 'negative' }
  ];
}

function offsetTime(baseDate, seconds) {
  const baseMs = baseDate ? new Date(baseDate).getTime() : Date.now();
  const date = new Date((Number.isNaN(baseMs) ? Date.now() : baseMs) + (seconds * 1000));
  return date.toISOString();
}

function buildTimeline(call, turns, summaryGenerated) {
  const start = call.answered_at || call.called_at || call.created_at || new Date().toISOString();
  const timeline = [
    { at: start, label: 'Call Connected', status: 'completed' }
  ];
  if (turns.some((turn) => turn.role === 'AI')) {
    timeline.push({ at: offsetTime(start, 8), label: 'Greeting Completed', status: 'completed' });
  }
  if (turns.some((turn) => turn.role === 'AI' && /\?/.test(turn.text))) {
    timeline.push({ at: offsetTime(start, 18), label: 'Question Asked', status: 'completed' });
  }
  if (turns.some(isPatientTurn)) {
    timeline.push({ at: offsetTime(start, 28), label: 'Patient Response Captured', status: 'completed' });
  }
  if (summaryGenerated) {
    timeline.push({ at: call.analysis_completed_at || call.ended_at || offsetTime(start, 45), label: 'Summary Generated', status: 'completed' });
  }
  timeline.push({ at: call.ended_at || offsetTime(start, 60), label: 'Call Completed', status: String(call.outcome || '').toLowerCase() === 'completed' ? 'completed' : 'attention' });
  return timeline;
}

function buildMetrics(call, turns, responseTimes = []) {
  const duration = Number(call.call_duration || 0)
    || secondsBetween(call.answered_at || call.called_at, call.ended_at)
    || Math.round(Number(call.media_packets || 0) * 0.02);
  const aiTalkTime = Number(call.ai_talk_time || 0) || estimateTalkSeconds(turns, 'AI');
  const patientTalkTime = Number(call.patient_talk_time || 0) || estimateTalkSeconds(turns, 'PATIENT');
  const silenceDuration = Math.max(0, duration - aiTalkTime - patientTalkTime);
  const questionsAsked = turns.filter((turn) => turn.role === 'AI' && /\?/.test(turn.text)).length;
  const questionsAnswered = turns.filter(isPatientTurn).length;
  const averageResponseTime = responseTimes.length
    ? Math.round(responseTimes.reduce((sum, value) => sum + Number(value || 0), 0) / responseTimes.length)
    : null;

  return {
    total_duration: duration,
    ai_talk_time: aiTalkTime,
    patient_talk_time: patientTalkTime,
    silence_duration: silenceDuration,
    interruptions: 0,
    questions_asked: questionsAsked,
    questions_answered: questionsAnswered,
    average_response_time_ms: averageResponseTime
  };
}

function buildQuality(call, entities, metrics, summary) {
  const requiredDataCaptured = Object.entries(entities).some(([key, value]) => {
    if (['call_completed', 'social_media_mentioned', 'donation_invitation_shared'].includes(key)) {
      return false;
    }
    return value === true || value === false || (typeof value === 'string' && value.trim());
  });
  const checks = [
    { key: 'conversation_completed', label: 'Conversation Completed', passed: String(call.outcome || '').toLowerCase() === 'completed' || Boolean(entities.call_completed) },
    { key: 'required_questions_asked', label: 'Required Questions Asked', passed: Number(metrics.questions_asked || 0) > 0 },
    { key: 'required_data_captured', label: 'Required Data Captured', passed: requiredDataCaptured },
    { key: 'call_ended_properly', label: 'Call Ended Properly', passed: Boolean(call.ended_at) || String(call.outcome || '').toLowerCase() === 'completed' },
    { key: 'analysis_generated', label: 'Analysis Generated', passed: Boolean(summary) }
  ];
  const score = Math.round((checks.filter((check) => check.passed).length / checks.length) * 100);
  return { score, checks };
}

function buildCallAnalysis(call = {}) {
  const callType = normalizeCallType(call.call_type);
  const turns = parseTranscriptTurns(call.transcript_text || '');
  const entities = callType === CALL_TYPES.THREE_MONTH_FOLLOWUP
    ? extractFollowupEntities(turns)
    : extractReviewEntities(turns);
  const sentiment = detectSentiment(turns, entities, callType);
  const summary = buildSummary(callType, entities, String(call.outcome || '').toLowerCase());
  const metrics = buildMetrics(call, turns);
  const quality = buildQuality(call, entities, metrics, summary);
  const timeline = buildTimeline(call, turns, Boolean(summary));

  return {
    summary,
    call_type: callType,
    call_type_label: formatCallType(callType),
    sentiment: sentiment.label,
    // Signed, so a negative call does not store a positive-looking number.
    // Magnitude is the classifier's confidence.
    sentiment_score: sentiment.label === 'negative' ? -sentiment.confidence
      : sentiment.label === 'positive' ? sentiment.confidence : 0,
    entities,
    outcome_cards: buildOutcomeCards(callType, entities),
    timeline_events: timeline,
    metrics,
    quality_score: quality.score,
    quality_checks: quality.checks,
    transcript_turns: turns
  };
}

async function storeCallAnalysis({ dbRun, callId, analysis }) {
  await dbRun(
    `UPDATE calls
        SET summary = ?,
            analysis_summary = ?,
            sentiment = ?,
            sentiment_label = ?,
            sentiment_score = ?,
            call_duration = ?,
            ai_talk_time = ?,
            patient_talk_time = ?,
            quality_score = ?,
            timeline_events = ?,
            extracted_entities = ?,
            analysis_json = ?,
            analysis_status = ?,
            analysis_completed_at = ?
      WHERE id = ?`,
    [
      analysis.summary,
      analysis.summary,
      analysis.sentiment,
      analysis.sentiment,
      analysis.sentiment_score,
      analysis.metrics.total_duration,
      analysis.metrics.ai_talk_time,
      analysis.metrics.patient_talk_time,
      analysis.quality_score,
      JSON.stringify(analysis.timeline_events || []),
      JSON.stringify(analysis.entities || {}),
      JSON.stringify(analysis),
      'completed',
      new Date().toISOString(),
      callId
    ]
  );
}

module.exports = {
  CALL_TYPES,
  buildCallAnalysis,
  formatCallType,
  normalizeCallType,
  parseTranscriptTurns,
  storeCallAnalysis
};
