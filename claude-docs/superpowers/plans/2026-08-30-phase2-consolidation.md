# Phase 2 — Pipeline consolidation and pre-deployment fixes

**Date:** 2026-08-30 · **Status:** approved, ready to build
**Goal:** get the codebase to a state worth building a deployment pipeline around,
so end-to-end testing can happen on production against real calls.

Covers items 2, 3, 4, 7 and 8 from the outstanding list.

## Decisions

| Decision | Choice |
| --- | --- |
| Queueing | **Both** — explicit "schedule a call" plus automatic rules |
| Owner digest | Email to configurable recipients at a configurable time, config in the database |
| Mail transport | SMTP via `nodemailer` — works with the existing Google Workspace domain, no new vendor |
| Digest content | **Full detail including patient names** |
| Person data | Moves to `patients`; `customers` becomes a pure call-attempt queue |
| `clients` | Retired; annual reminders become an automatic queue rule |

### Recorded risk — digest content

The digest will carry patient names, numbers and call outcomes into an inbox.
Everywhere else in this system that data is redacted before it leaves: the audit
log masks phones, support tickets strip patient fields, and the agent role
cannot see a contact at all. This is the first path that sends identifiable
patient data in the clear, and it lands in mail servers, backups and anything
the recipient forwards.

Recommended numbers-only; **the full-detail option was chosen deliberately after
that trade-off was presented.** Recorded here so the decision is auditable.

Mitigations built in regardless: recipients are an explicit allow-list stored in
the database (not free text at send time), TLS is required on the SMTP
connection, and the digest is off by default until recipients are configured.

## Schema — migration `0006`

**New `app_settings`** — `key` (pk), `value` (jsonb), `updated_at`, `updated_by`.
Holds digest configuration and auto-queue rules so neither needs a redeploy to
change. Replaces the single-purpose `app_state` row, which is dropped.

**`users.password_changed_at`** — timestamptz, for session invalidation.

**`customers`** — `patient_id` becomes `NOT NULL`, and these person columns are
dropped now that `patients` owns them:

```
name, phone, normalized_phone, preferred_language, preferred_dialect,
do_not_call, consent_status, dnd_checked_at, last_visit_date, preferred_slot
```

Kept on `customers` because they describe the *call cycle*, not the person:
`best_call_slot`, `pickup_rate_score`, `attempt_count`, `retry_count`,
`next_retry_at`, `status`, `locked_at` and the rest of the retry machine.

**`clients`** — dropped at the end of the plan, once reminders are rules.

All tables are empty on both projects, so there is no backfill.

## Task 1 — Migration and settings store

`0006` as above, plus `src/app-settings.js`: typed get/set over `app_settings`
with defaults, so callers never deal with raw JSON. Unit-tested against defaults
and malformed stored values.

## Task 2 — Repoint the pipeline to `patients`

The large one: ~95 query sites. Work file by file, running the suite after each.

- `src/scheduler.js` — the eligibility query joins `patients` for the person
  gates (`do_not_call`, `consent_status`, `status = 'active'`) and reads
  language and slot from there.
- `src/call-management.js` — `findCustomerByPhone` becomes `findPatientByPhone`;
  `ensureIncomingCustomerForCall` resolves or creates a **patient**, then opens a
  queue entry against it.
- `src/websocket-bridge.js`, `services/post-call-pipeline.js`,
  `services/call-orchestration.js`, `services/crm-sync.js`,
  `services/reporting.js`, `routes/customers.js`, `routes/calls.js`,
  `routes/feedback.js`, `src/api-routes.js` — read person fields through the
  join rather than from `customers`.

**Contact masking must survive the move.** Several of these endpoints return
customer name and phone to the browser today. Every one that can be reached by
an agent goes through `serializePatient`. This is the highest-risk part of the
task: a leak here is silent, so it gets explicit tests rather than a read-through.

## Task 3 — Explicit queueing

`POST /api/patients/:id/schedule-call` with `scheduled_at` and `call_type`,
creating the queue entry. Bulk variant for a multi-select on the patients screen.
Refuses when the patient is `do_not_call`, `inactive`, or already has an open
queue entry — with a clear message rather than a silent no-op.

UI: a "Schedule a call" row action and a bulk bar on selection.

## Task 4 — Automatic queueing rules

Stored in `app_settings` under `auto_queue`:

```json
{ "enabled": false,
  "rules": [
    { "id": "donation-followup", "enabled": true, "service": "donation",
      "min_days_since": 90, "call_type": "REVIEW_CALL", "slot": "10:00" },
    { "id": "annual-reminder", "enabled": true, "service": "any",
      "min_days_since": 365, "call_type": "THREE_MONTH_FOLLOWUP", "slot": "10:00" }
  ] }
```

Rule evaluation is a pure function — `(patient, rule, today) -> boolean` — so
eligibility is unit-tested without a database. The scheduler applies enabled
rules on its tick, skipping patients who already have an open queue entry.

**Off by default.** Automatic dialling starts only when someone switches it on,
and the annual-reminder rule reproduces what `clients` did.

## Task 5 — Retire `clients`

Delete `routes/clients.js`, `public/clients.html`, the redirect stub, and
`triggerAnnualClientReminderCalls`. Drop the table. Its behaviour is the
`annual-reminder` rule from task 4, so this is removal, not reimplementation.

## Task 6 — Sessions end when a password changes

`users.password_changed_at` is set on every password change or admin reset. The
session token carries that timestamp; `requireAdminAuth` compares it against the
stored value through the existing 30-second account cache, so a changed password
invalidates every other session without a per-request query.

Closes the remaining half of the stateless-token problem: deletion and
deactivation already revoke immediately, password change did not.

## Task 7 — Daily digest by email

`services/mailer.js` — nodemailer over SMTP, TLS required, configuration from
env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`).

`app_settings.owner_digest`:

```json
{ "enabled": false, "recipients": [], "send_at": "08:00", "timezone": "Asia/Kolkata" }
```

The scheduler sends once per local day when the time has passed, recording the
send in `app_settings` so a restart cannot double-send. Replaces the tick that
built a digest, sent nothing, and logged `"Morning digest sent successfully"`.

Sending failures are logged and retried on the next tick — a mail outage must
not stop the scheduler placing calls.

## Task 8 — Settings screen

Admin-only page for digest configuration and auto-queue rules, so neither needs
SQL or a redeploy. Includes a "Send a test digest now" button, because the first
thing anyone wants to know is whether the mail actually arrives.

## Task 9 — Dead code

Remove `services/pdf.js` and `services/reporting.js`'s report paths that write
PDFs to `/tmp` behind the disabled reports page. `buildOwnerDashboardData` is
kept — task 7 uses it. Drop `routes/reports.js` and the `/reports.html`
disabling route.

## Task 10 — Production accounts

Create the agent accounts through the Users screen. Operational, not code, but
it blocks end-to-end testing so it belongs on the list.

## Definition of done

- `customers` has no person columns and `patient_id` is `NOT NULL`
- A patient scheduled from the screen is picked up by the scheduler
- An automatic rule queues an eligible patient, and does not queue a
  `do_not_call`, inactive, or already-queued one
- An agent cannot obtain a contact through any endpoint, including the ones
  touched in task 2
- Changing a password ends other sessions
- A test digest arrives at a configured address
- `clients` no longer exists in the schema or the code
- Full suite passes

## Not in this plan

Retention (still open), `replicas: 1` (in-process state), and the end-to-end
call itself — which is the point of the *next* phase, once there is a
deployment pipeline.
