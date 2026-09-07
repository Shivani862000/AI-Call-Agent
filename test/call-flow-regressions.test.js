'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReviewCallTurnInstruction, isPositiveExperienceReply, isGoodbyeReply
} = require('../src/conversation-state');
const { spokenName, buildClosingLine } = require('../prompts/closing.ts');
const { YESTERDAY } = require('./support/call-dates');

// Taken from real UAT calls, where the agent asked the same question three
// times because none of these matched anything.
test('the commonest answers are understood in both scripts', () => {
  for (const reply of ['ठीक है', 'ठीक है, ok ok', 'theek hai', 'thik hai', 'achha tha']) {
    assert.equal(isPositiveExperienceReply(reply), true, `not understood: ${reply}`);
  }
});

test('someone ending the call is not treated as an unclear answer', () => {
  for (const reply of ['Ok, bye', 'bye', 'theek hai bye', 'main rakhta hoon']) {
    assert.equal(isGoodbyeReply(reply), true, `not recognised as goodbye: ${reply}`);
  }
  assert.equal(isGoodbyeReply('achha tha'), false);
});

// One call asked the same question three times, the last after the donor had
// already said "Ok, bye".
test('an unclear answer is chased once, then the call closes', () => {
  const state = { step: 'experience', lastVisitDate: YESTERDAY };

  const first = buildReviewCallTurnInstruction('mmm hmm', state, 'C', 'Ankita');
  assert.match(first, /experience achha tha ya koi pareshani hui thi/);
  assert.notEqual(state.conversationCompleted, true);

  const second = buildReviewCallTurnInstruction('mmm hmm', state, 'C', 'Ankita');
  assert.match(second, /Koi baat nahi/);
  assert.match(second, /Aapka din shubh ho/);
  assert.equal(state.conversationCompleted, true);
});

test('a goodbye closes the call immediately, without another question', () => {
  const state = { step: 'experience', lastVisitDate: YESTERDAY };
  const reply = buildReviewCallTurnInstruction('Ok, bye', state, 'C', 'Ankita');

  assert.doesNotMatch(reply, /experience achha tha ya koi pareshani/);
  assert.match(reply, /Aapka din shubh ho/);
  assert.equal(state.conversationCompleted, true);
});

// A full name made the fixed lines longer and the model began corrupting them:
// "aap dobara blood donate Verma kar sakte hain", then a truncated closing.
test('only the first name is spoken', () => {
  assert.equal(spokenName('Shivani Verma'), 'Shivani');
  assert.equal(spokenName('  ankita  '), 'ankita');
  assert.equal(spokenName(''), '');
  assert.equal(buildClosingLine('Shivani Verma'), 'Dhanyavaad Shivani ji. Aapka din shubh ho.');

  const state = { step: 'issue_detail', lastVisitDate: YESTERDAY };
  const closing = buildReviewCallTurnInstruction('bukhaar tha', state, 'C', 'Shivani Verma');
  assert.doesNotMatch(closing, /Verma/, 'the surname should never be spoken');
});
