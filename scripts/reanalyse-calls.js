/**
 * scripts/reanalyse-calls.js
 * Recompute the stored analysis for calls that were analysed while it was broken.
 *
 * GEMINI_MODEL was pointed at a Live-API-only model, which rejects
 * generateContent with a 400, so every post-call analysis fell back to keyword
 * matching and wrote a plausible-looking sentiment nobody could tell from a
 * real one. The transcripts themselves are intact -- only the derived columns
 * are wrong -- so this reruns the analysis over the stored transcript.
 *
 * Deliberately NOT the full pipeline: no recording download, no CRM sync, no
 * hot-lead alerts, no customer_queue workflow. Those already ran, they are
 * outward-facing, and re-firing them months later would be wrong. Only the
 * derived analysis columns, the feedback row, and the supervisor event a
 * negative call should have raised at the time are touched.
 *
 *   node scripts/reanalyse-calls.js              # dry run, prints the diff
 *   node scripts/reanalyse-calls.js --apply      # writes, after a backup
 *   node scripts/reanalyse-calls.js --apply --ids 3,4,5
 *
 * --apply writes a JSON backup of every column it touches to
 * scratch/reanalyse-backup-<timestamp>.json first. Restore is a plain UPDATE
 * per row from that file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { initializeDatabase, dbAll, dbGet, dbRun, closeDatabase } = require('../db');
const { analyzeCallTranscript, categorizeFeedback } = require('../services/gemini');
const { buildCallAnalysis } = require('../services/call-analysis');
const { extractCallFeedback } = require('../services/call-feedback');
const { resolveSentiment, createSupervisorEvent } = require('../services/call-orchestration');
const { pickRating } = require('../services/post-call-pipeline');

const APPLY = process.argv.includes('--apply');
const ID_FILTER = (() => {
  const flag = process.argv.indexOf('--ids');
  if (flag === -1) return null;
  return String(process.argv[flag + 1] || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isInteger);
})();

/** The columns this script overwrites, saved before it does. */
const BACKUP_COLUMNS = [
  'summary', 'analysis_summary', 'analysis_json', 'report_excerpt',
  'extracted_rating', 'extracted_review_text', 'sentiment', 'sentiment_label',
  'sentiment_score', 'quality_score', 'timeline_events', 'extracted_entities',
  'analysis_completed_at'
];

