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
  buildReviewCallTurnInstruction('nahi', state);
  const closingInstruction = buildReviewCallTurnInstruction('experience achha tha', state);

  assert.equal(state.conversationState, 'COMPLETED');
  assert.equal(state.endCallAfterNextReply, true);
  assert.equal(countClosingLines(closingInstruction), 1);
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

test('auto-hangup recognizes the shared closing line', () => {
  assert.equal(shouldAutoHangupAfterAgentTurn(FINAL_CLOSING_LINE), true);
  assert.equal(shouldAutoHangupAfterAgentTurn('Dhanyavaad sir.'), false);
});
