# Supabase Production-Readiness Design

**Date:** 2026-08-26
**Status:** Approved design for implementation
**Supersedes:** `2026-08-26-mongodb-atlas-production-readiness-design.md`
**Scope:** Replace SQLite with Supabase Postgres and add the minimum authentication, database, health, logging, and verification controls required before the separate DigitalOcean production-deployment work.

## 1. Outcome

The application remains one Node.js/Express deployable with the same dashboard, HTTP routes, call flows, reporting flows, and external integrations. A single Supabase project becomes the only persistent application datastore. PostgreSQL access is isolated behind purpose-built repositories and application-level operations; routes and services do not use raw database clients, a generic SQL compatibility layer, or Supabase queries directly.

The Supabase database starts empty. Existing `feedback.db` contents are deliberately discarded. There is no export, backup, import, reconciliation, dual-write period, or SQLite fallback. Source-controlled PostgreSQL migrations create the new schema. After the Supabase-backed application passes acceptance checks, SQLite code, dependencies, configuration, files, and persistent storage are removed.

The same Supabase project supports the two initial client/tenant records. Tenant-owned rows carry `client_id`. Webmaster accounts are platform administrators with access to both clients. The system supports multiple active webmaster accounts; there is no singleton-webmaster constraint.

## 2. Approved Constraints

- Supabase Postgres replaces SQLite completely for all persistent application data.
- MongoDB Atlas is no longer part of the target architecture or implementation plan.
- Existing SQLite data is intentionally abandoned and must not be copied or backed up as part of this work.
- Existing HTTP paths, response behavior, admin UI, numeric public IDs, and business workflows remain compatible.
- PostgreSQL access is isolated behind named repositories and transaction-level application operations.
- Use one Supabase project and one Postgres database for the two initial clients; do not create a project per tenant.
- Every tenant-owned row has a required `client_id`; webmaster accounts are platform-wide administrators in this phase.
- Supabase Auth owns password hashing and password verification. No plaintext password is stored by the application.
- Application roles, activation state, username, and session invalidation version live in application tables, not user-editable Auth metadata.
- A secure provisioning command may be run repeatedly to create multiple webmaster accounts. It never overwrites an existing identity or profile.
- Normal server startup never creates, resets, or recreates any webmaster account.
- Supabase database credentials, the service-role key, and the cookie-signing secret are deployment secrets.
- Keep the production baseline lean: least-privilege database access, private server-side data access, source-controlled migrations, database-aware health, structured logs, and protected operator routes.
- DigitalOcean Droplet creation and deployment automation remain a separate follow-on plan. Google Cloud is not used.

## 3. Current-State Findings

### 3.1 Runtime and application shape

- `index.js` is a 1,700+ line entry point that builds the Express app, HTTP server, Twilio WebSocket bridge, scheduler, direct-call endpoints, recording/transcript endpoints, and startup sequence.
- Startup validates configuration, opens SQLite through `initializeDatabase()`, starts a 15-second in-process scheduler, and then listens.
- `public/admin.html` is served without authentication and calls the existing `/api/**` routes directly.
- There is no login route, user model, session mechanism, role enforcement, or protected admin/API boundary.
- `GET /health` always returns `200` and does not test the datastore.
- Logging is free-form and can include phone numbers, provider URLs, or transcript content.
- `liveCallState` is process memory used by the live dashboard. It remains intentionally ephemeral.
- Downloaded recordings are temporary files; durable audio remains with Twilio. The database stores recording references, not audio blobs.
- The repository currently has no test suite, CI definition, or production process definition.

### 3.2 Current persistence and query shape

`db.js` owns SQLite connection setup, runtime DDL, additive column changes, and the generic `dbRun`, `dbGet`, and `dbAll` helpers. It creates `customers`, `calls`, `feedback`, `app_state`, and `call_supervisor_events`.

SQL is embedded through active routes and services. The data model is relational: calls and feedback belong to customers, supervisor events belong to calls, reporting joins related tables and performs grouped aggregates, and customer deletion removes related data. This shape maps directly to PostgreSQL foreign keys, transactions, constraints, indexes, joins, and aggregate queries.

`routes/calls.js`, `routes/twiml.js`, and `routes/whatsapp.js` contain legacy SQL but are not mounted by the active application. Their status must be verified before conversion or deletion.

### 3.3 Compatibility that must be preserved

