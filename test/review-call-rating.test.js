'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReviewCallTurnInstruction } = require('../src/conversation-state');
const { buildReviewCallingPrompt } = require('../prompts/review-calling.ts');
const { extractCallFeedback } = require('../services/call-feedback');
const { buildCallAnalysis } = require('../services/call-analysis');
const { YESTERDAY } = require('./support/call-dates');

const RATING_QUESTION = /1 se 5/i;

/** Runs the review call from the identity check to the turn after `experience`. */
function runToRating(experienceReply, issueReply) {
  const state = { step: 'intro', lastVisitDate: YESTERDAY };
  const said = [];
  said.push(buildReviewCallTurnInstruction('haan ji', state, 'Apna Blood Centre', 'Ankita'));
  said.push(buildReviewCallTurnInstruction(experienceReply, state, 'Apna Blood Centre', 'Ankita'));
  if (state.step === 'issue_detail') {
    said.push(buildReviewCallTurnInstruction(issueReply, state, 'Apna Blood Centre', 'Ankita'));
  }
  return { state, said };
}

test('the review call asks for a rating out of 5 after a good experience', () => {
  const { state, said } = runToRating('bahut achha tha');

  assert.match(said[said.length - 1], RATING_QUESTION);
  assert.equal(state.step, 'rating');
  // The rating question is a question; the call cannot be closing yet.
  assert.notEqual(state.endCallAfterNextReply, true);
});

test('the review call asks for a rating after a complaint has been captured', () => {
  const { state, said } = runToRating('bahut dikkat hui thi', 'staff ne dhyan nahi diya');

  assert.match(said[said.length - 1], RATING_QUESTION);
  assert.equal(state.step, 'rating');
  assert.notEqual(state.endCallAfterNextReply, true);
});

test('the rating answer is acknowledged and the call then closes', () => {
  const { state } = runToRating('bahut achha tha');
  const instruction = buildReviewCallTurnInstruction('chaar', state, 'Apna Blood Centre', 'Ankita');

  assert.match(instruction, /Aapka din shubh ho/);
  assert.equal(state.endCallAfterNextReply, true);
  assert.equal(state.ratingGiven, 4);
});

// A donor who will not put a number on it is not asked twice, and nothing is
// invented on their behalf. An unrated call must stay unrated.
test('a donor who gives no number is not pressed and nothing is guessed', () => {
  const { state } = runToRating('theek tha');
  const instruction = buildReviewCallTurnInstruction('pata nahi', state, 'Apna Blood Centre', 'Ankita');

  assert.equal(RATING_QUESTION.test(instruction), false);
  assert.match(instruction, /Aapka din shubh ho/);
  assert.equal(state.endCallAfterNextReply, true);
  assert.equal(state.ratingGiven, undefined);
});

test('the rating question never becomes a review or social media ask', () => {
  const { said } = runToRating('bahut achha tha');
  const banned = /subscribe|\blike\b|facebook|google page|channel|review zarur/i;
  for (const line of said) {
    assert.equal(banned.test(line), false, `social media ask found in:\n${line}`);
  }
});

test('the system prompt tells the agent to ask for the rating', () => {
  const prompt = buildReviewCallingPrompt({ patientName: 'Ankita', lastVisitDate: YESTERDAY });
  assert.match(prompt, RATING_QUESTION);
});

// ── The number the donor says has to reach the record ──────────────────────────

const RATED_TRANSCRIPT = [
  { role: 'AGENT', text: 'Aapne kal blood donate kiya tha, uske liye dhanyavaad. Aapka experience kaisa raha?' },
  { role: 'CUSTOMER', text: 'बहुत चक्कर आया उसके बाद में' },
  { role: 'AGENT', text: 'Maaf kijiye. Kripya batayein aapko kya pareshani hui thi?' },
  { role: 'CUSTOMER', text: 'donate karne ke baad bahut weakness thi' },
  { role: 'AGENT', text: '1 se 5 ke beech mein aap apne experience ko kitne number denge?' },
  { role: 'CUSTOMER', text: 'do' }
];

test('the spoken rating is extracted from the transcript', () => {
  assert.equal(extractCallFeedback(RATED_TRANSCRIPT).stars, 2);
});

test('the spoken rating reaches the call analysis', () => {
  const analysis = buildCallAnalysis({
    transcript_text: RATED_TRANSCRIPT.map((turn) => `${turn.role}: ${turn.text}`).join('\n'),
    call_type: 'REVIEW_CALL',
    outcome: 'completed'
  });

  assert.equal(analysis.rating, 2);
  assert.equal(analysis.sentiment, 'negative');
});

test('a call where the rating was never answered stores no rating', () => {
  const unrated = RATED_TRANSCRIPT.slice(0, -1).concat({ role: 'CUSTOMER', text: 'pata nahi' });
  assert.equal(extractCallFeedback(unrated).stars, null);
});

// The donor said a number out loud. A model's guess from the same transcript
// must not overwrite it.
test('a rating the donor actually said outranks one inferred by the model', () => {
  const { pickRating } = require('../services/post-call-pipeline');
  assert.equal(pickRating({ modelRating: 4, spokenRating: 2 }), 2);
  assert.equal(pickRating({ modelRating: 4, spokenRating: null }), 4);
  assert.equal(pickRating({ modelRating: null, spokenRating: null }), null);
});
