'use strict';

const { isGreetingOnly, normalizeHindiEnglishText } = require('../src/conversation-state');

/**
 * A call the patient picked up and then gave nothing on.
 *
 * iCallMate reports "completed" for any call that connected, so a patient who
 * said "Hello? Hello?" and hung up was counted as a completed call beside the
 * ones that produced feedback. These calls were answered, but they are not
 * completed: they are flagged, retried once, and kept out of the completed
 * counts.
 */
const NO_RESPONSE_OUTCOME = 'no_response';
const NO_RESPONSE_DETAIL = 'Patient disconnected without giving any feedback';
const NO_RESPONSE_SUMMARY = 'The patient answered but disconnected without giving any feedback.';

/** Retries placed after a no-response call before the patient is left alone. */
const NO_RESPONSE_MAX_RETRIES = 1;

/**
 * What the live call saw of the patient, stored on calls.engagement.
 *
 *   engaged      -- confirmed who they were and answered at least one question
 *   declined     -- said it was the wrong person, or that they could not talk
 *   no_response  -- never confirmed who they were, or confirmed and then said
 *                   nothing more before the call ended
 */
function describeEngagement(state = {}) {
  if (state.identityOutcome === 'declined') return 'declined';
  if (state.step === 'intro' || !state.identityOutcome) return NO_RESPONSE_OUTCOME;
  return (state.answersGiven || 0) > 0 ? 'engaged' : NO_RESPONSE_OUTCOME;
}

// Words that carry nothing on their own: greetings, "haan", "hmm". Deliberately
// short. "theek", "nahi" and anything else that can answer a question is left
// out, because a patient who said only "theek hai" did give an answer.
const FILLER_WORDS = new Set([
  'hello', 'helo', 'hallo', 'halo', 'hi', 'hey', 'namaste', 'namaskar',
  'haan', 'han', 'haa', 'ha', 'hmm', 'hm', 'ji', 'jee', 'haanji',
  'हेलो', 'हैलो', 'हलो', 'नमस्ते', 'नमस्कार', 'हाँ', 'हां', 'हा', 'जी', 'हम्म'
]);

function isFillerTurn(text) {
  if (isGreetingOnly(text)) return true;
  const words = normalizeHindiEnglishText(text)
    .replace(/[.,!?।"'…-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.every((word) => FILLER_WORDS.has(word));
}

/**
 * Whether a stored transcript shows the patient saying nothing but greetings.
 *
 * Only transcripts with speaker labels are judged. A recording transcribed
 * afterwards has no way to tell the agent's lines from the patient's, and
 * reading the agent's questions as the patient's words would never flag
 * anything -- but guessing the other way would flag real feedback.
 */
function isNoResponseTranscript(transcriptText) {
  const lines = String(transcriptText || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const labelled = lines
    .map((line) => /^(AGENT|AI|CUSTOMER|PATIENT)\s*:\s*(.*)$/i.exec(line))
    .filter(Boolean);
  if (!labelled.length) return false;

  return labelled
    .filter((match) => /^(CUSTOMER|PATIENT)$/i.test(match[1]))
    .every((match) => isFillerTurn(match[2]));
}

/**
 * The single decision the pipeline and the backfill both make. What the live
 * call recorded wins; the transcript is only read for calls that have no such
 * record (older calls, or a pipeline that ran before the call saved it).
 */
function isNoResponseCall({ engagement, transcriptText } = {}) {
  if (engagement) return engagement === NO_RESPONSE_OUTCOME;
  return isNoResponseTranscript(transcriptText);
}

module.exports = {
  NO_RESPONSE_OUTCOME,
  NO_RESPONSE_DETAIL,
  NO_RESPONSE_SUMMARY,
  NO_RESPONSE_MAX_RETRIES,
  describeEngagement,
  isFillerTurn,
  isNoResponseTranscript,
  isNoResponseCall
};
