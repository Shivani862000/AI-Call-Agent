'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDeepgramListenUrl,
  createDeepgramTranscriptBuffer
} = require('../src/speech-utils');

test('Deepgram live URL enables interim speech and utterance fallback events', () => {
  const url = new URL(createDeepgramListenUrl());
  assert.equal(url.searchParams.get('interim_results'), 'true');
  assert.equal(url.searchParams.get('vad_events'), 'true');
  assert.ok(Number(url.searchParams.get('utterance_end_ms')) >= 1000);
});

test('speech-final caller text dispatches immediately', () => {
  const transcripts = [];
  const buffer = createDeepgramTranscriptBuffer({
    onTranscript: (text) => transcripts.push(text)
  });

  const result = buffer.handleResult({
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: 'haan kar rahi hoon' }] }
  });

  assert.equal(result.hasSpeech, true);
  assert.deepEqual(transcripts, ['haan kar rahi hoon']);
  buffer.close();
});

test('final caller text flushes even when Deepgram omits speech-final', async () => {
  const transcripts = [];
  const buffer = createDeepgramTranscriptBuffer({
    flushDelayMs: 5,
    onTranscript: (text) => transcripts.push(text)
  });

  buffer.handleResult({
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ transcript: 'yes' }] }
  });
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(transcripts, ['yes']);
  buffer.close();
});
