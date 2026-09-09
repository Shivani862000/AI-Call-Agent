# P07 Import and Schedule Preservation

**Goal:** Spreadsheet updates change only the fields a staff member previewed, and unrelated queue edits preserve the existing call schedule and workflow.
**Spec:** [P07 remediation contract](../2026-09-08-APPLICATION_GAP_REMEDIATION_PLAN.md#p07--preserve-import-fields-and-compare-schedule-instants-correctly).
**Dependencies:** P01 disposable database harness and [domain decisions](../APPLICATION_DOMAIN_CONTRACTS.md). Record the verified prerequisite commit at dispatch.
**Architecture:** Keep the existing Express routes and server-held import previews. Separate create normalization from update patches. Confirm each update against its current locked patient row inside `dbTx`. Compare valid schedule instants by epoch milliseconds.

## Global Constraints

- Continue on `codex/remediation-fixes`; preserve unrelated files and existing authorization/privacy fixes.
- Schema remains `0019`. Do not edit distributed migrations or introduce a new schema authority.
- Use `dbTx()` for atomic application writes; it supplies `{ run, get, all }` on one checked-out client with `?` placeholders.
- Use only the P01 audited unit and disposable database commands. No environment files, shared databases, providers, calls, notifications, pushes, merges or deployments.
- Imports never write consent, suppression, patient status or any other contact restriction, including when the upload contains those headers.
- Preserve the existing maximum of 5 MiB and 5,000 rows. Durable multi-instance import storage and performance batching belong to P16; do not expand this task into that work.
- Demonstrate actual behavior failing before the fix and passing after it. Real route/database assertions are required; a pure helper or source-string assertion alone does not prove persisted behavior.

### Task 1: Preserve imported data and schedule state

**Modify:** `src/patient-import.js`, `src/patient-rules.js` if necessary, `routes/patients.js`, `routes/customers.js`, `public/patients.html`, relevant audited test manifest and tests.
**Create:** `src/schedule-time.js`, `test/patient-import-route.test.js`, `test/schedule-edit.test.js`.

1. Add failing pure import regressions for header presence, explicit clears, duplicate update targets and conflicting reference/phone matches. Add real HTTP/database regressions using the actual patient and customer routers with external dependencies inert. Seed a refused, suppressed, inactive patient with notes, email and dates; retain exact values for post-confirmation assertions.
2. Carry uploaded field presence from header parsing to the server-held preview and update patch. Required first-name/phone columns still apply. Missing optional columns preserve stored values; present blank nullable fields clear to `null`; blank required names/phones are field errors. `preferred_language` is non-nullable in the current schema: an explicitly blank update is a field error, not an implicit reset to Hindi. Nullable enum fields may be cleared; unknown is a distinct explicit value. Creation defaults remain separate. Derive `normalized_phone` only when phone is present. Ignore unknown/protected headers even if supplied directly to an internal plan builder.
3. Resolve both reference and normalized-phone matches. Different patient IDs are a row-specific conflict. Reject duplicate target IDs and duplicate create identities in the file. Capture a real database row version at preview; PostgreSQL `xmin::text` is acceptable for this short-lived preview and avoids JavaScript timestamp precision loss.
4. Confirm against the same identity and version while holding the patient lock in `dbTx`. Changed/deleted patients and newly conflicting identities require a refreshed preview, with row-specific failure details. Apply only allowlisted patch fields. Creation must recheck identity and handle unique conflicts without transforming into an unpreviewed update. Keep per-row results deterministic and preserve the existing single-use, user-owned preview contract. Do not return arbitrary driver messages in failure details. On an injected write failure, that row's writes roll back.
5. Show actual planned changes and explicit clears in the import UI using safe DOM text APIs. Clearly label a bounded preview and give total counts so staff are not told an incomplete list shows every row. A confirmation failure must remain visible and actionable. Preserve ADMIN-only import access.
6. Compare validated scheduled timestamps by epoch milliseconds, including `Date` values returned by PostgreSQL and timezone-equivalent input strings. Invalid nonempty timestamp inputs must be rejected before normalization silently falls back to a different date/slot. Past-date validation remains. Only a changed future schedule may reset a reschedulable workflow. Unrelated edits preserve `status`, attempts, next retry and lock/manual flags; slot formatting alone must not reset an unchanged instant. Preserve existing permitted real rescheduling behavior.
7. Verify the actual preview/confirmation routes: omission preservation, explicit clears, protected headers, stale preview, reference/phone conflict, duplicate update target, another user's token, expired/replayed token, and row failure rollback. Verify actual customer PUT with a future callback/retry row: unrelated edit and equivalent instant preserve workflow; a changed valid schedule reschedules; invalid/past input rejects without writes. All fixtures are runner-owned and cleaned in `finally`.
8. Run the affected audited unit/DB files and the existing remediation authorization/privacy suite. Record exact commands and counts, and run `git diff --check`. Update this Tier 2 plan with prerequisite/evidence. Commit only this task's named files. The controller owns the main plan/evidence register and will arrange a separate review; do not spawn subagents.

Rollback: revert the application change; no migration or live data rewrite is involved. Existing preview tokens may expire/restart normally. Distributed import recovery and admission concurrency remain separate tasks, so this change does not claim those guarantees.

## Task 1 evidence

- Dispatch base: `5ff850e44a677357a3b631b1cb324a905118f0fd` on `codex/remediation-fixes`.
- Verified P01 disposable-harness prerequisite: `ed9a3e6`.
- RED: `npm run test:unit -- --file test/patient-import.test.js` reported 12 passed / 5 failed for the new import contracts; `npm run test:db -- --file test/schedule-edit.test.js` reported 0 passed / 2 failed; `npm run test:db -- --file test/patient-import-route.test.js` reported 0 passed / 5 failed after the synthetic fixture was corrected.
- GREEN: `npm run test:unit` reported 315 passed / 0 failed, including the focused 17 import tests and the authorization/privacy regressions. The initial sandboxed run produced loopback `listen EPERM`; the authorized rerun passed.
- GREEN: `npm run test:db -- --file test/patient-import-route.test.js` reported 5 passed / 0 failed, and `npm run test:db -- --file test/schedule-edit.test.js` reported 2 passed / 0 failed. Both ran against fresh internal-network PostgreSQL 17.6 containers at schema `0019`, with migrations applied twice and resources cleaned by the audited runner.
- JavaScript syntax checks and `git diff --check` passed. No direct PostgreSQL client, environment file, shared database, provider, call, notification, migration, push, merge, or deployment was used.

### Fix round 1

- Base: `c1fba27e996c6f03d7ebffd1a5e994b374ace307`.
- RED: the focused schedule database file reported 2 passed / 1 failed when a past canonical timestamp was accepted behind future date/slot components. The focused import database file reported 5 passed / 1 failed before its new post-write fault adapter was wired; this was a coverage gap around the existing real `dbTx` rollback, not evidence of a production rollback defect.
- GREEN: `npm run test:db -- --file test/schedule-edit.test.js` reported 3 passed / 0 failed, covering the exact persisted instant, mismatched components, past time, impossible calendar dates, Asia/Kolkata calling hours, valid offsets, real rescheduling, and exact no-write state.
- GREEN: `npm run test:db -- --file test/patient-import-route.test.js` reported 6 passed / 0 failed. A fault after the real transactional row write restored exact persisted state including `updated_at`/`xmin`, returned a sanitized failure, and allowed the next row to commit.
- The consumed-token UI state now remains disabled until a new preview; the changed inline script parses successfully. The accepted import unit file and syntax/diff checks remain the final focused gates.
