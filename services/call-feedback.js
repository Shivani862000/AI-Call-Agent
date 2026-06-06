const { categorizeFeedback } = require('./gemini');

const NUMBER_WORDS = new Map([
  ['one', 1],
  ['ek', 1],
  ['एक', 1],
  ['1', 1],
  ['two', 2],
  ['do', 2],
  ['दो', 2],
  ['2', 2],
  ['three', 3],
  ['teen', 3],
  ['तीन', 3],
  ['3', 3],
  ['four', 4],
  ['char', 4],
  ['chaar', 4],
  ['चार', 4],
  ['चार्ज', 4],
  ['4', 4],
  ['five', 5],
  ['paanch', 5],
  ['panch', 5],
  ['पांच', 5],
  ['पाँच', 5],
  ['5', 5]
]);

const IGNORE_EXACT = new Set([
  'yes',
  'haan',
  'ha',
  'han',
  'ji',
  'ok',
  'okay',
  'hello',
  'hindi',
  'english',
  'hindi mein',
  'english mein'
]);

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectLanguage(customerTurns) {
  const combined = customerTurns.map((turn) => turn.text).join(' ').toLowerCase();

  if (/\b(hindi|haan|achha|accha|theek|thik|bahut|ji)\b/.test(combined)) {
    return 'hi';
  }

  if (/\b(english|overall|experience|staff|waiting|cleanliness)\b/.test(combined)) {
    return 'en';
  }

  return null;
}

function detectConsent(customerTurns) {
  const combined = customerTurns
    .slice(0, 4)
    .map((turn) => normalizeText(turn.text))
    .join(' ');

  if (!combined) {
    return false;
  }

  return /\b(yes|haan|ha|han|ji|bilkul|sure|okay|ok|continue|speak)\b/.test(combined);
}

function splitIntoExchanges(transcript = []) {
  const exchanges = [];
  let prompt = [];

  for (const turn of transcript) {
    if (!turn || !String(turn.text || '').trim()) {
      continue;
    }

    if (turn.role === 'AGENT') {
      prompt.push(String(turn.text).trim());
      continue;
    }

    if (turn.role === 'CUSTOMER') {
      exchanges.push({
        promptText: prompt.join(' ').trim(),
        responseText: String(turn.text).trim()
      });
      prompt = [];
    }
  }

  return exchanges;
}

function detectPromptType(promptText) {
  const normalized = normalizeText(promptText);

  if (!normalized) {
    return 'unknown';
  }

  if (/(hindi|english)/.test(normalized)) {
    return 'language';
  }

  if (/(2 to 3 minutes|2 3 minutes|feedback about your recent visit|recent visit ke feedback|recent visit)/.test(normalized)) {
    return 'consent';
  }

  if (/(1 se 5|scale|rating|excellent|star|stars)/.test(normalized)) {
    return 'rating';
  }

  if (/(overall experience|visit experience|aapka visit|experience kaisa|experience kaisa raha)/.test(normalized)) {
    return 'overall';
  }

  if (/(safai|cleanliness|hygiene|lab clean|lab cleanliness|clean and comfortable)/.test(normalized)) {
    return 'cleanliness';
  }

  if (/(staff|behaviour|behavior|specific person)/.test(normalized)) {
    return 'staff';
  }

  if (/(waiting time|sample collection|process|samjhaya|clearly)/.test(normalized)) {
    return 'process';
  }

  if (/(behtar|improve|suggestion|sujhav|could do better|aur.*kar sakte|improve your experience)/.test(normalized)) {
    return 'improvement';
  }

  return 'unknown';
}

function extractNumericRatingFromText(text) {
  const candidates = [];

  const raw = String(text || '').trim();
  const normalized = normalizeText(raw);
  const tokens = normalized.split(' ').filter(Boolean);

  for (const token of tokens) {
    if (NUMBER_WORDS.has(token)) {
      const score = NUMBER_WORDS.get(token);
      if (score >= 1 && score <= 5) {
        candidates.push(score);
      }
    }
  }

  if (/चार/.test(raw) || /\bchar\b/.test(normalized) || /\bchaar\b/.test(normalized) || /\bcharge\b/.test(normalized)) {
    candidates.push(4);
  }

  if (/पांच|पाँच/.test(raw) || /\bpaanch\b/.test(normalized) || /\bpanch\b/.test(normalized)) {
    candidates.push(5);
  }

  if (/तीन/.test(raw) || /\bteen\b/.test(normalized)) {
    candidates.push(3);
  }

  const match = normalized.match(/\b([1-5])\s*(?:out of 5|\/5|star|stars|rating)?\b/);
  if (match) {
    candidates.push(Number(match[1]));
  }

  return candidates.length ? candidates[candidates.length - 1] : null;
}

