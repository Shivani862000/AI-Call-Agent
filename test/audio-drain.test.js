'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dequeueAudioFrame, calculateHangupDelayMs } = require('../src/audio-drain');

test('final partial audio frame keeps turn completion active until the next drain tick', () => {
  const source = Buffer.alloc(1000, 1);

  const first = dequeueAudioFrame(source, { turnComplete: true });
  assert.equal(first.chunk.length, 640);
  assert.equal(first.remaining.length, 360);
  assert.equal(first.turnComplete, true);
  assert.equal(first.drainComplete, false);

  const tail = dequeueAudioFrame(first.remaining, { turnComplete: first.turnComplete });
  assert.equal(tail.chunk.length, 360);
  assert.equal(tail.remaining.length, 0);
  assert.equal(tail.turnComplete, true);
  assert.equal(tail.drainComplete, false);

  const drained = dequeueAudioFrame(tail.remaining, { turnComplete: tail.turnComplete });
  assert.equal(drained.chunk, null);
  assert.equal(drained.turnComplete, false);
  assert.equal(drained.drainComplete, true);
});

test('post-drain hangup uses the configured provider grace period', () => {
  assert.equal(calculateHangupDelayMs({
    audioDrained: true,
    finalAudioGraceMs: 3000,
    pendingAudioMs: 9000,
    estimatedSpeechMs: 7000
  }), 3000);
});

test('pre-drain fallback includes pending audio and a safety margin', () => {
  assert.equal(calculateHangupDelayMs({
    finalAudioGraceMs: 3000,
    pendingAudioMs: 2800,
    estimatedSpeechMs: 1800
  }), 3800);
});
