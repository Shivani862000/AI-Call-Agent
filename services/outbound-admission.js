'use strict';

const crypto = require('node:crypto');
const { canContactPatient, normalizeConsentStatus } = require('../src/contact-policy');

const ADMISSION_OUTCOMES = Object.freeze({
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict'
});

function canonicalValue(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function buildAttemptRequestKey(input = {}) {
  if (canonicalValue(input.requestKey)) return canonicalValue(input.requestKey);
  const material = [
    canonicalValue(input.patientId),
    canonicalValue(input.customerId),
    canonicalValue(input.destination),
    canonicalValue(input.callType).toUpperCase(),
    canonicalValue(input.scheduledAt)
  ].join('|');
  return `attempt-${crypto.createHash('sha256').update(material).digest('hex').slice(0, 40)}`;
}

function sameRequest(existing = {}, input = {}) {
  return [
    ['patientId', existing.patient_id, input.patientId],
    ['customerId', existing.customer_id, input.customerId],
    ['destination', existing.destination_snapshot, input.destination],
    ['callType', String(existing.call_type || '').toUpperCase(), String(input.callType || '').toUpperCase()]
  ].every(([, left, right]) => canonicalValue(left) === canonicalValue(right));
}

function evaluateAdmission({
  patient = {},
  customer = {},
  requestKey,
  existingAttempt = null,
  paused = false,
  attemptsToday = 0,
  latestAttemptAt = null,
  activeReservations = 0,
  now = new Date(),
  maxAttemptsPerDay = 3,
  maxActiveReservations = Infinity,
  cooldownMs = 3 * 60 * 60 * 1000
} = {}) {
  const input = {
    patientId: patient.id || customer.patient_id,
    customerId: customer.id,
    destination: patient.normalized_phone || patient.phone || customer.normalized_phone || customer.phone,
    callType: customer.call_type || 'REVIEW_CALL',
    scheduledAt: customer.scheduled_datetime || customer.next_retry_at,
    requestKey
  };
  const key = buildAttemptRequestKey(input);

  if (existingAttempt) {
    return sameRequest(existingAttempt, input)
      ? { outcome: ADMISSION_OUTCOMES.DUPLICATE, reason: 'request_already_admitted', requestKey: key, attempt: existingAttempt }
      : { outcome: ADMISSION_OUTCOMES.CONFLICT, reason: 'request_key_payload_conflict', requestKey: key };
  }
  if (paused) return { outcome: ADMISSION_OUTCOMES.REJECTED, reason: 'outbound_paused', requestKey: key };
  const contact = canContactPatient({
    ...patient,
    ...customer,
    consent_status: normalizeConsentStatus(patient.consent_status ?? customer.consent_status) || 'unknown'
  });
  if (!contact.allowed) return { outcome: ADMISSION_OUTCOMES.REJECTED, reason: `contact_${contact.reason}`, requestKey: key };
  if (String(patient.status || customer.patient_status || 'active') !== 'active') {
    return { outcome: ADMISSION_OUTCOMES.REJECTED, reason: 'patient_inactive', requestKey: key };
  }
  if (!input.destination) return { outcome: ADMISSION_OUTCOMES.REJECTED, reason: 'missing_destination', requestKey: key };
  if (Number(activeReservations) >= Number(maxActiveReservations)) {
    return { outcome: ADMISSION_OUTCOMES.REJECTED, reason: 'capacity_exhausted', requestKey: key };
  }
  if (Number(attemptsToday) >= Number(maxAttemptsPerDay)) {
    return { outcome: ADMISSION_OUTCOMES.REJECTED, reason: 'daily_attempt_limit', requestKey: key };
  }
  if (latestAttemptAt) {
    const elapsed = new Date(now).getTime() - new Date(latestAttemptAt).getTime();
    if (!Number.isFinite(elapsed) || elapsed < Number(cooldownMs)) {
      return { outcome: ADMISSION_OUTCOMES.REJECTED, reason: 'cooldown_active', requestKey: key };
    }
  }
  return {
    outcome: ADMISSION_OUTCOMES.ACCEPTED,
    reason: 'admitted',
    requestKey: key,
    contactRevision: patient.contact_revision ?? null,
    destination: input.destination
  };
}

function classifyProviderSubmission({ response = null, error = null } = {}) {
  if (error) return { state: 'submission_unknown', reason: 'network_or_timeout', retryable: false };
  const status = String(response?.status || '').toLowerCase();
  if (['queued', 'accepted', 'submitted', 'success'].includes(status) || response?.providerReturnedSid) {
    return { state: 'submitted', reason: 'provider_accepted', retryable: false };
  }
  if (status === 'rejected' || response?.ok === false || response?.accepted === false) {
    return { state: 'rejected', reason: 'provider_rejected', retryable: true };
  }
  return { state: 'submission_unknown', reason: 'provider_response_unrecognized', retryable: false };
}

module.exports = {
  ADMISSION_OUTCOMES,
  buildAttemptRequestKey,
  evaluateAdmission,
  classifyProviderSubmission,
  sameRequest
};
