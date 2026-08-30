# Supabase Migration — Design

**Date:** 2026-08-30
**Branch:** `vikrant-enhancements`
**Status:** Approved design, ready for implementation planning

## Goal

Move all persistent data in AI-Call-Agent from the local SQLite file and local
filesystem into Supabase, for both local development and production.

Three stores move:

| Today | After |
| --- | --- |
| `feedback.db` (SQLite, 10 tables) | Supabase Postgres |
| `recordings/*.wav`, `/tmp/feedback-call-recordings/*.mp3` | Supabase Storage, private bucket |
| `logs/system.log` (rotated file) | `system_logs` table |

After this work the application container holds no persistent state on disk.

## Decisions made

| Decision | Choice | Why |
| --- | --- | --- |
| Supabase surface | Postgres only, via `pg` | All 260 query sites use raw SQL with real JOINs and GROUP BYs. PostgREST would mean rewriting them. Auth stays as the existing bcrypt + signed-cookie scheme. |
| Local database | Separate hosted Supabase dev project | No Docker dependency for local work. Accepts network latency, which the hot-path analysis shows is tolerable. |
| Existing production data | Start fresh, archive `feedback.db` | No migration script needed. Cutover is a redeploy. |
| Schema fidelity | Port, fix, and drop dead columns | Same table and column names so queries do not move, but indexes, foreign keys and types are corrected on the way in. |
| File storage | Recordings and audit log both move | Removes every persistent volume from the deployment. |
| `system_logs` retention | Deferred — keep everything for now | See Deferred Decisions. |

## Architecture

### The seam

Every database call in the application goes through three functions exported by
`db.js`: `dbRun`, `dbGet`, `dbAll`. There are 260 call sites across 20 files.
All of them use `?` placeholders.

If those three functions keep their exact signatures and return shapes, calling
code does not change. The migration is therefore concentrated in `db.js` plus a
small number of sites that depend on SQLite-specific behaviour.

### Connection

Use `pg.Pool` against Supabase's Supavisor **session-mode pooler**:

```
aws-0-<region>.pooler.supabase.com:5432
```

- Not the direct `db.<ref>.supabase.co:5432` host — it is IPv6-only and will not
  resolve from many networks.
- Not transaction mode on port 6543 — it does not preserve session state, which
  the transaction sites need.

