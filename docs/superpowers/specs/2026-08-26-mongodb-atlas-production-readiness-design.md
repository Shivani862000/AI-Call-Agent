# MongoDB Atlas Production-Readiness Design

**Date:** 2026-08-26
**Status:** Approved design for implementation
**Scope:** Replace SQLite with MongoDB Atlas and add the minimum authentication, deployment, health, and logging controls required for a lean production cutover.

## 1. Outcome

The application will remain one Node.js/Express deployable with the same dashboard, HTTP routes, call flows, reporting flows, and external integrations. MongoDB Atlas will become the only persistent application datastore. Route handlers and services will call purpose-built repositories and application-level data-access functions; they will not issue MongoDB queries directly, retain SQL strings, or use a generic SQL-to-Mongo compatibility layer.

The Atlas database starts empty. Existing `feedback.db` contents are deliberately discarded. There is no export, backup, import, dual-write period, or data reconciliation. After the Mongo-backed application passes its automated and isolated-Atlas acceptance checks, the SQLite module, dependency, and database-file configuration are removed before the separate DigitalOcean production-deployment phase. Any old server-side SQLite file or volume is deleted during the later production cutover without being read or copied.

This design intentionally avoids a multi-service architecture, a broad platform rewrite, and an enterprise migration program.

## 2. Approved Constraints

- MongoDB Atlas replaces SQLite completely for all persistent application data.
- Existing SQLite data is intentionally abandoned and must not be copied or backed up as part of this work.
- Existing HTTP paths, response behavior, admin UI, and business workflows remain compatible.
- MongoDB access is isolated behind repositories and named data-access operations.
- Authentication uses password hashes and roles stored in the MongoDB `users` collection.
- Server startup never creates a webmaster and never reads startup environment variables to create or overwrite webmaster credentials.
- A one-time deployment command creates the initial webmaster from an operator-supplied username and password. Only the hash is stored.
- The Atlas connection string and cookie-signing secret are deployment secrets.
- The production baseline is limited to Atlas network restrictions, deployment-secret management, a Mongo-aware health endpoint, and structured logs, plus the authentication controls necessary to protect the admin application.
- Cutover is direct and short. There is no long rollback, backup, migration, or dual-write plan.

## 3. Current-State Findings

### 3.1 Runtime and application shape

- `index.js` is a 1,700+ line entry point that builds the Express app, HTTP server, Twilio WebSocket bridge, scheduler, direct call endpoints, recent-call endpoints, recording/transcript endpoints, and startup sequence.
- Startup calls `validateConfig()`, opens SQLite through `initializeDatabase()`, starts a 15-second in-process scheduler, and only then listens for traffic.
- The dashboard is a static `public/admin.html` file served before any authentication middleware. It calls `/api/customers`, `/api/feedback`, `/api/calls/*`, and `/api/reports/*` directly.
- There is currently no login route, user model, session mechanism, role enforcement, or protected admin/API boundary. Project documentation also identifies authentication as absent.
- `GET /health` always returns `200` with application configuration metadata. It does not test the datastore.
- Logging uses free-form `console.log`/`console.error`. Some messages include phone numbers, provider URLs, or complete transcripts, so logs are neither structured nor consistently safe for production.
- `liveCallState` is an in-memory `Map`. It supports the live dashboard only and is lost on restart; it is not durable application state.
- Downloaded call recordings are temporary files under `/tmp/feedback-call-recordings`. Durable recording media remains at Twilio and must not be moved into MongoDB.
- No test suite, CI definition, container/deployment manifest, or production process definition is present in the repository.

### 3.2 Current persistence

`db.js` owns the SQLite connection, startup DDL, additive column migration logic, and three generic helpers: `dbRun`, `dbGet`, and `dbAll`. It creates five tables:

1. `customers`
2. `calls`
3. `feedback`
4. `app_state`
5. `call_supervisor_events`

`app_state` is defined but unused. The other four tables are accessed from `index.js`, active route modules, and service modules. SQL is embedded throughout call initiation, scheduling, callbacks, feedback extraction, post-call analysis, CRM sync, reporting, and customer management. Reporting relies on joins and SQL aggregates. Customer deletion manually deletes feedback and calls before the customer.

