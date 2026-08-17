'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMediaToken } = require('../src/auth');
const {
  buildOutboundCampaignPayload,
  ensureAuthenticatedMediaUrl,
  redactMediaUrlToken
} = require('../services/icallmate');

test('outbound media URLs receive a valid one-time token', () => {
  const mediaUrl = ensureAuthenticatedMediaUrl('wss://example.com/icallmate/media');
  const token = new URL(mediaUrl).searchParams.get('token');

  assert.ok(token);
  assert.equal(validateMediaToken(token), true);
  assert.equal(validateMediaToken(token), false);
});

test('stored media URLs redact their token', () => {
  const redactedUrl = redactMediaUrlToken('wss://example.com/icallmate/media?token=secret-value&call=12');
  const parsed = new URL(redactedUrl);

  assert.equal(parsed.searchParams.get('token'), '[redacted]');
  assert.equal(parsed.searchParams.get('call'), '12');
  assert.doesNotMatch(redactedUrl, /secret-value/);
});

test('incoming media shared token remains valid across calls', () => {
  process.env.ICALLMATE_MEDIA_SHARED_SECRET = 'shared-media-test-secret-with-at-least-32-bytes';
  const sharedToken = require('../src/auth').createMediaToken({ reusable: true });

  assert.equal(validateMediaToken(sharedToken), true);
  assert.equal(validateMediaToken(sharedToken), true);
  delete process.env.ICALLMATE_MEDIA_SHARED_SECRET;
});

test('OBD payload uses the field names documented by iCallMate', () => {
  const payload = buildOutboundCampaignPayload('+918810300000', 42, {
    customerName: 'Test Customer',
    wsurl: 'wss://example.com/icallmate/media',
    callbackapi: 'https://example.com/api/icallmate/callback?secret=value'
  });
  const recipient = payload.msisdnlist[0];

  assert.equal(recipient.phoneno, '918810300000');
  assert.equal(recipient.customer_name, 'Test Customer');
  assert.equal(recipient.msisdn, undefined);
  assert.equal(recipient.name, undefined);
});
