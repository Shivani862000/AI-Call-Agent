# P11 Post-call job durability (partial implementation)

Date: 9 September 2026. Prerequisite: P09/P10 local lifecycle slices. Schema migration `0023_post_call_jobs.sql` is included on this branch.

## Implemented in this slice

- Added a durable `post_call_jobs` table keyed by call, stage and input revision. It records status, attempts, retry time, claim token/expiry, bounded error code and completion time, with RLS and indexes for due work and call cleanup.
- Added `services/post-call-jobs.js` with deterministic input revisions, 1/5/15/60/240-minute retry delays, row-locked due-work claims, token-fenced completion, and token-fenced retry/manual-review transitions.
- The post-call pipeline claims a revision before processing, marks the call as processing, records missing-transcript failures as blocked/retryable job state, completes the job only after the existing final effects return, and fences caught failures through the job claim.
- Added focused pure and PostgreSQL regression coverage. Fixture cleanup deletes jobs with their call, and the isolated manifest migrates and tests schema `0023`.

## Verification

- `npm run test:unit`: **364/364 passed**, no failures, cancellations or skips.
- `npm run test:db`: **37/37 passed** on an isolated PostgreSQL 17 database migrated through `0023`.
- Focused job test covers duplicate claim blocking, wrong-token completion, retry state/error persistence and call-delete cascade.

## Remaining before P11 completion

1. [ ] Split recording acquisition, transcription, analysis and finalization into independently resumable stages rather than one pipeline claim.
2. [ ] Require the claim token on every call, feedback, customer, supervisor and queue/attempt effect; finalize those effects and completion in one transaction.
3. [ ] Add boot/periodic recovery scans, lease renewal, notification outbox records and unique effect keys for external delivery.
4. [ ] Add restart, takeover and failure-after-each-boundary tests, plus reconciliation/backfill for legacy `processing` and prematurely completed calls.

The current work prevents duplicate job ownership and makes retry state durable, but it does not yet prove exactly-once final effects or restart recovery for every external side effect. No provider, notification, storage or deployment boundary was used.
