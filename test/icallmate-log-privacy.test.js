'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactProviderPayload, redactRequestPayload } = require('../services/icallmate');

test('provider request and response diagnostics omit secret fields and signed query values', () => {
  const payload = {
    ukey: 'ukey-synthetic-secret',
    serviceno: '1800000000',
    msisdnlist: [{
      wsurl: 'wss://media.example/icallmate/media?token=media-synthetic-secret',
      callbackapi: 'https://app.example/callback?secret=callback-synthetic-secret'
    }],
    nested: { apiKey: 'api-synthetic-secret', message: 'ok' }
  };

  const request = redactRequestPayload(payload);
  const response = redactProviderPayload({
    status: 'queued',
    signed_url: 'https://storage.example/audio?token=storage-synthetic-secret',
    ukey: 'response-synthetic-secret',
    nested: { detail: 'safe' }
  });
  const output = JSON.stringify({ request, response });

  assert.doesNotMatch(output, /ukey-synthetic-secret|callback-synthetic-secret|api-synthetic-secret|response-synthetic-secret|storage-synthetic-secret/);
  assert.match(output, /token=\[redacted\]/);
  assert.equal(request.ukey, undefined);
  assert.equal(request.nested.apiKey, undefined);
  assert.equal(response.ukey, undefined);
  assert.equal(response.nested.detail, 'safe');
});