function extractRating(exchanges) {
  const ratingExchanges = exchanges.filter((exchange) => detectPromptType(exchange.promptText) === 'rating');

  for (let index = ratingExchanges.length - 1; index >= 0; index -= 1) {
    const score = extractNumericRatingFromText(ratingExchanges[index].responseText);
    if (Number.isInteger(score)) {
      return score;
    }
  }

  return null;
}

function extractRatingFromTranscriptTurns(transcript = []) {
  for (let index = 0; index < transcript.length; index += 1) {
    const turn = transcript[index];
    if (!turn || turn.role !== 'AGENT') {
      continue;
    }

    const promptType = detectPromptType(turn.text);
    if (promptType !== 'rating') {
      continue;
    }

    const customerTurn = transcript[index + 1];
    if (customerTurn?.role === 'CUSTOMER') {
      const directScore = extractNumericRatingFromText(customerTurn.text);
      if (Number.isInteger(directScore)) {
        return directScore;
      }
    }

    const agentAcknowledgement = transcript[index + 2];
    if (agentAcknowledgement?.role === 'AGENT') {
      const acknowledgedScore = extractNumericRatingFromText(agentAcknowledgement.text);
      if (Number.isInteger(acknowledgedScore)) {
        return acknowledgedScore;
      }
    }
  }

  return null;
}

function isSubstantiveTurn(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length < 6) {
    return false;
  }

  if (IGNORE_EXACT.has(normalized)) {
    return false;
  }

  return true;
}

function isLikelyNoiseForPrompt(text, promptType) {
  const raw = String(text || '').trim();
  const normalized = normalizeText(raw);

  if (!normalized) {
    return true;
  }

  if (/\b(goodbye|bye|thank you|thanks|nene|none|no suggestion)\b/.test(normalized)) {
    return true;
  }

  if (promptType === 'staff' && !/\b(staff|sumit|behavior|behaviour|communication|attitude|rude|helpful|issue|problem)\b/.test(normalized) && !/[ऀ-ॿ]/.test(raw)) {
    return true;
  }

  if (promptType === 'improvement' && normalized.length < 12) {
    return true;
  }

  return false;
}

function cleanTurnForSummary(text) {
  return String(text || '')
    .replace(/\b(Beh\.?|Goodbye\.?|Nene)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[.।!?]+$/g, '')
    .trim();
}

function buildStructuredReviewSummary(exchanges) {
  const latestByType = new Map();

  exchanges.forEach((exchange) => {
    const promptType = detectPromptType(exchange.promptText);
    const responseText = String(exchange.responseText || '').trim();

    if (!['overall', 'cleanliness', 'staff', 'process', 'improvement'].includes(promptType)) {
      return;
    }

    if (!isSubstantiveTurn(responseText) || extractNumericRatingFromText(responseText) !== null || isLikelyNoiseForPrompt(responseText, promptType)) {
      return;
    }

    latestByType.set(promptType, cleanTurnForSummary(responseText));
  });

  const lines = [];

  if (latestByType.has('overall')) {
    lines.push(`Overall experience: ${latestByType.get('overall')}.`);
  }

  if (latestByType.has('cleanliness')) {
    lines.push(`Cleanliness feedback: ${latestByType.get('cleanliness')}.`);
  }

  if (latestByType.has('staff')) {
    lines.push(`Staff feedback: ${latestByType.get('staff')}.`);
  }

  if (latestByType.has('process')) {
    lines.push(`Process feedback: ${latestByType.get('process')}.`);
  }

  if (latestByType.has('improvement')) {
    lines.push(`Suggestion: ${latestByType.get('improvement')}.`);
  }

  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function extractReviewText(exchanges) {
  const structuredSummary = buildStructuredReviewSummary(exchanges);
  if (structuredSummary) {
    return structuredSummary.slice(0, 1000);
  }

  const feedbackPromptTypes = new Set(['overall', 'cleanliness', 'staff', 'process', 'improvement']);
  const substantiveTurns = exchanges
    .filter((exchange) => feedbackPromptTypes.has(detectPromptType(exchange.promptText)))
    .map((exchange) => ({
      promptType: detectPromptType(exchange.promptText),
      text: String(exchange.responseText || '').trim()
    }))
    .filter((entry) => isSubstantiveTurn(entry.text))
    .filter((entry) => extractNumericRatingFromText(entry.text) === null)
    .filter((entry) => !isLikelyNoiseForPrompt(entry.text, entry.promptType))
    .map((entry) => cleanTurnForSummary(entry.text));

  if (!substantiveTurns.length) {
    return '';
  }

  const uniqueTurns = [];
  const seen = new Set();

  for (const turn of substantiveTurns) {
    const normalized = normalizeText(turn);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniqueTurns.push(turn);
    }
  }

  return uniqueTurns.slice(-4).join(' ').slice(0, 1000);
}

