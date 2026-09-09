'use strict';

const crypto = require('node:crypto');

const EVENT_MATCH_STATES = Object.freeze({
  MATCHED: 'matched',
  UNMATCHED: 'unmatched',
  AMBIGUOUS: 'ambiguous'
});

function scalar(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeProviderId(value) {
  return scalar(value).toLowerCase();
}

function extractEventIdentity(payload = {}) {
  const attemptId = payload.attempt_id ?? payload.attemptId ?? payload.attemptID;
  const requestKey = payload.request_key ?? payload.requestKey ?? payload.idempotency_key ?? payload.idempotencyKey;
  const providerId = payload.provider_call_id
    ?? payload.providerCallId
    ?? payload.call_sid
    ?? payload.callSid
    ?? payload.CallSid
    ?? payload.sid
    ?? payload.ref_no;
  return {
    attemptId: scalar(attemptId) || null,
    requestKey: scalar(requestKey) || null,
    providerId: normalizeProviderId(providerId) || null,
    phone: scalar(payload.phoneno ?? payload.phone ?? payload.callerId ?? payload.customer_number) || null
  };
}

function buildEventKey(payload = {}) {
  const identity = extractEventIdentity(payload);
  const material = [
    identity.attemptId || '', identity.requestKey || '', identity.providerId || '',
    scalar(payload.event || payload.call_event || payload.call_status || 'callback').toLowerCase(),
    scalar(payload.timestamp || payload.call_start_time || payload.call_end_time)
  ].join('|');
  return `event-${crypto.createHash('sha256').update(material).digest('hex').slice(0, 48)}`;
}

function safeEventPayload(payload = {}) {
  const allowed = [
    'event', 'call_event', 'call_status', 'call_type', 'timestamp', 'call_start_time', 'call_ansd_time',
    'call_end_time', 'attempt_id', 'attemptId', 'request_key', 'requestKey', 'provider_call_id',
    'providerCallId', 'call_sid', 'callSid', 'CallSid', 'sid', 'ref_no', 'phoneno', 'callerId', 'customer_number', 'did', 'serviceno'
  ];
  return Object.fromEntries(allowed.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]));
}

function matchCallEvent({ event = {}, attempts = [], allowIdless = false } = {}) {
  const identity = extractEventIdentity(event);
  const rows = Array.isArray(attempts) ? attempts : [];
  const by = (field, value) => rows.filter((row) => scalar(row[field]) === scalar(value));
  const providerMatches = identity.providerId
    ? rows.filter((row) => normalizeProviderId(row.provider_call_id) === identity.providerId)
    : [];

  if (identity.attemptId) {
    const matches = by('id', identity.attemptId);
    if (matches.length === 1) return { state: EVENT_MATCH_STATES.MATCHED, reason: 'attempt_id', attempt: matches[0], identity };
    return { state: EVENT_MATCH_STATES.UNMATCHED, reason: 'unknown_attempt_id', identity };
  }
  if (identity.requestKey) {
    const matches = by('request_key', identity.requestKey);
    if (matches.length === 1) return { state: EVENT_MATCH_STATES.MATCHED, reason: 'request_key', attempt: matches[0], identity };
    return { state: EVENT_MATCH_STATES.UNMATCHED, reason: 'unknown_request_key', identity };
  }
  if (identity.providerId) {
    if (providerMatches.length === 1) return { state: EVENT_MATCH_STATES.MATCHED, reason: 'provider_id', attempt: providerMatches[0], identity };
    if (providerMatches.length > 1) return { state: EVENT_MATCH_STATES.AMBIGUOUS, reason: 'duplicate_provider_id', identity, attempts: providerMatches };
    return { state: EVENT_MATCH_STATES.UNMATCHED, reason: 'unknown_provider_id', identity };
  }

  if (!allowIdless) return { state: EVENT_MATCH_STATES.UNMATCHED, reason: 'identity_required', identity };
  const phoneMatches = identity.phone
    ? rows.filter((row) => scalar(row.destination_snapshot) === identity.phone && ['reserved', 'submitting', 'submitted', 'submission_unknown'].includes(String(row.state || '').toLowerCase()))
    : [];
  if (phoneMatches.length === 1) return { state: EVENT_MATCH_STATES.MATCHED, reason: 'idless_unique_compatibility', attempt: phoneMatches[0], identity };
  if (phoneMatches.length > 1) return { state: EVENT_MATCH_STATES.AMBIGUOUS, reason: 'idless_multiple_candidates', identity, attempts: phoneMatches };
  return { state: EVENT_MATCH_STATES.UNMATCHED, reason: 'no_eligible_candidate', identity };
}

module.exports = { EVENT_MATCH_STATES, extractEventIdentity, matchCallEvent, normalizeProviderId, buildEventKey, safeEventPayload };