Pool settings: `max: 10`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 10000`.

Both Supabase projects should be created in the region nearest the application
server.

### Compatibility shims inside `db.js`

Three differences between `sqlite3` and `pg` are absorbed by the wrapper so that
no calling code changes:

**1. Placeholder rewriting.** SQL is written with `?`; Postgres wants `$1, $2`.
The wrapper rewrites placeholders positionally before execution.

**2. `lastID`.** 15 files read `result.lastID` after an INSERT. `dbRun` appends
`RETURNING id` to INSERT statements and maps the returned value to `lastID`.

*Exception:* `app_state` has no `id` column — it is keyed on `key`. The append is
driven by an explicit allow-list of id-bearing tables, not by pattern matching,
so this case fails loudly rather than silently.

**3. `changes`.** Mapped from `pg`'s `rowCount`.

### New export: `dbTx(fn)`

Two sites open transactions as independent `dbRun` calls:

- `routes/support-tickets.js:14`
- `db.js:229`

Under a connection pool, `BEGIN`, the statements, and `COMMIT` land on different
connections and stop being a single transaction. In the support-ticket case this
would commit the `PENDING-<uuid>` placeholder without the real ticket ID.

`dbTx(fn)` checks out one client from the pool, runs the callback against it, and
commits or rolls back.

Only `routes/support-tickets.js` consumes it. The `db.js:229` transaction lives
inside `runMigrations()`, which this design deletes; its work is replaced by the
seed-if-empty path described under Migrations.

### Removed from `db.js`

- `backupDatabase()` and `startDatabaseBackupSchedule()` — Supabase provides
  point-in-time recovery. The existing implementation writes backups to the same
  volume as the database, which is the problem rather than the solution.
- The entire `addColumnIfMissing` migration chain — replaced by versioned SQL.
- `fixCorruptedSchemas()` and `copyLegacyCallIdsToProviderCallId()` — SQLite
  repair paths with no meaning against a fresh Postgres schema.

## Schema

Same 10 tables, same column names, so no query rewrites.

### Type conversions

**Converted:**

- `TIMESTAMP` (currently ISO-8601 strings) → `timestamptz`.
  Verified safe: no code site performs string operations (`.slice`, `.split`,
  `.startsWith`, `.replace`) on a timestamp column, and the 10 range comparisons
  in `services/reporting.js` pass ISO strings as bound parameters, which Postgres
  casts cleanly.
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `bigint GENERATED ALWAYS AS IDENTITY`.

**Deliberately not converted:**

`INTEGER` 0/1 flag columns stay integers. 17 SQL sites compare them numerically
(`is_active = 1`, `do_not_call = 1`, `auto_retry_enabled = 0`). Postgres rejects
`boolean = 1`, so converting would require 17 hand-edits for no functional gain.

### Constraints and indexes added

Foreign keys, actually enforced, with `ON DELETE CASCADE`:

- `calls.customer_id` → `customers.id`
- `feedback.customer_id` → `customers.id`
- `feedback.call_id` → `calls.id`
- `call_supervisor_events.call_id` → `calls.id`
- `clients.linked_customer_id` → `customers.id`

This replaces the hand-ordered delete sequences in `routes/customers.js:679`.

Indexes:

- `calls(customer_id)`
- `calls(provider_call_id)`
- `feedback(customer_id)`
- `feedback(call_id)`
- `call_supervisor_events(call_id)`
- `customers(normalized_phone)` — **unique**

CHECK constraints on columns that are currently free text but hold a fixed set of
values: `customers.status`, `calls.status`, `calls.outcome`, `users.role`.

### `normalized_phone` gets wired up

The column exists today and is never written or read. Under this design it is
populated on every customer write and carries a unique index.

`findCustomerByPhone()` in `src/call-management.js:180` currently loads the 200
most recently created customers and filters them in JavaScript, which means a
returning patient outside that window gets a duplicate record created for them.
It becomes a single indexed query on `normalized_phone`.

### Columns dropped

Confirmed by whole-word grep across `src`, `services`, `routes`, `public` and
`scripts` — zero references outside the migration itself.

```
customers  data_retention_until, phone_number, scheduled_at, last_attempt_at,
           next_attempt_at, last_pickup_slot, provider_request_id

calls      scheduled_at, uuid, invoice_triggered, proposal_triggered,
           recording_consent_captured, recording_download_status,
           supervisor_notes, call_end_reason
