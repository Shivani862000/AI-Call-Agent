# Pending work

Open items carried out of working sessions. Each entry says what is wrong, where
it lives, and what "done" looks like — enough to pick up without the original
conversation.

Started 2026-09-09.

## Blocked on configuration (not fixable from the repo)

### 1. `DATABASE_URL` secret is empty — every UAT deploy fails

`Build and Deploy` dies at the "Apply migrations" step:

```
env:
  DATABASE_URL:
[MIGRATE FAILED] SUPABASE_URL_DEV is not set
```

[deploy.yml:79](../.github/workflows/deploy.yml) passes `secrets.DATABASE_URL` to
`scripts/migrate.js`. The secret is unset, so `resolveDatabaseUrl` falls back to
`SUPABASE_URL_DEV`, which does not exist on the runner either.

Failed the same way on 2026-09-07 (run 34143208738) and 2026-09-09 (run
34374777142), so **the UAT droplet has been running pre-2026-09-07 code since
then**. Anything merged to `uat-kcpathlab` in that window is on the branch but
not deployed.

**Done when:** a `DATABASE_URL` repository secret holds the UAT Postgres
connection string and `gh run rerun <id> --failed` reaches the deploy step.

### 2. `PUBLIC_BASE_URL` is not configured

Absent from `.env` and `.env.uat.example`; [config.js:46](../src/config.js)
falls back to `http://localhost:<port>`.

Consequence: the daily digest cannot build links to calls, so it degrades to a
report with no transcript or recording links — the feature that was asked for.

**Done when:** `PUBLIC_BASE_URL` is set to the UAT origin and a digest sent from
that environment contains working links.

## Verification owed

### 3. Confirm recording *capture* still works on a live call — DONE 2026-09-10

Verified by call 370 (2026-09-10 04:47 UTC): `recording_status = 'stored'`,
transcript captured, analysis completed. The stored object is a valid 50.5s WAV
matching the call's 51s duration, peak amplitude 28826/32767 with 59% audible
samples — real conversation, not silence.

Capture was never broken. The whole of the reported defect was playback, and
that is fixed in 7368394 — still undeployed at the time of writing, see item 1.

## Deferred defects

### 4. A recording is lost silently if the hangup write fails

[websocket-bridge.js:1613](../src/websocket-bridge.js) saves the `.wav` inside
the `.then()` of the hangup database write. The matching `.catch()` at line 1664
only logs. If that write rejects, the file is never written to disk at all — no
local copy, no `pending_upload` row, nothing for the scheduler sweep to retry.

Not observed in the wild; found while tracing the playback defect.

**Done when:** the recording is saved independently of the database write, so a
database hiccup at hangup costs a row update and not the audio.

### 5. Day windows are computed in server local time

[reporting.js:2-19](../services/reporting.js) builds ranges with
`setHours(...)` on a local `Date` and then serialises to ISO. On a UTC droplet
serving IST users, "yesterday" is a UTC day — shifted 5½ hours from the day the
owner means.

The digest's own 24-hour sections avoid this by computing the window in SQL, but
`yesterday_snapshot`, `getTodayDateRange` and the weekly rollups still carry it.

**Done when:** the ranges are computed in the configured timezone
(`owner_digest.timezone`, default `Asia/Kolkata`) rather than the server's.

### 6. Star ratings are mostly not captured

Of the feedback rows on UAT, most carry a `category` (`good`, `average`) with
`stars` NULL. The digest renders a category chip when stars are missing, so the
email is correct either way — but the average-rating figure is close to
meaningless until ratings are actually collected.

**Done when:** it is decided whether the call flow should be capturing a numeric
rating at all, and either it is captured or the average is dropped.

### 7. Feedback with no `call_id` cannot be linked

`feedback.call_id` is nullable and web-form submissions arrive without one, so
those entries appear in the digest without a link to a call. Correct behaviour
today; noting it so it is not mistaken for a bug later.

### 8. `OBJECT_STORAGE_BUCKET` is dead configuration

`.env` sets `OBJECT_STORAGE_BUCKET=feedback-call-recordings`. Nothing reads it —
[supabase-storage.js:5](../services/supabase-storage.js) reads
`SUPABASE_STORAGE_BUCKET`, defaulting to `call-recordings`, which is where the
working files actually are. Harmless, but it reads like the real setting.

**Done when:** the unused variable is removed, or the code is changed to read it.