`routes/calls.js`, `routes/twiml.js`, and `routes/whatsapp.js` also contain SQL, but they are not mounted by the current `index.js`; equivalent active routes exist in `index.js`. Implementation must confirm they remain unused before deleting or converting them.

### 3.3 Compatibility that must be preserved

- Public application records currently expose numeric `id` values and snake_case fields such as `customer_id`, `called_at`, and `priority_score`.
- Dashboard JavaScript interpolates customer IDs as numbers in inline handlers. Replacing them directly with MongoDB ObjectId strings would break the current UI.
- Routes use numeric IDs in path parameters and return `lastID`-style identifiers after inserts.
- Business logic expects SQLite-style integer flags in several places and parses some JSON stored as text columns.
- Reports expect customer/call/feedback relationships and current customer names, not merely isolated documents.
- Scheduler eligibility depends on customer status, retry time, preferred/best slot, consent and DND flags, and whether a recent call exists.

### 3.4 Domains not yet implemented

There is no current persistent implementation for users, agents, clients, campaign configurations, or support tickets. The current agent prompt and client name are code/environment configuration, not database records. The target collections for these domains are included in this design, but adding new management UIs, APIs, or business workflows for them is not part of this cutover.

## 4. Target Architecture

### 4.1 Boundaries

The target remains a single Express application:

```text
Admin UI / Twilio callbacks / scheduler
                 |
          routes and workflows
                 |
   named repository/application operations
                 |
       one shared MongoClient + Atlas
```

The persistence layer has three responsibilities:

1. Establish and close the single process-wide MongoDB client.
2. Create/verify required indexes and expose collection handles.
3. Implement semantic operations such as `customers.findEligibleForScheduler()`, `calls.findRecentWithCustomers()`, `feedback.upsertForCall()`, and `reports.buildRangeSummary()`.

Routes retain validation, HTTP status mapping, and response formatting. Services retain call orchestration and external side effects. Repositories own MongoDB filters, updates, aggregation pipelines, transactions, BSON conversion, and duplicate-key interpretation. This replaces every `dbRun`/`dbGet`/`dbAll` call without teaching callers MongoDB syntax.

There will be no generic `query(sql, params)` facade, SQL parser, generic base repository, or route-by-route direct use of `collection.find()`.

### 4.2 Connection lifecycle

- `MONGODB_URI` is required and secret; `MONGODB_DB_NAME` is required configuration and is not secret.
- One `MongoClient` is created at startup with the driver defaults plus bounded server-selection/connect timeouts suitable for fast failure.
- Startup connects, performs a `ping`, and ensures indexes before the HTTP server begins listening. Failure exits non-zero without starting a partially usable server.
- SIGTERM/SIGINT stop the scheduler, stop accepting traffic, and close the shared client.
- Repositories receive a database/collection registry rather than importing or constructing clients themselves.
- Request handlers use driver operations with explicit projections and limits where the current route is bounded.

### 4.3 Stable identifiers and API mapping

MongoDB `_id` remains the internal ObjectId. Each API-visible domain document also has a unique integer `id`. Integers are allocated atomically with `findOneAndUpdate` counter documents in `application_state` (for example `_id: "counter:customers"`). Gaps are allowed; reuse is forbidden.

This choice preserves existing route parameters, dashboard interpolation, response bodies, and `lastID` behavior while avoiding a UI rewrite. Repository mappers keep existing snake_case response shapes. Within MongoDB:

- dates are BSON `Date`, not ISO strings;
- booleans are BSON booleans, not `0`/`1`;
- analyses, key points, objections, competitors, and event payloads are objects/arrays, not JSON strings;
- relationships use the stable integer fields (`customer_id`, `call_id`, `client_id`, and `agent_id`);
- mappers provide legacy integer flags or JSON-string fields only where current application code still requires them during the narrow refactor.

This transitional mapping belongs in repositories and can be simplified later without changing stored data or HTTP contracts.

