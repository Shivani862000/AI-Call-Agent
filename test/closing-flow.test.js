'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FINAL_CLOSING_LINE } = require('../prompts/closing.ts');
const { buildReviewCallingPrompt } = require('../prompts/review-calling.ts');
const { buildThreeMonthFollowupPrompt } = require('../prompts/three-month-followup.ts');
const {
  shouldAutoHangupAfterAgentTurn,
  buildReviewCallTurnInstruction,
  buildThreeMonthFollowupTurnInstruction
} = require('../src/conversation-state');

function countClosingLines(text) {
  return String(text).split(FINAL_CLOSING_LINE).length - 1;
}

function newConversationState() {
  return {
    step: 'intro',
    conversationState: 'IN_PROGRESS',
    conversationCompleted: false,
    endCall: false,
    endCallAfterNextReply: false
  };
}

test('review prompt contains one unambiguous closing line', () => {
  const prompt = buildReviewCallingPrompt();
  assert.equal(countClosingLines(prompt), 1);
  assert.doesNotMatch(prompt, /Namaskar/i);
  assert.doesNotMatch(prompt, /wait briefly after the closing|if user says .* at closing/i);
  assert.match(prompt, /Do not wait for another response after the closing line/i);
});

test('three-month follow-up prompt contains one unambiguous closing line', () => {
  const prompt = buildThreeMonthFollowupPrompt();
  assert.equal(countClosingLines(prompt), 1);
  assert.doesNotMatch(prompt, /Namaskar/i);
  assert.doesNotMatch(prompt, /wait briefly after the closing|if the donor says .* closing response/i);
  assert.match(prompt, /Do not wait for another response after the closing line/i);
});

test('review flow completes with the shared closing line', () => {
  const state = newConversationState();

  // Positive feedback no longer ends the call: the donor is still asked about
  // booking a slot for their next eligible donation.
  buildReviewCallTurnInstruction('haan ji, main hi bol raha hoon', state);
  const closingInstruction = buildReviewCallTurnInstruction('experience bahut achha tha', state);

  assert.equal(state.conversationState, 'COMPLETED');
  assert.equal(state.endCallAfterNextReply, true);
  assert.equal(countClosingLines(closingInstruction), 1);
});

test('review flow asks for issue details before closing a negative experience', () => {
  const state = newConversationState();
  buildReviewCallTurnInstruction('haan ji, main hi bol raha hoon', state);
  const issueInstruction = buildReviewCallTurnInstruction('experience kharab tha, dikkat hui', state);

  assert.equal(state.step, 'issue_detail');
  assert.match(issueInstruction, /pareshani hui/i);
  assert.equal(state.endCallAfterNextReply, false);

  const closingInstruction = buildReviewCallTurnInstruction('staff ka behaviour rude tha', state);
  assert.equal(state.conversationState, 'COMPLETED');
  assert.equal(state.endCallAfterNextReply, true);
  assert.equal(countClosingLines(closingInstruction), 1);
});

test('review flow does not interpret a positive yes response as a problem', () => {
  const state = newConversationState();
  buildReviewCallTurnInstruction('haan ji, main hi bol raha hoon', state);
  const instruction = buildReviewCallTurnInstruction('haan ji, bahut achha tha', state);

  assert.equal(state.conversationState, 'COMPLETED');
  assert.doesNotMatch(instruction, /kya problem|kya pareshani hui/i);
});

test('review flow recognizes badhiya as positive feedback', () => {
  const state = newConversationState();
  buildReviewCallTurnInstruction('haan ji, main hi bol raha hoon', state);
  const instruction = buildReviewCallTurnInstruction('sab badhiya tha', state);

  assert.equal(state.conversationState, 'COMPLETED');
  assert.doesNotMatch(instruction, /pareshani hui/i);
  assert.equal(countClosingLines(instruction), 1);
});

test('three-month follow-up flow completes with the shared closing line', () => {
  const state = newConversationState();
  buildThreeMonthFollowupTurnInstruction('haan', state);
  buildThreeMonthFollowupTurnInstruction('nahi', state);
  // A willing donor is now asked when they intend to come before the call ends.
  buildThreeMonthFollowupTurnInstruction('haan', state);
  buildThreeMonthFollowupTurnInstruction('haan', state);
  const closingInstruction = buildThreeMonthFollowupTurnInstruction('5 tareekh ko', state);

  assert.equal(state.conversationState, 'COMPLETED');
  assert.equal(state.endCallAfterNextReply, true);
  assert.equal(countClosingLines(closingInstruction), 1);
});

test('three-month follow-up accepts the recorded identity confirmation', () => {
  const state = newConversationState();
  const instruction = buildThreeMonthFollowupTurnInstruction('haan, kar rahi hoon', state);

  assert.equal(state.step, 'donated_again');
  assert.match(instruction, /dobara blood donate kiya hai/i);
  assert.equal(state.endCallAfterNextReply, false);
});

test('three-month follow-up no-donation flow waits for interest answer', () => {
  const state = newConversationState();
  buildThreeMonthFollowupTurnInstruction('haan ji', state);
  const interestQuestion = buildThreeMonthFollowupTurnInstruction('nahi', state);

  assert.equal(state.step, 'plan_to_donate');
  assert.match(interestQuestion, /ruchi rakhte hain/i);
  assert.equal(state.endCallAfterNextReply, false);

  const closingInstruction = buildThreeMonthFollowupTurnInstruction('nahi, abhi interested nahi', state);
  assert.equal(state.conversationState, 'COMPLETED');
  assert.match(closingInstruction, /Theek hai\./i);
  assert.equal(state.redonationInterest, 'no');
  assert.equal(countClosingLines(closingInstruction), 1);
});

test('auto-hangup recognizes the shared closing line', () => {
  assert.equal(shouldAutoHangupAfterAgentTurn(FINAL_CLOSING_LINE), true);
  assert.equal(shouldAutoHangupAfterAgentTurn('Dhanyavaad sir.'), false);
  assert.equal(shouldAutoHangupAfterAgentTurn('Dhanyavaad Ankita ji. Aapka din shubh ho.'), true);
});
