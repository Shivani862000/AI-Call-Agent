'use strict';

const { dbGet, dbRun } = require('../db');
const { normalizePhoneLookupValue } = require('./helpers');
const { normalizePatientPayload } = require('./patient-rules');

/**
 * Resolves the patient a queue entry belongs to, creating one when the person
 * is not on file yet.
 *
 * Every path that opens a call — the outbound API, incoming calls, annual
 * reminders, test calls — funnels through here, so a queue entry can never
 * exist without a patient behind it. This is what lets `customers` stop being
 * the place person data lives.
 */

/** Splits a single display name into the first/last the patients table wants. */
function splitName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: 'Unknown', last_name: null };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') || null };
}

/**
 * Returns the patient id for this person, creating the record if needed.
 * Matching is by normalised phone, the same key the unique index uses.
 */
async function resolvePatientId({ name, phone, preferredSlot, language, serviceInterest, createdBy }) {
  const normalized = normalizePhoneLookupValue(phone);

  if (normalized) {
    const existing = await dbGet('SELECT id FROM patients WHERE normalized_phone = ?', [normalized]);
    if (existing) return existing.id;
  }

  const payload = normalizePatientPayload({
    ...splitName(name),
    phone,
    preferred_call_slot: preferredSlot || '10:00',
    preferred_language: language || 'hi',
    notes: serviceInterest ? `Service interest: ${serviceInterest}` : null
  });

  // A number that cannot be normalised (an internal test id, an unknown
  // caller) still gets a patient, but no unique key — so it cannot collide.
  const created = await dbRun(
    `INSERT INTO patients (first_name, last_name, phone, normalized_phone,
       preferred_call_slot, preferred_language, notes, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (normalized_phone) WHERE normalized_phone IS NOT NULL
     DO UPDATE SET updated_at = now()`,
    [
      payload.first_name, payload.last_name, payload.phone, payload.normalized_phone,
      payload.preferred_call_slot, payload.preferred_language, payload.notes,
      createdBy || 'system', createdBy || 'system'
    ]
  );

  if (created.lastID) return created.lastID;

  // The upsert took the DO UPDATE branch under a concurrent insert.
  const raced = await dbGet('SELECT id FROM patients WHERE normalized_phone = ?', [normalized]);
  return raced?.id || null;
}

module.exports = { resolvePatientId, splitName };
