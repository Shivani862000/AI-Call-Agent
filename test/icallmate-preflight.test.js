'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getMediaHealthUrl,
  assertPublicMediaEndpointReachable,
  ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE
} = require('../services/icallmate');

test('iCallMate preflight removes media credentials from the health URL', () => {
  assert.equal(
    getMediaHealthUrl('wss://voice.example.com/icallmate/media?token=private'),
    'https://voice.example.com/health'
  );
});

test('iCallMate preflight accepts a reachable public endpoint', async () => {
  let requestedUrl = '';
  await assertPublicMediaEndpointReachable(
    'wss://voice.example.com/icallmate/media?token=private',
    {
      fetchImpl: async (url) => {
        requestedUrl = url;
        return { ok: true, status: 200 };
      }
    }
  );

  assert.equal(requestedUrl, 'https://voice.example.com/health');
});

test('iCallMate preflight blocks calls when the public tunnel is unavailable', async () => {
  await assert.rejects(
    assertPublicMediaEndpointReachable(
      'wss://voice.example.com/icallmate/media?token=private',
      { fetchImpl: async () => ({ ok: false, status: 503 }) }
    ),
    (error) => {
      assert.equal(error.code, ICALLMATE_MEDIA_ENDPOINT_UNAVAILABLE);
      assert.match(error.message, /preflight failed: public URL returned HTTP 503/);
      return true;
    }
  );
});
