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