- API-visible records use numeric `id` values and snake_case fields.
- Dashboard JavaScript and route parameters treat customer and call IDs as numbers.
- Existing routes expect insert results equivalent to SQLite `lastID`.
- Existing code uses integer flags and JSON-encoded text in places; repository mappers preserve response compatibility while Postgres stores native booleans and `jsonb`.
- Scheduler eligibility depends on customer workflow fields and recent call history.
- Reports require joins, date-range filters, aggregates, and current customer names.

### 3.4 Domains not yet implemented

Users, agents, clients, campaign configurations, and support tickets do not have complete persistence workflows today. Their tables belong in the target schema, but this cutover does not add management UIs or broad new product features. Two client rows are provisioned as deployment data; webmaster accounts have platform-wide access in this phase.

## 4. Target Architecture

### 4.1 Boundaries

```text
Admin UI / Twilio callbacks / scheduler
                 |
          routes and workflows
                 |
   named repositories and transactions
                 |
          one pg connection pool
                 |
        one Supabase Postgres project

Login request -> Supabase Auth -> signed application session
                              -> app_users/app_user_roles authorization
```

Routes retain validation, status mapping, and response formatting. Services retain call orchestration and external side effects. Repositories own SQL, tenant scoping, value mapping, duplicate/constraint interpretation, and transaction boundaries. Reporting SQL lives in one reporting repository.

There is no generic `query(sql, params)` interface exposed outside persistence, no automatic SQLite dialect translator, no ORM requirement, and no route-by-route use of Supabase SDK database methods.

### 4.2 Connection and migration lifecycle

- `SUPABASE_DB_URL` is a secret pooled Postgres connection string for a least-privilege runtime role.
- One bounded `pg.Pool` is created during startup. Startup performs `SELECT 1` before listening and exits non-zero on failure.
- SQL migrations live in `supabase/migrations/` and run explicitly during deployment or local database reset. Application startup never runs DDL.
- SIGTERM/SIGINT stop scheduling, stop accepting traffic, drain the pool, and close the HTTP server.
- Repositories receive a database facade; they do not construct pools.
- The browser never receives a database URL, service-role key, or direct access to tenant tables.

### 4.3 Data types and stable contracts

- Existing public IDs become PostgreSQL `bigint generated by default as identity`; API mappers return safe JavaScript numbers while values remain within `Number.MAX_SAFE_INTEGER`.
- Timestamps use `timestamptz` in UTC.
- Flags use native `boolean`.
- AI analysis, key points, objections, competitors, and event payloads use `jsonb`.
- Existing route responses retain snake_case names and numeric IDs.
- Recording metadata and URLs are stored; audio and temporary local paths are not durable database assets.
- Constraints and indexes are declared in migrations rather than created by runtime code.

### 4.4 Tenant boundary

`clients` represents the two initial tenants. `customers`, `calls`, `feedback`, `agents`, `campaign_configurations`, `support_tickets`, `call_supervisor_events`, and tenant-scoped application state contain `client_id`.

Every repository operation that reads or mutates tenant-owned data requires an explicit `clientId`. Foreign keys and composite uniqueness prevent cross-client relationships. The current platform-wide `webmaster` role may select either active client through a small authenticated client selector. The selected `activeClientId` is stored in the signed session and revalidated against `clients` on each request before it reaches a repository. Existing business route URLs do not change. Tenant-scoped roles and self-service client administration are deferred.

Supabase Data API grants for application tables are revoked from `anon` and `authenticated`. Row Level Security is enabled with no public policies, so accidentally exposing the Data API does not expose rows. A source-controlled `ai_call_agent_runtime` NOLOGIN group role receives only required table/sequence privileges and explicit backend policies; deployment creates a secret-bearing LOGIN role and grants it membership. The trusted Express backend remains the only data-access path in this phase, and repository tests prove that every tenant-owned operation includes `client_id`.

### 4.5 Transactions and idempotency

- Creating a call and marking its customer called occurs in one transaction.
- Customer deletion relies on declared foreign-key cascade behavior for calls, feedback, and supervisor events and executes in one transaction.
- Call-derived feedback uses a unique non-null `call_id` constraint plus `INSERT ... ON CONFLICT`.
- Provider callbacks use a unique non-null `twilio_sid` and idempotent updates.
- External actions such as Twilio calls, WhatsApp, CRM, email, and AI requests never run inside database transactions.
- Post-call status fields remain recovery markers after interruption.
- The first production deployment remains one application replica because the scheduler and live-call map are process-local.

