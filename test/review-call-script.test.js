'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReviewCallingPrompt,
  buildReviewCallingOpeningPrompt,
  describeVisit
} = require('../prompts/review-calling.ts');
const { buildClosingLine } = require('../prompts/closing.ts');
const {
  buildReviewCallTurnInstruction,
  shouldAutoHangupAfterAgentTurn
} = require('../src/conversation-state');

// 'intro' is now the identity check; the experience question comes after it.
const freshState = () => ({ step: 'experience' });
const verifiedState = () => {
  const state = { step: 'intro' };
  buildReviewCallTurnInstruction('haan ji', state, 'Client', 'Ankita');
  return state;
};

/**
 * Everything the agent can be told to say on a review call.
 *
 * The system prompt's Rules section is stripped: it spells out what the agent
 * must never say ("never ask for reviews, likes, subscribes"), which would
 * otherwise match the very guards below.
 */
function spokenPartOnly(prompt) {
  return String(prompt).split(/^Rules:/m)[0];
}

function everySpokenLine() {
  return [
    spokenPartOnly(buildReviewCallingPrompt({ patientName: 'Ankita', lastVisitDate: '2026-08-30' })),
    buildReviewCallingOpeningPrompt({ patientName: 'Ankita', lastVisitDate: '2026-08-30' }),
    buildReviewCallTurnInstruction('haan ji', { step: 'intro' }, 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('galat number', { step: 'intro' }, 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('bahut achha tha', freshState(), 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('bahut bura tha', freshState(), 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('abhi busy hoon', freshState(), 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('hmm', freshState(), 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('staff rude tha', { step: 'issue_detail' }, 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('haan', { step: 'redonation' }, 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('nahi', { step: 'redonation' }, 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('pata nahi', { step: 'redonation' }, 'Client', 'Ankita')
  ];
}

// The live script asked a donor who had just called the experience "bahut bura"
// to like and subscribe to a video, because the request sat in the complaint
// branch as well as the positive one.
test('the review call never asks for reviews, likes or social media', () => {
  const banned = /subscribe|\blike\b|facebook|google page|channel|review zarur/i;
  for (const line of everySpokenLine()) {
    assert.equal(banned.test(line), false, `social media ask found in:\n${line}`);
  }
});

// "Dhanyavaad sir" was spoken to every patient, women included.
test('the review call never assumes the patient is male', () => {
  for (const line of everySpokenLine()) {
    assert.equal(/\bsir\b|\bmadam\b|\bmaam\b/i.test(line), false, `gendered address in:\n${line}`);
  }
});

// video_sent was hydrated onto the session but never reached the prompt, so the
// agent claimed a video had been sent whether or not one had.
test('the review call never claims a video or message was sent', () => {
  for (const line of everySpokenLine()) {
    assert.equal(/video|bheja hai/i.test(line), false, `unfounded claim in:\n${line}`);
  }
});

test('the opening discloses that the call is automated and recorded', () => {
  const opening = buildReviewCallingOpeningPrompt({ patientName: 'Ankita' });
  assert.match(opening, /automated call/i);
  assert.match(opening, /record ho rahi hai/i);
});

test('the patient is addressed by name when one is known', () => {
  assert.match(buildReviewCallingOpeningPrompt({ patientName: 'Ankita' }), /Ankita ji/);
  const anonymous = buildReviewCallingOpeningPrompt({});
  assert.equal(/ ji,/.test(anonymous), false);
  assert.match(anonymous, /hai\. Aapne /);
});

test('the donation date is described from the record, not assumed to be yesterday', () => {
  const now = new Date('2026-08-31T10:00:00');
  assert.equal(describeVisit('2026-08-30', now), 'kal');
  assert.equal(describeVisit('2026-08-31', now), 'aaj');
  assert.equal(describeVisit('2026-08-08', now), '8 August ko');
  assert.equal(describeVisit('', now), 'haal hi mein');
  // A date in the future is bad data; say nothing specific rather than lie.
  assert.equal(describeVisit('2026-09-05', now), 'haal hi mein');
});

test('a named closing still triggers the auto hangup', () => {
  assert.equal(shouldAutoHangupAfterAgentTurn(buildClosingLine('Ankita')), true);
  assert.equal(shouldAutoHangupAfterAgentTurn(buildClosingLine('')), true);
});

test('both the positive and the complaint path reach the closing', () => {
  const positive = verifiedState();
  assert.match(buildReviewCallTurnInstruction('bahut achha tha', positive, 'Client', 'Ankita'), /slot book karna chahenge/);
  assert.match(buildReviewCallTurnInstruction('haan', positive, 'Client', 'Ankita'), /Aapka din shubh ho/);

  const complaint = verifiedState();
  assert.match(buildReviewCallTurnInstruction('bahut bura tha', complaint, 'Client', 'Ankita'), /Kripya batayein aapko kya pareshani hui thi/);
  const afterIssue = buildReviewCallTurnInstruction('staff rude tha', complaint, 'Client', 'Ankita');
  assert.match(afterIssue, /sambandhit adhikari tak pahucha dungi/);
  assert.match(afterIssue, /slot book karna chahenge/);
  assert.match(buildReviewCallTurnInstruction('nahi', complaint, 'Client', 'Ankita'), /Aapka din shubh ho/);
});

// Every donor is asked, and the answer is recorded for the team to act on.
test('the slot answer is recorded as yes, no or unclear', () => {
  const yes = { step: 'redonation' };
  buildReviewCallTurnInstruction('haan bilkul', yes, 'Client', 'Ankita');
  assert.equal(yes.redonationInterest, 'yes');

  const no = { step: 'redonation' };
  buildReviewCallTurnInstruction('nahi, abhi nahi', no, 'Client', 'Ankita');
  assert.equal(no.redonationInterest, 'no');

  const unclear = { step: 'redonation' };
  buildReviewCallTurnInstruction('pata nahi, dekhta hoon', unclear, 'Client', 'Ankita');
  assert.equal(unclear.redonationInterest, 'unclear');
});

// The agent has no calendar; promising a confirmed booking would be a lie.
test('the agent never claims an appointment is confirmed', () => {
  for (const line of everySpokenLine()) {
    assert.equal(/slot confirm ho gaya|appointment confirm ho gay|book ho gaya/i.test(line), false, `false confirmation in:\n${line}`);
  }
});
