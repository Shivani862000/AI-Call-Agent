'use strict';

/**
 * Decides whether a patient may be queued for a call.
 *
 * Pure and free of I/O, because this is the code that decides to phone a real
 * person. Both paths use it: the explicit "schedule a call" action and the
 * automatic rules, so a patient who must not be called cannot be reached by
 * going in the other door.
 */

/** Reasons a patient can never be queued, whatever the caller wants. */
function blockingReason(patient) {
  if (!patient) return 'Patient not found';
  if (Number(patient.do_not_call) === 1) return 'This patient is marked do not call';
  if (String(patient.consent_status) === 'refused') return 'This patient has refused consent';
  if (String(patient.status) !== 'active') return 'This patient is not on the calling list';
  if (!patient.normalized_phone) return 'This patient has no usable mobile number';
  return null;
}

function daysBetween(fromIso, todayIso) {
  if (!fromIso) return null;
  const from = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${String(todayIso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / 86400000);
}

/** The service date a rule measures from. */
function lastServiceDate(patient, service) {
  if (service === 'donation') return patient.last_donation_date || null;
  if (service === 'test') return patient.last_test_date || null;

  const dates = [patient.last_donation_date, patient.last_test_date]
    .filter(Boolean)
    .map((d) => String(d).slice(0, 10))
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/**
 * Returns { eligible, reason }. A patient with no relevant service date is
 * deliberately NOT eligible: "we have never recorded a donation" is not the
 * same as "they donated long ago", and treating it as such would cold-call
 * everyone on the list the moment a rule is switched on.
 */
function evaluateRule(patient, rule, todayIso) {
  const blocked = blockingReason(patient);
  if (blocked) return { eligible: false, reason: blocked };
  if (!rule || rule.enabled === false) return { eligible: false, reason: 'Rule is off' };

  const since = lastServiceDate(patient, String(rule.service));
  if (!since) return { eligible: false, reason: 'No recorded service date to measure from' };

  const days = daysBetween(since, todayIso);
  if (days == null) return { eligible: false, reason: 'Service date is not a real date' };
  if (days < Number(rule.min_days_since)) {
    return { eligible: false, reason: `Only ${days} days since last service` };
  }

  return { eligible: true, reason: null, daysSince: days };
}

/**
 * Applies every enabled rule to every patient, returning at most one entry per
 * patient — the first matching rule wins, so overlapping rules cannot queue the
 * same person twice.
 */
function selectPatientsToQueue({ patients = [], rules = [], today, alreadyQueued = new Set() }) {
  const todayIso = String(today || new Date().toISOString()).slice(0, 10);
  const selected = [];

  for (const patient of patients) {
    if (alreadyQueued.has(patient.id)) continue;
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      const result = evaluateRule(patient, rule, todayIso);
      if (result.eligible) {
        selected.push({ patientId: patient.id, rule, daysSince: result.daysSince });
        break;
      }
    }
  }

  return selected;
}

module.exports = { blockingReason, evaluateRule, selectPatientsToQueue, lastServiceDate, daysBetween };
