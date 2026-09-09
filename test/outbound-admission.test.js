'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADMISSION_OUTCOMES,
  buildAttemptRequestKey,
  evaluateAdmission,
  classifyProviderSubmission
} = require('../services/outbound-admission');

const patient = { id: 7, status: 'active', normalized_phone: '919876543210', consent_status: 'unknown' };
const customer = { id: 11, patient_id: 7, call_type: 'REVIEW_CALL', scheduled_datetime: '2026-09-09T10:00:00.000Z' };

test('request keys are deterministic and distinguish payload changes', () => {
  const one = buildAttemptRequestKey({ patientId: 7, customerId: 11, destination: '919876543210', callType: 'review_call', scheduledAt: customer.scheduled_datetime });
  assert.equal(one, buildAttemptRequestKey({ patientId: 7, customerId: 11, destination: '919876543210', callType: 'REVIEW_CALL', scheduledAt: customer.scheduled_datetime }));
  assert.notEqual(one, buildAttemptRequestKey({ patientId: 7, customerId: 11, destination: '919876543211', callType: 'REVIEW_CALL', scheduledAt: customer.scheduled_datetime }));
});

test('admission accepts unknown consent but blocks restrictions before capacity', () => {
  assert.equal(evaluateAdmission({ patient, customer }).outcome, ADMISSION_OUTCOMES.ACCEPTED);
  assert.equal(evaluateAdmission({ patient: { ...patient, consent_status: 'denied' }, customer }).reason, 'contact_refused');
  assert.equal(evaluateAdmission({ patient: { ...patient, do_not_call: '1' }, customer }).reason, 'contact_do_not_call');
  assert.equal(evaluateAdmission({ patient: { ...patient, wrong_number_flag: 1 }, customer }).reason, 'contact_wrong_number');
});

test('pause, capacity, daily limits and cooldown reject without a provider request', () => {
  assert.equal(evaluateAdmission({ patient, customer, paused: true }).reason, 'outbound_paused');
  assert.equal(evaluateAdmission({ patient, customer, activeReservations: 2, maxActiveReservations: 2 }).reason, 'capacity_exhausted');
  assert.equal(evaluateAdmission({ patient, customer, attemptsToday: 3 }).reason, 'daily_attempt_limit');
  assert.equal(evaluateAdmission({ patient, customer, latestAttemptAt: '2026-09-09T09:00:00.000Z', now: '2026-09-09T10:00:00.000Z' }).reason, 'cooldown_active');
});

test('same request key is idempotent and changed payload conflicts', () => {
  const admitted = evaluateAdmission({ patient, customer });
  const existing = {
    patient_id: patient.id,
    customer_id: customer.id,
    destination_snapshot: patient.normalized_phone,
    call_type: customer.call_type
  };
  assert.equal(evaluateAdmission({ patient, customer, requestKey: admitted.requestKey, existingAttempt: existing }).outcome, ADMISSION_OUTCOMES.DUPLICATE);
  assert.equal(evaluateAdmission({ patient, customer: { ...customer, call_type: 'THREE_MONTH_FOLLOWUP' }, requestKey: admitted.requestKey, existingAttempt: existing }).outcome, ADMISSION_OUTCOMES.CONFLICT);
});

test('provider uncertainty is retained instead of treated as a safe retry', () => {
  assert.deepEqual(classifyProviderSubmission({ response: { status: 'queued', providerReturnedSid: true } }), { state: 'submitted', reason: 'provider_accepted', retryable: false });
  assert.deepEqual(classifyProviderSubmission({ error: new Error('timeout') }), { state: 'submission_unknown', reason: 'network_or_timeout', retryable: false });
  assert.deepEqual(classifyProviderSubmission({ response: { status: 'rejected' } }), { state: 'rejected', reason: 'provider_rejected', retryable: true });
});
