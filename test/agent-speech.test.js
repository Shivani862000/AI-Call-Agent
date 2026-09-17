'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BYTES_PER_MS,
  createAgentSpeechTracker,
  isFillerOnly,
  isAcknowledgementOnly,
  decideBargeIn,
  decideCallerTurn
} = require('../src/agent-speech');

const ms = (n) => n * BYTES_PER_MS;

// The transcript used to hold every word the model generated. Generation runs
// ahead of playback, so a line the caller cut off after three words was stored
// whole, and the call record said the donor had been asked a question they
// never heard.
test('a line played to the end is recorded whole', () => {
  const speech = createAgentSpeechTracker();
  speech.addText('Aapka experience kaisa raha?');
  speech.addAudio(ms(2000));
  speech.markGenerationComplete();
  speech.markSent(ms(2000));

  const turn = speech.finish();
  assert.equal(turn.text, 'Aapka experience kaisa raha?');
  assert.equal(turn.playedMs, 2000);
  assert.equal(speech.interrupt(), null, 'nothing is left to interrupt once it has drained');
});

test('an interrupted line records only the part that was played', () => {
  const speech = createAgentSpeechTracker();
  speech.addText('one two three four five six seven eight');
  speech.addAudio(ms(4000));
  speech.markGenerationComplete();
  speech.markSent(ms(2000));

  const cut = speech.interrupt();
  assert.equal(cut.spokenText, 'one two three four');
  assert.equal(cut.unspokenText, 'five six seven eight');
  assert.equal(cut.playedMs, 2000);
  assert.equal(cut.totalMs, 4000);
  assert.equal(speech.isActive(), false);
});

// Gemini Live streams its transcription in fragments alongside the audio, so
// each fragment is placed at the point in the audio where it arrived.
test('streamed fragments are matched to the audio they arrived with', () => {
  const speech = createAgentSpeechTracker();
  speech.addText('Aapne kal');
  speech.addAudio(ms(1000));
  speech.addText('blood donate kiya tha,');
  speech.addAudio(ms(1000));
  speech.addText('uske liye dhanyavaad.');
  speech.addAudio(ms(1000));
  speech.markSent(ms(1500));

  const cut = speech.interrupt();
  assert.equal(cut.spokenText, 'Aapne kal blood donate');
  assert.equal(cut.unspokenText, 'kiya tha, uske liye dhanyavaad.');
});

test('a line cut before any audio reached the caller records nothing as spoken', () => {
  const speech = createAgentSpeechTracker();
  speech.addText('Kya aap mujhe sun pa rahe hain?');
  speech.addAudio(ms(1500));

  const cut = speech.interrupt();
  assert.equal(cut.spokenText, '');
  assert.equal(cut.unspokenText, 'Kya aap mujhe sun pa rahe hain?');
});

test('remaining audio is what has been generated but not yet sent', () => {
  const speech = createAgentSpeechTracker();
  assert.equal(speech.remainingMs(), 0);
  speech.addAudio(ms(3000));
  speech.markSent(ms(1000));
  assert.equal(speech.remainingMs(), 2000);
});

test('the tracker counts turns and interruptions for the call summary', () => {
  const speech = createAgentSpeechTracker();
  speech.addText('first');
  speech.addAudio(ms(100));
  speech.markSent(ms(100));
  speech.markGenerationComplete();
  speech.finish();

  speech.addText('second line here');
  speech.addAudio(ms(1000));
  speech.markSent(ms(100));
  speech.interrupt();

  assert.deepEqual(speech.stats(), { turns: 2, interrupted: 1 });
});

test('hellos and hums are filler; short agreements are acknowledgements', () => {
  for (const said of ['Hello', 'hello hello', 'Hello? Hello?', 'हेलो हेलो', 'hmm']) {
    assert.equal(isFillerOnly(said), true, said);
  }
  for (const said of ['haan', 'haan ji', 'हां जी', 'achha', 'ok', 'theek hai']) {
    assert.equal(isFillerOnly(said), false, said);
    assert.equal(isAcknowledgementOnly(said), true, said);
  }
  for (const said of ['hello kaun bol raha hai', 'nahi', 'ruko ek minute', '']) {
    assert.equal(isFillerOnly(said), false, said);
    assert.equal(isAcknowledgementOnly(said), false, said);
  }
});

// From prod: callers say "hello hello" while the agent is talking. Each hello
// cut the agent off mid-sentence and the caller never heard the question.
test('a hello over the agent does not stop it talking', () => {
  assert.deepEqual(
    decideBargeIn({ callerText: 'hello hello', agentRemainingMs: 2500 }),
    { stopAgent: false, reason: 'filler' }
  );
  assert.deepEqual(
    decideBargeIn({ callerText: 'haan ji', agentRemainingMs: 2500 }),
    { stopAgent: false, reason: 'acknowledgement' }
  );
});

test('real words over the agent still stop it', () => {
  assert.deepEqual(
    decideBargeIn({ callerText: 'abhi main busy hoon', agentRemainingMs: 2500 }),
    { stopAgent: true, reason: 'barge_in' }
  );
});

test('the opening and the closing are never cut off', () => {
  assert.deepEqual(
    decideBargeIn({ callerText: 'abhi main busy hoon', agentRemainingMs: 2500, protectedTurn: true }),
    { stopAgent: false, reason: 'protected_turn' }
  );
});

test('there is nothing to stop when the agent is silent', () => {
  assert.equal(decideBargeIn({ callerText: 'hello', agentRemainingMs: 0 }).stopAgent, false);
});

test('a hello said over the agent is dropped: the rest of the line is the answer', () => {
  assert.equal(decideCallerTurn({ callerText: 'hello hello', remainingMsAtSpeechStart: 3000, agentRemainingMs: 1200 }), 'drop');
  assert.equal(decideCallerTurn({ callerText: 'hello hello', remainingMsAtSpeechStart: 3000, agentRemainingMs: 0 }), 'drop');
});

// "Haan ji" over the last word of a question is the answer to it, not noise.
test('speech that starts as the line ends is kept', () => {
  assert.equal(decideCallerTurn({ callerText: 'hello', remainingMsAtSpeechStart: 300, agentRemainingMs: 0 }), 'dispatch');
  assert.equal(decideCallerTurn({ callerText: 'haan ji', remainingMsAtSpeechStart: 300, agentRemainingMs: 200 }), 'defer');
});

test('an answer given while the agent is still talking waits for it to finish', () => {
  assert.equal(decideCallerTurn({ callerText: 'haan', remainingMsAtSpeechStart: 3000, agentRemainingMs: 1500 }), 'defer');
  assert.equal(decideCallerTurn({ callerText: 'haan', remainingMsAtSpeechStart: 3000, agentRemainingMs: 0 }), 'dispatch');
});

test('speech in silence is handled straight away', () => {
  assert.equal(decideCallerTurn({ callerText: 'hello', remainingMsAtSpeechStart: 0, agentRemainingMs: 0 }), 'dispatch');
  assert.equal(decideCallerTurn({ callerText: 'achha tha', remainingMsAtSpeechStart: 0, agentRemainingMs: 0 }), 'dispatch');
});
