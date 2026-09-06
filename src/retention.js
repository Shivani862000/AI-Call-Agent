'use strict';

/**
 * How long call content is kept before it is destroyed.
 *
 * Recordings and transcripts of blood donors are health data, and keeping them
 * indefinitely because nothing deletes them is not a decision anyone made. The
 * policy here is ten years from the call, after which the recording and every
 * piece of free text derived from it are destroyed.
 *
 * The call row itself survives, holding only dates, outcome and counts. That
 * keeps the fact that a call happened -- which the centre needs for its own
 * records -- without keeping what was said.
 *
 * Pure and free of I/O, because this is the code that decides to destroy
 * patient data and it must be readable and testable on its own.
 */
const DEFAULT_RETENTION_YEARS = 10;

/** Columns holding what was said, or anything derived from it. */
const CONTENT_COLUMNS = Object.freeze([
  'transcript_text',
  'analysis_json',
  'analysis_summary',
  'summary',
  'key_points_json',
  'report_excerpt',
  'extracted_review_text',
  'extracted_entities',
  'timeline_events',
  'objections_json',
  'competitor_mentions_json',
  'notes',
  'provider_payload_json',
  'redonation_note',
  'reported_donation_date',
  'reported_donation_place',
  'intended_visit_note'
]);

function retentionYears(setting) {
  const years = Number(setting && setting.years);
  if (!Number.isFinite(years) || years < 1) return DEFAULT_RETENTION_YEARS;
  return Math.floor(years);
}

/**
 * The date before which content must be destroyed. Anything on or after it is
 * still within the retention period.
 */
function cutoffDate(setting, now = new Date()) {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - retentionYears(setting));
  return cutoff;
}

function isEnabled(setting) {
  return Boolean(setting && setting.enabled);
}

/**
 * Whether a call is past its retention period. A call with no date at all is
 * deliberately kept: an unknown age is not evidence of being old enough to
 * destroy, and this is not reversible.
 */
function isDueForPurge(call, setting, now = new Date()) {
  if (!isEnabled(setting)) return false;
  const stamp = call && (call.called_at || call.ended_at || call.created_at);
  if (!stamp) return false;
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return false;
  return at < cutoffDate(setting, now);
}

/** The UPDATE that empties a purged call, as a statement and its parameters. */
function buildPurgeStatement(callId) {
  const assignments = CONTENT_COLUMNS.map((column) => `${column} = NULL`).join(', ');
  return {
    sql: `UPDATE calls SET ${assignments}, recording_object_key = NULL,
             recording_url = NULL, recording_status = 'purged'
           WHERE id = ?`,
    params: [callId]
  };
}

module.exports = {
  DEFAULT_RETENTION_YEARS,
  CONTENT_COLUMNS,
  retentionYears,
  cutoffDate,
  isEnabled,
  isDueForPurge,
  buildPurgeStatement
};
