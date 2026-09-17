/**
 * scripts/flag-no-response-calls.js
 * Mark past calls the patient picked up and gave nothing on as no_response.
 *
 * Until the pipeline learned to tell them apart, a patient who said "Hello?
 * Hello?" and hung up was stored as a completed call. This reads the stored
 * transcript of every completed call with the same test the pipeline now uses
 * and relabels the ones that match. No model is called.
 *
 * Deliberately only the call row: no retries are scheduled and the patient's
 * queue entry is left alone. Calling someone back weeks later because of a
 * relabel would be wrong. Feedback rows attached to flagged calls are listed,
 * not deleted.
 *
 * Only transcripts with speaker labels (AGENT:/CUSTOMER:) can be judged, so a
 * call transcribed from its recording afterwards is never flagged.
 *
 *   node scripts/flag-no-response-calls.js              # dry run, lists the calls
 *   node scripts/flag-no-response-calls.js --apply      # writes, after a backup
 *   node scripts/flag-no-response-calls.js --apply --ids 3,4,5
 *
 * --apply writes a JSON backup of every column it touches to
 * scratch/no-response-backup-<timestamp>.json first.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { initializeDatabase, dbAll, dbRun, closeDatabase } = require('../db');
const {
  NO_RESPONSE_OUTCOME,
  NO_RESPONSE_DETAIL,
  NO_RESPONSE_SUMMARY,
  isNoResponseCall
} = require('../services/no-response');

const APPLY = process.argv.includes('--apply');
const ID_FILTER = (() => {
  const flag = process.argv.indexOf('--ids');
  if (flag === -1) return null;
  return String(process.argv[flag + 1] || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isInteger);
})();

const BACKUP_COLUMNS = ['outcome', 'outcome_detail', 'summary', 'analysis_summary'];

function patientLines(transcriptText) {
  return String(transcriptText || '')
    .split('\n')
    .filter((line) => /^\s*(CUSTOMER|PATIENT)\s*:/i.test(line))
    .map((line) => line.slice(line.indexOf(':') + 1).trim());
}

async function main() {
  await initializeDatabase();

  const calls = await dbAll(
    `SELECT calls.*, customer_queue.name AS customer_name,
            (SELECT COUNT(*) FROM feedback WHERE feedback.call_id = calls.id) AS feedback_rows
       FROM calls
       LEFT JOIN customer_queue ON customer_queue.id = calls.customer_id
      WHERE calls.outcome = 'completed'
        AND COALESCE(calls.call_direction, 'outbound') = 'outbound'
        AND COALESCE(calls.transcript_text, '') != ''
      ORDER BY calls.id`
  );

  const scoped = ID_FILTER ? calls.filter((call) => ID_FILTER.includes(call.id)) : calls;
  const targets = scoped.filter((call) => isNoResponseCall({
    engagement: call.engagement,
    transcriptText: call.transcript_text
  }));

  console.log(`${scoped.length} completed call(s) checked, ${targets.length} gave no feedback`
    + `${APPLY ? '' : ' -- DRY RUN, nothing will be written'}\n`);

  for (const call of targets) {
    const said = patientLines(call.transcript_text);
    console.log(
      `  #${call.id}  ${call.customer_name || 'Unnamed'}  ${call.called_at ? new Date(call.called_at).toISOString().slice(0, 16) : ''}`
      + `  patient said: ${said.length ? said.map((line) => JSON.stringify(line)).join(', ') : '(nothing)'}`
      + `${Number(call.feedback_rows) ? `  [${call.feedback_rows} feedback row(s) attached]` : ''}`
    );
  }

  if (!APPLY || !targets.length) {
    await closeDatabase();
    return;
  }

  const backupDir = path.join(__dirname, '..', 'scratch');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `no-response-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(targets.map((call) => {
    const row = { id: call.id };
    for (const column of BACKUP_COLUMNS) row[column] = call[column];
    return row;
  }), null, 2));
  console.log(`\nBackup written to ${backupPath}`);

  for (const call of targets) {
    await dbRun(
      `UPDATE calls
          SET outcome = ?, outcome_detail = ?, summary = ?, analysis_summary = ?
        WHERE id = ? AND outcome = 'completed'`,
      [NO_RESPONSE_OUTCOME, NO_RESPONSE_DETAIL, NO_RESPONSE_SUMMARY, NO_RESPONSE_SUMMARY, call.id]
    );
  }
  console.log(`${targets.length} call(s) marked ${NO_RESPONSE_OUTCOME}`);

  await closeDatabase();
}

main().catch(async (error) => {
  console.error(error);
  await closeDatabase().catch(() => {});
  process.exit(1);
});
