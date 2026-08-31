'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { unusableCredentials, describeCallBlock } = require('../src/call-capability');

const real = {
  AI_PROVIDER: 'gemini-live',
  GEMINI_API_KEY: 'AIzaSyD-real-looking-key-000000000000000',
  DEEPGRAM_API_KEY: '0123456789abcdef0123456789abcdef01234567'
};

test('real-looking credentials are accepted', () => {
  assert.deepStrictEqual(unusableCredentials(real), []);
});

test('the exact values that dialled a patient and delivered silence are caught', () => {
  // This is what shipped: placeholders that satisfied a presence check.
  const shipped = { ...real, GEMINI_API_KEY: 'local-dev-placeholder', DEEPGRAM_API_KEY: 'local-dev-placeholder' };
  assert.deepStrictEqual(unusableCredentials(shipped).sort(), ['DEEPGRAM_API_KEY', 'GEMINI_API_KEY']);
});

test('the usual template spellings are caught', () => {
  for (const bad of ['', 'your_gemini_api_key', 'replace_with_a_key', '<your-key>', 'changeme', 'TODO', 'xxxxxxxx']) {
    assert.ok(unusableCredentials({ ...real, DEEPGRAM_API_KEY: bad }).includes('DEEPGRAM_API_KEY'),
      `${JSON.stringify(bad)} should be rejected`);
  }
});

test('GOOGLE_API_KEY satisfies the Gemini requirement', () => {
  const viaGoogle = { ...real, GEMINI_API_KEY: '', GOOGLE_API_KEY: 'AIzaSyD-real-looking-key-000000000000000' };
  assert.deepStrictEqual(unusableCredentials(viaGoogle), []);
});

test('the refusal names what to fix, not just that it failed', () => {
  const message = describeCallBlock(['GEMINI_API_KEY']);
  assert.match(message, /GEMINI_API_KEY/);
  assert.match(message, /placeholder|not configured/i);
  // A patient must not be dialled by a system that cannot speak to them.
  assert.match(message, /call/i);
});

test('every outbound path is gated, because they all funnel through initiateCall', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'icallmate.js'), 'utf8');
  const body = source.slice(source.indexOf('async function initiateCall('));
  // The check must come before any provider dispatch, or the call is placed anyway.
  const guardAt = body.indexOf('unusableCredentials');
  const dispatchAt = body.indexOf('initiateMasterPostCall');
  assert.ok(guardAt > -1, 'initiateCall must check call capability');
  assert.ok(guardAt < dispatchAt, 'the check must run before the provider is called');
});