### 4.4 Consistency and side effects

- Single-document state transitions use atomic update operators and return the updated document.
- Creating a call and marking its customer called should use a short transaction because both writes are local and jointly define initiation state.
- Customer deletion uses a short transaction to delete related feedback, calls, supervisor events, and the customer, preserving the current “delete related data” behavior.
- Feedback generated for a call is idempotent through a unique partial index on `call_id` and an upsert.
- Provider callbacks identify calls by unique `twilio_sid` and make repeat deliveries safe. External actions such as WhatsApp, CRM, email, and Twilio calls are not placed inside database transactions.
- Post-call processing remains a sequence of atomic status updates. Existing status fields are the recovery signal after a process interruption.
- The first production deployment is limited to one application replica because the scheduler and live-call map are process-local. Distributed scheduling/locking is explicitly deferred.

## 5. Collections and Data Modeling

All collections use collection-level JSON Schema validation for required identity, type, and enum fields while allowing known workflow fields to evolve. Validators should reject wrong BSON types but should not duplicate every route-level business rule.

### 5.1 `users`

Purpose: admin authentication and authorization.

Core fields: `id`, `username`, `username_normalized`, `password_hash`, `roles` (initially `["webmaster"]`), `active`, `auth_version`, `initial_webmaster`, `created_at`, `updated_at`, and nullable `last_login_at`.

Indexes:

- unique `{ username_normalized: 1 }`
- unique `{ id: 1 }`
- unique partial `{ initial_webmaster: 1 }` where `initial_webmaster` is `true`, preventing concurrent provisioning commands from creating two initial webmasters

Passwords, reset tokens, cookie values, and plaintext credentials must never appear in logs or any other collection.

### 5.2 `customers`

Purpose: the current customer record and call eligibility/workflow state.

Core fields mirror the current customer table, including contact details, slots, status, prioritization, language/dialect, DND/consent flags, retry state, sentiment summary, follow-ups, and revenue hints. Dates become BSON dates and flags become booleans. `client_id` is optional in this single-client cutover and reserved for later productization.

Indexes:

- unique `{ id: 1 }`
- unique `{ phone: 1 }` to retain current behavior
- `{ priority_score: -1, created_at: -1 }` for the dashboard list
- `{ status: 1, next_retry_at: 1 }` for due retry/callback work
- `{ status: 1, best_call_slot: 1, preferred_slot: 1 }` for scheduled-slot selection

Recent-call suppression is resolved by the calls repository after finding eligible customers, or by one aggregation with `$lookup`; it is not modeled as duplicated mutable state.

### 5.3 `calls`

Purpose: call lifecycle, provider identifiers, transcript/analysis results, recording references, outcome workflow, integration statuses, and supervisor summary state.

Core fields mirror the current calls table. JSON-text columns become nested values (`analysis`, `key_points`, `objections`, and `competitor_mentions`). The transcript remains text in the call document. MongoDB stores recording metadata/URLs only, never audio blobs or temporary local paths as durable assets.

Indexes:

- unique `{ id: 1 }`
- unique partial `{ twilio_sid: 1 }` where `twilio_sid` is a string
- `{ customer_id: 1, called_at: -1 }` for history and recent-call suppression
- `{ called_at: -1 }` for recent calls and date-range reports
- `{ outcome: 1, called_at: -1 }` for outcome reporting
- `{ transcript_status: 1, analysis_status: 1, called_at: 1 }` for recoverable pipeline work

Transcript and analysis payload sizes must be bounded at the application layer so an individual call cannot approach MongoDB’s document limit. The initial limit should be generous enough for the current 3–5 minute flow and reject pathological payloads before persistence.

### 5.4 `feedback`

Purpose: manual and call-derived feedback.

Core fields: `id`, `customer_id`, nullable `call_id`, `review_text`, `category`, `stars`, `source`, and `submitted_at`.

Indexes:

- unique `{ id: 1 }`
- unique partial `{ call_id: 1 }` where `call_id` is numeric
- `{ customer_id: 1, submitted_at: -1 }`
- `{ submitted_at: -1 }`

