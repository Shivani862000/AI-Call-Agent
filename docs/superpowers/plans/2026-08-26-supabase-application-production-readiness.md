# Supabase Application Production-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SQLite with an empty Supabase Postgres database, support two client/tenant records and multiple webmaster accounts, and deliver the minimum application-level security, health, logging, and verification required before DigitalOcean deployment.

**Architecture:** Keep the current single-process Express application, routes, dashboard, and call workflows. Place parameterized PostgreSQL behind focused repositories using one `pg.Pool`; use Supabase Auth for password verification and application tables for usernames, activation, roles, and session invalidation. Store both clients in one Supabase project, require `client_id` in every tenant-owned repository operation, and keep webmasters platform-wide for this phase.

**Tech Stack:** Node.js 24 LTS, Express, hosted Supabase Postgres/Auth, `pg`, `@supabase/supabase-js`, Supabase CLI hosted migration commands, `cookie-session`, `express-rate-limit`, Node’s built-in test runner, and Supertest.

**Spec:** `docs/superpowers/specs/2026-08-26-supabase-production-readiness-design.md`

## Global Constraints

- Start Supabase empty and deliberately discard existing SQLite data; do not export, back up, import, dual-write, or reconcile it.
- Supabase Postgres is the only persistent application datastore. MongoDB and SQLite are not runtime or fallback options.
- Do not require Docker or a local Supabase/Postgres stack. Database integration tests use one dedicated hosted non-production Supabase project.
- Use one Supabase project for both initial clients. Tenant-owned rows and repository calls require `client_id`.
- Webmaster accounts are platform-wide and unlimited in count. Normal startup must never create, reset, or overwrite one.
- Supabase Auth owns password hashing; the application stores no password or password hash.
- Provisioning accepts passwords only through a hidden prompt or stdin and rejects `--password` and password environment variables.
- Preserve existing business routes, status behavior, dashboard workflows, numeric IDs, and snake_case response fields.
- Do not expose raw SQL or database/Supabase clients to routes and services.
- Do not expose the Supabase secret key to browser code or normal runtime request handling.
- Production Postgres connections require strict CA verification through `SUPABASE_DB_CA_CERT`; only the dedicated hosted test harness may explicitly use encrypted `require` mode without CA verification.
- Keep one application replica because scheduler and live-call ownership remain process-local.
- Google Cloud, DigitalOcean infrastructure/pipeline work, and UAT are outside this plan.
- Pin Node.js to `>=24 <25`; use TDD and one focused commit per task.

## Planned File Structure

### Database and persistence

- `supabase/config.toml` — Supabase CLI metadata used to push source-controlled migrations to hosted projects; it is not a local runtime dependency.
- `supabase/migrations/20260826000100_application_schema.sql` — extensions, tables, keys, checks, indexes, grants, and RLS posture.
- `supabase/migrations/20260826000200_preserve_tenant_on_nullable_foreign_keys.sql` — preserves required tenant IDs when nullable cross-table references are deleted.
- `scripts/push-test-migrations.js` — validates the hosted test-project guard before invoking the Supabase CLI migration push.
- `persistence/postgres.js` — creates, verifies, and closes one `pg.Pool`; exposes transaction helpers.
- `persistence/mappers.js` — converts Postgres values to current API shapes.
- `repositories/index.js` — constructs all repositories from the database facade.
- `repositories/users.js` — username lookup, roles, activation, login timestamp, and auth version.
- `repositories/clients.js` — minimal client lookup/create required by provisioning and tests.
- `repositories/customers.js` — tenant-scoped CRUD, scheduling eligibility, and cascade deletion.
- `repositories/calls.js` — tenant-scoped call lifecycle, callback idempotency, history, and recent lists.
- `repositories/feedback.js` — manual creation, call upsert, and joined listings.
- `repositories/supervisor-events.js` — append and newest-first lookup.
- `repositories/reporting.js` — tenant/date-range joins and aggregates.
- `repositories/agents.js`, `repositories/campaign-configurations.js`, `repositories/support-tickets.js`, `repositories/application-state.js` — minimal approved table ownership.

### Authentication and runtime hardening

