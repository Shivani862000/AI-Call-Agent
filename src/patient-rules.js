'use strict';

const { normalizePhoneLookupValue } = require('./helpers');

/**
 * Validation, normalisation and role-aware masking for patient records.
 * Pure — no I/O — so the masking rules can be tested directly. Masking is the
 * part that must never regress, because a leak is silent.
 */

const LANGUAGES = new Set(['en', 'hi']);
const GENDERS = new Set(['male', 'female', 'other', 'unknown']);
const BLOOD_GROUPS = new Set(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']);
const CONSENT = new Set(['unknown', 'granted', 'refused']);
const STATUSES = new Set(['active', 'inactive']);

/** Columns an agent may never read or write. */
const CONTACT_FIELDS = ['phone', 'email'];

// ── Masking ────────────────────────────────────────────────────────────────────

/**
 * `••••••3210`. Fixed-width mask: a variable-length one would leak how many
 * digits the number has, and would render the same person differently
 * depending on whether their number was stored with a country code.
 * Numbers with fewer than 4 digits mask entirely.
 */
function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 4) return '•'.repeat(4);
  return `••••••${digits.slice(-4)}`;
}

/** `v•••@•••.in` — enough to recognise a known address, not to reconstruct it. */
function maskEmail(value) {
  const email = String(value || '').trim();
  if (!email || !email.includes('@')) return email ? '•••' : '';
  const [local, domain] = email.split('@');
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
  return `${local.slice(0, 1)}•••@•••${tld}`;
}

/**
 * Shapes a row for the client. For a non-admin the real phone and email are
 * removed from the object entirely rather than blanked, so they cannot be
 * recovered from the response by any means.
 */
function serializePatient(row, role) {
  if (!row) return row;
  const isAdmin = String(role || '').toUpperCase() === 'ADMIN';
  const patient = { ...row };

  patient.phone_masked = maskPhone(row.normalized_phone || row.phone);
  patient.email_masked = maskEmail(row.email);
  patient.full_name = [row.first_name, row.last_name].filter(Boolean).join(' ');

  if (!isAdmin) {
    CONTACT_FIELDS.forEach((field) => { delete patient[field]; });
    delete patient.normalized_phone;
  }

  return patient;
}

/** Which contact fields a non-admin is attempting to change. */
function attemptedContactWrites(body = {}) {
  return CONTACT_FIELDS.filter((field) => body[field] !== undefined);
}

// ── Normalisation and validation ───────────────────────────────────────────────

function cleanText(value, max = 200) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : null;
}

function normalizePatientPayload(input = {}) {
  const language = String(input.preferred_language || 'hi').trim().toLowerCase();
  const gender = String(input.gender || 'unknown').trim().toLowerCase();
  const bloodGroup = String(input.blood_group || 'unknown').trim().toUpperCase();

  return {
    reference_id: cleanText(input.reference_id, 60),
    first_name: cleanText(input.first_name, 80),
    last_name: cleanText(input.last_name, 80),
    phone: cleanText(input.phone, 20),
    normalized_phone: normalizePhoneLookupValue(input.phone) || null,
    email: cleanText(input.email, 160)?.toLowerCase() || null,
    preferred_call_slot: cleanText(input.preferred_call_slot, 5) || '10:00',
    preferred_language: LANGUAGES.has(language) ? language : 'hi',
    date_of_birth: cleanText(input.date_of_birth, 10),
    gender: GENDERS.has(gender) ? gender : 'unknown',
    blood_group: BLOOD_GROUPS.has(bloodGroup) ? bloodGroup : 'unknown',
    last_donation_date: cleanText(input.last_donation_date, 10),
    last_test_date: cleanText(input.last_test_date, 10),
    do_not_call: input.do_not_call ? 1 : 0,
    consent_status: CONSENT.has(String(input.consent_status || '').toLowerCase())
      ? String(input.consent_status).toLowerCase() : 'unknown',
    status: STATUSES.has(String(input.status || '').toLowerCase())
      ? String(input.status).toLowerCase() : 'active',
    notes: cleanText(input.notes, 2000)
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Field-keyed errors in the shape the UI already renders. */
function validatePatientPayload(payload) {
  const errors = {};

  if (!payload.first_name) {
    errors.first_name = 'First name is required';
  }

  if (!payload.phone) {
    errors.phone = 'Mobile number is required';
  } else if (!payload.normalized_phone || payload.normalized_phone.length < 10) {
    errors.phone = 'Enter a valid 10-digit mobile number';
  }

  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(payload.email)) {
    errors.email = 'Enter a valid email address, or leave it blank';
  }

  if (payload.preferred_call_slot && !/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.preferred_call_slot)) {
    errors.preferred_call_slot = 'Use a 24-hour time such as 10:00';
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const [field, label] of [
    ['date_of_birth', 'Date of birth'],
    ['last_donation_date', 'Last blood donation'],
    ['last_test_date', 'Last blood test']
  ]) {
    const value = payload[field];
    if (!value) continue;
    if (!isRealDate(value)) errors[field] = `${label} must be a real date (YYYY-MM-DD)`;
    else if (value > today) errors[field] = `${label} cannot be in the future`;
  }

  return errors;
}

module.exports = {
  LANGUAGES,
  GENDERS,
  BLOOD_GROUPS,
  CONTACT_FIELDS,
  maskPhone,
  maskEmail,
  serializePatient,
  attemptedContactWrites,
  normalizePatientPayload,
  validatePatientPayload,
  isRealDate
};
