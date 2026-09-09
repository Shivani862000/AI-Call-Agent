'use strict';

const CONSENT_VALUES = new Set(['unknown', 'granted', 'refused']);

function normalizeConsentStatus(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (normalized === 'denied') return 'refused';
  if (normalized === 'pending' || normalized === '') return 'unknown';
  return CONSENT_VALUES.has(normalized) ? normalized : null;
}

function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value === 1 ? 1 : 0;
  return /^(1|true|yes|on|y)$/i.test(String(value || '').trim()) ? 1 : 0;
}

function patientTurns(transcriptText = '') {
  return String(transcriptText || '')
    .split(/\r?\n/)
    .map(line => line.match(/^\s*\[?(?:PATIENT|CUSTOMER|USER)\]?\s*:\s*(.*)$/i)?.[1] || '')
    .filter(Boolean)
    .join(' ');
}

function hasSpeakerLabels(transcriptText = '') {
  return /(?:^|\n)\s*\[?(?:AI|AGENT|PATIENT|CUSTOMER|USER)\]?\s*:/i.test(String(transcriptText || ''));
}

function detectExplicitContactIntent(transcriptText = '') {
  const patientText = patientTurns(transcriptText).toLowerCase();
  if (!patientText) return 'unknown';
  if (/\bwrong\s+number|\bgalat\s+(?:number|phone)|\bnot\s+(?:the|a)\s+number|wrong\s+person/.test(patientText)) return 'refused';
  if (/\b(?:do\s*not|don't|dont|never)\s+call|\bnot\s+interested|\bno\s+thanks|\bnahi\s+chahiye|\binterest\s+nahi|\bbaat\s+nahi\s+karni/.test(patientText)) return 'refused';
  if (/\b(?:yes|haan|ha|interested|call\s+me|callback|baad\s+mein)\b/.test(patientText)) return 'granted';
  return 'unknown';
}

function canContactPatient(patient = {}) {
  if (parseBooleanFlag(patient.do_not_call)) return { allowed: false, reason: 'do_not_call' };
  if (parseBooleanFlag(patient.wrong_number_flag)) return { allowed: false, reason: 'wrong_number' };
  if (normalizeConsentStatus(patient.consent_status) === 'refused') return { allowed: false, reason: 'refused' };
  return { allowed: true, reason: null };
}

function restrictionRestoreAttempt(existing = {}, next = {}) {
  if (parseBooleanFlag(existing.do_not_call) && !parseBooleanFlag(next.do_not_call)) return 'do_not_call';
  if (parseBooleanFlag(existing.wrong_number_flag) && !parseBooleanFlag(next.wrong_number_flag)) return 'wrong_number';
  if (normalizeConsentStatus(existing.consent_status) === 'refused'
      && normalizeConsentStatus(next.consent_status) !== 'refused') return 'consent_status';
  return null;
}

module.exports = {
  CONSENT_VALUES,
  normalizeConsentStatus,
  parseBooleanFlag,
  detectExplicitContactIntent,
  canContactPatient,
  restrictionRestoreAttempt,
  patientTurns,
  hasSpeakerLabels
};
