'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReviewCallTurnInstruction,
  isNegativeOrBusyReply,
  isNegativeExperienceReply
} = require('../src/conversation-state');
const { buildCallAnalysis } = require('../services/call-analysis');
const { heuristicAnalysis } = require('../services/gemini');
const { resolveAnalysisModel } = require('../services/gemini');
const { resolveSentiment } = require('../services/call-orchestration');
const { YESTERDAY } = require('./support/call-dates');

/**
 * Production call 16, verbatim.
 *
 * A donor said she felt very dizzy after donating. The agent answered "Koi baat
 * nahi" and hung up, and the call was filed as neutral. Both halves of that are
 * reproduced below so neither can come back.
 */
const COMPLAINT = 'बहुत दिक़्क़त आई बहुत चक्कर आया उसके बाद में.';
const CALL_16_TRANSCRIPT = [
  'AGENT: Good Afternoon. Main Apna Blood Centre se bol rahi hoon - yeh ek automated call hai, aur quality ke liye record ho rahi hai. Kya main ankita ji se baat kar rahi hoon?',
  'CUSTOMER: Hello.',
  'AGENT: Aapne 28 August ko blood donate kiya tha, uske liye dhanyavaad. Aapka experience kaisa raha?',
  'CUSTOMER: Hello.',
  'AGENT: ankita ji, blood donate karne ka aapka experience achha tha ya koi pareshani hui thi?',
  `CUSTOMER: ${COMPLAINT}`
].join('\n');

// ── The call must not end on a complaint ───────────────────────────────────────

// "उसके बाद में" means "after that". It was matched by the "बाद में" ("later")
// brush-off pattern, so a donor describing when she felt faint was read as
// asking to be called back, and the call ended on the spot.
test('"uske baad mein" in a sentence is not a request to call back later', () => {
  assert.equal(isNegativeOrBusyReply(COMPLAINT), false);
  assert.equal(isNegativeOrBusyReply('उसके बाद में चक्कर आया'), false);
  assert.equal(isNegativeOrBusyReply('sample dene ke baad mein weakness thi'), false);
});

test('a genuine "call me later" is still recognised', () => {
  assert.equal(isNegativeOrBusyReply('baad mein baat karte hain'), true);
  assert.equal(isNegativeOrBusyReply('बाद में'), true);
  assert.equal(isNegativeOrBusyReply('abhi busy hoon'), true);
  assert.equal(isNegativeOrBusyReply('later please'), true);
});

// Deepgram writes "दिक़्क़त" with nuqta (U+093C); the keyword list held the plain
// "दिक्कत". Byte-for-byte they differ, so every complaint spelled this way was
// invisible to every Hindi classifier in the codebase.
test('a nuqta spelling of a complaint word still matches', () => {
  assert.equal(isNegativeExperienceReply('बहुत दिक़्क़त हुई'), true);
  assert.equal(isNegativeExperienceReply('बहुत दिक्कत हुई'), true);
});

// Dizziness, fainting and weakness are the commonest adverse reactions to
// giving blood -- the exact thing a next-day review call exists to catch -- and
// none of them were in the Devanagari complaint list.
test('post-donation adverse reactions read as a negative experience', () => {
  assert.equal(isNegativeExperienceReply('बहुत चक्कर आया'), true);
  assert.equal(isNegativeExperienceReply('बहुत कमजोरी लग रही थी'), true);
  assert.equal(isNegativeExperienceReply('मुझे बेहोशी आ गई'), true);
  assert.equal(isNegativeExperienceReply('हाथ में बहुत दर्द हुआ'), true);
});

