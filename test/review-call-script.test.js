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
const { YESTERDAY, eligibilityLabel } = require('./support/call-dates');

// 'intro' is now the identity check; the experience question comes after it.
const freshState = () => ({ step: 'experience' });
const verifiedState = () => {
  const state = { step: 'intro', lastVisitDate: YESTERDAY };
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
    spokenPartOnly(buildReviewCallingPrompt({ patientName: 'Ankita', lastVisitDate: YESTERDAY })),
    buildReviewCallingOpeningPrompt({ patientName: 'Ankita', lastVisitDate: YESTERDAY }),
    buildReviewCallTurnInstruction('haan ji', { step: 'intro' }, 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('galat number', { step: 'intro' }, 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('bahut achha tha', freshState(), 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('bahut bura tha', freshState(), 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('abhi busy hoon', freshState(), 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('hmm', freshState(), 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('staff rude tha', { step: 'issue_detail' }, 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('paanch', { step: 'rating' }, 'Client', 'Ankita'),
    buildReviewCallTurnInstruction('pata nahi', { step: 'rating' }, 'Client', 'Ankita'),
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

// Patients hung up on an opening that led with "automated call ... record ho
// rahi hai" and reached their name last.
test('the opening asks for the patient by name and nothing else', () => {
  assert.equal(buildReviewCallingOpeningPrompt({ patientName: 'Ankita Verma' }), '"Namaste, kya meri baat Ankita ji se ho rahi hai?"');
});

test('once confirmed, the call says who is calling and that it is an AI call being recorded', () => {
  const confirmed = buildReviewCallTurnInstruction('haan ji', { step: 'intro', lastVisitDate: YESTERDAY }, 'Client', 'Ankita');
  assert.match(confirmed, /"Ankita ji, main Apna Blood Bank, Palwal se Priya bol rahi hoon\. Yeh AI call hai aur quality ke liye record ho rahi hai\. Aapne kal blood donate kiya tha/);
});

// With no name there is nobody to confirm, so the introduction cannot wait.
test('with no name on file the opening introduces the call and asks for a moment', () => {
  const anonymous = buildReviewCallingOpeningPrompt({});
  assert.equal(/ ji\b/.test(anonymous), false);
  assert.match(anonymous, /Apna Blood Bank, Palwal se Priya bol rahi hoon\. Yeh AI call hai/);
  assert.match(anonymous, /Kya main aapse do minute baat kar sakti hoon\?/);
  assert.doesNotMatch(anonymous, /donate/);

  const confirmed = buildReviewCallTurnInstruction('haan', { step: 'intro', lastVisitDate: YESTERDAY }, 'Client', '');
  assert.match(confirmed, /Say exactly: "Aapne kal blood donate kiya tha/);
  assert.doesNotMatch(confirmed, /AI call/);
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

// Both paths now pass through the rating question on the way out, so the
// closing is one turn further along than it used to be.
test('both the positive and the complaint path reach the closing', () => {
  const happy = verifiedState();
  const positive = buildReviewCallTurnInstruction('bahut achha tha', happy, 'Client', 'Ankita');
  assert.match(positive, /Bahut achhi baat hai/);
  assert.match(positive, /1 se 5/);
  assert.match(buildReviewCallTurnInstruction('paanch', happy, 'Client', 'Ankita'), /Aapka din shubh ho/);

  const complaint = verifiedState();
  assert.match(buildReviewCallTurnInstruction('bahut bura tha', complaint, 'Client', 'Ankita'), /Kripya batayein aapko kya pareshani hui thi/);
  const afterIssue = buildReviewCallTurnInstruction('staff rude tha', complaint, 'Client', 'Ankita');
  assert.match(afterIssue, /sambandhit adhikari tak pahucha dungi/);
  assert.match(afterIssue, /1 se 5/);
  assert.match(buildReviewCallTurnInstruction('do', complaint, 'Client', 'Ankita'), /Aapka din shubh ho/);
});

// The review call runs the day after a donation, when the donor cannot give
// blood for another three months. It says when they can and stops there;
// arranging a visit belongs to the follow-up call, which is placed when it is
// actually actionable.
test('the review call tells the donor when they are eligible but arranges nothing', () => {
  const state = verifiedState();
  buildReviewCallTurnInstruction('bahut achha tha', state, 'Client', 'Ankita');
  const closing = buildReviewCallTurnInstruction('paanch', state, 'Client', 'Ankita');

  assert.match(closing, new RegExp(`${eligibilityLabel(YESTERDAY)} aap dobara blood donate kar sakte hain, aapka swagat hai`));
  assert.doesNotMatch(closing, /kab aana|kis din|samay|abhi bata/i);
});

test('the review call never asks a donor to arrange a visit', () => {
  for (const line of everySpokenLine()) {
    assert.equal(/kis din aur kis samay|aane ka samay abhi bata/i.test(line), false, `visit arrangement in:\n${line}`);
  }
});


// The agent has no calendar; promising a confirmed booking would be a lie.
// The centre has no appointment system and nobody calls back.
test('the agent never claims an appointment is confirmed or promises a callback', () => {
  for (const line of everySpokenLine()) {
    assert.equal(/slot confirm|call karke|book ho gaya|appointment confirm/i.test(line), false, `false promise in:\n${line}`);
  }
});


test('the intended visit is lifted out of the transcript', () => {
  const { detectIntendedVisit } = require('../services/call-analysis');
  assert.equal(detectIntendedVisit([
    { role: 'AI', text: 'Bahut achha. Aap kis din aur kis samay aana chahenge?' },
    { role: 'PATIENT', text: 'agle mahine ki 5 tareekh, subah 10 baje' }
  ]), 'agle mahine ki 5 tareekh, subah 10 baje');
  assert.equal(detectIntendedVisit([]), '');
});

test('the digest lists who to expect, and says nothing was booked', () => {
  const { formatExpectedVisitors } = require('../src/scheduler');

  assert.match(formatExpectedVisitors([]), /none recorded/);

  const body = formatExpectedVisitors([
    { first_name: 'Ankita', last_name: '', intended_visit_note: 'agle mahine ki 5 tareekh' },
    { first_name: 'Sunita', last_name: 'Devi', intended_visit_note: '', redonation_note: 'haan zaroor' }
  ]);
  assert.match(body, /Donors expecting to visit \(2\)/);
  assert.match(body, /- Ankita: agle mahine ki 5 tareekh/);
  assert.match(body, /- Sunita Devi: haan zaroor/);
  assert.match(body, /No appointment is booked and nobody is calling them back/);
});
