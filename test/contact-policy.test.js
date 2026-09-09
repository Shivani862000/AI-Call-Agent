'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeConsentStatus,
  parseBooleanFlag,
  detectExplicitContactIntent,
  canContactPatient,
  restrictionRestoreAttempt
} = require('../src/contact-policy');
const { detectConversationOutcome, computePriorityScore } = require('../services/call-orchestration');

test('legacy consent values normalize at one compatibility boundary', () => {
  assert.equal(normalizeConsentStatus('denied'), 'refused');
  assert.equal(normalizeConsentStatus('pending'), 'unknown');
  assert.equal(normalizeConsentStatus('granted'), 'granted');
  assert.equal(normalizeConsentStatus('refused'), 'refused');
  assert.equal(normalizeConsentStatus('unexpected'), null);
});

test('boolean flags parse false strings as false', () => {
  assert.equal(parseBooleanFlag('false'), 0);
  assert.equal(parseBooleanFlag('0'), 0);
  assert.equal(parseBooleanFlag('off'), 0);
  assert.equal(parseBooleanFlag('true'), 1);
  assert.equal(parseBooleanFlag(1), 1);
});

test('explicit patient refusal wins over positive keywords', () => {
  assert.equal(detectConversationOutcome({ transcriptText: 'CUSTOMER: I am not interested.' }), 'not_interested');
  assert.equal(detectConversationOutcome({ transcriptText: 'PATIENT: No thanks, I am not interested but maybe later.' }), 'not_interested');
  assert.equal(detectConversationOutcome({ transcriptText: 'PATIENT: Galat number hai, please do not call.' }), 'wrong_number');
  assert.equal(detectExplicitContactIntent('CUSTOMER: do not call me again'), 'refused');
  assert.equal(detectExplicitContactIntent('CUSTOMER: yes, please call me tomorrow'), 'granted');
  assert.equal(detectExplicitContactIntent('AI: do not call this number\nCUSTOMER: hello'), 'unknown');
  assert.equal(detectConversationOutcome({ transcriptText: 'AI: do not call this number' }), 'completed');
  assert.equal(detectConversationOutcome({ transcriptText: 'CUSTOMER: not interested, call me later' }), 'not_interested');
});

test('restricted patients are blocked while unknown consent remains explicit', () => {
  assert.deepEqual(canContactPatient({ do_not_call: 1, consent_status: 'granted', status: 'active' }), { allowed: false, reason: 'do_not_call' });
  assert.deepEqual(canContactPatient({ wrong_number_flag: 1, consent_status: 'granted', status: 'active' }), { allowed: false, reason: 'wrong_number' });
  assert.deepEqual(canContactPatient({ consent_status: 'denied', status: 'active' }), { allowed: false, reason: 'refused' });
  assert.deepEqual(canContactPatient({ consent_status: 'unknown', status: 'active' }), { allowed: true, reason: null });
});

test('ordinary edits cannot relax an existing contact restriction', () => {
  assert.equal(restrictionRestoreAttempt({ do_not_call: 1, consent_status: 'refused' }, { do_not_call: 0, consent_status: 'refused' }), 'do_not_call');
  assert.equal(restrictionRestoreAttempt({ wrong_number_flag: 1 }, { wrong_number_flag: 0 }), 'wrong_number');
  assert.equal(restrictionRestoreAttempt({ consent_status: 'denied' }, { consent_status: 'granted' }), 'consent_status');
  assert.equal(restrictionRestoreAttempt({ consent_status: 'unknown' }, { consent_status: 'granted' }), null);
});

test('priority scoring does not treat legacy denied as a permissive value', () => {
  assert.ok(computePriorityScore({ consent_status: 'denied' }) < computePriorityScore({ consent_status: 'unknown' }));
});
