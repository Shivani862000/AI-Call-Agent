'use strict';

/**
 * Data behind the Overview page.
 *
 * Every day boundary here is an Indian day. The containers run UTC, and a
 * "today" read off the server clock starts at 05:30 IST -- the defect still
 * open in services/reporting.js. Asia/Kolkata has no daylight saving, so a
 * fixed +05:30 offset is exact rather than an approximation.
 *
 * Averages count working days only, Monday to Saturday. The centre does not
 * call on Sundays; dividing by calendar days would make every ordinary day
 * look better than average.
 */

const { dbAll, dbGet, dbRun } = require('../db');

const TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const RANGES = Object.freeze(['24h', 'today', 'yesterday', '7d', '30d', 'month']);

/** How far back "Needs attention" looks. Older items were handled off-screen or not at all. */
const ATTENTION_WINDOW_DAYS = 30;

/** A retry this late means the scheduler did not pick it up. Less than that is just queue lag. */
const OVERDUE_GRACE_HOURS = 2;

const ATTENTION_KEY = /^(call|queue):\d+:(complaint|callback|wrong_number|overdue)$/;

const OUTBOUND = "COALESCE(calls.call_direction, 'outbound') = 'outbound'";
const IST = `AT TIME ZONE '${TIMEZONE}'`;

// ── Calendar ────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' of the Indian calendar day containing `date`. */
function istDate(date) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant an Indian calendar day begins. */
function istMidnight(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
}

function addDays(day, count) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

function isWorkingDay(day) {
  return new Date(`${day}T00:00:00Z`).getUTCDay() !== 0;
}

/** Working days from `from` to `to`, both inclusive. Zero when the span is empty. */
function countWorkingDays(from, to) {
  if (!from || !to || to < from) return 0;
  let count = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (isWorkingDay(day)) count += 1;
  }
  return count;
}

/**
 * The window a range covers, and which days it is made of.
 *
 * `wholeDays` is the inclusive span of complete Indian days; `includesToday`
 * says whether today's part-day is in it too. The rolling 24 hours is neither:
 * it is the tail of yesterday plus today so far, and is handled on its own.
 */
function resolveRange(key, now = new Date()) {
  const today = istDate(now);
  const yesterday = addDays(today, -1);
  const todayStart = istMidnight(today);
  const firstOfMonth = `${today.slice(0, 8)}01`;

  switch (key) {
    case 'today':
      return { key, label: 'Today', start: todayStart, end: now, wholeDays: null, includesToday: true };
    case 'yesterday':
      return { key, label: 'Yesterday', start: istMidnight(yesterday), end: todayStart, wholeDays: [yesterday, yesterday], includesToday: false };
    case '7d':
      return { key, label: 'Last 7 days', start: istMidnight(addDays(today, -6)), end: now, wholeDays: [addDays(today, -6), yesterday], includesToday: true };
    case '30d':
      return { key, label: 'Last 30 days', start: istMidnight(addDays(today, -29)), end: now, wholeDays: [addDays(today, -29), yesterday], includesToday: true };
    case 'month':
      return { key, label: 'This month', start: istMidnight(firstOfMonth), end: now, wholeDays: [firstOfMonth, yesterday], includesToday: true };
    case '24h':
    default:
      return { key: '24h', label: 'Last 24 hours', start: new Date(now.getTime() - DAY_MS), end: now, wholeDays: null, includesToday: true, rolling: true };
  }
}

/**
 * What an average stretch of working days would have produced over `range`.
 *
 * `perDay` is the all-time count per working day; `byTimeOfDay` is the part of
 * it that normally happens before the current Indian clock time. Using the
 * latter for today's part-day is what keeps "Today" at 10 AM from reading as
 * far below average.
 */
function expectedCount(range, { perDay, byTimeOfDay }, now = new Date()) {
  const today = istDate(now);
  const soFarToday = isWorkingDay(today) ? byTimeOfDay : 0;

  if (range.rolling) {
    const restOfYesterday = isWorkingDay(addDays(today, -1)) ? Math.max(perDay - byTimeOfDay, 0) : 0;
    return restOfYesterday + soFarToday;
  }

  const whole = range.wholeDays ? countWorkingDays(range.wholeDays[0], range.wholeDays[1]) * perDay : 0;
  return whole + (range.includesToday ? soFarToday : 0);
}

