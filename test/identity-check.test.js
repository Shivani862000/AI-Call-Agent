'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReviewCallTurnInstruction,
  buildThreeMonthFollowupTurnInstruction,
  isIdentityConfirmation,
  isWrongPersonReply
} = require('../src/conversation-state');
const { YESTERDAY } = require('./support/call-dates');

const CALL_TYPES = [
  ['review call', buildReviewCallTurnInstruction],
  ['follow-up', buildThreeMonthFollowupTurnInstruction]
];

const intro = () => ({ step: 'intro', lastVisitDate: YESTERDAY });

// Patients answer the phone with "Hello" and then hear the question. A hello
// used to count as "yes, it's me", and the call went on to tell whoever it was
// about the donation.
for (const [label, turn] of CALL_TYPES) {
  test(`${label}: a hello is met with the name question again, not the donation`, () => {
    const state = intro();
    const reply = turn('Hello?', state, 'x', 'Ankita');

    assert.match(reply, /Say exactly: "Ji, kya meri baat Ankita ji se ho rahi hai\?"/);
    assert.doesNotMatch(reply, /donate/i);
    assert.equal(state.step, 'intro');
    assert.notEqual(state.endCallAfterNextReply, true);
  });

  test(`${label}: the name question is asked at most twice more, then the call closes unnamed`, () => {
    const state = intro();
    turn('Hello', state, 'x', 'Ankita');
    turn('hello hello', state, 'x', 'Ankita');
    const last = turn('हेलो', state, 'x', 'Ankita');

    assert.match(last, /Koi baat nahi\. Dhanyavaad\. Aapka din shubh ho\./);
    assert.doesNotMatch(last, /Ankita|donate/i);
    assert.equal(state.conversationCompleted, true);
  });

  // The commonest reply to "Kya meri baat Ankita ji se ho rahi hai?" was read
  // as a wrong number and the call hung up.
  test(`${label}: "who is calling" is answered and the question put back`, () => {
    for (const asked of ['kaun bol raha hai?', 'आप कौन बोल रहे हो?', 'aap kahan se bol rahe ho']) {
      const state = intro();
      const reply = turn(asked, state, 'x', 'Ankita');

      assert.match(reply, /"Main Apna Blood Bank, Palwal se Priya bol rahi hoon\. Kya meri baat Ankita ji se ho rahi hai\?"/, asked);
      assert.doesNotMatch(reply, /donate/i, asked);
      assert.notEqual(state.conversationCompleted, true, asked);
    }
  });

  test(`${label}: a confirmation after a hello carries on with the call`, () => {
    const state = intro();
    turn('Hello', state, 'x', 'Ankita');
    const reply = turn('haan ji, bol rahi hoon', state, 'x', 'Ankita');

    assert.match(reply, /Ankita ji, main Apna Blood Bank, Palwal se Priya bol rahi hoon\. Yeh AI call hai/);
    assert.notEqual(state.step, 'intro');
  });
}

test('the ways people say "yes, it is me" are recognised', () => {
  for (const said of ['haan', 'haan ji', 'ji', 'हां जी', 'bol rahi hoon', 'haan bolo', 'boliye', 'main hi hoon', 'बोलिए', 'yes speaking']) {
    assert.equal(isIdentityConfirmation(said), true, said);
  }
  for (const said of ['Hello', 'hello ji', 'haan hello', 'kaun bol raha hai?', 'आप कौन?', 'hmm']) {
    assert.equal(isIdentityConfirmation(said), false, said);
  }
});

test('asking who is calling is not a wrong number', () => {
  for (const asked of ['kaun bol raha hai', 'aap kaun', 'कौन बोल रहा है']) {
    assert.equal(isWrongPersonReply(asked), false, asked);
  }
});