- `auth/supabase-auth.js` — Supabase Auth password verification and admin identity operations.
- `auth/session.js` — signed cookie and same-origin checks.
- `auth/middleware.js` — database-backed active-user and role enforcement.
- `routes/auth.js` — login, logout, session, and active-client selection endpoints.
- `scripts/provision-webmaster.js` — repeatable, non-overwriting webmaster provisioning.
- `config/runtime-config.js` — validates runtime configuration without logging values.
- `logging/logger.js` — one-line JSON logging and redaction.
- `middleware/request-context.js` — request IDs and completion events.
- `middleware/twilio-validation.js` — Twilio SDK signature checks.
- `public/login.html` — minimal webmaster login page.

### Tests

- `.env.test.example` — secret-free template for the dedicated hosted Supabase test project.
- `tests/helpers/postgres-test-context.js`
- `tests/helpers/postgres-test-context.test.js`
- `tests/helpers/start-test-app.js`
- `tests/helpers/test-config.js`
- `tests/persistence/postgres.test.js`
- `tests/repositories/customers.test.js`
- `tests/repositories/calls-feedback.test.js`
- `tests/repositories/reporting.test.js`
- `tests/repositories/catalogs.test.js`
- `tests/routes/customers-feedback.test.js`
- `tests/auth/provision-webmaster.test.js`
- `tests/auth/auth-routes.test.js`
- `tests/health-and-logging.test.js`
- `tests/application-contracts.test.js`
- `tests/twilio-validation.test.js`
- `tests/sqlite-removal.test.js`

---

### Task 1: Add the Supabase/Postgres test baseline

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `.env.test.example`
- Create: `scripts/push-test-migrations.js`
- Create: `supabase/config.toml`
- Create: `tests/helpers/postgres-test-context.js`
- Create: `tests/helpers/postgres-test-context.test.js`
- Create: `tests/scripts/push-test-migrations.test.js`
- Create: `tests/helpers/start-test-app.js`
- Create: `tests/helpers/test-config.js`
- Create: `tests/application-contracts.test.js`
- Create: `tests/persistence/postgres.test.js`

**Interfaces:**
- Produces: `withTestDatabase(run) -> Promise<void>` using only a guarded `SUPABASE_TEST_DB_URL` for a dedicated hosted project.
- Produces: `makeTestConfig(overrides)` with inert provider configuration.
- Establishes: `npm test`, guarded `npm run test:db`, and hosted-only `npm run db:push:test` commands.

- [x] **Step 1: Capture current HTTP contracts before changing persistence**

Create `startTestApp()` that launches the current server as a child process on an ephemeral port with a temporary SQLite test path and inert provider settings, waits for `/health`, and terminates the child in cleanup. In `tests/application-contracts.test.js`, capture customer create/list/get/update/delete, duplicate-phone error shape, manual feedback validation/list shape, health shape, numeric IDs, and snake_case fields. Do not copy any existing `feedback.db`; the fixture creates and deletes its own temporary database.

Run: `npm test -- tests/application-contracts.test.js`
Expected: PASS against the current SQLite application. Preserve this test and make it pass against Postgres in later tasks.

- [x] **Step 2: Install dependencies and scripts**

Run:

```bash
npm install pg @supabase/supabase-js cookie-session express-rate-limit
npm install --save-dev supertest supabase
```

Set `engines.node` to `>=24 <25` and add scripts for `node --test --test-concurrency=1`, guarded hosted database tests, `supabase db push --db-url`, and `node scripts/provision-webmaster.js`. Do not add `supabase start`, `supabase stop`, or local reset commands.

- [x] **Step 3: Configure the isolated hosted Supabase test project boundary**

Keep source-controlled Supabase CLI metadata and migrations, but run no local services. Add `.env.test.local` to `.gitignore`; operators supply `SUPABASE_TEST_DB_URL`, `SUPABASE_TEST_PROJECT_REF`, and `SUPABASE_TEST_ALLOW_RESET=true` there or through CI secrets.

Create `withTestDatabase(run)` so it requires the dedicated hosted test project, validates that the connection hostname or pooler username matches `SUPABASE_TEST_PROJECT_REF`, refuses a URL matching `SUPABASE_DB_URL`, passes `{ connectionString, pool }`, and truncates only application tables between tests. Hosted database tests are skipped during ordinary offline unit runs and fail fast when `npm run test:db` is explicitly requested without all three guard variables.

- [x] **Step 4: Write failing lifecycle and schema tests**

