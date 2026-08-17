'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildIcallMateCallbackUrl,
  redactIcallMateCallbackUrl,
  hasValidIcallMateWebhookSecret
} = require('../src/icallmate-webhook');

const env = { ICALLMATE_WEBHOOK_SECRET: 'provider-callback-test-secret' };

test('callback URL carries the provider secret and redacts it for storage', () => {
  const callbackUrl = buildIcallMateCallbackUrl('https://example.com/base', env);
  const parsed = new URL(callbackUrl);

  assert.equal(parsed.pathname, '/api/icallmate/callback');
  assert.equal(parsed.searchParams.get('secret'), env.ICALLMATE_WEBHOOK_SECRET);
  assert.doesNotMatch(redactIcallMateCallbackUrl(callbackUrl), /provider-callback-test-secret/);
});

test('callback authentication accepts header or query secret and rejects missing values', () => {
  assert.equal(hasValidIcallMateWebhookSecret({ headers: {}, query: {} }, env), false);
  assert.equal(hasValidIcallMateWebhookSecret({
    headers: { 'x-webhook-secret': env.ICALLMATE_WEBHOOK_SECRET },
    query: {}
  }, env), true);
  assert.equal(hasValidIcallMateWebhookSecret({
    headers: {},
    query: { secret: env.ICALLMATE_WEBHOOK_SECRET }
  }, env), true);
  assert.equal(hasValidIcallMateWebhookSecret({
    headers: {},
    query: { secret: 'wrong-secret' }
  }, env), false);
});