function convertPlainTranscriptToTurns(transcriptText = '') {
  return String(transcriptText || '')
    .split('\n')
    .map((line) => {
      const divider = line.indexOf(':');
      if (divider === -1) return null;
      return { role: line.slice(0, divider).trim(), text: line.slice(divider + 1).trim() };
    })
    .filter((turn) => turn && turn.role && turn.text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the model, respecting the quota.
 *
 * The key is on the free tier: 5 generateContent requests per minute. Firing
 * the whole backlog at once earns a 429, and a 429 is indistinguishable from
 * any other failure inside analyzeCallTranscript -- it returns a keyword guess
 * flagged `degraded`. Writing those back would repeat the exact bug this script
 * exists to undo, so a throttled retry comes first and a still-degraded result
 * is skipped rather than stored.
 */
async function analyseWithBackoff(transcriptText, context, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await analyzeCallTranscript(transcriptText, context);
    if (!result.degraded) return result;

    const retryAfter = /retry in ([\d.]+)s/i.exec(result.degraded_reason || '');
    const quota = /429|RESOURCE_EXHAUSTED/i.test(result.degraded_reason || '');
    // 503 UNAVAILABLE is Gemini shedding load and is over in seconds. It cost
    // the first backfill run the one call the whole exercise was about, so a
    // transient server error retries alongside the quota errors; a 400 (a
    // request this model will never accept) still fails through immediately.
    const transient = /\b(500|502|503|504|UNAVAILABLE|overloaded|deadline)\b/i.test(result.degraded_reason || '');
    if ((!quota && !transient) || attempt === attempts) return result;

    const waitMs = quota
      ? Math.ceil((Number(retryAfter?.[1]) || 30) * 1000) + 1000
      : 5000 * attempt;
    console.log(`         ${quota ? 'quota reached' : 'model busy'}, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${attempts})`);
    await sleep(waitMs);
  }
  return analyzeCallTranscript(transcriptText, context);
}

async function recompute(call) {
  const transcriptText = call.transcript_text || '';
  const model = await analyseWithBackoff(transcriptText, {
    customerName: call.customer_name,
    clientName: process.env.CLIENT_NAME,
    callType: call.call_type
  });
  const productAnalysis = buildCallAnalysis({ ...call, transcript_text: transcriptText });
  const turns = convertPlainTranscriptToTurns(transcriptText);
  const heuristic = turns.length
    ? extractCallFeedback(turns)
    : { reviewText: '', stars: null };

  const sentiment = resolveSentiment(
    { label: productAnalysis.sentiment, score: productAnalysis.sentiment_score },
    model.customer_sentiment
  );
  const rating = pickRating({
    modelRating: model.rating,
    spokenRating: Number.isInteger(productAnalysis.rating) ? productAnalysis.rating : heuristic.stars
  });

  return {
    model,
    productAnalysis,
    sentiment,
    rating,
    reviewText: model.review_text || heuristic.reviewText || ''
  };
}

async function main() {
  await initializeDatabase();

  const calls = await dbAll(
    `SELECT calls.*, customer_queue.name AS customer_name
       FROM calls
       LEFT JOIN customer_queue ON customer_queue.id = calls.customer_id
      WHERE calls.analysis_status = 'completed'
        AND COALESCE(calls.transcript_text, '') != ''
      ORDER BY calls.id`
  );

  const targets = ID_FILTER ? calls.filter((call) => ID_FILTER.includes(call.id)) : calls;
  console.log(`${targets.length} completed call(s) with a transcript${APPLY ? '' : ' -- DRY RUN, nothing will be written'}\n`);

  if (APPLY && targets.length) {
    const backupDir = path.join(__dirname, '..', 'scratch');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `reanalyse-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const backup = targets.map((call) => {
      const row = { id: call.id };
      for (const column of BACKUP_COLUMNS) row[column] = call[column];
      return row;
    });
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    console.log(`Backup written to ${backupPath}\n`);
  }

  let changed = 0;
  let degradedStill = 0;

  const THROTTLE_MS = 13000;
  let first = true;

  for (const call of targets) {
    if (!first) await sleep(THROTTLE_MS);
    first = false;
    const next = await recompute(call);
    const before = {
      sentiment: call.sentiment,
      score: Number(call.sentiment_score),
      rating: call.extracted_rating
    };
    const after = {
      sentiment: next.sentiment.label,
      score: next.sentiment.score,
      rating: next.rating
    };
    const differs = before.sentiment !== after.sentiment
      || before.score !== after.score
      || (before.rating ?? null) !== (after.rating ?? null);

    if (next.model.degraded) {
      degradedStill += 1;
      console.log(`  #${call.id}  SKIPPED -- the model is still unreachable (${next.model.degraded_reason})`);
      continue;
    }

    console.log(
      `  #${call.id}  ${before.sentiment}/${before.score}${before.rating ? ` ${before.rating}★` : ''}`
      + `  ->  ${after.sentiment}/${after.score}${after.rating ? ` ${after.rating}★` : ''}`
      + `${differs ? '' : '   (no change)'}`
    );
    if (differs) {
      console.log(`         ${next.model.summary}`);
      changed += 1;
    }

    if (!APPLY) continue;

    await dbRun(
      `UPDATE calls
          SET summary = ?,
              analysis_summary = ?,
              analysis_json = ?,
              report_excerpt = ?,
              extracted_rating = ?,
              extracted_review_text = ?,
              sentiment = ?,
              sentiment_label = ?,
              sentiment_score = ?,
              quality_score = ?,
              timeline_events = ?,
              extracted_entities = ?,
              analysis_completed_at = ?
        WHERE id = ?`,
      [
        next.productAnalysis.summary || next.model.summary || null,
        next.productAnalysis.summary || next.model.summary || null,
        JSON.stringify({ ...next.model, product_analysis: next.productAnalysis }),
        next.model.report_excerpt || null,
        next.rating,
        next.reviewText || null,
        next.sentiment.label,
        next.sentiment.label,
        next.sentiment.score,
        next.productAnalysis.quality_score,
        JSON.stringify(next.productAnalysis.timeline_events || []),
        JSON.stringify(next.productAnalysis.entities || {}),
        new Date().toISOString(),
        call.id
      ]
    );

    // The feedback row is the working record the team reads. A call that has
    // neither a rating nor any words from the donor stays without one rather
    // than gaining an empty row.
    const hasFeedback = Boolean(String(next.reviewText || '').trim()) || Number.isInteger(next.rating);
    if (hasFeedback) {
      const categorization = await categorizeFeedback(next.reviewText || '', Number.isInteger(next.rating) ? next.rating : 3);
      const existing = await dbGet('SELECT id FROM feedback WHERE call_id = ?', [call.id]);
      if (existing) {
        await dbRun(
          'UPDATE feedback SET review_text = ?, category = ?, stars = ?, source = ? WHERE id = ?',
          [next.reviewText || '', categorization.category, next.rating, 'call', existing.id]
        );
      } else {
        await dbRun(
          `INSERT INTO feedback (customer_id, call_id, review_text, category, stars, submitted_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [call.customer_id, call.id, next.reviewText || '', categorization.category, next.rating, new Date().toISOString(), 'call']
        );
      }
    }

    // The alert this call should have raised at the time. Guarded, so rerunning
    // the backfill does not stack duplicates.
    if (next.sentiment.label === 'negative') {
      const already = await dbGet(
        "SELECT id FROM call_supervisor_events WHERE call_id = ? AND event_type = 'negative_signal_detected'",
        [call.id]
      );
      if (!already) {
        await createSupervisorEvent({
          dbRun,
          callId: call.id,
          eventType: 'negative_signal_detected',
          severity: 'high',
          payload: { objections: [], competitors: [], summary: next.model.summary || null, source: 'backfill' }
        });
      }
    }
  }

  console.log(`\n${changed} of ${targets.length} call(s) ${APPLY ? 'updated' : 'would change'}.`);
  if (degradedStill) {
    console.log(`${degradedStill} skipped because the model is unreachable -- fix GEMINI_ANALYSIS_MODEL before rerunning.`);
  }
  if (!APPLY) console.log('Rerun with --apply to write.');

  await closeDatabase();
}

main().catch((error) => {
  console.error('[REANALYSE ERROR]', error.message);
  process.exit(1);
});
