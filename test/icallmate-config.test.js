'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.ICALLMATE_WEBHOOK_SECRET = 'test-icallmate-callback-secret';
process.env.APP_BASE_URL = '';
process.env.NGROK_URL = '';
process.env.WEBHOOK_URL = '';
process.env.SERVER_NAME = '';

const mountApiRoutes = require('../src/api-routes');
const { validateMediaToken } = require('../src/auth');

test('iCallMate config returns an authenticated media URL', async (t) => {
  const app = express();
  app.use(express.json());
  mountApiRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/icallmate/config`);
  assert.equal(response.status, 200);

  const config = await response.json();
  const mediaUrl = new URL(config.websocket_url);
  const token = mediaUrl.searchParams.get('token');
  assert.equal(mediaUrl.pathname, '/icallmate/media');
  assert.ok(token);
  assert.equal(validateMediaToken(token), true);

  const callbackUrl = new URL(config.callback_url);
  assert.equal(callbackUrl.pathname, '/api/icallmate/callback');
  assert.equal(callbackUrl.searchParams.get('secret'), process.env.ICALLMATE_WEBHOOK_SECRET);

  const rejectedCallback = await fetch(`http://127.0.0.1:${address.port}/api/icallmate/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call_type: 'outbound', event: 'test' })
  });
  assert.equal(rejectedCallback.status, 401);

  const acceptedCallback = await fetch(config.callback_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call_type: 'outbound', event: 'test' })
  });
  assert.equal(acceptedCallback.status, 200);
});
