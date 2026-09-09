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

async function reserveOutboundAttempt({
  dbTx,
  customerId,
  callType = 'REVIEW_CALL',
  requestKey,
  providerScope = 'icallmate',
  writerId = 'application',
  now = new Date(),
  maxActiveReservations = Infinity,
  maxAttemptsPerDay = 3,
  cooldownMs = 3 * 60 * 60 * 1000
} = {}) {
  if (typeof dbTx !== 'function') throw new TypeError('dbTx is required');
  return dbTx(async (tx) => {
    const customer = await tx.get(
      `SELECT c.*, p.id AS current_patient_id, p.status AS current_patient_status,
              p.normalized_phone AS patient_normalized_phone, p.phone AS patient_phone,
              p.do_not_call AS patient_do_not_call,
              p.consent_status AS patient_consent_status, p.contact_revision
         FROM customers c
         JOIN patients p ON p.id = c.patient_id
        WHERE c.id = ?
        FOR UPDATE`,
      [customerId]
    );
    if (!customer) return { outcome: ADMISSION_OUTCOMES.REJECTED, reason: 'customer_not_found' };

    const patient = {
      id: customer.current_patient_id,
      status: customer.current_patient_status,
      normalized_phone: customer.patient_normalized_phone,
      phone: customer.patient_phone,
      do_not_call: customer.patient_do_not_call,
      wrong_number_flag: customer.wrong_number_flag,
      consent_status: customer.patient_consent_status,
      contact_revision: customer.contact_revision
    };
    const input = {
      patientId: patient.id,
      customerId: customer.id,
      destination: patient.normalized_phone || patient.phone,
      callType,
      scheduledAt: customer.scheduled_datetime || customer.next_retry_at,
      requestKey
    };
    const key = buildAttemptRequestKey(input);
    const existing = await tx.get(
      `SELECT id, patient_id, customer_id, destination_snapshot, call_type, state, provider_call_id
         FROM call_attempts WHERE request_key = ? FOR UPDATE`,
      [key]
    );
    const duplicate = evaluateAdmission({ patient, customer, requestKey: key, existingAttempt: existing });
    if (existing) return { ...duplicate, attemptId: existing.id };

    const active = await tx.get(
      `SELECT COUNT(*) AS count FROM call_attempts
        WHERE state IN ('reserved','submitting','submitted','submission_unknown')`
    );
    const callsToday = await tx.get(
      `SELECT COUNT(*) AS count FROM calls
        WHERE patient_id = ? AND call_direction = 'outbound'
          AND (called_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
      [patient.id]
    );
    const pendingToday = await tx.get(
      `SELECT COUNT(*) AS count FROM call_attempts a
        WHERE a.patient_id = ? AND a.reserved_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date AT TIME ZONE 'Asia/Kolkata'
          AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.attempt_id = a.id)`,
      [patient.id]
    );
    const latestCall = await tx.get(
      `SELECT called_at AS latest_at FROM calls WHERE patient_id = ? AND call_direction = 'outbound' ORDER BY called_at DESC NULLS LAST LIMIT 1`,
      [patient.id]
    );
    const latestAttempt = await tx.get(
      `SELECT reserved_at AS latest_at FROM call_attempts WHERE patient_id = ? ORDER BY reserved_at DESC LIMIT 1`,
      [patient.id]
    );
    const latestAttemptAt = [latestCall?.latest_at, latestAttempt?.latest_at]
      .filter(Boolean).sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
    const decision = evaluateAdmission({
      patient,
      customer,
      requestKey: key,
      activeReservations: Number(active?.count || 0),
      maxActiveReservations,
      attemptsToday: Number(callsToday?.count || 0) + Number(pendingToday?.count || 0),
      maxAttemptsPerDay,
      latestAttemptAt,
      cooldownMs,
      now
    });
    if (decision.outcome !== ADMISSION_OUTCOMES.ACCEPTED) return decision;

    const created = await tx.run(
      `INSERT INTO call_attempts
        (request_key, patient_id, customer_id, destination_snapshot, call_type, contact_revision, state, provider_scope, writer_id)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
      [key, patient.id, customer.id, decision.destination, callType, patient.contact_revision || 0, providerScope, writerId]
    );
    await tx.run(
      `UPDATE customers SET status = 'calling', last_called_at = ?, locked_at = ?
        WHERE id = ? AND COALESCE(status, 'pending') <> 'calling'`,
      [new Date(now).toISOString(), new Date(now).toISOString(), customer.id]
    );
    return { ...decision, attemptId: created.lastID, patientId: patient.id, customerId: customer.id };
  });
}