Assert imports for `createPostgres`, `pingPostgres`, `closePostgres`, and `withTransaction` fail initially. The completed test must prove `SELECT 1`, rollback behavior, all required tables, identity-generated numeric IDs, foreign keys, indexes, revoked `anon`/`authenticated` grants, and enabled RLS.

- [x] **Step 5: Verify the expected failure without starting Docker**

Run: `npm run test:db -- tests/persistence/postgres.test.js`
Expected: FAIL because `persistence/postgres.js` and the schema migration do not exist.

- [x] **Step 6: Commit the harness**

```bash
git add package.json package-lock.json supabase tests/helpers tests/application-contracts.test.js tests/persistence/postgres.test.js
git commit -m "test: add Supabase integration harness"
```

### Task 2: Create the Postgres schema and connection lifecycle

**Files:**
- Create: `supabase/migrations/20260826000100_application_schema.sql`
- Create: `supabase/migrations/20260826000200_preserve_tenant_on_nullable_foreign_keys.sql`
- Create: `persistence/postgres.js`
- Create: `persistence/mappers.js`
- Modify: `tests/persistence/postgres.test.js`
- Create: `tests/persistence/schema.test.js`
- Create: `tests/persistence/mappers.test.js`

**Interfaces:**
- Produces: `createPostgres({ connectionString, max, statementTimeoutMs, ssl, logger }) -> { pool, query, transaction, ping, close }` with strict remote certificate verification by default.
- Produces: `withTransaction(pool, work) -> Promise<T>` with rollback on error.
- Produces: `toApiCustomer`, `toApiCall`, `toApiFeedback`, and `toApiSupervisorEvent`.

- [x] **Step 1: Write the exact schema migration**

Define `clients`, `app_users`, `app_user_roles`, `customers`, `calls`, `feedback`, `call_supervisor_events`, `application_state`, `agents`, `campaign_configurations`, and `support_tickets`.

Use this identity/auth pattern:

```sql
create table public.clients (
  id bigint generated by default as identity primary key,
  slug text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  timezone text not null default 'UTC',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  username_normalized text not null unique,
  email text not null,
  email_normalized text not null unique,
  active boolean not null default true,
  auth_version integer not null default 1 check (auth_version >= 1),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_user_roles (
  user_id uuid not null references public.app_users(id) on delete cascade,
  role text not null check (role in ('webmaster')),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);
```

Use `bigint` identity IDs, `timestamptz`, booleans, and `jsonb`. Add required `client_id` and tenant-safe foreign keys to tenant tables. Declare cascades only for current ownership behavior. Add per-client phone uniqueness, unique non-null Twilio SID, unique non-null feedback `call_id`, scheduler/report indexes, and `UNIQUE NULLS NOT DISTINCT (client_id, key)` for application state.

- [x] **Step 2: Lock down the Data API**

Create `ai_call_agent_runtime` as a NOLOGIN group role. For every application table, enable RLS, revoke grants from `anon` and `authenticated`, grant only required CRUD privileges to the runtime group, and create explicit policies limited to `ai_call_agent_runtime`. Grant only required sequence usage/select. Do not create browser policies or grant application tables to `service_role`. The production LOGIN role and its password are deployment operations and do not appear in source.

- [x] **Step 3: Implement the bounded pool**

Use `pg.Pool` with explicit pool size, connection timeout, statement timeout, TLS driven by configuration, strict remote certificate verification by default, `SELECT 1` ping, `BEGIN/COMMIT/ROLLBACK`, and idempotent close. Never log the connection string. The hosted test harness explicitly uses encrypted non-verifying mode until its test CA is configured; production supplies `SUPABASE_DB_CA_CERT`.

- [x] **Step 4: Implement explicit mappers**

Convert `bigint` strings to safe numeric IDs, reject unsafe values, serialize timestamps, and emit legacy integer-flag/JSON-string compatibility only where current callers require it.

- [x] **Step 5: Push to the hosted test project and verify**

```bash
npm run db:push:test -- --dry-run
npm run db:push:test
npm run test:db -- tests/persistence/postgres.test.js tests/persistence/schema.test.js tests/persistence/mappers.test.js
```

Expected: the dry run lists only the source-controlled migration, the push succeeds against the guarded test URL, and all persistence tests pass. No Docker daemon is used.

- [x] **Step 6: Commit schema and persistence**

```bash
git add supabase/migrations persistence tests/persistence/postgres.test.js
git commit -m "feat: add Supabase Postgres schema"
```

