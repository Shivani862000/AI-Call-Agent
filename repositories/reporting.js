const { requireClientId } = require('./customers');

function number(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

function safeId(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    const error = new Error(`${field} is outside JavaScript's safe integer range`);
    error.code = 'UNSAFE_DATABASE_ID';
    throw error;
  }
  return parsed;
}

function counts(row, fields) {
  return Object.fromEntries(fields.map((field) => [field, number(row?.[field])]));
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeCall(row) {
  return {
    ...row,
    id: safeId(row.id, 'calls.id'),
    customer_id: safeId(row.customer_id, 'calls.customer_id'),
    hot_lead_score: number(row.hot_lead_score),
    extracted_rating: row.extracted_rating === null ? null : number(row.extracted_rating),
    objections_json: jsonArray(row.objections),
    competitor_mentions_json: jsonArray(row.competitor_mentions)
  };
}

function createReportingRepository(database) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('Reporting repository requires a database query function');
  }

  return {
    async buildRangeData(clientId, { start, end } = {}) {
      const scopedClientId = requireClientId(clientId);
      if (!start || !end) throw new Error('Reporting start and end are required');
      const params = [scopedClientId, start, end];

      const [callStats, feedbackStats, feedback, analyzed, pending, slots, scripts] = await Promise.all([
        database.query(
          `select count(*) as total_calls,
                  count(*) filter (where outcome in ('answered', 'completed', 'consent_given', 'interested', 'callback', 'not_interested', 'hot_lead')) as answered,
                  count(*) filter (where outcome = 'no_answer') as no_answer,
                  count(*) filter (where outcome = 'declined') as declined,
                  count(*) filter (where outcome = 'consent_given') as consent_given,
                  count(*) filter (where whatsapp_sent) as whatsapp_sent,
                  count(*) filter (where fallback_triggered) as fallbacks_triggered,
                  count(*) filter (where outcome in ('interested', 'hot_lead')) as hot_leads
             from calls
            where client_id = $1 and called_at >= $2::timestamptz and called_at <= $3::timestamptz`,
          params
        ),
        database.query(
          `select count(*) as feedback_count,
                  round(avg(stars) filter (where stars is not null), 1) as average_rating,
                  count(*) filter (where category = 'good') as good_count,
                  count(*) filter (where category = 'average') as average_count,
                  count(*) filter (where category = 'bad') as bad_count
             from feedback
            where client_id = $1 and submitted_at >= $2::timestamptz and submitted_at <= $3::timestamptz`,
          params
        ),
        database.query(
          `select f.id, c.name as customer_name, f.category, f.stars,
                  left(f.review_text, 180) as review_excerpt, f.submitted_at
             from feedback f
             join customers c on c.client_id = f.client_id and c.id = f.customer_id
            where f.client_id = $1 and f.submitted_at >= $2::timestamptz and f.submitted_at <= $3::timestamptz
            order by f.submitted_at desc, f.id desc limit 20`,
          params
        ),
        database.query(
          `select calls.*, c.name as customer_name, c.phone as customer_phone
             from calls
             join customers c on c.client_id = calls.client_id and c.id = calls.customer_id
            where calls.client_id = $1 and calls.called_at >= $2::timestamptz and calls.called_at <= $3::timestamptz
            order by calls.called_at desc, calls.id desc limit 25`,
          params
        ),
        database.query(
          `select calls.id, calls.customer_id, c.name as customer_name, calls.called_at,
                  calls.outcome, calls.recording_status, calls.transcript_status,
                  calls.analysis_status, calls.follow_up_task
             from calls
             join customers c on c.client_id = calls.client_id and c.id = calls.customer_id
            where calls.client_id = $1 and calls.called_at >= $2::timestamptz and calls.called_at <= $3::timestamptz
              and (coalesce(calls.recording_status, 'pending') <> 'completed'
                or coalesce(calls.transcript_status, 'pending') <> 'completed'
                or coalesce(calls.analysis_status, 'pending') <> 'completed'
                or calls.outcome in ('initiated', 'scheduled_initiated', 'no_answer', 'busy', 'callback'))
            order by calls.called_at desc, calls.id desc limit 12`,
          params
        ),
        database.query(
          `select to_char(date_trunc('hour', called_at at time zone 'UTC'), 'HH24:MI') as slot,
                  count(*) as total_calls
             from calls
            where client_id = $1 and called_at >= $2::timestamptz and called_at <= $3::timestamptz
            group by date_trunc('hour', called_at at time zone 'UTC')
            order by total_calls desc, slot asc limit 5`,
          params
        ),
        database.query(
          `select coalesce(call_script_version, 'default') as script_version,
                  count(*) as total_calls,
                  avg(extracted_rating) filter (where extracted_rating is not null) as avg_rating
             from calls
            where client_id = $1 and called_at >= $2::timestamptz and called_at <= $3::timestamptz
            group by coalesce(call_script_version, 'default')
            order by avg_rating desc nulls last, total_calls desc, script_version asc limit 5`,
          params
        )
      ]);

      return {
        call_stats: counts(callStats.rows[0], [
          'total_calls', 'answered', 'no_answer', 'declined', 'consent_given',
          'whatsapp_sent', 'fallbacks_triggered', 'hot_leads'
        ]),
        feedback_stats: counts(feedbackStats.rows[0], [
          'feedback_count', 'average_rating', 'good_count', 'average_count', 'bad_count'
        ]),
        feedback: feedback.rows.map((row) => ({
          ...row,
          id: safeId(row.id, 'feedback.id'),
          stars: row.stars === null ? null : number(row.stars)
        })),
        analyzed_calls: analyzed.rows.map(normalizeCall),
        pending_items: pending.rows.map((row) => ({
          ...row,
          id: safeId(row.id, 'calls.id'),
          customer_id: safeId(row.customer_id, 'calls.customer_id')
        })),
        peak_slots: slots.rows.map((row) => ({ slot: row.slot, total_calls: number(row.total_calls) })),
        script_performance: scripts.rows.map((row) => ({
          script_version: row.script_version,
          total_calls: number(row.total_calls),
          avg_rating: number(row.avg_rating)
        }))
      };
    }
  };
}

module.exports = { createReportingRepository };