/** Working days a range spans, counting today's part-day as one when today is a working day. */
function workingDaysInRange(range, now = new Date()) {
  const today = istDate(now);
  if (range.rolling) return 1;
  const whole = range.wholeDays ? countWorkingDays(range.wholeDays[0], range.wholeDays[1]) : 0;
  return whole + (range.includesToday && isWorkingDay(today) ? 1 : 0);
}

function compareLabel(range, now = new Date()) {
  if (range.key === 'today') return 'vs overall average by this time of day';
  if (range.key === '24h') return 'vs overall average for a working day';
  const days = workingDaysInRange(range, now);
  if (days === 0) return 'not a working day';
  return `vs overall average for ${days} working ${days === 1 ? 'day' : 'days'}`;
}

function isAttentionKey(value) {
  return ATTENTION_KEY.test(String(value || ''));
}

// ── Queries ─────────────────────────────────────────────────────────────────

const num = (value) => (value == null ? 0 : Number(value));
const numOrNull = (value) => (value == null ? null : Number(value));

async function rangeCalls(range) {
  const params = [range.start.toISOString(), range.end.toISOString()];
  const [totals, slot] = await Promise.all([
    dbGet(
      `SELECT
         COUNT(*) AS placed,
         COUNT(calls.answered_at) AS answered,
         COUNT(*) FILTER (WHERE calls.answered_at IS NULL AND calls.outcome IN ('no_answer', 'declined')) AS no_answer,
         COUNT(*) FILTER (WHERE calls.answered_at IS NULL AND calls.outcome = 'busy') AS busy,
         AVG(EXTRACT(EPOCH FROM (calls.ended_at - calls.answered_at)))
           FILTER (WHERE calls.answered_at IS NOT NULL AND calls.ended_at > calls.answered_at) AS avg_seconds
       FROM calls
       WHERE ${OUTBOUND} AND calls.called_at >= ? AND calls.called_at < ?`,
      params
    ),
    // Three calls is the least an hour needs before its answer rate means anything.
    dbGet(
      `SELECT
         EXTRACT(HOUR FROM calls.called_at ${IST})::int AS hour,
         COUNT(*) AS placed,
         COUNT(calls.answered_at) AS answered
       FROM calls
       WHERE ${OUTBOUND} AND calls.called_at >= ? AND calls.called_at < ?
       GROUP BY 1
       HAVING COUNT(*) >= 3
       ORDER BY COUNT(calls.answered_at)::float / COUNT(*) DESC, COUNT(*) DESC
       LIMIT 1`,
      params
    )
  ]);

  const placed = num(totals?.placed);
  const answered = num(totals?.answered);
  const noAnswer = num(totals?.no_answer);
  const busy = num(totals?.busy);

  return {
    placed,
    answered,
    no_answer: noAnswer,
    busy,
    other: Math.max(placed - answered - noAnswer - busy, 0),
    answer_rate: placed ? (answered / placed) * 100 : null,
    avg_seconds: numOrNull(totals?.avg_seconds),
    best_slot: slot
      ? { hour: num(slot.hour), placed: num(slot.placed), answered: num(slot.answered), rate: (num(slot.answered) / num(slot.placed)) * 100 }
      : null
  };
}

