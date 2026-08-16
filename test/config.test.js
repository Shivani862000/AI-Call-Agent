'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('Gemini Live voice defaults preserve final audio before hangup', () => {
  const env = { ...process.env, AI_PROVIDER: 'gemini-live' };
  [
    'GEMINI_LIVE_DIRECT_AUDIO',
    'FINAL_AUDIO_GRACE_MS',
    'GEMINI_LIVE_SILENCE_DURATION_MS',
    'GEMINI_LIVE_PREFIX_PADDING_MS',
    'GEMINI_LIVE_MAX_OUTPUT_TOKENS'
  ].forEach((key) => delete env[key]);

  const result = spawnSync(process.execPath, [
    '-e',
    `const c = require('./src/config'); process.stdout.write(JSON.stringify({
      directAudio: c.GEMINI_LIVE_DIRECT_AUDIO,
      finalAudioGraceMs: c.FINAL_AUDIO_GRACE_MS,
      silenceMs: c.GEMINI_LIVE_SILENCE_DURATION_MS,
      prefixPaddingMs: c.GEMINI_LIVE_PREFIX_PADDING_MS,
      maxOutputTokens: c.GEMINI_LIVE_MAX_OUTPUT_TOKENS
    }));`
  ], {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    directAudio: true,
    finalAudioGraceMs: 3000,
    silenceMs: 600,
    prefixPaddingMs: 100,
    maxOutputTokens: 340
  });
});
