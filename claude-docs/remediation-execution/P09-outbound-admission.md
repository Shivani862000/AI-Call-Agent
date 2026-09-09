# P09 Outbound Admission

**Goal:** Make every outbound request pass through a current, idempotent admission decision before provider I/O. Durable reservations and two-worker integration remain coupled to the `0021` lifecycle migration.

## Bounded slice completed

- `services/outbound-admission.js` defines deterministic request keys, payload-conflict detection, current contact/suppression checks, pause/capacity/daily-limit/cooldown decisions and provider response uncertainty classification.
- `test/outbound-admission.test.js` covers deterministic keys, unknown versus refused consent, do-not-call/wrong-number blocking, pause/capacity/daily/cooldown rejection, same-key idempotency, payload conflict and accepted/rejected/unknown provider results.
- `scripts/test-isolated.js` classifies the focused test in the audited unit manifest.

Verification: `node --test test/outbound-admission.test.js` — **5 passed, 0 failed, 0 skipped**.

## Still required before P09 completion

1. Add the coordinated `0021_contact_and_call_attempts.sql` schema expansion for contact revision, durable attempt ownership, reservations and uncertainty states.
2. Replace the three manual/scheduler/diagnostic claim-then-submit paths with one transaction-backed admission and a reserved attempt key before provider I/O.
3. Add owned PostgreSQL concurrency tests for two workers, scheduler/manual races, refusal/pause races, retained-history limits, crash before/after submission and accepted-with-lost-response. No provider request may occur after a committed rejection.

No provider, database, storage, notification, deployment or live credential boundary was used by this slice.
