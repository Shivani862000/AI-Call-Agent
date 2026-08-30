'use strict';

/**
 * SQLite-to-Postgres SQL translation.
 *
 * The application's ~260 query sites are written in SQLite dialect. Rather than
 * rewrite them, db.js runs every statement through here on the way to `pg`.
 * These functions are pure and do no I/O so they can be unit-tested directly.
 */

/**
 * Rewrites SQLite-style `?` placeholders into Postgres `$1, $2, ...`.
 * Question marks inside single-quoted string literals are left alone.
 */
function toPgPlaceholders(sql) {
  let out = '';
  let index = 0;
  let inLiteral = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (char === "'") {
      // '' inside a literal is an escaped quote, not a terminator.
      if (inLiteral && sql[i + 1] === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inLiteral = !inLiteral;
      out += char;
      continue;
    }

    if (char === '?' && !inLiteral) {
      index += 1;
      out += `$${index}`;
      continue;
    }

    out += char;
  }

  return out;
}

/** Tables with an `id` identity column. `app_state` is keyed on `key`. */
const ID_TABLES = new Set([
  'customers',
  'clients',
  'agents',
  'users',
  'campaign_configs',
  'calls',
  'feedback',
  'call_supervisor_events',
  'support_tickets',
  'patients',
  'system_logs'
]);

/**
 * Appends `RETURNING id` to INSERT statements so the pg result can populate
 * `lastID` the way sqlite3 did. Statements targeting a table without an `id`
 * column, and statements that already return something, are left untouched.
 */
function withReturningId(sql) {
  const match = /^\s*INSERT\s+INTO\s+"?([a-z_][a-z0-9_]*)"?/i.exec(sql);
  if (!match) return sql;
  if (!ID_TABLES.has(match[1].toLowerCase())) return sql;
  if (/\bRETURNING\b/i.test(sql)) return sql;
  return `${sql.replace(/;\s*$/, '')} RETURNING id`;
}

module.exports = { toPgPlaceholders, withReturningId, ID_TABLES };
