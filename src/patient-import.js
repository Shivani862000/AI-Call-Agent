'use strict';

const { normalizePatientPayload, validatePatientPayload } = require('./patient-rules');

/**
 * Spreadsheet import: header matching, row validation, and classifying each row
 * as new / update / problem. Pure — takes rows of cells and a lookup of
 * existing patients, returns a plan. Nothing here writes.
 */

/** Canonical column -> the header spellings a real spreadsheet might use. */
const COLUMN_ALIASES = {
  reference_id: ['reference id', 'reference', 'patient id', 'donor id', 'ref', 'id'],
  first_name: ['first name', 'firstname', 'given name', 'name'],
  last_name: ['last name', 'lastname', 'surname', 'family name'],
  phone: ['mobile number', 'mobile', 'phone', 'phone number', 'contact', 'contact number'],
  email: ['email', 'email id', 'email address', 'e mail'],
  preferred_call_slot: ['preferred time', 'preferred time for call', 'best time to call', 'call time', 'slot'],
  preferred_language: ['preferred language', 'language'],
  date_of_birth: ['date of birth', 'dob', 'birth date'],
  gender: ['gender', 'sex'],
  blood_group: ['blood group', 'blood type'],
  last_donation_date: ['last donation date', 'last blood donation', 'last donation'],
  last_test_date: ['last test date', 'last blood test', 'last test'],
  notes: ['notes', 'remarks', 'comments']
};

const REQUIRED_COLUMNS = ['first_name', 'phone'];

/** `First Name` / `first_name` / `FirstName` all reduce to `first name`. */
function canonicalizeHeader(value) {
  return String(value == null ? '' : value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Maps sheet headers to canonical field names.
 * Returns { map: {columnIndex: field}, missing: [requiredFieldsNotFound] }.
 */
function mapHeaders(headerRow = []) {
  const lookup = new Map();
  Object.entries(COLUMN_ALIASES).forEach(([field, aliases]) => {
    aliases.forEach((alias) => { if (!lookup.has(alias)) lookup.set(alias, field); });
  });

  const map = {};
  const seen = new Set();
  headerRow.forEach((header, index) => {
    const field = lookup.get(canonicalizeHeader(header));
    // First column wins, so a sheet with both "Name" and "First Name" does not
    // silently take whichever came last.
    if (field && !seen.has(field)) {
      map[index] = field;
      seen.add(field);
    }
  });

  return { map, missing: REQUIRED_COLUMNS.filter((field) => !seen.has(field)) };
}

/** Excel dates arrive as Date objects, serials, or text depending on the file. */
function toIsoDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  // dd/mm/yyyy and dd-mm-yyyy — the common Indian spreadsheet format.
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (match) {
    const [, d, m, y] = match;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return text;
}

function cellToField(field, value) {
  if (field.endsWith('_date') || field === 'date_of_birth') return toIsoDate(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // Excel stores numbers numerically; a phone read as a number loses its
  // leading zero and may arrive in exponential notation.
  if (typeof value === 'number') return String(Math.round(value));
  return value == null ? '' : String(value).trim();
}

/**
 * Builds the import plan.
 *
 * `rows`      - array of cell arrays, header row excluded
 * `headerMap` - from mapHeaders()
 * `findExisting(payload, rowIndex)` - returns an existing patient row, or null.
 *   Indexed by row so rows skipped for validation cannot shift the alignment.
 */
function buildImportPlan({ rows = [], headerMap = {}, findExisting = () => null }) {
  const plan = { creates: [], updates: [], problems: [], total: rows.length };

  rows.forEach((cells, index) => {
    const rowNumber = index + 2; // +1 for the header, +1 for 1-based sheets
    const raw = {};
    Object.entries(headerMap).forEach(([columnIndex, field]) => {
      raw[field] = cellToField(field, cells[Number(columnIndex)]);
    });

    if (Object.values(raw).every((value) => value === '' || value == null)) return;

    const payload = normalizePatientPayload(raw);
    const errors = validatePatientPayload(payload);

    if (Object.keys(errors).length > 0) {
      plan.problems.push({
        row: rowNumber,
        name: [payload.first_name, payload.last_name].filter(Boolean).join(' ') || '(no name)',
        messages: Object.values(errors)
      });
      return;
    }

    const existing = findExisting(payload, index);
    if (existing) plan.updates.push({ row: rowNumber, id: existing.id, payload });
    else plan.creates.push({ row: rowNumber, payload });
  });

  // A file listing the same person twice would otherwise insert both and hit
  // the unique index halfway through the import.
  const seen = new Set();
  plan.creates = plan.creates.filter((entry) => {
    const key = entry.payload.normalized_phone;
    if (!key) return true;
    if (seen.has(key)) {
      plan.problems.push({
        row: entry.row,
        name: entry.payload.first_name,
        messages: ['This mobile number appears more than once in the file']
      });
      return false;
    }
    seen.add(key);
    return true;
  });

  return plan;
}

module.exports = {
  COLUMN_ALIASES,
  REQUIRED_COLUMNS,
  canonicalizeHeader,
  mapHeaders,
  toIsoDate,
  buildImportPlan
};