async function rangeFeedback(range) {
  const row = await dbGet(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE category IN ('good', 'positive')) AS good,
       COUNT(*) FILTER (WHERE category IN ('average', 'neutral')) AS average,
       COUNT(*) FILTER (WHERE category IN ('bad', 'poor', 'negative')) AS poor
     FROM feedback
     WHERE submitted_at >= ? AND submitted_at < ?`,
    [range.start.toISOString(), range.end.toISOString()]
  );
  return { total: num(row?.total), good: num(row?.good), average: num(row?.average), poor: num(row?.poor) };
}

/**
 * All-time figures from working days before today. Today is left out because
 * it is incomplete, and would drag the per-day average down every morning.
 */
async function history(now, { includeFeedback }) {
  const todayStart = istMidnight(istDate(now)).toISOString();
  const nowIso = now.toISOString();

  const calls = await dbGet(
    `SELECT
       MIN((calls.called_at ${IST})::date)::text AS first_day,
       COUNT(*) AS placed,
       COUNT(*) FILTER (WHERE (calls.called_at ${IST})::time <= (?::timestamptz ${IST})::time) AS placed_by_time,
       COUNT(calls.answered_at) AS answered,
       AVG(EXTRACT(EPOCH FROM (calls.ended_at - calls.answered_at)))
         FILTER (WHERE calls.answered_at IS NOT NULL AND calls.ended_at > calls.answered_at) AS avg_seconds
     FROM calls
     WHERE ${OUTBOUND}
       AND calls.called_at < ?
       AND EXTRACT(ISODOW FROM calls.called_at ${IST}) <> 7`,
    [nowIso, todayStart]
  );

  const firstDay = calls?.first_day || null;
  const workingDays = firstDay ? countWorkingDays(firstDay, addDays(istDate(now), -1)) : 0;

  let feedback = null;
  if (includeFeedback && firstDay) {
    // Counted from the first calling day, so both averages share one denominator.
    feedback = await dbGet(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE (submitted_at ${IST})::time <= (?::timestamptz ${IST})::time) AS by_time
       FROM feedback
       WHERE submitted_at >= ? AND submitted_at < ?
         AND EXTRACT(ISODOW FROM submitted_at ${IST}) <> 7`,
      [nowIso, istMidnight(firstDay).toISOString(), todayStart]
    );
  }

  return {
    workingDays,
    placed: num(calls?.placed),
    placedByTime: num(calls?.placed_by_time),
    answered: num(calls?.answered),
    avgSeconds: numOrNull(calls?.avg_seconds),
    feedback: feedback ? { total: num(feedback.total), byTime: num(feedback.by_time) } : null
  };
}

function averagesFor(range, past, now) {
  if (!past.workingDays) return null;
  const perDay = (total, byTime) => ({ perDay: total / past.workingDays, byTimeOfDay: byTime / past.workingDays });

  return {
    working_days: past.workingDays,
    placed: expectedCount(range, perDay(past.placed, past.placedByTime), now),
    answer_rate: past.placed ? (past.answered / past.placed) * 100 : null,
    avg_seconds: past.avgSeconds,
    feedback: past.feedback ? expectedCount(range, perDay(past.feedback.total, past.feedback.byTime), now) : null
  };
}

const PATIENT_NAME = "COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), ''), 'Unnamed patient')";
const HAS_RECORDING = "((c.recording_object_key IS NOT NULL AND c.recording_status = 'stored') OR COALESCE(c.recording_url, '') <> '')";
const DURATION = 'CASE WHEN c.answered_at IS NOT NULL AND c.ended_at > c.answered_at THEN EXTRACT(EPOCH FROM (c.ended_at - c.answered_at))::int END';
const SUMMARY = "COALESCE(NULLIF(c.analysis_summary, ''), NULLIF(c.summary, ''), NULLIF(c.report_excerpt, ''))";
const NO_LATER_CALL = `NOT EXISTS (
  SELECT 1 FROM calls later
   WHERE later.patient_id = c.patient_id
     AND later.id <> c.id
     AND later.called_at > c.called_at)`;

/**
 * Open items, newest first within each kind. Complaints stay until someone
 * hides them. Callbacks and overdue retries also clear themselves once the
 * patient has been called again, because then there is nothing left to do.
 */
