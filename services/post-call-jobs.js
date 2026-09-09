'use strict';

const crypto = require('node:crypto');

const RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 240 * 60_000]);
const DEFAULT_LEASE_MS = 5 * 60_000;

function buildInputRevision(call = {}) {
  const material = [call.id, call.transcript_source, call.transcript_status, call.transcript_text, call.recording_object_key, call.recording_status]
    .map((value) => value == null ? '' : String(value)).join('|');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 48);
}

function retryDelayMs(attemptCount) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, Number(attemptCount || 1) - 1));
  return RETRY_DELAYS_MS[index];
}

function makeClaimToken() {
  return crypto.randomUUID();
}

async function claimPostCallJob({ dbTx, callId, stage = 'completion', inputRevision, now = new Date(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  if (typeof dbTx !== 'function') throw new TypeError('dbTx is required');
  if (!callId || !inputRevision) throw new TypeError('callId and inputRevision are required');
  const nowIso = new Date(now).toISOString();
  const token = makeClaimToken();
  return dbTx(async (tx) => {
    await tx.run(
      `INSERT INTO post_call_jobs (call_id, stage, input_revision, status, next_run_at)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT (call_id, stage, input_revision) DO NOTHING`,
      [callId, stage, inputRevision, nowIso]
    );
    const job = await tx.get(
      `SELECT * FROM post_call_jobs
        WHERE call_id = ? AND stage = ? AND input_revision = ?
        FOR UPDATE`,
      [callId, stage, inputRevision]
    );
    if (!job) return { state: 'missing' };
    if (job.status === 'completed') return { state: 'completed', job };
    if (job.status === 'processing' && job.claim_expires_at && new Date(job.claim_expires_at).getTime() > new Date(now).getTime()) {
      return { state: 'busy', job };
    }
    if (job.status === 'manual_review' || (job.status === 'blocked' && new Date(job.next_run_at).getTime() > new Date(now).getTime())) {
      return { state: 'not_due', job };
    }
    const claimed = await tx.run(
      `UPDATE post_call_jobs
          SET status = 'processing', attempt_count = COALESCE(attempt_count, 0) + 1,
              claim_token = ?, claim_expires_at = ?, updated_at = now()
        WHERE id = ?`,
      [token, new Date(new Date(now).getTime() + leaseMs).toISOString(), job.id]
    );
    return claimed.changes ? { state: 'claimed', token, job: { ...job, attempt_count: Number(job.attempt_count || 0) + 1 } } : { state: 'busy', job };
  });
}

async function completePostCallJob({ dbTx, jobId, claimToken, now = new Date() } = {}) {
  return dbTx(async (tx) => {
    const result = await tx.run(
      `UPDATE post_call_jobs
          SET status = 'completed', completed_at = ?, claim_token = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE id = ? AND status = 'processing' AND claim_token = ?`,
      [new Date(now).toISOString(), jobId, claimToken]
    );
    return { changed: result.changes > 0, jobId };
  });
}

async function failPostCallJob({ dbTx, jobId, claimToken, attemptCount = 1, errorCode = 'post_call_failed', now = new Date() } = {}) {
  const nextDelay = retryDelayMs(attemptCount);
  const nextRun = new Date(new Date(now).getTime() + nextDelay).toISOString();
  return dbTx(async (tx) => {
    const result = await tx.run(
      `UPDATE post_call_jobs
          SET status = CASE WHEN ? >= ? THEN 'manual_review' ELSE 'blocked' END,
              next_run_at = ?, last_error_code = ?, claim_token = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE id = ? AND status = 'processing' AND claim_token = ?`,
      [attemptCount, RETRY_DELAYS_MS.length, nextRun, String(errorCode).slice(0, 120), jobId, claimToken]
    );
    return { changed: result.changes > 0, jobId, nextRunAt: nextRun };
  });
}

module.exports = { RETRY_DELAYS_MS, DEFAULT_LEASE_MS, buildInputRevision, retryDelayMs, claimPostCallJob, completePostCallJob, failPostCallJob };