### Task 3: Implement client and customer repositories

**Files:**
- Create: `repositories/index.js`
- Create: `repositories/clients.js`
- Create: `repositories/customers.js`
- Create: `tests/repositories/customers.test.js`
- Create: `tests/routes/customers-feedback.test.js`
- Modify: `routes/customers.js`
- Modify: `index.js`

**Interfaces:**
- Produces: `createRepositories(database)` with all repository properties named in the file structure.
- Produces: `clients.create`, `clients.findById`, and `clients.findBySlug`.
- Produces tenant-required customer methods: `create(clientId, input)`, `findById(clientId, id)`, `list(clientId)`, `update(clientId, id, patch)`, `deleteWithRelations(clientId, id)`, and `findEligibleForScheduler(clientId, options)`.

- [x] **Step 1: Write failing repository tests**

Cover identity IDs, per-client duplicate phone behavior, CRUD, explicit field whitelisting, retry increments, scheduling eligibility, and cascade deletion. Seed two clients with the same phone and assert each can own it. Assert every method rejects a missing `clientId` before issuing SQL.

- [x] **Step 2: Verify failure**

Run: `npm test -- tests/repositories/customers.test.js`
Expected: FAIL because the repositories are missing.

- [x] **Step 3: Implement parameterized repositories**

Use named methods and parameterized SQL only. `findEligibleForScheduler` filters workflow flags, due times, slot fields, and recent-call suppression in one bounded query ordered by priority and creation time. Interpret unique violations by constraint name to retain the current duplicate-phone response.

- [x] **Step 4: Rewire customer flows**

Change `routes/customers.js` to `createCustomersRouter({ customers, getClientId })`. Move scheduler and pre-call customer persistence in `index.js` to repository calls. The initial `getClientId` resolves a validated platform client context; tests set it explicitly.

During this staged checkpoint, a configured `SUPABASE_DB_URL` requires `DEFAULT_CLIENT_ID` and validates that it identifies an active client before serving traffic. The later authentication task replaces this temporary default with the signed session's revalidated `activeClientId`. A focused SQLite customer adapter preserves the existing whole-application contract only while calls and feedback remain on their later migration tasks; the final SQLite-removal task deletes that adapter and fallback.

- [x] **Step 5: Verify and commit**

```bash
npm test -- tests/repositories/customers.test.js tests/routes/customers-feedback.test.js
node --check routes/customers.js
node --check index.js
git add repositories routes/customers.js index.js tests
git commit -m "feat: move customers to Supabase Postgres"
```

### Task 4: Implement calls, feedback, and supervisor events

**Files:**
- Create: `repositories/calls.js`
- Create: `repositories/feedback.js`
- Create: `repositories/supervisor-events.js`
- Create: `tests/repositories/calls-feedback.test.js`
- Modify: `index.js`
- Modify: `routes/feedback.js`
- Modify: `services/call-feedback.js`
- Modify: `services/call-orchestration.js`
- Modify: `services/post-call-pipeline.js`
- Modify: `services/crm-sync.js`

**Interfaces:**
- `calls.createAndMarkCustomer(clientId, input)` performs both writes in one transaction.
- Call lookup/update/list methods require `clientId`, including Twilio SID lookups.
- Feedback create/upsert/list methods and supervisor-event append/list methods require `clientId`.

- [ ] **Step 1: Write transaction and idempotency tests**

Test two-client isolation, numeric IDs, transaction rollback, unique Twilio SID behavior, repeated callback updates, 2 MiB call-payload rejection, native `jsonb`, feedback upsert concurrency, newest-first events, and customer cascade deletion.

- [ ] **Step 2: Implement the repositories**

Use `INSERT ... RETURNING`, `UPDATE ... RETURNING`, explicit patch whitelists, conflict-safe feedback upsert, and joined projections matching current HTTP fields. Every join includes compatible `client_id`; never locate tenant-owned data by public ID alone.

- [ ] **Step 3: Rewire active workflows**

