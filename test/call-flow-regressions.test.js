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

// A donor reported the agent stopping mid-goodbye and the call ending. Gemini
// raises its interrupt whenever the VAD hears anything, background noise
// included; clearing the audio queue then discarded the closing, and because
// the hangup fires once the buffer drains, the call ended on the spot.
test('background noise cannot cut the closing short', () => {
  const { shouldIgnoreBargeIn } = require('../src/conversation-state');

  // Mid-conversation: interrupting is correct.
  assert.equal(shouldIgnoreBargeIn({ state: { step: 'experience' } }), false);
  assert.equal(shouldIgnoreBargeIn({}), false);

  // Closing: there is nothing left to interrupt.
  assert.equal(shouldIgnoreBargeIn({ hangupAfterAudioDrains: true }), true);
  assert.equal(shouldIgnoreBargeIn({ pendingHangup: true }), true);
  assert.equal(shouldIgnoreBargeIn({ state: { endCallAfterNextReply: true } }), true);
  assert.equal(shouldIgnoreBargeIn({ state: { conversationState: 'COMPLETED' } }), true);
});

test('the flow marks itself closing before the goodbye is spoken', () => {
  const state = { step: 'experience', lastVisitDate: YESTERDAY };
  const { shouldIgnoreBargeIn } = require('../src/conversation-state');

  assert.equal(shouldIgnoreBargeIn({ state }), false, 'not closing yet');

  buildReviewCallTurnInstruction('bahut achha tha', state, 'C', 'Ankita');
  assert.equal(shouldIgnoreBargeIn({ state }), true, 'the closing turn must be protected');
});

// From two real follow-up calls. The donor's own "Hello" arrived while the
// agent was introducing itself; barge-in cleared the audio, so both calls were
// cut at "...quality ke liye record". Nobody was ever asked who they were.
test('a hello during the introduction does not cut it off', () => {
  const { shouldIgnoreBargeIn } = require('../src/conversation-state');
  assert.equal(shouldIgnoreBargeIn({ openingInProgress: true }), true);
  assert.equal(shouldIgnoreBargeIn({ openingInProgress: false, state: { step: 'experience' } }), false);
});

// "कहां" (where) contains "हां" (yes). The alternation had no word boundary, so
// "आप कहां से बोल रहे हो?" was read as agreement and the agent answered a
// question about its own identity with "Bahut achha. Kab donate kiya tha?".
test('a question is never mistaken for a yes', () => {
  const { isAffirmativeReply, isQuestionReply } = require('../src/conversation-state');

  for (const asked of ['आप कहां से बोल रहे हो?', 'आप कौन बोल रहे हो?', 'aap kaun bol rahe ho']) {
    assert.equal(isQuestionReply(asked), true, `not seen as a question: ${asked}`);
    assert.equal(isAffirmativeReply(asked), false, `read as yes: ${asked}`);
  }

  for (const agreed of ['हां जी', 'हाँ', 'जी हां', 'ठीक है', 'haan ji']) {
    assert.equal(isAffirmativeReply(agreed), true, `agreement missed: ${agreed}`);
  }
});

// The donor said "नहीं मैंने नहीं कराया" and was congratulated -- "Bahut achha
// kaam kiya" -- for a donation they had just denied.
test('a denial is never treated as agreement', () => {
  const { buildThreeMonthFollowupTurnInstruction } = require('../src/conversation-state');
  const state = { step: 'donated_again' };

  const reply = buildThreeMonthFollowupTurnInstruction('नहीं मैंने नहीं कराया', state, 'Apna Blood Centre', 'Rajesh');
  assert.doesNotMatch(reply, /Kab donate kiya tha/, 'asked when they donated after they said they had not');
  assert.match(reply, /bhavishya mein blood donate karne mein ruchi/);
  assert.equal(state.step, 'plan_to_donate');
});

// One call asked the same question four times while the donor asked who was
// calling.
test('the follow-up gives up rather than repeating forever', () => {
  const { buildThreeMonthFollowupTurnInstruction } = require('../src/conversation-state');
  const state = { step: 'donated_again' };

  const first = buildThreeMonthFollowupTurnInstruction('आप कौन बोल रहे हो?', state, 'Apna Blood Centre', 'Rajesh');
  assert.match(first, /Answer their question/);

  buildThreeMonthFollowupTurnInstruction('Hello', state, 'Apna Blood Centre', 'Rajesh');
  const last = buildThreeMonthFollowupTurnInstruction('Hello', state, 'Apna Blood Centre', 'Rajesh');
  assert.match(last, /Koi baat nahi/);
  assert.equal(state.conversationCompleted, true);
});
