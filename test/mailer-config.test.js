'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isMailConfigured, mailConfig } = require('../services/mailer');

const relay = { SMTP_HOST: 'smtp-relay.gmail.com', MAIL_FROM: 'noreply@example.com' };
const password = {
  SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@example.com',
  SMTP_PASS: 'secret', MAIL_FROM: 'a@example.com'
};

test('a password transport still needs a username and a password', () => {
  assert.equal(isMailConfigured(password), true);
  assert.equal(isMailConfigured({ ...password, SMTP_PASS: '' }), false);
  assert.equal(isMailConfigured({ ...password, SMTP_USER: '' }), false);
});

// Google Workspace's relay authenticates the machine by IP, so there is no
// credential to hold on the droplet.
test('an IP-authenticated relay needs no credentials', () => {
  assert.equal(isMailConfigured({ ...relay, SMTP_AUTH_MODE: 'ip' }), true);
  assert.equal(mailConfig({ ...relay, SMTP_AUTH_MODE: 'ip' }).authMode, 'ip');
});

// Treating "no username and no password" as consent to send unauthenticated
// would turn a forgotten SMTP_PASS into a silent unauthenticated relay attempt.
test('missing credentials are an error, not an implied relay', () => {
  assert.equal(isMailConfigured(relay), false);
  assert.equal(mailConfig(relay).authMode, 'password');
});

test('a host or sender is required whichever mode is used', () => {
  assert.equal(isMailConfigured({ ...relay, SMTP_AUTH_MODE: 'ip', SMTP_HOST: '' }), false);
  assert.equal(isMailConfigured({ ...relay, SMTP_AUTH_MODE: 'ip', MAIL_FROM: '' }), false);
});

test('the sender falls back to the username only when there is one', () => {
  assert.equal(mailConfig(password).from, 'a@example.com');
  assert.equal(mailConfig({ ...relay, SMTP_AUTH_MODE: 'ip' }).from, 'noreply@example.com');
});

// The digest carries patient names, so an unencrypted hop is refused in both
// modes -- an IP-allowlisted relay has nothing else protecting the payload.
test('TLS is required on every port in both modes', () => {
  for (const env of [password, { ...relay, SMTP_AUTH_MODE: 'ip' }]) {
    assert.equal(mailConfig({ ...env, SMTP_PORT: '587' }).port, 587);
    assert.equal(mailConfig({ ...env, SMTP_PORT: '465' }).port, 465);
  }
  const source = require('fs').readFileSync(require.resolve('../services/mailer'), 'utf8');
  assert.match(source, /requireTLS: config\.port !== 465/);
  assert.match(source, /secure: config\.port === 465/);
});

// DigitalOcean and most hosts block outbound 25/465/587 by default and drop the
// packets rather than refusing them, so every provider looks the same: a long
// hang, then a timeout that says nothing about why.
test('a blocked SMTP port is explained, not just timed out', () => {
  const { explainMailError } = require('../services/mailer');
  const config = { host: 'smtp-relay.gmail.com', port: 587 };

  for (const code of ['ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED']) {
    const message = explainMailError(Object.assign(new Error('connect ' + code), { code }), config).message;
    assert.match(message, /smtp-relay\.gmail\.com:587/);
    assert.match(message, /blocked by the hosting provider/i);
  }
});

// A wrong password must not be reported as a network block.
test('an authentication failure is passed through untouched', () => {
  const { explainMailError } = require('../services/mailer');
  const original = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
  assert.equal(explainMailError(original, { host: 'h', port: 587 }), original);
});

test('the transport cannot wait forever', () => {
  const source = require('fs').readFileSync(require.resolve('../services/mailer'), 'utf8');
  for (const option of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
    assert.match(source, new RegExp(`${option}: \\d+`), `${option} is not set`);
  }
});