async function attentionItems() {
  const rows = await dbAll(
    `WITH items AS (
       SELECT 'complaint' AS kind, 'call:' || c.id || ':complaint' AS item_key,
              c.id AS call_id, c.patient_id, c.customer_id, c.call_type, ${PATIENT_NAME} AS patient_name,
              ${SUMMARY} AS detail, c.called_at AS happened_at, NULL::timestamptz AS due_at,
              ${DURATION} AS duration_seconds, ${HAS_RECORDING} AS has_recording
         FROM calls c
         LEFT JOIN patients p ON p.id = c.patient_id
        WHERE c.sentiment_label = 'negative'
          AND c.called_at >= now() - make_interval(days => ?::int)

       UNION ALL
       SELECT 'callback', 'call:' || c.id || ':callback',
              c.id, c.patient_id, c.customer_id, c.call_type, ${PATIENT_NAME},
              ${SUMMARY}, c.called_at, c.next_action_at,
              ${DURATION}, ${HAS_RECORDING}
         FROM calls c
         LEFT JOIN patients p ON p.id = c.patient_id
        WHERE (c.callback_requested = 1 OR c.outcome = 'callback')
          AND c.called_at >= now() - make_interval(days => ?::int)
          AND ${NO_LATER_CALL}

       UNION ALL
       SELECT 'wrong_number', 'queue:' || cu.id || ':wrong_number',
              c.id, cu.patient_id, cu.id, cu.call_type, ${PATIENT_NAME},
              ${SUMMARY}, COALESCE(c.called_at, cu.updated_at, cu.created_at), NULL::timestamptz,
              ${DURATION}, COALESCE(${HAS_RECORDING}, false)
         FROM customers cu
         LEFT JOIN patients p ON p.id = cu.patient_id
         LEFT JOIN LATERAL (
           SELECT * FROM calls WHERE calls.customer_id = cu.id
            ORDER BY calls.called_at DESC NULLS LAST, calls.id DESC LIMIT 1
         ) c ON true
        WHERE cu.wrong_number_flag = 1
          AND COALESCE(c.called_at, cu.updated_at, cu.created_at) >= now() - make_interval(days => ?::int)

       UNION ALL
       SELECT 'overdue', 'call:' || c.id || ':overdue',
              c.id, c.patient_id, c.customer_id, c.call_type, ${PATIENT_NAME},
              c.follow_up_task, c.called_at, c.next_action_at,
              ${DURATION}, ${HAS_RECORDING}
         FROM calls c
         JOIN customers cu ON cu.id = c.customer_id
         LEFT JOIN patients p ON p.id = c.patient_id
        WHERE c.next_action_at < now() - make_interval(hours => ?::int)
          AND c.next_action_at >= now() - make_interval(days => ?::int)
          AND cu.status IN ('retry_scheduled', 'callback_scheduled')
          AND COALESCE(c.callback_requested, 0) <> 1
          AND COALESCE(c.outcome, '') <> 'callback'
          AND ${NO_LATER_CALL}
     )
     SELECT items.*, (d.item_key IS NOT NULL) AS hidden
       FROM items
       LEFT JOIN overview_dismissals d ON d.item_key = items.item_key
      ORDER BY CASE items.kind WHEN 'complaint' THEN 0 WHEN 'callback' THEN 1 WHEN 'overdue' THEN 2 ELSE 3 END,
               items.happened_at DESC NULLS LAST
      LIMIT 100`,
    [ATTENTION_WINDOW_DAYS, ATTENTION_WINDOW_DAYS, ATTENTION_WINDOW_DAYS, OVERDUE_GRACE_HOURS, ATTENTION_WINDOW_DAYS]
  );

  return rows.map((row) => ({
    key: row.item_key,
    kind: row.kind,
    call_id: numOrNull(row.call_id),
    patient_id: numOrNull(row.patient_id),
    customer_id: numOrNull(row.customer_id),
    call_type: row.call_type || null,
    patient_name: row.patient_name,
    detail: row.detail || null,
    happened_at: row.happened_at,
    due_at: row.due_at,
    duration_seconds: numOrNull(row.duration_seconds),
    has_recording: Boolean(row.has_recording),
    hidden: Boolean(row.hidden)
  }));
}

/** Rare groups first: an O− donor lapsing costs the centre more than an O+ one. */
const BLOOD_GROUP_ORDER = "CASE p.blood_group WHEN 'O-' THEN 0 WHEN 'AB-' THEN 1 WHEN 'B-' THEN 2 WHEN 'A-' THEN 3 ELSE 4 END";

