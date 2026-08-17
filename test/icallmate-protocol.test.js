'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldStartAiBridgeForEvent,
  buildReverseHangupEvent
} = require('../src/icallmate-protocol');
const {
  ICALLMATE_REVERSE_MEDIA_CHUNK_BYTES,
  ICALLMATE_REVERSE_MEDIA_INTERVAL_MS
} = require('../src/config');

test('AI bridge waits for answer while retaining media as a fallback', () => {
  assert.equal(shouldStartAiBridgeForEvent('connected', false), false);
  assert.equal(shouldStartAiBridgeForEvent('start', false), false);
  assert.equal(shouldStartAiBridgeForEvent('answer', false), true);
  assert.equal(shouldStartAiBridgeForEvent('media', false), true);
  assert.equal(shouldStartAiBridgeForEvent('media', true), false);
});

test('AI hangup and reverse-media framing match the iCallMate protocol', () => {
  assert.deepEqual(buildReverseHangupEvent({
    streamId: 'stream-1',
    callerId: '919876543210',
    reason: 'complete'
  }), {
    event: 'reverse-hangup-call',
    streamId: 'stream-1',
    callerId: '919876543210',
    source: 'ai',
    message: 'Call Dropped on BOT',
    reason: 'complete'
  });
  assert.equal(ICALLMATE_REVERSE_MEDIA_CHUNK_BYTES, 1600);
  assert.equal(ICALLMATE_REVERSE_MEDIA_INTERVAL_MS, 100);
});