Pass `{ repositories, clientId }` through call-feedback, orchestration, post-call, and CRM operations. Keep provider calls outside database transactions and retain existing Twilio/OpenAI behavior.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- tests/repositories/calls-feedback.test.js tests/routes/customers-feedback.test.js
node --check services/call-feedback.js
node --check services/call-orchestration.js
node --check services/post-call-pipeline.js
node --check services/crm-sync.js
git add repositories index.js routes services tests
git commit -m "feat: move call workflows to Supabase Postgres"
```

### Task 5: Replace reporting SQL

**Files:**
- Create: `repositories/reporting.js`
- Create: `tests/repositories/reporting.test.js`
- Modify: `services/reporting.js`
- Modify: `index.js`

**Interfaces:**
- Produces: `reporting.buildRangeData(clientId, { start, end })` with current report input fields.
- Retains PDF formatting and presentation calculations in `services/reporting.js`.

- [ ] **Step 1: Write fixed-fixture tests**

Seed both clients and assert exact per-client totals, average rating, outcomes, slot labels, script averages, pending items, joined customer names, objections, and competitor mentions. Use overlapping-looking fixtures to detect missing tenant predicates.

- [ ] **Step 2: Implement PostgreSQL reporting**

Use parameterized CTEs/queries with indexed date predicates and `client_id` in every branch. Use PostgreSQL aggregates and `jsonb` operators while keeping presentation in application code.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- tests/repositories/reporting.test.js
node --check services/reporting.js
git add repositories/reporting.js services/reporting.js index.js tests/repositories/reporting.test.js
git commit -m "feat: move reporting to PostgreSQL"
```

### Task 6: Add minimal ownership for remaining tables

**Files:**
- Create: `repositories/agents.js`
- Create: `repositories/campaign-configurations.js`
- Create: `repositories/support-tickets.js`
- Create: `repositories/application-state.js`
- Create: `tests/repositories/catalogs.test.js`
- Modify: `repositories/index.js`

**Interfaces:**
- Each tenant repository provides `create(clientId, input)`, `findById(clientId, id)`, and `list(clientId, options)`.
- Application state provides `get(clientIdOrNull, key)` and `set(clientIdOrNull, key, value, expectedVersion?)`.

- [ ] **Step 1: Write failing contract tests**

Assert client isolation, identity IDs, field mappings, foreign-key rejection, application-state version checks, and absence of provider-secret columns.

- [ ] **Step 2: Implement only tested methods**

