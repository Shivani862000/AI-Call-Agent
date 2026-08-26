const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const request = require('supertest');
const twilio = require('twilio');
const { validateTwilioHttp, validateTwilioUpgrade } = require('../middleware/twilio-validation');

const TOKEN = 'twilio-test-auth-token';
const BASE = 'https://calls.example.test';

function signature(url, params = {}) {
  return twilio.getExpectedTwilioSignature(TOKEN, url, params);
}

test('validates form callbacks with query strings against the external canonical URL', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));
  app.post('/call/status', validateTwilioHttp({ authToken: TOKEN, publicBaseUrl: BASE }), (_req, res) => res.sendStatus(200));
  const url = `${BASE}/call/status?clientId=7`;
  const params = { CallSid: 'CA123', CallStatus: 'completed' };
  await request(app)
    .post('/call/status?clientId=7')
    .set('host', 'internal-droplet:3000')
    .set('x-forwarded-proto', 'https')
    .set('x-twilio-signature', signature(url, params))
    .type('form')
    .send(params)
    .expect(200);
});

test('validates signed GET TwiML URLs and rejects invalid signatures', async () => {
  const app = express();
  app.get('/call/twiml', validateTwilioHttp({ authToken: TOKEN, publicBaseUrl: BASE }), (_req, res) => res.sendStatus(200));
  const path = '/call/twiml?customerName=Asha&clientId=2';
  await request(app).get(path).set('x-twilio-signature', signature(`${BASE}${path}`)).expect(200);
  await request(app).get(path).set('x-twilio-signature', 'invalid').expect(403, { error: 'Invalid provider signature' });
});

test('WebSocket upgrade validation uses the external wss URL and logs no sensitive input', () => {
  const logged = [];
  const logger = { warn: (event, fields) => logged.push({ event, fields }) };
  const validator = validateTwilioUpgrade({ authToken: TOKEN, publicBaseUrl: BASE, logger });
  const path = '/call/stream?clientId=3';
  const requestLike = { url: path, headers: { 'x-twilio-signature': signature(`wss://calls.example.test${path}`) } };
  assert.equal(validator(requestLike), true);
  requestLike.headers['x-twilio-signature'] = 'invalid-private-signature';
  requestLike.headers.cookie = 'private-cookie';
  assert.equal(validator(requestLike), false);
  const serialized = JSON.stringify(logged);
  assert.equal(serialized.includes('invalid-private-signature'), false);
  assert.equal(serialized.includes('private-cookie'), false);
  assert.equal(serialized.includes(TOKEN), false);
});
