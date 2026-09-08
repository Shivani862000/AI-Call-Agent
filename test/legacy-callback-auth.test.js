'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { servePrivacyApp } = require('./support/privacy-app');

const secret = 'synthetic-legacy-provider-secret';

test('legacy callbacks are disabled by default before any database work', async t => {
  const app = await servePrivacyApp(t, { console: { ...console, log() {} } });
  for (const [method, target] of [['GET', '/call/status'], ['POST', '/CALL/STATUS/'], ['POST', '/call/recording-status']]) {
    const response = await app.request(method, target);
    assert.equal(response.status, 404, target);
  }
  assert.deepEqual(app.effects, []);
});

test('enabled legacy callbacks require provider credentials even with an ADMIN cookie', async t => {
  const app = await servePrivacyApp(t, { env: { ENABLE_LEGACY_CALL_WEBHOOKS: 'true', ICALLMATE_WEBHOOK_SECRET: secret },
    console: { ...console, log() {} } });
  const token = app.auth.createAuthToken('operator', 'ADMIN');
  for (const target of ['/call/status', '/call/recording-status']) {
    for (const query of ['', '?secret=wrong', '?secret[]=synthetic-legacy-provider-secret']) {
      assert.equal((await app.request('POST', target + query, token)).status, 401, target + query);
    }
  }
  assert.deepEqual(app.effects, []);
});

test('legacy callbacks fail closed when explicitly enabled without a configured secret', async t => {
  const app = await servePrivacyApp(t, { env: { ENABLE_LEGACY_CALL_WEBHOOKS: 'true' },
    console: { ...console, log() {} } });
  assert.equal((await app.request('GET', `/call/status?secret=${secret}`)).status, 401);
  assert.deepEqual(app.effects, []);
});

test('an enabled authenticated status callback reaches its handler without logging credentials', async t => {
  const logs = [];
  const app = await servePrivacyApp(t, { env: { ENABLE_LEGACY_CALL_WEBHOOKS: 'true', ICALLMATE_WEBHOOK_SECRET: secret },
    console: { ...console, log: (...args) => logs.push(args.join(' ')) } });
  const response = await app.request('GET', `/CALL/STATUS/?CallSid=fixture-call&secret=${secret}`);
  assert.equal(response.status, 200);
  assert.deepEqual(app.effects, ['dbGet']);
  assert.ok(!logs.join('\n').includes(secret));
});