```

Result: `calls` 74 → 66 columns, `customers` 51 → 44.
(`recording_local_path` is renamed rather than dropped — see Recordings.)

### Redundancy kept

These overlapping pairs are carried over unchanged, because collapsing them means
rewriting queries:

- `calls.status` / `calls.outcome`, with the two sync triggers reimplemented in
  Postgres
- `calls.sentiment` / `calls.sentiment_label`
- `calls.analysis_summary` / `calls.summary`

## Migrations

Schema lives in versioned SQL files under `supabase/migrations/`, applied with
`supabase db push`. The Supabase CLI tracks applied versions in
`supabase_migrations.schema_migrations`.

Because the project starts fresh, migration `0001` is the complete schema.

**`db.js` no longer runs DDL at boot.** New boot sequence:

1. Connect.
2. Read the newest `version` from `supabase_migrations.schema_migrations`.
3. Compare it against an `EXPECTED_SCHEMA_VERSION` constant in the codebase.
4. On mismatch, log the two versions and exit non-zero.

A running container must never alter the schema. This turns "someone deployed
code ahead of the migration" from a class of runtime SQL errors into one boot
failure with both version numbers in the message.

### Bootstrap accounts — behaviour change

`db.js:247-261` currently upserts three accounts with committed bcrypt hashes on
every boot, then runs `DELETE FROM users WHERE username IN ('admin', 'agent1')`.

All of that is removed. Seeding becomes: insert one admin from `ADMIN_USERNAME`
and `ADMIN_PASSWORD_HASH`, and only when the `users` table is empty.

Consequences:

- `admin@vikitechsolutions.in`, `agent1@vikitechsolutions.in` and
  `PRASHANTGUPTA74@YAHOO.CO.UK` stop existing. They must be recreated through a
  seed script with fresh passwords.
- `ADMIN_USERNAME=admin` starts working — today it is created and deleted in the
  same transaction.
- Operators can rotate those passwords, which is impossible today.
- The currently failing assertion in `test/database-safety.test.js` passes.

## Recordings in Supabase Storage

Private bucket `call-recordings`. Object keys shaped:

```
calls/<callId>/<streamId>.wav
calls/<callId>/<callSid>.mp3
```

Accessed with the `service_role` key from the server only. The key is never sent
to a browser.

### Column rename

`calls.recording_local_path` → `calls.recording_object_key`. Ten sites across
`src/api-routes.js`, `src/websocket-bridge.js` and
`services/post-call-pipeline.js`. A column named `local_path` holding a bucket key
is a trap for the next reader.

### Upload must not block call teardown

The mixed WAV is written to local temp exactly as today, then uploaded on a
background task. On upload failure the local file is retained and
`calls.recording_status` is set to `pending_upload`; a scheduler sweep retries.

This means a network failure to Supabase degrades to current behaviour rather
than hanging the WebSocket close handler.

### Two writers converge

- `src/websocket-bridge.js:1510` — mixed 8 kHz WAV on socket close
- `services/post-call-pipeline.js:16` — downloaded provider MP3

These currently write to two different hardcoded directories, only one of which
is volume-mounted, and only under Kubernetes. Both now target the same bucket.

### Playback

`GET /api/calls/:callId/recording` (`src/api-routes.js:1466`) stops calling
`res.sendFile` and instead returns a 60-second signed URL, so audio does not
proxy through Node.

## Audit log as a table

New table:

```sql
system_logs (
  id       bigint generated always as identity primary key,
  ts       timestamptz not null default now(),
  level    text not null,
  event    text not null,
  details  jsonb
)
```

Indexed on `(ts desc)` and `(event)`.

### Public API unchanged

`services/system-logger.js` keeps exporting `info` / `warn` / `error` / `debug`
with identical signatures, so roughly 60 call sites do not move.
`sanitizeLogDetails()` runs exactly as it does today — phone masking, and dropping
of transcripts, prompts, payloads and patient names.

### Write path

`logger.info()` is called 8 times inside `src/websocket-bridge.js`, during a live
call, and is synchronous today. It must not become an awaited network round-trip.

- Console output stays synchronous and unconditional. Container logs never depend
  on the database being reachable.
- Rows buffer in memory and flush every 2 seconds or at 50 rows, as one
  multi-row INSERT.
- Fire-and-forget. Callers never await; failures never propagate to the caller.
- Buffer caps at 1000 rows, dropping oldest first, so a Supabase outage cannot
  grow memory without bound.

### Reader

`GET /api/logs` (`src/api-routes.js:162`) becomes a SQL query. The regex filters
it applies today (`/\[(CALL_[A-Z_]+)\]/` and similar) become indexed
`WHERE event LIKE 'CALL_%'` clauses.

`fs.existsSync(logger.LOG_FILE)` and the file read are removed.

## Configuration and deployment

### Environment variables

`DATABASE_URL` keeps its name but changes meaning, from a filesystem path to a
Postgres connection string. `src/config.js` gains a guard: if `DATABASE_URL` does
not start with `postgres://`, boot fails with an explicit message. A half-migrated
deploy still pointing at `/app/data/feedback.db` must crash rather than silently
write to a file nobody reads.

New required variables, validated at boot alongside the existing checks:

```
DATABASE_URL=postgresql://...pooler.supabase.com:5432/postgres
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<secret>
SUPABASE_STORAGE_BUCKET=call-recordings
```

Removed: `DATABASE_BACKUP_ENABLED`, `DATABASE_BACKUP_DIR`,
`DATABASE_BACKUP_RETENTION`, `DATABASE_BACKUP_INTERVAL_MS`, `RECORDINGS_DIR`,
`SYSTEM_LOG_MAX_BYTES`, `SYSTEM_LOG_MAX_FILES`.

`SUPABASE_SERVICE_ROLE_KEY` is a full-access credential: Kubernetes Secret in
production, `.env` locally, never baked into an image.

Two projects, two env files. The same migrations are applied to both.