async function recordAttemptSubmission({ dbTx, attemptId, response, error = null } = {}) {
  if (typeof dbTx !== 'function') throw new TypeError('dbTx is required');
  const classification = classifyProviderSubmission({ response, error });
  return dbTx(async (tx) => {
    const state = classification.state;
    const result = await tx.run(
      `UPDATE call_attempts
          SET state = ?, provider_call_id = ?, provider_response_json = ?, updated_at = now(),
              submitted_at = CASE WHEN ? = 'submitted' THEN COALESCE(submitted_at, now()) ELSE submitted_at END
        WHERE id = ? AND state IN ('reserved','submitting','submission_unknown')`,
      [state, response?.sid || null, JSON.stringify({
        status: response?.status || null,
        providerReturnedSid: Boolean(response?.providerReturnedSid),
        reason: classification.reason
      }), state, attemptId]
    );
    return { ...classification, changed: result.changes > 0, attemptId };
  });
}

async function recordContactDecision({
  dbTx,
  patientId,
  decision,
  expectedRevision = null,
  actorUsername = null,
  actorRole = 'SYSTEM',
  sourceType = 'workflow',
  sourceAttemptId = null,
  evidenceRef = null,
  allowRestore = false
} = {}) {
  if (typeof dbTx !== 'function') throw new TypeError('dbTx is required');
  const normalizedDecision = normalizeConsentStatus(decision);
  if (!normalizedDecision) throw Object.assign(new Error('invalid contact decision'), { code: 'CONTACT_DECISION_INVALID' });
  if (normalizedDecision === 'granted' && !(allowRestore && String(actorRole).toUpperCase() === 'ADMIN')) {
    throw Object.assign(new Error('contact restoration requires an ADMIN revision decision'), { code: 'CONTACT_RESTORE_REQUIRES_ADMIN' });
  }
  return dbTx(async (tx) => {
    const patient = await tx.get(
      `SELECT id, do_not_call, consent_status, contact_revision
         FROM patients WHERE id = ? FOR UPDATE`,
      [patientId]
    );
    if (!patient) throw Object.assign(new Error('patient not found'), { code: 'PATIENT_NOT_FOUND' });
    const revision = Number(patient.contact_revision || 0);
    if (expectedRevision !== null && Number(expectedRevision) !== revision) {
      throw Object.assign(new Error('contact revision is stale'), { code: 'CONTACT_REVISION_CONFLICT' });
    }
    const alreadyRefused = normalizedDecision === 'refused'
      && Number(patient.do_not_call || 0) === 1
      && normalizeConsentStatus(patient.consent_status) === 'refused';
    if (alreadyRefused) return { changed: false, revision, decision: 'refused' };

    const nextRevision = revision + 1;
    await tx.run(
      `UPDATE patients
          SET do_not_call = CASE WHEN ? = 'refused' THEN 1 ELSE do_not_call END,
              consent_status = ?, contact_revision = ?,
              consent_updated_at = now(), contact_restriction_source = ?,
              contact_restriction_evidence = ?, contact_restriction_updated_at = now(),
              updated_at = now()
        WHERE id = ?`,
      [normalizedDecision, normalizedDecision, nextRevision, sourceType, evidenceRef, patientId]
    );
    const event = await tx.run(
      `INSERT INTO contact_events
        (patient_id, actor_username, source_type, source_attempt_id, evidence_ref, expected_revision, new_revision, decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [patientId, actorUsername, sourceType, sourceAttemptId, evidenceRef, revision, nextRevision, normalizedDecision]
    );
    if (normalizedDecision === 'refused') {
      await tx.run(
        `UPDATE customers
            SET status = 'cancelled', next_retry_at = NULL, auto_retry_enabled = 0, locked_at = NULL
          WHERE patient_id = ?
            AND status IN ('pending','scheduled','retry_scheduled','callback_scheduled','calling')`,
        [patientId]
      );
    }
    return { changed: true, revision: nextRevision, decision: normalizedDecision, eventId: event.lastID };
  });
}

module.exports = {
  ADMISSION_OUTCOMES,
  buildAttemptRequestKey,
  evaluateAdmission,
  classifyProviderSubmission,
  reserveOutboundAttempt,
  recordAttemptSubmission,
  recordContactDecision,
  sameRequest
};