Use explicit field lists and tenant predicates. Do not add management routes, UI, scheduling behavior, or ticket workflows.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- tests/repositories/catalogs.test.js
git add repositories tests/repositories/catalogs.test.js
git commit -m "feat: add tenant-scoped catalog repositories"
```

### Task 7: Add Supabase Auth and multiple-webmaster provisioning

**Files:**
- Create: `repositories/users.js`
- Create: `auth/supabase-auth.js`
- Create: `auth/session.js`
- Create: `auth/middleware.js`
- Create: `routes/auth.js`
- Create: `scripts/provision-webmaster.js`
- Create: `public/login.html`
- Create: `tests/auth/provision-webmaster.test.js`
- Create: `tests/auth/auth-routes.test.js`
- Modify: `repositories/index.js`
- Modify: `index.js`
- Modify: `public/admin.html`

**Interfaces:**
- `createSupabaseAuth({ url, anonKey })` produces `verifyPassword(email, password)`.
- `createSupabaseAdmin({ url, serviceRoleKey })` produces `createUser` and `deleteUser` for provisioning only.
- `provisionWebmaster({ adminAuth, database, username, email, password })` returns `{ id, username }`.
- User repository methods load normalized usernames, active authorization, roles, login time, and auth version.
- Middleware reloads current authority, validates the signed `activeClientId`, exposes it to repositories, and enforces `requireRole('webmaster')`.

- [ ] **Step 1: Write provisioning tests**

Use a fake Supabase Admin adapter plus test Postgres. Assert username/email normalization, minimum 12-character password, no password/hash columns, one role row, duplicate rejection, Auth-user compensation on profile failure, rejection of `--password`, and safe output.

Mandatory cardinality assertion:

```js
const first = await provisionWebmaster(firstInput);
const second = await provisionWebmaster(secondInput);
assert.notEqual(first.id, second.id);
assert.equal(await countActiveWebmasters(database), 2);
```

- [ ] **Step 2: Write HTTP auth tests**

Assert either webmaster can log in independently; wrong credentials return generic `401`; cookie attributes are correct; session reloads roles and active clients; `POST /auth/select-client` accepts either active client and rejects absent/inactive IDs; logout clears; inactive/auth-version-changed users fail; non-webmasters receive `403`; and no Supabase token reaches JSON or browser storage.

- [ ] **Step 3: Implement safe provisioning**

Require `SUPABASE_DB_URL`, `SUPABASE_URL`, and `SUPABASE_SECRET_KEY`, plus `--username` and `--email`; read password without echo or from stdin; reject password flags/environment values. Preflight normalized username/email, call Supabase Admin `createUser`, insert profile plus role in one Postgres transaction, and delete the new Auth identity if the transaction fails. Never cap webmaster count or update existing accounts.

- [ ] **Step 4: Implement login and sessions**

Resolve normalized username to private email, verify through Supabase Auth, discard returned tokens, and create a signed cookie containing only user ID, auth version, active client ID, and issue time. Default to the lowest-ID active client only when the session has no selection. Add `POST /auth/select-client` to validate and replace that selection. Use a fixed eight-hour lifetime, login throttling, database-backed authorization and client validation on every protected request, and same-origin checks for browser mutations.

- [ ] **Step 5: Protect and verify**

Keep login assets, auth entry endpoints, `/health`, and validated Twilio endpoints public. Protect client selection, admin HTML, `/api/**`, reports, recordings/transcripts, and operator call endpoints without renaming them. Add a compact selector to `public/admin.html`; selection refreshes existing dashboard data rather than introducing client-specific business URLs.

```bash
npm test -- tests/auth/provision-webmaster.test.js tests/auth/auth-routes.test.js
git add auth repositories/users.js repositories/index.js routes/auth.js scripts public index.js tests/auth
git commit -m "feat: add multiple Supabase webmaster accounts"
```

### Task 8: Add configuration, health, logs, and graceful shutdown

**Files:**
- Create: `config/runtime-config.js`
- Create: `logging/logger.js`
- Create: `middleware/request-context.js`
- Create: `tests/health-and-logging.test.js`
- Modify: `.env.example`
- Modify: `index.js`
- Modify: active routes/services containing sensitive console output

**Interfaces:**
- `loadRuntimeConfig(env)` returns validated values without printing them.
- Logger methods emit one-line redacted JSON.
- `createHealthHandler({ ping, clock })` returns database-aware `200` or `503`.

- [ ] **Step 1: Write hardening tests**

Assert missing `SUPABASE_DB_URL`, `SUPABASE_DB_CA_CERT`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, or `COOKIE_SECRET` fails before listen; the secret key is not required by normal runtime; cookie secret is at least 32 bytes; health follows connectivity; shutdown closes the pool; and logs redact credentials, cookies, phone numbers, transcripts, and feedback.

- [ ] **Step 2: Implement configuration and logging**

Whitelist fields, emit stable error codes, and replace sensitive logs in touched paths. `.env.example` contains safe placeholders and descriptions only.

- [ ] **Step 3: Make startup and health database-aware**

Use this order: validate config, create pool, ping, construct repositories/routes, start scheduler, listen. Shutdown stops scheduling, stops new traffic, drains HTTP, and closes the pool.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- tests/health-and-logging.test.js
git add config logging middleware .env.example index.js routes services tests/health-and-logging.test.js
git commit -m "feat: harden Supabase runtime readiness"
```

### Task 9: Validate Twilio public entry points

**Files:**
- Create: `middleware/twilio-validation.js`
- Create: `tests/twilio-validation.test.js`
- Modify: `index.js`

**Interfaces:**
- `validateTwilioHttp({ authToken, publicBaseUrl })` validates the externally signed URL/body.
- `validateTwilioUpgrade({ authToken, publicBaseUrl })` rejects invalid media WebSocket upgrades.

- [ ] **Step 1: Write signature tests**

Cover forms, query strings, reverse-proxy canonical URLs, invalid signatures, and WebSocket upgrades. Failures must log no token, signature, phone, or body.

- [ ] **Step 2: Implement using Twilio’s SDK helper**

Apply validation only to provider-controlled webhook/TwiML/status/media paths. Browser/operator routes continue using application sessions.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- tests/twilio-validation.test.js tests/auth/auth-routes.test.js
git add middleware/twilio-validation.js index.js tests/twilio-validation.test.js
git commit -m "feat: validate public Twilio callbacks"
```

### Task 10: Remove SQLite and stale MongoDB artifacts

**Files:**
- Create: `tests/sqlite-removal.test.js`
- Delete: `db.js`
- Delete after reachability confirmation: `routes/calls.js`
- Delete after reachability confirmation: `routes/twiml.js`
- Delete after reachability confirmation: `routes/whatsapp.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces an architecture guard proving Supabase/Postgres is the only persistence implementation.

- [ ] **Step 1: Write the guard before deletion**

Scan runtime source and dependencies. Fail on `sqlite3`, `feedback.db`, `DATABASE_URL`, `MONGODB_URI`, the MongoDB driver, generic SQLite helpers, or old provider-specific configuration. Exclude historical Git data and the guard’s literal list.

- [ ] **Step 2: Verify the guard fails**

Run: `npm test -- tests/sqlite-removal.test.js`
Expected: FAIL against current SQLite references.

- [ ] **Step 3: Remove old persistence**

Remove `sqlite3`, delete `db.js`, and remove database-file configuration. Delete unmounted duplicate routes only after `rg` and route tests prove they are unused. Do not read, copy, or convert `feedback.db`.

- [ ] **Step 4: Update documentation**

Document hosted test-project setup, runtime configuration names, explicit migration push, repeatable webmaster provisioning, shared two-client design, health behavior, and intentional SQLite-data abandonment. Remove local-Docker and MongoDB instructions.

- [ ] **Step 5: Verify and commit**

```bash
npm test
npm run db:push:test -- --dry-run
npm run test:db
npm ls sqlite3 mongodb
rg -n "sqlite3|feedback\\.db|DATABASE_URL|MONGODB_|mongodb" --glob '!node_modules/**' .
git add -A
git commit -m "refactor: remove SQLite and MongoDB persistence"
```

Expected: tests pass; neither obsolete dependency is installed; provider references remain only in historical explanation where intentional.

### Task 11: Complete hosted Supabase acceptance and prepare handoff

**Files:**
- Create: `docs/deployment/supabase-production-handoff.md`
- Modify: documentation only if verification reveals an operational requirement

**Interfaces:**
- Produces a secret-free handoff checklist for the separate DigitalOcean pipeline plan.

- [ ] **Step 1: Confirm the isolated hosted test project guard**

Use the dedicated non-production hosted project created for integration tests, never the future production project. Confirm that its reference matches `SUPABASE_TEST_PROJECT_REF`, that `SUPABASE_TEST_DB_URL` differs from `SUPABASE_DB_URL`, and that all credentials come from `.env.test.local` or CI secret injection rather than repository files or shell history.

- [ ] **Step 2: Apply migrations and run integration tests**

Dry-run and then apply source-controlled migrations with `npm run db:push:test`; run `npm run test:db` and the complete suite with the hosted-test guard that prevents destructive cleanup outside the verification project.

- [ ] **Step 3: Prove multiple webmasters**

Provision two distinct test webmasters using hidden input. Log in as each, verify independent sessions, disable one in a controlled test, and prove the other remains authorized. Remove test identities afterward using explicit IDs.

- [ ] **Step 4: Prove tenant/application acceptance**

Create two client fixtures and demonstrate isolation. Through existing routes, create a test customer, simulate provider-safe callback data, verify transcript/feedback/report visibility, restart, and verify persistence without user recreation. Do not place a real customer call from this verification project.

- [ ] **Step 5: Write the handoff runbook**

Record, without values: required variables, migration command, runtime/provisioning credential separation, client inputs, multi-webmaster command, health contract, one-replica requirement, SQLite-abandonment rule, and canonical URL dependency.

- [ ] **Step 6: Final verification and commit**

```bash
npm ci
npm run db:push:test -- --dry-run
npm run db:push:test
npm test
npm run test:db
git diff --check
git status --short
git add docs/deployment/supabase-production-handoff.md
git commit -m "docs: add Supabase production handoff"
```

## Completion Gate

Application production-readiness is complete only when:

- the application starts and operates with Supabase/Postgres while SQLite is absent;
- two clients coexist without cross-client repository leakage;
- at least two webmaster accounts can be provisioned and authenticate independently;
- startup creates or resets no users;
- health, logs, protected routes, and Twilio validation pass automated tests;
- the dedicated hosted test project passes migration and application acceptance without Docker; and
- the secret-free handoff is ready for the separate DigitalOcean production pipeline work.

Do not begin the DigitalOcean pipeline or UAT work inside this plan.