function getCustomerTurns(transcript = []) {
  return transcript.filter((turn) => turn.role === 'CUSTOMER' && String(turn.text || '').trim());
}

function extractCallFeedback(transcript = []) {
  const customerTurns = getCustomerTurns(transcript);
  const exchanges = splitIntoExchanges(transcript);
  const reviewText = extractReviewText(exchanges);
  const stars = extractRating(exchanges) ?? extractRatingFromTranscriptTurns(transcript);
  const consentDetected = detectConsent(customerTurns);
  const language = detectLanguage(customerTurns);

  return {
    reviewText,
    stars,
    consentDetected,
    language,
    hasFeedback: Boolean(reviewText) || Number.isInteger(stars)
  };
}

async function saveCallFeedbackFromTranscript({ dbGet, dbRun, callSid, customerId, transcript, overwriteExisting = false }) {
  if (!callSid || !Array.isArray(transcript) || transcript.length === 0) {
    return { saved: false, reason: 'missing_call_or_transcript' };
  }

  const callRecord = await dbGet('SELECT * FROM calls WHERE provider_call_id = ?', [callSid]);
  const resolvedCustomerId = customerId || callRecord?.customer_id;

  if (!callRecord || !resolvedCustomerId) {
    return { saved: false, reason: 'call_record_not_found' };
  }

  const extraction = extractCallFeedback(transcript);
  const transcriptText = transcript.map((turn) => `${turn.role}: ${turn.text}`).join('\n');

  await dbRun(
    `UPDATE calls
        SET transcript_text = ?,
            consent_detected = ?,
            language = ?,
            extracted_rating = ?,
            extracted_review_text = ?
      WHERE id = ?`,
    [
      transcriptText,
      extraction.consentDetected ? 1 : 0,
      extraction.language,
      extraction.stars,
      extraction.reviewText || null,
      callRecord.id
    ]
  );

  if (!extraction.hasFeedback) {
    return { saved: false, reason: 'no_feedback_detected', extraction };
  }

  const existingFeedback = await dbGet('SELECT id FROM feedback WHERE call_id = ?', [callRecord.id]);
  if (existingFeedback) {
    if (!overwriteExisting) {
      return { saved: false, reason: 'already_saved', extraction };
    }

    const reviewText = extraction.reviewText || 'Customer shared a rating on the call.';
    const stars = Number.isInteger(extraction.stars) ? extraction.stars : 3;
    const categorization = await categorizeFeedback(reviewText, stars);

    await dbRun(
      `UPDATE feedback
          SET review_text = ?,
              category = ?,
              stars = ?,
              submitted_at = ?,
              source = ?
        WHERE id = ?`,
      [
        reviewText,
        categorization.category,
        stars,
        new Date().toISOString(),
        'call',
        existingFeedback.id
      ]
    );

    await dbRun(
      'UPDATE calls SET feedback_saved_at = ?, outcome = COALESCE(outcome, ?) WHERE id = ?',
      [new Date().toISOString(), 'completed', callRecord.id]
    );

    return {
      saved: true,
      feedbackId: existingFeedback.id,
      extraction,
      category: categorization.category,
      updated: true
    };
  }

  const reviewText = extraction.reviewText || 'Customer shared a rating on the call.';
  const stars = Number.isInteger(extraction.stars) ? extraction.stars : 3;
  const categorization = await categorizeFeedback(reviewText, stars);

  const result = await dbRun(
    `INSERT INTO feedback (customer_id, call_id, review_text, category, stars, submitted_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      resolvedCustomerId,
      callRecord.id,
      reviewText,
      categorization.category,
      stars,
      new Date().toISOString(),
      'call'
    ]
  );

  await dbRun(
    'UPDATE calls SET feedback_saved_at = ?, outcome = COALESCE(outcome, ?) WHERE id = ?',
    [new Date().toISOString(), 'completed', callRecord.id]
  );

  return {
    saved: true,
    feedbackId: result.lastID,
    extraction,
    category: categorization.category
  };
}

module.exports = {
  extractCallFeedback,
  saveCallFeedbackFromTranscript
};
