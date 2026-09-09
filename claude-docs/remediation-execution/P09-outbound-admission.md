# P09 Outbound Admission

**Goal:** Make every outbound request pass through a current, idempotent admission decision before provider I/O. Durable reservations and two-worker integration remain coupled to the `0021` lifecycle migration.

## Bounded slice completed

- `services/outbound-admission.js` defines deterministic request keys, payload-conflict detection, current contact/suppression checks, pause/capacity/daily-limit/cooldown decisions and provider response uncertainty classification.
- `test/outbound-admission.test.js` covers deterministic keys, unknown versus refused consent, do-not-call/wrong-number blocking, pause/capacity/daily/cooldown rejection, same-key idempotency, payload conflict and accepted/rejected/unknown provider results.
- `scripts/test-isolated.js` classifies the focused test in the audited unit manifest.

Verification: `node --test test/outbound-admission.test.js` — **5 passed, 0 failed, 0 skipped**.

## Durable schema and first integration slice

- Added `supabase/migrations/0021_contact_and_call_attempts.sql` with patient contact revisions, append-only contact events, durable attempt/request keys, provider uncertainty states, scoped provider identity and `calls.attempt_id`. New processing tables have RLS enabled with no public policies.
- `reserveOutboundAttempt` locks the current customer/patient row, rechecks contact state and current attempt/cooldown counts, creates a reserved attempt before provider I/O and marks the queue row calling. `recordAttemptSubmission` records submitted/rejected/unknown without persisting raw provider payloads.
- `/call/start`, `/api/calls/initiate/:customerId`, `/api/icallmate/outgoing-call`, the legacy `routes/calls.js` initiator and the scheduler now use the shared transaction-backed reservation before provider I/O. Duplicate requests return the existing attempt; provider errors remain `submission_unknown` and are not automatically released for blind retry. Explicit provider rejection is the only submission result that schedules a controlled retry.
- `test/outbound-admission-db.test.js` verifies migration fields, reservation/submission state, contact-event linkage, `calls.attempt_id`, duplicate request-key rejection and owned cleanup. Focused disposable PostgreSQL verification passed **1/1**; the full audited DB suite passed **36/36** on schema `0021`; the full isolated unit suite passed **355/355**.

The admission transaction now also locks the durable patient row before evaluating the daily budget/cooldown. A focused concurrent PostgreSQL regression with two queue rows for one patient passes: exactly one reservation is accepted and the other receives `daily_attempt_limit`.

## Still required before P09 completion

1. [x] Add the coordinated `0021_contact_and_call_attempts.sql` schema expansion for contact revision, durable attempt ownership, reservations and uncertainty states.
2. [x] Replace the manual, legacy router and scheduler claim-then-submit paths with the same transaction-backed admission and reserved attempt key before provider I/O. Event/media identity and diagnostic-specific policy remain P10 work.
3. [ ] Extend the owned PostgreSQL concurrency suite to scheduler/manual races, refusal/pause races, retained-history limits, crash before/after submission and accepted-with-lost-response. No provider request may occur after a committed rejection.

No provider, database, storage, notification, deployment or live credential boundary was used by this slice.
