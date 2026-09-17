'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeEngagement,
  isNoResponseTranscript,
  isNoResponseCall
} = require('../services/no-response');
const {
  buildOutboundDemoTurnInstruction
} = require('../src/conversation-state');
const { YESTERDAY } = require('./support/call-dates');

const OPENING = 'AGENT: Namaste, kya meri baat Ankita ji se ho rahi hai?';

test('a patient who only says hello is a no-response call', () => {
  const transcript = [
    OPENING,
    'CUSTOMER: Hello?',
    'AGENT: Ji, kya meri baat Ankita ji se ho rahi hai?',
    'CUSTOMER: हेलो हेलो',
    'AGENT: Ji, kya meri baat Ankita ji se ho rahi hai?',
    'CUSTOMER: hello haan ji'
  ].join('\n');
  assert.equal(isNoResponseTranscript(transcript), true);
});

test('a call where the patient never spoke is a no-response call', () => {
  assert.equal(isNoResponseTranscript(OPENING), true);
});

test('any real answer after the hellos is feedback', () => {
  for (const answer of ['theek tha', 'bahut achha experience tha', 'nahi', 'galat number', 'abhi busy hoon', '5']) {
    const transcript = [OPENING, 'CUSTOMER: hello', `CUSTOMER: ${answer}`].join('\n');
    assert.equal(isNoResponseTranscript(transcript), false, answer);
  }
});

test('an unlabelled transcript is never judged', () => {
  assert.equal(isNoResponseTranscript('Speaker 0: namaste\nSpeaker 1: hello'), false);
  assert.equal(isNoResponseTranscript(''), false);
});

test('what the live call recorded wins over the transcript', () => {
  const chatty = [OPENING, 'CUSTOMER: haan bol rahi hoon'].join('\n');
  assert.equal(isNoResponseCall({ engagement: 'no_response', transcriptText: chatty }), true);
  assert.equal(isNoResponseCall({ engagement: 'engaged', transcriptText: OPENING }), false);
  assert.equal(isNoResponseCall({ engagement: 'declined', transcriptText: OPENING }), false);
  assert.equal(isNoResponseCall({ engagement: null, transcriptText: OPENING }), true);
});

const turn = (reply, state) => buildOutboundDemoTurnInstruction(reply, state, 'x', 'Ankita');
const intro = () => ({ step: 'intro', lastVisitDate: YESTERDAY });

test('live call: hung up before saying who they are', () => {
  const state = intro();
  assert.equal(describeEngagement(state), 'no_response');
  turn('Hello?', state);
  assert.equal(describeEngagement(state), 'no_response');
});

test('live call: hellos until the agent gives up', () => {
  const state = intro();
  turn('Hello', state);
  turn('hello hello', state);
  turn('हेलो', state);
  assert.equal(state.conversationCompleted, true);
  assert.equal(describeEngagement(state), 'no_response');
});

test('live call: confirmed, then hung up without answering', () => {
  const state = intro();
  turn('haan bol rahi hoon', state);
  assert.equal(describeEngagement(state), 'no_response');
});

test('live call: confirmed and answered a question', () => {
  const state = intro();
  turn('haan bol rahi hoon', state);
  turn('bahut achha tha', state);
  assert.equal(describeEngagement(state), 'engaged');
});

test('live call: a hello after confirming is not an answer', () => {
  const state = intro();
  turn('haan bol rahi hoon', state);
  turn('hello?', state);
  assert.equal(describeEngagement(state), 'no_response');
});

test('live call: wrong person is declined, not no-response', () => {
  const state = intro();
  turn('galat number hai', state);
  assert.equal(describeEngagement(state), 'declined');
});