### 5.5 `supervisor_events`

Purpose: append-only call supervision events currently stored in `call_supervisor_events`.

Core fields: `id`, `call_id`, `event_type`, `severity`, `payload`, and `created_at`.

Indexes:

- unique `{ id: 1 }`
- `{ call_id: 1, created_at: -1 }`
- `{ severity: 1, created_at: -1 }`

The collection name changes at the repository boundary only; `/api/calls/:callId/supervisor-events` remains unchanged.

### 5.6 `application_state`

Purpose: small durable application metadata, beginning with public-ID counters. Each document uses a semantic string `_id`, a typed `value`, `version`, and `updated_at`. Optional `expires_at` supports future leases or temporary state and receives a TTL index only when that feature is introduced.

This collection does not replace `liveCallState` in this cutover. Live audio/session data remains ephemeral.

### 5.7 `clients`

Purpose: future persistent client/business profiles when the current environment/code-based client context becomes manageable data.

Direction: `id`, `name`, `status`, `timezone`, non-secret business metadata, and timestamps. Index unique `id` and `{ status: 1, name: 1 }`. Provider credentials do not belong here. The collection may be empty at cutover because no client-management workflow exists today.

### 5.8 `agents`

Purpose: future persistent voice-agent definitions.

Direction: `id`, optional `client_id`, `name`, `provider`, `model`, `voice`, `language`, `prompt_version`, `status`, and timestamps. Index unique `id` and `{ client_id: 1, status: 1 }`. API keys remain deployment secrets. The existing hard-coded prompt/provider selection continues until a separately approved workflow uses this collection.

### 5.9 `campaign_configurations`

Purpose: future persistent campaign scheduling, retry, agent, and script configuration.

Direction: `id`, optional `client_id`, optional `agent_id`, `name`, `status`, `schedule`, `retry_policy`, `script_version`, and timestamps. Index unique `id` and `{ client_id: 1, status: 1 }`. It is not a job queue and does not replace the current scheduler in this cutover.

### 5.10 `support_tickets`

Purpose: future persistent support/escalation cases distinct from append-only supervisor telemetry.

Direction: `id`, optional `client_id`, nullable `customer_id`/`call_id`, `title`, `description`, `status`, `priority`, nullable `assignee_user_id`, and timestamps. Index unique `id`, `{ status: 1, priority: -1, created_at: -1 }`, and `{ customer_id: 1, created_at: -1 }`. No support-ticket UI or route is added now.

### 5.11 Reports and joins

Current SQL report queries become a small set of MongoDB aggregation pipelines owned by a reporting repository. `$lookup` joins calls/feedback to customers so reports retain the latest customer name. `$match` on indexed date fields occurs before `$lookup`; projections keep transcripts and large analysis objects out of aggregate inputs unless required. Application code retains final percentage, label, and PDF formatting logic.

## 6. Authentication, Provisioning, and Security

### 6.1 Login and authorization

Add a minimal same-origin session flow while retaining all current business URLs:

- `POST /auth/login` accepts username/password and returns a secure signed session cookie after verifying the hash from `users`.
- `POST /auth/logout` clears the cookie.
- `GET /auth/session` returns the authenticated username and current roles for dashboard initialization.
- The cookie contains only a signed user identifier, issue/expiry times, and `auth_version`; it contains no password, password hash, or authority trusted without a database read.
- Every authenticated request reloads the user by ID and verifies `active`, `auth_version`, and roles from MongoDB. Role changes or account disabling therefore take effect immediately.
- The cookie is `HttpOnly`, `Secure` in production, `SameSite=Lax`, path `/`, and has a short fixed lifetime. `COOKIE_SECRET` must contain at least 32 random bytes and is never logged.
- Unknown usernames still perform a comparison against a fixed dummy hash to reduce username timing leakage. Login attempts receive a small per-IP rate limit suitable for the required single-replica deployment.
- Authenticated state-changing browser requests must pass a same-origin `Origin` check; Twilio webhook endpoints are excluded from this browser-only check and use provider validation instead.
- The initial role is `webmaster`. Authorization middleware must still accept required roles explicitly so future roles do not inherit access accidentally.

