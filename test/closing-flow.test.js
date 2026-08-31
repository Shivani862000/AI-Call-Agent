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
  const slotQuestion = buildReviewCallTurnInstruction('experience bahut achha tha', state);
  assert.equal(state.step, 'redonation');
  assert.equal(state.endCallAfterNextReply, false);
  assert.match(slotQuestion, /slot book karna chahenge/i);
  assert.equal(countClosingLines(slotQuestion), 0);

  const closingInstruction = buildReviewCallTurnInstruction('haan, book kar dijiye', state);
  assert.equal(state.conversationState, 'COMPLETED');
  assert.equal(state.endCallAfterNextReply, true);
  assert.equal(state.redonationInterest, 'yes');
  assert.equal(countClosingLines(closingInstruction), 1);
});

test('review flow asks for issue details before closing a negative experience', () => {
  const state = newConversationState();
  const issueInstruction = buildReviewCallTurnInstruction('experience kharab tha, dikkat hui', state);

  assert.equal(state.step, 'issue_detail');
  assert.match(issueInstruction, /pareshani hui/i);
  assert.equal(state.endCallAfterNextReply, false);

  const slotQuestion = buildReviewCallTurnInstruction('staff ka behaviour rude tha', state);
  assert.equal(state.step, 'redonation');
  assert.match(slotQuestion, /slot book karna chahenge/i);

  const closingInstruction = buildReviewCallTurnInstruction('nahi, abhi nahi', state);
  assert.equal(state.conversationState, 'COMPLETED');
  assert.equal(state.endCallAfterNextReply, true);
  assert.equal(state.redonationInterest, 'no');
  assert.equal(countClosingLines(closingInstruction), 1);
});

test('review flow does not interpret a positive yes response as a problem', () => {
  const state = newConversationState();
  const instruction = buildReviewCallTurnInstruction('haan ji, bahut achha tha', state);

  assert.equal(state.step, 'redonation');
  assert.doesNotMatch(instruction, /kya problem|kya pareshani hui/i);
});

test('review flow recognizes badhiya as positive feedback', () => {
  const state = newConversationState();
  const instruction = buildReviewCallTurnInstruction('sab badhiya tha', state);

  assert.equal(state.step, 'redonation');
  assert.doesNotMatch(instruction, /pareshani hui/i);
  assert.equal(countClosingLines(instruction), 0);
});

test('three-month follow-up flow completes with the shared closing line', () => {
  const state = newConversationState();
  buildThreeMonthFollowupTurnInstruction('haan', state);
  buildThreeMonthFollowupTurnInstruction('nahi', state);
  const closingInstruction = buildThreeMonthFollowupTurnInstruction('haan', state);

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
  assert.match(closingInstruction, /Theek hai Sir/i);
  assert.equal(countClosingLines(closingInstruction), 1);
});

test('auto-hangup recognizes the shared closing line', () => {
  assert.equal(shouldAutoHangupAfterAgentTurn(FINAL_CLOSING_LINE), true);
  assert.equal(shouldAutoHangupAfterAgentTurn('Dhanyavaad sir.'), false);
});