### Deployment becomes stateless

- `docker-compose.yml` and `docker-compose.prod.yml`: remove the `feedback_data`
  and `feedback_recordings` volumes.
- `k8s/pvc.yaml`: removed. `k8s/deployment.yaml` mounts an `emptyDir` for WAV
  staging before upload.
- `Dockerfile`: `RUN mkdir -p /app/data /tmp/feedback-call-recordings` is no
  longer needed for persistence.

This removes the orphaned-recordings problem, the unmounted-log problem, and the
backups-on-the-same-volume problem by removing the volume.

**Caveat:** this removes the *storage* reason the deployment is pinned to
`replicas: 1`, but not the only one. `liveCallState`, `incomingCallState` and
`validMediaTokens` remain in-process, so a second replica would still break live
call tracking and media-token validation. Horizontal scaling is separate work and
is out of scope here.

### Latency in the call path

The per-media-packet counter at `src/websocket-bridge.js:1407` is already batched
at 25 packets and already dispatched through `runInBackground`, so it is not in
the audio loop. The other seven database writes in the bridge occur at call start
and call end.

Net exposure is a handful of round-trips per call, none between audio frames.
Region colocation of both Supabase projects with the application server keeps
this well inside tolerance.

## Testing

Tests run against a dedicated `test` schema in the dev Supabase project,
truncated between runs. This keeps `npm test` working without a Docker
dependency, consistent with the local-development choice.

Verification turns the storage assessment's own findings into assertions:

- `PRAGMA`-equivalent check that foreign keys are enforced and cascade correctly
- All six indexes present
- No duplicate `normalized_phone` values, and a returning caller outside the old
  200-row window resolves to the existing customer
- A support ticket submission is atomic — no `PENDING-` prefixed ticket IDs
  survive a forced mid-transaction failure
- `system_logs` writes do not block: a call completes normally with the Supabase
  log endpoint unreachable
- Recording upload failure leaves the local file and sets `pending_upload`
- One real call driven end to end

`test/database-safety.test.js` needs updating for the removed hardcoded accounts;
its user-table assertion currently fails and should pass afterwards.

## Order of work

Each step is independently verifiable.

1. Migration SQL — schema, indexes, foreign keys, constraints, triggers
2. `db.js` swap — `pg` driver, placeholder shim, `RETURNING id`, `dbTx`
3. Smoke pass across all 260 call sites: boot, log in, create customer, manual
   feedback, dashboards, support ticket, call history
4. Recordings to Storage, including the `pending_upload` retry sweep
5. Logger to `system_logs`, with the buffered writer
6. Deployment configuration, volumes removed
7. Cutover — a redeploy, since there is no data to move

## Rollback

Revert the deploy. The existing `feedback.db` is untouched on its volume,
archived as agreed. There is no data written to Supabase that needs unwinding,
because the system starts fresh.

## Deferred decisions

**`system_logs` retention.** No deletion job is built in this project. This is the
one table that grows with traffic rather than with patient count, so it will need
a window. Revisit when the table passes roughly one million rows or when Supabase
tier limits are first approached — whichever comes first.

**Patient data retention.** The `customers.data_retention_until` column is being
dropped as dead. Retention policy for transcripts, recordings and patient records
remains unimplemented and is out of scope here, but it is now a more visible gap:
recordings in Storage and transcripts in Postgres both accumulate indefinitely.

**Horizontal scaling.** In-process session state still pins the deployment to a
single replica. Moving `liveCallState` and `validMediaTokens` to shared storage is
separate work.

## Out of scope

- Supabase Auth — the existing bcrypt users table and signed-cookie sessions stay
- Row Level Security — the application connects as a single trusted service role
- Splitting the 66-column `calls` table into `calls` / `call_analysis` /
  `call_media`
- Collapsing the `status`/`outcome`, `sentiment`/`sentiment_label` and
  `analysis_summary`/`summary` pairs
- The dead `services/pdf.js` and `services/reporting.js` PDF paths writing to
  `/tmp`
- The owner digest that builds a message and never sends it
  (`src/scheduler.js:171`)
- `scripts/seed-demo-reports.js`, which references the dropped
  `whatsapp_summary_sent` column and fails partway with no transaction