async function donors(now) {
  const weekStart = istMidnight(addDays(istDate(now), -6)).toISOString();

  const [counts, upcoming, due] = await Promise.all([
    dbGet(
      `SELECT
         COUNT(DISTINCT COALESCE(calls.patient_id::text, 'call-' || calls.id)) FILTER (WHERE calls.redonation_interest = 'yes') AS will_donate,
         COUNT(DISTINCT COALESCE(calls.patient_id::text, 'call-' || calls.id))
           FILTER (WHERE NULLIF(TRIM(calls.intended_visit_note), '') IS NOT NULL) AS planning_visit
       FROM calls
       WHERE calls.called_at >= ?`,
      [weekStart]
    ),
    dbAll(
      `SELECT * FROM (
         SELECT DISTINCT ON (c.patient_id)
                c.patient_id, ${PATIENT_NAME} AS patient_name, c.intended_visit_note, c.called_at, c.id AS call_id
           FROM calls c
           JOIN patients p ON p.id = c.patient_id
          WHERE NULLIF(TRIM(c.intended_visit_note), '') IS NOT NULL
            AND c.called_at >= now() - interval '30 days'
          ORDER BY c.patient_id, c.called_at DESC
       ) latest
       ORDER BY latest.called_at DESC
       LIMIT 5`
    ),
    // Due: last donation 90+ days ago, callable, nothing already queued, and
    // not called in the last 30 days. Capped at 500, the bulk scheduler's limit.
    dbAll(
      `SELECT p.id AS patient_id, ${PATIENT_NAME} AS patient_name, p.blood_group, p.last_donation_date,
              last_call.called_at AS last_called_at,
              COUNT(*) OVER () AS total
         FROM patients p
         LEFT JOIN LATERAL (
           SELECT MAX(calls.called_at) AS called_at FROM calls WHERE calls.patient_id = p.id
         ) last_call ON true
        WHERE p.status = 'active'
          AND COALESCE(p.do_not_call, 0) = 0
          AND p.consent_status <> 'refused'
          AND p.last_donation_date IS NOT NULL
          AND p.last_donation_date <= (now() ${IST})::date - 90
          AND (last_call.called_at IS NULL OR last_call.called_at < now() - interval '30 days')
          AND NOT EXISTS (
            SELECT 1 FROM customers cu
             WHERE cu.patient_id = p.id
               AND cu.status IN ('pending', 'scheduled', 'calling', 'retry_scheduled', 'callback_scheduled'))
        ORDER BY ${BLOOD_GROUP_ORDER}, p.last_donation_date ASC, p.id
        LIMIT 500`
    )
  ]);

  return {
    window_start: weekStart,
    will_donate: num(counts?.will_donate),
    planning_visit: num(counts?.planning_visit),
    upcoming: upcoming.map((row) => ({
      patient_id: num(row.patient_id),
      patient_name: row.patient_name,
      note: row.intended_visit_note,
      called_at: row.called_at,
      call_id: num(row.call_id)
    })),
    due: {
      total: due.length ? num(due[0].total) : 0,
      patients: due.map((row) => ({
        patient_id: num(row.patient_id),
        patient_name: row.patient_name,
        blood_group: row.blood_group,
        last_donation_date: row.last_donation_date,
        last_called_at: row.last_called_at
      }))
    }
  };
}