## 5. Schema and Index Direction

### 5.1 Supabase-managed `auth.users`

Supabase Auth stores password hashes, issues/verifies credentials, and owns authentication records. Application code never selects password hashes and never stores plaintext passwords. An Auth UUID is linked to `app_users.id`.

### 5.2 `app_users` and `app_user_roles`

`app_users`: `id uuid primary key references auth.users(id) on delete cascade`, `username`, `username_normalized`, `email`, `active`, `auth_version`, `last_login_at`, `created_at`, and `updated_at`.

`app_user_roles`: `user_id`, `role`, and `created_at`, with primary key `(user_id, role)`. The initial allowed role is `webmaster`.

Indexes and constraints:

- unique `app_users(username_normalized)`
- unique case-insensitive normalized email
- check that `auth_version >= 1`
- primary key `(user_id, role)` permits many users to hold `webmaster`; there is deliberately no unique webmaster or `initial_webmaster` constraint

Authorization always reloads `active`, `auth_version`, and roles from Postgres. User-editable Supabase metadata is never authoritative.

### 5.3 `clients`

Core fields: numeric `id`, unique `slug`, `name`, `status`, `timezone`, non-secret business metadata, and timestamps. Provider credentials never belong in this table.

Indexes: unique `slug`; `(status, name)`.

### 5.4 `customers`

Fields mirror the current customer table plus required `client_id`. Phone uniqueness changes from global to per-client: unique `(client_id, phone)`. Additional indexes cover `(client_id, priority_score desc, created_at desc)`, due retries, scheduled slots, and workflow status.

### 5.5 `calls`

Fields mirror the current calls table plus required `client_id`. Transcript remains text; analysis-related JSON-text columns become `jsonb`. Indexes cover unique non-null `twilio_sid`, `(client_id, customer_id, called_at desc)`, recent/date-range reporting, outcomes, and recoverable pipeline statuses. A check or application guard limits the complete persisted call payload to the approved 2 MiB application limit.

### 5.6 `feedback`

Core fields: numeric `id`, `client_id`, `customer_id`, nullable unique `call_id`, `review_text`, `category`, `stars`, `source`, and `submitted_at`. Indexes cover `(client_id, customer_id, submitted_at desc)` and `(client_id, submitted_at desc)`.

### 5.7 `call_supervisor_events`

Core fields: numeric `id`, `client_id`, `call_id`, `event_type`, `severity`, `payload jsonb`, and `created_at`. Indexes cover `(client_id, call_id, created_at desc)` and `(client_id, severity, created_at desc)`.

### 5.8 `application_state`

Core fields: nullable `client_id`, `key`, `value jsonb`, `version`, and `updated_at`. A null `client_id` denotes global state; non-null denotes tenant state. A `UNIQUE NULLS NOT DISTINCT (client_id, key)` constraint prevents duplicate scoped keys. Live audio/session state does not move here.

### 5.9 `agents`, `campaign_configurations`, and `support_tickets`

These tables establish ownership and constraints without adding new product workflows:

- `agents`: `client_id`, name, provider/model/voice/language/prompt version, status, timestamps.
- `campaign_configurations`: `client_id`, optional `agent_id`, name, status, schedule/retry policy as `jsonb`, script version, timestamps.
- `support_tickets`: `client_id`, optional customer/call references, title, description, status, priority, optional assignee user, timestamps.

All receive tenant-prefixed indexes. API keys and provider secrets remain deployment secrets.

### 5.10 Reporting

The reporting repository converts current SQLite queries to parameterized PostgreSQL. It uses joins and indexed date filters, returns existing field names, and keeps percentage/PDF formatting in application code. PostgreSQL `jsonb_array_elements_text` or small application reductions replace parsing JSON strings where necessary.

## 6. Authentication and Multiple Webmaster Provisioning

### 6.1 Login and session behavior

