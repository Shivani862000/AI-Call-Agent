'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TICKET_TYPES, createTicketId, sanitizeSupportContext, validateSubmission } = require('../src/support-ticket');

test('support ticket IDs use the agreed type prefixes', () => {
  assert.equal(createTicketId(TICKET_TYPES.BUG, 1042), 'BUG-1042');
  assert.equal(createTicketId(TICKET_TYPES.IDEA, 1042), 'IDEA-1042');
  assert.equal(createTicketId(TICKET_TYPES.QUESTION, 1042), 'QUES-1042');
});

test('support context keeps only safe diagnostics', () => {
  const safe = sanitizeSupportContext({
    pageUrl: 'https://app.example/customers.html?patient=Jane#private',
    pageTitle: 'Customer Jane Doe', browser: 'Chrome 126', os: 'Windows', device: 'desktop',
    viewport: { width: 1440, height: 900 }, name: 'Jane Doe', phone: '+919999999999'
  });
  assert.equal(safe.pageUrl, 'https://app.example/customers.html');
  assert.equal(safe.pageTitle, 'Outbound Calls');
  assert.equal(safe.name, undefined);
  assert.equal(safe.phone, undefined);
});

test('submission requires a bounded description and known type', () => {
  assert.throws(() => validateSubmission({ type: 'URGENT', description: 'x', context: {} }), /type/i);
  assert.throws(() => validateSubmission({ type: 'BUG', description: ' ', context: {} }), /description/i);
});

test('submission redacts common PII, PHI labels, and secrets from reporter text', () => {
  const payload = validateSubmission({ type: 'BUG', description: 'Patient: Jane Doe, phone 9876543210, email jane@example.com, token=secret', context: {} });
  assert.doesNotMatch(payload.description, /Jane Doe|9876543210|jane@example\.com|secret/);
  assert.match(payload.description, /\[redacted/);
});
