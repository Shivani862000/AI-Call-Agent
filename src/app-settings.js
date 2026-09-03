'use strict';

/**
 * Typed access to `app_settings`, so callers never handle raw JSON and a
 * malformed or missing row degrades to a safe default rather than throwing
 * inside the scheduler tick.
 *
 * Both defaults are deliberately inert: the digest sends nothing until
 * recipients exist, and automatic calling is off until someone turns it on.
 */

const { SCRIPT_PLACEHOLDERS } = require('../prompts/safety-rules.ts');

/** Longest a custom script may be. A prompt this size already reads as a wall. */
const MAX_SCRIPT_LENGTH = 4000;

/** The calls a rule may place. There is no prompt for anything else. */
const CALL_TYPES = Object.freeze(['REVIEW_CALL', 'THREE_MONTH_FOLLOWUP']);

const DEFAULTS = Object.freeze({
  owner_digest: {
    enabled: false,
    recipients: [],
    send_at: '08:00',
    timezone: 'Asia/Kolkata',
    last_sent_date: null
  },
  // Empty means "use the built-in script". The safety rules are appended to
  // whatever is written here and cannot be edited away.
  call_scripts: {
    review_call: { system_prompt: '', opening_prompt: '' },
    three_month_followup: { system_prompt: '', opening_prompt: '' }
  },
  auto_queue: {
    enabled: false,
    rules: [
      // The three-month follow-up: the call that asks whether they have donated
      // again and when they intend to come in. It was set to REVIEW_CALL, which
      // asks "aapne kal blood donate kiya tha, experience kaisa raha?" -- a
      // question about yesterday, put to someone who last donated 90 days ago.
      {
        id: 'donation-followup',
        enabled: true,
        service: 'donation',
        min_days_since: 90,
        call_type: 'THREE_MONTH_FOLLOWUP',
        slot: '10:00'
      },
      // Off by default: there is no yearly prompt. It was set to
      // THREE_MONTH_FOLLOWUP, which opens "blood donation ke 3 mahine poore ho
      // gaye hain" -- said to someone a year on. Switching it on places that
      // call until a prompt written for a yearly reminder exists.
      {
        id: 'annual-reminder',
        enabled: false,
        service: 'any',
        min_days_since: 365,
        call_type: 'THREE_MONTH_FOLLOWUP',
        slot: '10:00'
      }
    ]
  }
});

function defaultsFor(key) {
  return JSON.parse(JSON.stringify(DEFAULTS[key] ?? {}));
}

/**
 * Merges a stored value over its defaults, one level deep. A key the stored
 * value omits keeps its default, so adding a setting later does not require
 * rewriting existing rows.
 */
function withDefaults(key, stored) {
  const base = defaultsFor(key);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
  return { ...base, ...stored };
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns a problem description, or null. */
function validateSetting(key, value) {
  if (!value || typeof value !== 'object') return 'Settings must be an object';

  if (key === 'owner_digest') {
    if (!Array.isArray(value.recipients)) return 'Recipients must be a list';
    const bad = value.recipients.find((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(r)));
    if (bad) return `"${bad}" is not a valid email address`;
    if (value.recipients.length > 20) return 'At most 20 recipients';
    if (!TIME_PATTERN.test(String(value.send_at))) return 'Send time must be a 24-hour time such as 08:00';
    if (value.enabled && value.recipients.length === 0) {
      return 'Add at least one recipient before switching the digest on';
    }
    return null;
  }

  if (key === 'call_scripts') {
    for (const callType of ['review_call', 'three_month_followup']) {
      const script = value[callType];
      if (script === undefined) continue;
      if (!script || typeof script !== 'object') return `${callType} must be an object`;

      for (const field of ['system_prompt', 'opening_prompt']) {
        const text = String(script[field] ?? '');
        if (text.length > MAX_SCRIPT_LENGTH) {
          return `${callType} ${field} is longer than ${MAX_SCRIPT_LENGTH} characters`;
        }
        // A misspelled placeholder resolves to nothing and is read out as a gap
        // in the sentence, which is only discovered on a live call.
        const unknown = [...text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)]
          .map((match) => match[1].toLowerCase())
          .filter((name) => !SCRIPT_PLACEHOLDERS.includes(name));
        if (unknown.length) {
          return `${callType} ${field}: unknown placeholder {{${unknown[0]}}}. `
            + `Available: ${SCRIPT_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}`;
        }
      }

      // An opening with no script behind it would greet the patient and then
      // fall back to the built-in flow mid-call.
      if (String(script.opening_prompt || '').trim() && !String(script.system_prompt || '').trim()) {
        return `${callType}: an opening line needs a script to go with it`;
      }
    }
    return null;
  }

  if (key === 'auto_queue') {
    if (!Array.isArray(value.rules)) return 'Rules must be a list';
    for (const rule of value.rules) {
      if (!rule || !rule.id) return 'Every rule needs an id';
      if (!['donation', 'test', 'any'].includes(String(rule.service))) {
        return `Rule "${rule.id}": service must be donation, test or any`;
      }
      const days = Number(rule.min_days_since);
      if (!Number.isFinite(days) || days < 1) {
        return `Rule "${rule.id}": days since last service must be at least 1`;
      }
      if (!TIME_PATTERN.test(String(rule.slot))) {
        return `Rule "${rule.id}": call time must be a 24-hour time such as 10:00`;
      }
      // Unvalidated, an unrecognised call type falls through to REVIEW_CALL, so
      // a rule would quietly place a different call from the one it names.
      if (!CALL_TYPES.includes(String(rule.call_type))) {
        return `Rule "${rule.id}": call type must be one of ${CALL_TYPES.join(', ')}`;
      }
    }
    return null;
  }

  return null;
}

function createSettingsStore({ dbGet, dbRun }) {
  return {
    async get(key) {
      try {
        const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [key]);
        return withDefaults(key, row?.value);
      } catch (error) {
        // A settings read must never take down the scheduler.
        console.error('[SETTINGS] falling back to defaults for', key, '-', error.message);
        return defaultsFor(key);
      }
    },

    async set(key, value, username) {
      const merged = withDefaults(key, value);
      const issue = validateSetting(key, merged);
      if (issue) throw Object.assign(new Error(issue), { statusCode: 400 });

      await dbRun(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES (?, ?, ?, now())
         ON CONFLICT (key) DO UPDATE
           SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [key, JSON.stringify(merged), username || null]
      );
      return merged;
    },

    /** Narrow write for bookkeeping the caller owns, e.g. the digest's send date. */
    async patch(key, changes, username) {
      const current = await this.get(key);
      return this.set(key, { ...current, ...changes }, username);
    }
  };
}

module.exports = {
  CALL_TYPES,
  MAX_SCRIPT_LENGTH, DEFAULTS, defaultsFor, withDefaults, validateSetting, createSettingsStore };