- `POST /auth/login` accepts the existing username/password shape.
- The server normalizes the username, loads its active `app_users` record, then asks Supabase Auth to verify the password using the linked email.
- Successful login creates the existing lean signed application cookie containing only `userId`, `authVersion`, `activeClientId`, and issue time. Supabase access/refresh tokens are not exposed to browser JavaScript.
- `GET /auth/session` reloads the user and roles and returns username, roles, active clients, and the selected client.
- `POST /auth/select-client` accepts an active client ID, verifies it through the clients repository, and updates only `activeClientId` in the signed session. It returns `404` for an absent/inactive client and never accepts a client identity from an unvalidated header.
- `POST /auth/logout` clears the cookie.
- Every protected request reloads the user and roles from Postgres. Deactivation or `auth_version` increment invalidates existing sessions.
- The cookie is `HttpOnly`, `Secure` in production, `SameSite=Lax`, path `/`, and fixed at eight hours without sliding renewal.
- Login is rate-limited and uses a uniform error response. State-changing browser requests require same-origin validation.
- Public Twilio routes remain outside session authentication and use Twilio signature validation.

### 6.2 Repeatable webmaster command

The deployment command is:

```text
npm run provision:webmaster -- --username <username> --email <email>
Password: <hidden TTY prompt or newline-terminated stdin>
```

Each invocation may create another webmaster. The command:

1. requires `SUPABASE_URL` and a server-only `SUPABASE_SERVICE_ROLE_KEY`;
2. normalizes and validates username and email;
3. accepts password only from a hidden prompt or stdin, never a CLI flag or environment variable;
4. enforces the configured minimum password length;
5. rejects an existing normalized username or email without altering it;
6. creates the Supabase Auth identity, `app_users` row, and `webmaster` role;
7. compensates by deleting the newly created Auth identity if application-profile creation fails;
8. prints only the created username and safe public user ID; and
9. clears password references and exits without leaving a reusable token.

There is no active-webmaster count restriction. Re-running with a different username/email creates a second or later webmaster. Re-running with an existing identity fails; it never resets a password or changes roles. Normal startup does not import or call the provisioning module.

No webmaster-management UI, invitations, or password-reset workflow is included in this cutover. Operators use the explicit provisioning command to add accounts.

## 7. Secrets, Health, and Logs

### 7.1 Required configuration

| Name | Secret | Runtime use |
| --- | --- | --- |
| `SUPABASE_DB_URL` | Yes | Least-privilege pooled Postgres connection |
| `SUPABASE_URL` | No | Supabase Auth endpoint |
| `SUPABASE_ANON_KEY` | No | Server-side password verification client |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase Auth portion of provisioning only; not normal app runtime |
| `COOKIE_SECRET` | Yes | Signed application session, at least 32 random bytes |

`DATABASE_URL`, `MONGODB_URI`, and `MONGODB_DB_NAME` are removed. Webmaster usernames and passwords are not startup configuration.

### 7.2 Security baseline

- Runtime database credentials use a deployment-created LOGIN role that belongs to the source-controlled `ai_call_agent_runtime` group role, has only required table/function/sequence permissions, and has no schema-owner or `BYPASSRLS` privileges.
- Tenant tables are unavailable through the public Data API roles.
- The service-role key is supplied only to the provisioning job and migration/deployment context, never to browser code or routine request handlers.
- TLS is required for database and Auth connections.
- Secrets remain in deployment-secret management, not source, images, logs, tables, or `.env.example` values.
- Logs redact credentials, cookies, authorization headers, full phone numbers, recordings, passwords, transcripts, and feedback text.
- Choose a Supabase region near the DigitalOcean production region before provisioning.

### 7.3 Health and structured logs

`GET /health` executes a bounded `SELECT 1` through the runtime pool. It returns `200` with `{"ok":true,"database":"up","timestamp":"..."}` on success and `503` with `{"ok":false,"database":"down","timestamp":"..."}` on failure. It never returns hostnames, connection strings, Supabase keys, stack traces, provider configuration, or tenant names.

A small logger emits one-line JSON with timestamp, level, event, request ID, and safe context. HTTP completion logs include method, route template, status, and duration. This is targeted hardening, not a broad telemetry rollout.

## 8. Ordered Implementation Scope

1. Characterize existing HTTP and workflow contracts with focused tests.
2. Add the local Supabase/Postgres test environment, source-controlled migrations, and runtime connection pool.
3. Create the relational schema, constraints, indexes, tenant columns, deny-by-default Data API posture, and seed/provisioning interfaces.
4. Implement focused repositories for customers, calls, feedback, supervisor events, reporting, clients, agents, campaign configurations, support tickets, and application state.
5. Replace active SQLite callers with repository and transaction operations while preserving routes and response shapes.
6. Add Supabase Auth login, signed application sessions, multiple-webmaster provisioning, and role enforcement.
7. Validate Twilio-controlled public entry points.
8. Add database-aware health, structured logs, configuration validation, and graceful shutdown.
9. Verify against a clean local Supabase stack and an empty non-production Supabase project.
10. Remove SQLite and every MongoDB-specific plan/configuration reference after acceptance.
11. Hand the verified Supabase-only application to the separate DigitalOcean production pipeline plan.