test('the agent asks what went wrong instead of hanging up on a complaint', () => {
  // A "Hello" no longer confirms identity, so the donor says yes first; the
  // second "Hello" is the unclear answer to the experience question.
  const state = { step: 'intro', lastVisitDate: YESTERDAY };
  buildReviewCallTurnInstruction('Haan ji.', state, 'Apna Blood Centre', 'ankita');
  buildReviewCallTurnInstruction('Hello.', state, 'Apna Blood Centre', 'ankita');

  const instruction = buildReviewCallTurnInstruction(COMPLAINT, state, 'Apna Blood Centre', 'ankita');

  assert.match(instruction, /kya pareshani hui thi/i);
  assert.equal(state.step, 'issue_detail');
  assert.notEqual(state.endCallAfterNextReply, true);
});

// A complaint is an answer to the question that was asked. A busy signal is a
// refusal to answer it. When a reply looks like both, the answer wins.
test('a complaint outranks a busy signal on the experience question', () => {
  const state = { step: 'experience', lastVisitDate: YESTERDAY };
  const instruction = buildReviewCallTurnInstruction(
    'donate karne ke baad mein bahut dikkat hui', state, 'Apna Blood Centre', 'ankita'
  );

  assert.match(instruction, /kya pareshani hui thi/i);
  assert.equal(state.step, 'issue_detail');
});

// ── The call must not be filed as neutral ──────────────────────────────────────

test('the transcript analyser reads call 16 as negative', () => {
  const analysis = buildCallAnalysis({
    transcript_text: CALL_16_TRANSCRIPT,
    call_type: 'REVIEW_CALL',
    outcome: 'completed'
  });

  assert.equal(analysis.sentiment, 'negative');
  assert.ok(analysis.sentiment_score < 0, `expected a negative score, got ${analysis.sentiment_score}`);
});

// The fallback counted keywords across the whole transcript, the agent's own
// lines included. Its scripted question contains "achha", and the greeting
// contains "Good", so the agent talked itself into a positive rating of a call
// where the only thing the donor said was a complaint.
test('the fallback analyser scores what the donor said, not what the agent said', () => {
  assert.equal(heuristicAnalysis(CALL_16_TRANSCRIPT).customer_sentiment, 'negative');

  const agentPraiseOnly = [
    'AGENT: Aapka experience achha tha ya koi pareshani hui thi?',
    'CUSTOMER: Hello.'
  ].join('\n');
  assert.equal(heuristicAnalysis(agentPraiseOnly).customer_sentiment, 'neutral');
});

// Call 16 was stored with label "neutral" and score +0.8: the label came from
// the transcript analyser and the score from a different analyser's "positive".
// A record that disagrees with itself is worse than either answer alone.
test('the stored sentiment label and score always agree', () => {
  const neutral = resolveSentiment({ label: 'neutral', score: 0 }, 'positive');
  assert.equal(neutral.label, 'neutral');
  assert.equal(neutral.score, 0);

  const negative = resolveSentiment({ label: 'negative', score: -0.86 }, 'positive');
  assert.equal(negative.label, 'negative');
  assert.ok(negative.score < 0);

  // With no transcript-level reading, the model's label is used -- and the
  // score is then derived from that same label, not from the other one.
  const modelOnly = resolveSentiment(null, 'positive');
  assert.equal(modelOnly.label, 'positive');
  assert.ok(modelOnly.score > 0);
});

// GEMINI_MODEL was pointed at a Live-API-only model. Post-call analysis calls
// generateContent, which that model rejects with a 400, so every call in
// production silently fell back to keyword matching -- in 460ms, which is what
// gave it away in the logs.
test('post-call analysis never uses a live-only streaming model', () => {
  const live = resolveAnalysisModel({ GEMINI_MODEL: 'gemini-3.1-flash-live-preview' });
  assert.equal(/live/.test(live), false, `generateContent cannot use ${live}`);

  const explicit = resolveAnalysisModel({
    GEMINI_MODEL: 'gemini-3.1-flash-live-preview',
    GEMINI_ANALYSIS_MODEL: 'gemini-2.5-flash'
  });
  assert.equal(explicit, 'gemini-2.5-flash');
});