The login page, non-sensitive shared assets, auth endpoints, and `GET /health` remain public. Admin HTML, report/recording/transcript access, `/api/**`, `/call/start`, and other operator-triggered mutations require a valid webmaster session. Twilio callback/TwiML endpoints and the media-stream upgrade remain non-session endpoints because Twilio calls them; implementation must validate Twilio request signatures using the existing Twilio auth secret, the Twilio SDK helper, and the deployment’s canonical public URL. Twilio explicitly requires signature validation for both [webhooks](https://www.twilio.com/docs/usage/webhooks/webhooks-security) and [Media Streams](https://www.twilio.com/docs/voice/media-streams).

### 6.2 One-time webmaster command

Add an explicit deployment command with behavior equivalent to:

```text
npm run provision:webmaster -- --username <username>
Password: <read without echo from TTY or standard input>
```

The command:

1. connects using `MONGODB_URI` and `MONGODB_DB_NAME`;
2. normalizes and validates the username;
3. accepts the password only from a hidden prompt or standard input, never a command-line argument;
4. enforces a minimum length and hashes it in the application with bcrypt at cost 12;
5. inserts one active user with role `webmaster`;
6. exits non-zero if the username already exists or an active webmaster already exists;
7. logs only the created username and document/public ID; and
8. closes the database connection and clears password references before exit.

The command has no overwrite, upsert, or reset behavior. Normal `npm start` contains no provisioning call and ignores any `WEBMASTER_USERNAME`/`WEBMASTER_PASSWORD` variables if an operator mistakenly defines them. Password reset is a separate future operator capability, not startup behavior.

### 6.3 Secret and data handling

- Store `MONGODB_URI`, `COOKIE_SECRET`, Twilio tokens, AI-provider keys, SendGrid keys, and CRM credentials in the deployment platform’s secret manager. Do not bake them into images, manifests, `.env.example` values, logs, or MongoDB documents.
- Give the application a dedicated Atlas database user with `readWrite` only on the application database. Administrative Atlas credentials are not used by the app.
- Permit Atlas network access only from the production deployment’s fixed egress source or private network. Do not use `0.0.0.0/0` in production.
- Require TLS through the Atlas connection string and platform defaults.
- Structured logs must redact authorization/cookie headers, connection strings, provider credentials, full phone numbers, recordings, passwords, hashes, transcripts, and free-form feedback. Domain IDs and provider SIDs may be logged only in redacted/correlation-safe form.

## 7. Minimal Deployment Configuration and Operations

Required new configuration:

| Name | Secret | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | Atlas connection URI for the least-privilege application user |
| `MONGODB_DB_NAME` | No | Explicit production database name |
| `COOKIE_SECRET` | Yes | Session-cookie signing key, at least 32 random bytes |

`DATABASE_URL` is removed. Webmaster username/password are not startup configuration. Existing provider and public-URL settings remain as required by the current call flow.

### 7.1 Health

`GET /health` performs a bounded MongoDB `ping` on every check (or through a very short cache if platform polling becomes excessive):

- return `200` with `{"ok":true,"database":"up","timestamp":"..."}` when the process is running and MongoDB responds;
- return `503` with `{"ok":false,"database":"down","timestamp":"..."}` when the ping fails or times out;
- never return the URI, database host, credentials, stack trace, client name, model name, or public webhook URL.

The deployment platform routes traffic only after the endpoint returns `200`.

### 7.2 Structured logs

A small logger wrapper emits one-line JSON with `timestamp`, `level`, `event`, `request_id`, and safe context. HTTP completion logs include method, route template, status, and duration. Startup reports configuration presence, Mongo connection success, index readiness, scheduler state, and server readiness without values of secrets. Errors include a stable error code and stack only in server-side logs, after redaction.

This is a wrapper and targeted call-site cleanup, not adoption of a full telemetry stack.

### 7.3 Atlas and process baseline

- Use one Atlas project/cluster and one application database for this deployment.
- Apply indexes idempotently during deployment/startup before accepting traffic; index definitions live in source control.
- Run one application replica for the initial cutover because scheduler ownership and live-call state are process-local.
- Keep generated reports and downloaded recordings ephemeral. The database stores report inputs and recording references, not generated files.
- Configure graceful termination long enough to stop accepting new requests and close MongoDB cleanly; active external calls remain subject to the current provider callback recovery behavior.

### 7.4 Approved delivery sequence

The production host is an Ubuntu Droplet on DigitalOcean. Google Cloud will not remain in the target architecture. Delivery is intentionally split into two independently reviewed plans:

1. application production-readiness: MongoDB Atlas persistence, authentication/provisioning, health, structured logging, tests, and SQLite removal;
2. DigitalOcean production infrastructure and deployment pipeline.

Only the first plan is in progress. The production Droplet and its pipeline follow after the Mongo-backed application passes its local/integration acceptance suite. A second UAT Droplet and UAT pipeline are deferred until production deployment is complete and stable.

The application-readiness plan uses Node.js 24 LTS, an eight-hour fixed webmaster session with no sliding renewal, and a 2 MiB application limit for the complete call document. These conservative values can be changed later through explicit configuration/design work rather than left ambiguous in the first implementation.

## 8. Ordered Implementation Scope

This is the implementation order, not a request to implement the migration in this document task.

1. **Characterize existing contracts.** Add focused tests for customer CRUD/CSV behavior, call creation/callbacks, feedback upsert, recent calls, reports, health, and current response field shapes before changing persistence.
2. **Introduce Mongo infrastructure.** Add the MongoDB driver, connection lifecycle, collection registry, schema/index setup, BSON/value mappers, and atomic integer ID allocation in `application_state`.
3. **Build repositories by workflow.** Implement users, customers, calls, feedback, supervisor events, reporting, application state, clients, agents, campaign configurations, and support tickets repositories. For currently inactive domains, implement collection ownership/index setup and only the minimal create/find operations needed by provisioning or tests; do not add product features.
4. **Move active persistence callers.** Replace direct SQL in `index.js`, `routes/customers.js`, `routes/feedback.js`, `services/call-feedback.js`, `services/call-orchestration.js`, `services/post-call-pipeline.js`, `services/reporting.js`, and `services/crm-sync.js` with semantic repository/application operations. Convert or remove the three unmounted legacy route modules after confirming they have no runtime consumers.
5. **Add authentication and provisioning.** Add login/logout/session routes, webmaster authorization middleware, protected static/admin boundaries, signed cookie handling, login throttling, Mongo-backed user checks, and the one-time non-overwriting provisioning command.
6. **Harden public provider entry points.** Keep Twilio-required endpoints public but validate provider signatures; retain the same callback URLs and call behavior.
7. **Add production health and logs.** Make `/health` Mongo-aware, add structured request/domain logs, and remove sensitive/free-form console output.
8. **Verify locally and in a non-production Atlas database.** Run unit, repository integration, route compatibility, provisioning, authentication, index, health, and reporting tests against an isolated empty database.
9. **Remove SQLite after application acceptance.** Delete `db.js`, remove `sqlite3` and `DATABASE_URL`, and remove SQLite migration code and repository files so the deployment artifact has no fallback datastore.
10. **Perform direct production cutover in the separate DigitalOcean plan.** Create the restricted Atlas user/network rule and deployment secrets, deploy the Mongo-only app against an empty database, run the webmaster provisioning command once, log in, create one test customer, and complete one test call through transcript/feedback/report visibility. Delete any old server-side SQLite file or volume without reading or copying it.

If validation fails, stop and fix the Mongo-backed application. Do not restore SQLite, copy old data, or add dual-write as an improvised rollback.

## 9. Testing and Acceptance Checklist

### Automated acceptance

- [ ] A clean database initializes all required collections, validators, indexes, and counter state without SQLite present.
- [ ] Starting the server without `MONGODB_URI`, `MONGODB_DB_NAME`, or `COOKIE_SECRET` fails before listening and does not print secret values.
- [ ] Starting with unreachable MongoDB fails fast; a running app returns `503` from `/health` when connectivity is lost and returns `200` after connectivity recovers.
- [ ] Startup never inserts or updates a user, regardless of webmaster-like environment variables.
- [ ] Provisioning creates exactly one active webmaster, stores a bcrypt hash rather than plaintext, and rejects duplicate usernames or a second active initial webmaster.
- [ ] Login accepts the provisioned password, rejects a wrong password, sets the required cookie attributes, and reloads authorization from MongoDB.
- [ ] Logout clears the session; disabled users and incremented `auth_version` values invalidate existing cookies.
- [ ] Protected admin/API/report/recording/transcript/call-start routes reject unauthenticated requests. Health, auth entry points, and correctly signed Twilio callbacks remain reachable.
- [ ] Customer create/read/update/delete, CSV import, workflow updates, retry scheduling, DND enforcement, and unique-phone errors preserve current HTTP behavior and numeric IDs.
- [ ] Call initiation and callbacks are idempotent for a repeated Twilio SID and keep customer/call state consistent.
- [ ] Manual and call-derived feedback retain one feedback document per call and preserve list/report output.
- [ ] Recent-call, daily, and weekly report results match fixed fixtures for counts, ratings, outcomes, slots, scripts, and joined customer fields.
- [ ] Supervisor events remain ordered newest-first and are deleted with their parent customer/calls.
- [ ] Structured logs are valid JSON and test fixtures prove secrets, passwords, hashes, cookies, full phone numbers, transcripts, and feedback text are absent.
- [ ] No runtime module imports `sqlite3`, `db.js`, `dbRun`, `dbGet`, or `dbAll` after cleanup.

### Production cutover acceptance

- [ ] Atlas only permits the intended deployment network path and the app user is scoped to the one database.
- [ ] Deployment secrets are present in the platform secret manager and absent from source, image layers, and logs.
- [ ] `/health` reports MongoDB up before traffic is enabled.
- [ ] The one-time command provisions the intended webmaster without displaying or storing plaintext.
- [ ] The webmaster can log in and the existing dashboard loads customers, calls, feedback, and reports.
- [ ] One new test customer can be created and called; the call status, recording reference, transcript/analysis, feedback, and report data appear through the existing workflow.
- [ ] A restart preserves MongoDB data and authentication while recreating no users.
- [ ] SQLite code, dependency, database-file configuration, and fallback paths are absent from the deployment artifact; the later DigitalOcean cutover deletes any old server-side SQLite file or volume without reading it.

## 10. Explicit Non-Goals

- Exporting, backing up, importing, transforming, validating, or retaining existing SQLite data.
- Dual writes, change-data capture, long canary operation, or a generic SQL compatibility layer.
- A complex rollback system or continued SQLite fallback.
- Rewriting the admin UI, renaming current routes, or redesigning call/report workflows.
- Splitting the application into microservices or introducing a separate job queue/cache.
- Multi-region, multi-cluster, multi-replica scheduler coordination, or zero-downtime enterprise rollout.
- Full multi-tenant isolation or new client/agent/campaign/support-ticket management features.
- Storing call audio, generated PDFs, or temporary recording files in MongoDB.
- A broad observability platform, SIEM rollout, audit warehouse, or analytics redesign.
- Password reset, invitations, MFA, SSO, or a general user-administration UI in this first cutover.
- Refactoring unrelated Twilio, AI, PDF, email, CRM, or dashboard behavior.

## 11. Risks and Decisions Still Needed

These are bounded deployment/implementation choices; none changes the approved architecture.

1. **Atlas region/tier and deployment egress:** choose the Atlas region near the application and identify the fixed egress IP or private-network mechanism required for the allowlist. This is required before deployment configuration can be finalized.
2. **Canonical public URL behind proxies:** provide the exact externally visible HTTPS base URL and trusted-proxy behavior during the later DigitalOcean plan so Twilio signature validation uses the same URL Twilio signed.

No decision is needed about the old SQLite data: it is intentionally discarded.