## 9. Testing and Acceptance Checklist

### Automated acceptance

- [ ] A clean Supabase reset creates all tables, foreign keys, constraints, indexes, roles/grants, and RLS configuration.
- [ ] Starting without required runtime configuration fails before listening and prints no secret values.
- [ ] An unreachable database prevents startup; a running app returns `503` during database loss and recovers to `200`.
- [ ] Startup never inserts, resets, or updates Auth users or `app_users`.
- [ ] Provisioning creates one webmaster with a Supabase Auth identity and application role, storing no plaintext password.
- [ ] A second invocation with different credentials creates a second active webmaster.
- [ ] Duplicate username/email attempts fail without changing the existing account.
- [ ] A partial provisioning failure removes the newly created orphan Auth identity.
- [ ] Both provisioned webmasters can log in independently; disabling one invalidates only that user’s session.
- [ ] Either webmaster can select either active client, and changing the selected client changes repository scope without changing business route URLs.
- [ ] Protected routes require a current active webmaster role; public health/auth and correctly signed Twilio callbacks remain reachable.
- [ ] Tenant-owned repository operations require `clientId`, and fixtures for one client never appear in another client’s queries or mutations.
- [ ] Customer CRUD/CSV, calls/callbacks, feedback, reports, and supervisor events retain current HTTP behavior and numeric IDs.
- [ ] Per-client phone uniqueness and global Twilio SID idempotency behave correctly.
- [ ] Reports match fixed fixtures for counts, averages, outcomes, slots, scripts, and joined customer fields.
- [ ] Logs remain valid JSON and exclude secrets, passwords, cookies, full phone numbers, transcripts, and feedback text.
- [ ] No runtime module imports `sqlite3`, `db.js`, MongoDB drivers, or MongoDB configuration after cleanup.

### Production cutover acceptance

- [ ] One production Supabase project exists in the selected nearby region with two intended client records.
- [ ] Runtime and provisioning secrets are separately scoped and absent from source, images, and logs.
- [ ] Source-controlled migrations have been applied exactly once and `/health` reports database up.
- [ ] At least two intended webmaster accounts can be provisioned without displaying or storing plaintext credentials.
- [ ] Each webmaster can log in and load the existing dashboard.
- [ ] One test customer and one end-to-end test call complete through status, transcript/analysis, feedback, and reporting.
- [ ] A restart preserves data and accounts while creating or resetting no users.
- [ ] The deployment artifact contains no SQLite or MongoDB fallback code.

## 10. Explicit Non-Goals

- Preserving, migrating, backing up, importing, or reconciling existing SQLite data.
- MongoDB Atlas, dual writes, change-data capture, generic SQL translation, or a database fallback.
- A Supabase project or database per tenant.
- Tenant-admin roles, customer-facing accounts, client self-service, invitations, MFA, SSO, or a webmaster-management UI.
- Restricting webmaster accounts to one account or one tenant; webmasters are platform-wide in this phase.
- Rewriting the dashboard, renaming business routes, or redesigning call/report workflows.
- Microservices, a job queue/cache, multiple app replicas, or distributed scheduler coordination.
- Storing audio, generated PDFs, or temporary recording files in Postgres or Supabase Storage.
- Point-in-time recovery, read replicas, multi-region failover, or an enterprise observability rollout.
- DigitalOcean provisioning, CI/CD, Nginx/TLS, firewall automation, or UAT infrastructure in this plan.

## 11. Remaining Deployment Decisions

1. Select the Supabase region nearest the eventual DigitalOcean production Droplet.
2. Supply the two production client names, slugs, and timezones before cutover provisioning.
3. Provide the canonical public HTTPS URL during the DigitalOcean phase so Twilio signature validation uses the URL Twilio signed.

No decision is needed about old SQLite data, MongoDB, or webmaster cardinality: SQLite data is discarded, MongoDB is not used, and multiple webmasters are explicitly supported.