async function health() {
  const [calls, degraded] = await Promise.all([
    dbGet(
      `SELECT
         COUNT(*) FILTER (WHERE calls.answered_at IS NOT NULL) AS answered,
         COUNT(*) FILTER (WHERE calls.answered_at IS NOT NULL AND calls.analysis_status = 'completed') AS analysed,
         COUNT(*) FILTER (WHERE calls.answered_at IS NOT NULL AND calls.recording_status = 'stored') AS recordings_stored,
         COUNT(*) FILTER (WHERE calls.answered_at IS NOT NULL AND NULLIF(TRIM(calls.transcript_text), '') IS NOT NULL) AS transcripts
       FROM calls
       WHERE ${OUTBOUND} AND calls.called_at >= now() - interval '24 hours'`
    ),
    // Heuristic fallback looks like a real result on the call row, so the log is
    // the only place the difference is recorded.
    dbGet(
      `SELECT COUNT(DISTINCT details->>'callId') AS calls
         FROM system_logs
        WHERE event = 'FEEDBACK_ANALYSIS_DEGRADED'
          AND ts >= now() - interval '24 hours'`
    )
  ]);

  const analysed = num(calls?.analysed);
  const fallback = Math.min(num(degraded?.calls), analysed);
  return {
    answered: num(calls?.answered),
    analysed,
    analysed_by_ai: analysed - fallback,
    analysis_fallback: fallback,
    recordings_stored: num(calls?.recordings_stored),
    transcripts: num(calls?.transcripts)
  };
}

async function trend(now) {
  const today = istDate(now);
  const first = addDays(today, -6);
  const rows = await dbAll(
    `SELECT (calls.called_at ${IST})::date::text AS day,
            COUNT(*) AS placed,
            COUNT(calls.answered_at) AS answered
       FROM calls
      WHERE ${OUTBOUND} AND calls.called_at >= ?
      GROUP BY 1`,
    [istMidnight(first).toISOString()]
  );
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return Array.from({ length: 7 }, (_, index) => {
    const day = addDays(first, index);
    const row = byDay.get(day);
    return { day, working: isWorkingDay(day), placed: num(row?.placed), answered: num(row?.answered) };
  });
}

async function totals({ includeFeedback }) {
  const row = await dbGet(
    `SELECT
       (SELECT COUNT(*) FROM patients) AS patients,
       (SELECT COUNT(*) FROM calls WHERE ${OUTBOUND}) AS calls
       ${includeFeedback ? ', (SELECT COUNT(*) FROM feedback) AS feedback' : ''}`
  );
  return {
    patients: num(row?.patients),
    calls: num(row?.calls),
    feedback: includeFeedback ? num(row?.feedback) : null
  };
}

/**
 * Everything the Overview page shows, for one range.
 *
 * Feedback is left out for agents: /api/feedback is admin-only, and this must
 * not become a way round that.
 */
async function buildOverview({ range: rangeKey = '24h', role, now = new Date() } = {}) {
  const range = resolveRange(rangeKey, now);
  const includeFeedback = String(role || '').toUpperCase() !== 'AGENT';

  const [calls, feedback, past, attention, donorData, healthData, trendData, totalData] = await Promise.all([
    rangeCalls(range),
    includeFeedback ? rangeFeedback(range) : Promise.resolve(null),
    history(now, { includeFeedback }),
    attentionItems(),
    donors(now),
    health(),
    trend(now),
    totals({ includeFeedback })
  ]);

  return {
    generated_at: now.toISOString(),
    timezone: TIMEZONE,
    today: istDate(now),
    range: {
      key: range.key,
      label: range.label,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      compare: compareLabel(range, now),
      working_days: workingDaysInRange(range, now)
    },
    glance: { ...calls, feedback },
    average: averagesFor(range, past, now),
    attention,
    donors: donorData,
    health: healthData,
    trend: trendData,
    totals: totalData
  };
}

async function hideAttentionItem(key, username) {
  await dbRun(
    `INSERT INTO overview_dismissals (item_key, dismissed_by)
     VALUES (?, ?)
     ON CONFLICT (item_key) DO NOTHING`,
    [key, username || null]
  );
}

async function unhideAttentionItem(key) {
  await dbRun('DELETE FROM overview_dismissals WHERE item_key = ?', [key]);
}

module.exports = {
  RANGES,
  buildOverview,
  hideAttentionItem,
  unhideAttentionItem,
  isAttentionKey,
  // Exported for tests.
  istDate,
  istMidnight,
  addDays,
  isWorkingDay,
  countWorkingDays,
  resolveRange,
  expectedCount,
  workingDaysInRange,
  compareLabel
};
