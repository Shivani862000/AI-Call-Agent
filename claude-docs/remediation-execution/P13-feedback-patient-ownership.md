# P13 Feedback and retained-history ownership (partial implementation)

Date: 9 September 2026. Prerequisite: calls already retain `patient_id` and queue deletion no longer cascades history.

## Implemented in this slice

- Migration `0024_feedback_patient_ownership.sql` adds a required `feedback.patient_id`, backfills it from the durable call/customer identity, and rejects rows that cannot be attributed.
- A database trigger fills the patient identity for existing feedback writers, including manual feedback without a call. The foreign key uses `ON DELETE RESTRICT`, so retained feedback prevents accidental patient deletion.
- Feedback and reporting readers now join the patient table for names and phone labels, allowing history to render after its queue entry is deleted. Queue-specific fields remain optional where the queue row still exists.
- Added PostgreSQL regressions for call-linked and manual feedback, queue deletion, patient deletion protection and fixture cleanup.

## Verification

- `npm run test:db`: **39/39 passed** on an isolated PostgreSQL 17 database migrated through `0024`.
- `npm run test:unit`: **367/367 passed**, no failures, cancellations or skips.
- Existing schema-trigger and queue-history regressions remain green.

## Remaining before P13 completion

1. [ ] Replace trigger compatibility with one explicit feedback-store writer and idempotent patient/call effect key for every route and pipeline.
2. [ ] Audit all retained-history exports, CRM/reporting joins and deletion/admin workflows for patient ownership and role policy.
3. [ ] Backfill and review production rows with missing/conflicting patient identity before enforcing the migration in a shared environment.

No live database or deletion was used. This slice establishes the durable ownership invariant locally; it does not claim production backfill or release completion.
