'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  mailConfig,
  isMailConfigured,
  buildAssertion,
  buildRawMessage,
  explainGmailError
} = require('../services/mailer');

// A throwaway key pair, generated per run: nothing real is committed, and the
// signature assertions below verify against the matching public half.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const gmail = {
  GMAIL_CLIENT_EMAIL: 'kcpathlab-mailer@ai-call-agent-506814.iam.gserviceaccount.com',
  GMAIL_PRIVATE_KEY: privateKey,
  GMAIL_IMPERSONATE: 'noreply@vikitechsolutions.in',
  MAIL_FROM: 'noreply@vikitechsolutions.in'
};

const smtp = {
  SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@example.com',
  SMTP_PASS: 'secret', MAIL_FROM: 'a@example.com'
};

function decodePart(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

test('the Gmail API transport is chosen when a key and a sender exist', () => {
  assert.equal(mailConfig(gmail).transport, 'gmail-api');
  assert.equal(isMailConfigured(gmail), true);
});

// The droplet cannot reach any SMTP port, so a half-configured Gmail setup must
// not quietly fall back to a transport that is guaranteed to time out.
test('a Gmail key without an impersonated mailbox is not configured', () => {
  assert.equal(isMailConfigured({ ...gmail, GMAIL_IMPERSONATE: '' }), false);
  assert.equal(isMailConfigured({ ...gmail, GMAIL_PRIVATE_KEY: '', GMAIL_KEY_FILE: '' }), false);
});

test('SMTP still works for local development', () => {
  assert.equal(mailConfig(smtp).transport, 'smtp');
  assert.equal(isMailConfigured(smtp), true);
});

// Both configured at once would be ambiguous. Gmail wins because it is the one
// that works in production; SMTP is the developer's local convenience.
test('Gmail takes precedence when both are configured', () => {
  assert.equal(mailConfig({ ...smtp, ...gmail }).transport, 'gmail-api');
});

test('the assertion is a signed JWT Google will accept', () => {
  const now = new Date('2026-09-07T12:00:00Z');
  const assertion = buildAssertion({
    clientEmail: gmail.GMAIL_CLIENT_EMAIL,
    privateKey,
    impersonate: gmail.GMAIL_IMPERSONATE,
    now
  });

  const [header, claims, signature] = assertion.split('.');
  assert.deepEqual(decodePart(header), { alg: 'RS256', typ: 'JWT' });

  const payload = decodePart(claims);
  assert.equal(payload.iss, gmail.GMAIL_CLIENT_EMAIL);
  // "sub" is what makes this domain-wide delegation rather than a plain
  // service-account token: it names the mailbox being impersonated.
  assert.equal(payload.sub, gmail.GMAIL_IMPERSONATE);
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/gmail.send');
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  const issuedAt = Math.floor(now.getTime() / 1000);
  assert.equal(payload.iat, issuedAt);
  assert.equal(payload.exp, issuedAt + 3600);

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${header}.${claims}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
});

// Google rejects an assertion whose exp is more than an hour out.
test('the assertion never asks for more than an hour', () => {
  const payload = decodePart(buildAssertion({
    clientEmail: 'a@b.iam.gserviceaccount.com',
    privateKey,
    impersonate: 'x@y.in',
    now: new Date()
  }).split('.')[1]);
  assert.ok(payload.exp - payload.iat <= 3600);
});

test('the raw message carries both a text and an HTML part', () => {
  const raw = buildRawMessage({
    from: 'noreply@vikitechsolutions.in',
    to: ['owner@vikitechsolutions.in'],
    subject: 'Daily digest',
    text: 'plain body',
    html: '<p>html body</p>'
  });

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /^From: noreply@vikitechsolutions\.in\r\n/m);
  assert.match(decoded, /^To: owner@vikitechsolutions\.in\r\n/m);
  assert.match(decoded, /^Subject: Daily digest\r\n/m);
  assert.match(decoded, /Content-Type: multipart\/alternative; boundary="/);
  assert.match(decoded, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(decoded, /Content-Type: text\/html; charset="UTF-8"/);
  assert.ok(decoded.includes(Buffer.from('plain body', 'utf8').toString('base64')));
  assert.ok(decoded.includes(Buffer.from('<p>html body</p>', 'utf8').toString('base64')));
});

// Patient names in the digest are frequently Devanagari. A raw 8-bit subject
// header is invalid and arrives as mojibake.
test('a non-ASCII subject is RFC 2047 encoded', () => {
  const raw = buildRawMessage({
    from: 'a@b.in', to: ['c@d.in'],
    subject: 'रक्तदान रिपोर्ट', text: 'x', html: '<p>x</p>'
  });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const expected = `=?UTF-8?B?${Buffer.from('रक्तदान रिपोर्ट', 'utf8').toString('base64')}?=`;
  assert.ok(decoded.includes(`Subject: ${expected}`), 'subject should be base64 word-encoded');
  assert.ok(!decoded.includes('Subject: रक्तदान'), 'raw 8-bit subject header is invalid');
});

test('several recipients are comma separated in one header', () => {
  const decoded = Buffer.from(buildRawMessage({
    from: 'a@b.in', to: ['x@y.in', 'p@q.in'], subject: 's', text: 't', html: '<p>t</p>'
  }), 'base64url').toString('utf8');
  assert.match(decoded, /^To: x@y\.in, p@q\.in\r\n/m);
});

// base64url, not base64: Gmail rejects a body containing + or /.
test('the raw message is base64url with no padding', () => {
  const raw = buildRawMessage({
    from: 'a@b.in', to: ['c@d.in'], subject: 'ü'.repeat(40), text: 'x', html: '<p>x</p>'
  });
  assert.doesNotMatch(raw, /[+/=]/);
});

// These three are the entire failure surface of domain-wide delegation, and
// Google's own wording for them says nothing about the cause.
test('Google\'s opaque OAuth errors are explained', () => {
  assert.match(
    explainGmailError({ error: 'unauthorized_client' }).message,
    /domain-wide delegation/i
  );
  assert.match(
    explainGmailError({ error: 'invalid_grant' }).message,
    /mailbox|clock/i
  );
  assert.match(
    explainGmailError({ error: 'access_denied' }, 403).message,
    /Gmail API|scope/i
  );
});

test('an unrecognised error is passed through rather than mislabelled', () => {
  const message = explainGmailError({ error: 'teapot', error_description: 'short and stout' }).message;
  assert.match(message, /teapot/);
  assert.match(message, /short and stout/);
});
