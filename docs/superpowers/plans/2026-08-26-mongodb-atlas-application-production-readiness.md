# MongoDB Atlas Application Production-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing AI Call Agent application production-ready at the application boundary by replacing SQLite with an empty MongoDB Atlas database, adding Mongo-backed webmaster authentication/provisioning, and adding database-aware health, structured logs, and verification.

**Architecture:** Keep the current single-process Express/HTTP/WebSocket application and its existing routes, UI, and call workflows. Replace generic SQL helpers with focused MongoDB repositories backed by one shared `MongoClient`; preserve numeric public IDs and current snake_case HTTP payloads through explicit mappers. Authentication uses a signed cookie whose user and role are reloaded from MongoDB on every request.

**Tech Stack:** Node.js 24 LTS, Express, MongoDB Node.js driver, MongoDB Atlas, bcryptjs, cookie-session, express-rate-limit, Node's built-in test runner, Supertest, mongodb-memory-server replica set.

**Spec:** `docs/superpowers/specs/2026-08-26-mongodb-atlas-production-readiness-design.md`

## Global Constraints

- Start MongoDB Atlas empty and deliberately discard all existing SQLite data; do not export, back up, import, dual-write, or reconcile it.
- MongoDB Atlas is the only persistent application datastore. Do not run MongoDB or SQLite on the application server.
- Preserve existing HTTP paths, status behavior, dashboard workflows, numeric `id` values, and snake_case response fields.
- Do not add a generic SQL translator, generic query facade, or direct MongoDB calls in routes/services.
- Server startup must never create, recreate, reset, or overwrite a webmaster.
- The one-time provisioning command must accept the password through a hidden prompt or stdin, hash it in the application, and store no plaintext.
- `MONGODB_URI` and `COOKIE_SECRET` are secrets. Logs and error responses must not expose them or other credentials/PII/transcripts.
- Keep the first deployment at one application replica because scheduler and live-call ownership remain process-local.
- Google Cloud is out of scope and must not be introduced.
- DigitalOcean Droplet creation, Docker packaging, CI/CD, Nginx/TLS, firewall automation, and the UAT environment are a separate follow-on plan.
- Pin the application runtime to Node.js 24 LTS (`>=24 <25`) in development, tests, and the later production container.
- Use test-driven development for every behavior change and make one focused commit per task.

## Planned File Structure

### New runtime modules

- `config/runtime-config.js` — validates and returns runtime configuration without exposing secret values.
- `persistence/mongo.js` — owns `MongoClient` connect, ping, and close lifecycle.
- `persistence/collections.js` — collection names, validators, and idempotent index creation.
- `persistence/id-sequence.js` — atomic numeric public-ID allocation in `application_state`.
- `persistence/mappers.js` — BSON/native-value to legacy HTTP/application shape conversion.
- `repositories/index.js` — constructs repositories from one MongoDB handle.
- `repositories/users.js` — user lookup, creation, login timestamp, and auth-version access.
- `repositories/customers.js` — customer CRUD, scheduler eligibility, and transactional cascade deletion.
- `repositories/calls.js` — call CRUD/state transitions, history, callback idempotency, and recent-call joins.
- `repositories/feedback.js` — manual creation, call upsert, and joined feedback listing.
- `repositories/supervisor-events.js` — append and newest-first lookup.
- `repositories/reporting.js` — date-range aggregation pipelines used by daily/weekly reporting.
- `repositories/clients.js`, `repositories/agents.js`, `repositories/campaign-configurations.js`, `repositories/support-tickets.js` — minimal ownership for approved but currently inactive collections.
- `auth/session.js` — signed-cookie configuration and same-origin checks.
- `auth/middleware.js` — Mongo-backed authentication and role enforcement.
- `routes/auth.js` — login, logout, and session endpoints.
- `scripts/provision-webmaster.js` — one-time non-overwriting webmaster creation.
- `logging/logger.js` — one-line structured JSON logging with redaction.
- `middleware/request-context.js` — request IDs and completion logs.
- `middleware/twilio-validation.js` — official-SDK validation for public Twilio HTTP and WebSocket entry points.
- `public/login.html` — minimal webmaster login page matching the existing dashboard styling.

### New tests

- `tests/helpers/mongo-test-context.js`
- `tests/helpers/test-config.js`
- `tests/persistence/mongo.test.js`
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

### Existing files modified or removed

- Modify `package.json`, `package-lock.json`, `.env.example`, `README.md`, `index.js`, `public/admin.html`, active routes, and persistence-consuming services.
- Delete `db.js` and the unmounted SQL-backed `routes/calls.js`, `routes/twiml.js`, and `routes/whatsapp.js` after active equivalents are covered by tests.
- Remove the `sqlite3` dependency and all `DATABASE_URL` references.

---

### Task 1: Establish the MongoDB test harness and dependency baseline

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/helpers/mongo-test-context.js`
- Create: `tests/helpers/test-config.js`
- Create: `tests/persistence/mongo.test.js`

**Interfaces:**
- Produces: `withTestMongo(testFn)` and `makeTestConfig(overrides)` for all later tests.
- Produces: failing imports for `connectMongo`, `pingMongo`, `closeMongo`, `ensureCollections`, and `nextId` that Task 2 implements.

- [ ] **Step 1: Install runtime and test dependencies**

Run:

```bash
npm install mongodb bcryptjs cookie-session express-rate-limit
npm install --save-dev supertest mongodb-memory-server
```

Add scripts and an engine floor to `package.json`:

```json
"engines": { "node": ">=24 <25" },
"scripts": {
  "start": "node index.js",
  "dev": "node index.js",
  "test": "node --test --test-concurrency=1",
  "provision:webmaster": "node scripts/provision-webmaster.js"
}
```

- [ ] **Step 2: Create the replica-set MongoDB test helper**

Create `tests/helpers/mongo-test-context.js` with this exported contract:

```js
const { MongoClient } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

async function withTestMongo(run) {
  if (process.env.MONGODB_TEST_URI) {
    const dbName = process.env.MONGODB_TEST_DB_NAME;
    if (!dbName || !dbName.endsWith('_test')) {
      throw new Error('MONGODB_TEST_DB_NAME must end with _test');
    }
    try {
      return await run({ uri: process.env.MONGODB_TEST_URI, dbName });
    } finally {
      const cleanupClient = new MongoClient(process.env.MONGODB_TEST_URI);
      await cleanupClient.connect();
      await cleanupClient.db(dbName).dropDatabase();
      await cleanupClient.close();
    }
  }

  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  const dbName = `ai_call_agent_test_${Date.now()}`;

  try {
    return await run({ uri, dbName });
  } finally {
    await replSet.stop();
  }
}

module.exports = { withTestMongo };
```

Create `tests/helpers/test-config.js` with non-secret test defaults and no real provider credentials:

```js
function makeTestConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    port: 0,
    publicBaseUrl: 'https://example.test',
    cookieSecret: 'test-only-cookie-secret-at-least-32-bytes',
    sessionMaxAgeMs: 8 * 60 * 60 * 1000,
    twilioValidateSignatures: false,
    ...overrides
  };
}

module.exports = { makeTestConfig };
```

- [ ] **Step 3: Write the failing Mongo lifecycle/sequence tests**

Create `tests/persistence/mongo.test.js` covering ping, required collections/indexes, and concurrent ID allocation. The concurrency assertion must be exact:

```js
const ids = await Promise.all(
  Array.from({ length: 25 }, () => nextId(db, 'customers'))
);
assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
```

Also assert collection names exactly equal:

```js
[
  'users', 'customers', 'calls', 'feedback', 'agents', 'clients',
  'campaign_configurations', 'support_tickets', 'supervisor_events',
  'application_state'
]
```

- [ ] **Step 4: Run the tests and verify they fail for the missing persistence modules**

Run: `npm test -- tests/persistence/mongo.test.js`
Expected: FAIL with `Cannot find module '../../persistence/mongo'`.

- [ ] **Step 5: Commit the harness**

```bash
git add package.json package-lock.json tests/helpers tests/persistence/mongo.test.js
git commit -m "test: add MongoDB integration harness"
```

### Task 2: Implement MongoDB lifecycle, schema, indexes, IDs, and mappings

**Files:**
- Create: `persistence/mongo.js`
- Create: `persistence/collections.js`
- Create: `persistence/id-sequence.js`
- Create: `persistence/mappers.js`
- Test: `tests/persistence/mongo.test.js`

**Interfaces:**
- Produces: `connectMongo({ uri, dbName, logger }) -> { client, db }`.
- Produces: `pingMongo(db) -> Promise<boolean>` and `closeMongo(client) -> Promise<void>`.
- Produces: `ensureCollections(db) -> Promise<void>`.
- Produces: `nextId(db, sequenceName, options?) -> Promise<number>`.
- Produces: `toApiCustomer`, `toApiCall`, `toApiFeedback`, and `toApiSupervisorEvent`.

- [ ] **Step 1: Implement connection lifecycle**

Create `persistence/mongo.js` with one client per call and no global fallback:

```js
const { MongoClient } = require('mongodb');

async function connectMongo({ uri, dbName, logger = console }) {
  if (!uri) throw new Error('MONGODB_URI is required');
  if (!dbName) throw new Error('MONGODB_DB_NAME is required');

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000
  });
  await client.connect();
  const db = client.db(dbName);
  await db.command({ ping: 1 });
  logger.info?.('mongodb.connected', { database: dbName });
  return { client, db };
}

async function pingMongo(db) {
  try {
    await db.command({ ping: 1, maxTimeMS: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function closeMongo(client) {
  if (client) await client.close();
}

module.exports = { connectMongo, pingMongo, closeMongo };
```

- [ ] **Step 2: Implement atomic public IDs**

Create `persistence/id-sequence.js`:

```js
async function nextId(db, sequenceName, { session } = {}) {
  const document = await db.collection('application_state').findOneAndUpdate(
    { _id: `counter:${sequenceName}` },
    {
      $inc: { value: 1, version: 1 },
      $set: { updated_at: new Date() },
      $setOnInsert: { created_at: new Date() }
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: false, session }
  );
  return document.value;
}

module.exports = { nextId };
```

- [ ] **Step 3: Implement validators and the exact indexes from the spec**

In `persistence/collections.js`, define a `COLLECTIONS` constant for all ten names, create missing collections with `$jsonSchema`, use `collMod` for existing clean-environment collections, and call `createIndexes()` idempotently. Include at minimum:

```js
await db.collection('users').createIndexes([
  { key: { id: 1 }, unique: true, name: 'users_id_unique' },
  { key: { username_normalized: 1 }, unique: true, name: 'users_username_unique' },
  { key: { initial_webmaster: 1 }, unique: true, partialFilterExpression: { initial_webmaster: true }, name: 'users_initial_webmaster_unique' }
]);

await db.collection('customers').createIndexes([
  { key: { id: 1 }, unique: true, name: 'customers_id_unique' },
  { key: { phone: 1 }, unique: true, name: 'customers_phone_unique' },
  { key: { priority_score: -1, created_at: -1 }, name: 'customers_priority_created' },
  { key: { status: 1, next_retry_at: 1 }, name: 'customers_retry_due' },
  { key: { status: 1, best_call_slot: 1, preferred_slot: 1 }, name: 'customers_scheduled_slot' }
]);

await db.collection('calls').createIndexes([
  { key: { id: 1 }, unique: true, name: 'calls_id_unique' },
  { key: { twilio_sid: 1 }, unique: true, partialFilterExpression: { twilio_sid: { $type: 'string' } }, name: 'calls_twilio_sid_unique' },
  { key: { customer_id: 1, called_at: -1 }, name: 'calls_customer_called' },
  { key: { called_at: -1 }, name: 'calls_called_at' },
  { key: { outcome: 1, called_at: -1 }, name: 'calls_outcome_called' },
  { key: { transcript_status: 1, analysis_status: 1, called_at: 1 }, name: 'calls_pipeline_status' }
]);
```

Add these remaining exact indexes:

- `feedback`: unique `{ id: 1 }`; unique partial numeric `{ call_id: 1 }`; `{ customer_id: 1, submitted_at: -1 }`; `{ submitted_at: -1 }`.
- `supervisor_events`: unique `{ id: 1 }`; `{ call_id: 1, created_at: -1 }`; `{ severity: 1, created_at: -1 }`.
- `clients`: unique `{ id: 1 }`; `{ status: 1, name: 1 }`.
- `agents`: unique `{ id: 1 }`; `{ client_id: 1, status: 1 }`.
- `campaign_configurations`: unique `{ id: 1 }`; `{ client_id: 1, status: 1 }`.
- `support_tickets`: unique `{ id: 1 }`; `{ status: 1, priority: -1, created_at: -1 }`; `{ customer_id: 1, created_at: -1 }`.

Validators require `id` as an integer for domain records, BSON dates for timestamps, booleans for flags, arrays for roles/key-points/objections/competitors, objects for analysis/payload/schedule/retry policy, and the spec's required identity fields. `application_state` uses a semantic string `_id`, numeric `value`/`version`, and BSON dates. Do not create a TTL index until an expiring application-state feature exists.

- [ ] **Step 4: Implement explicit API mappers**

`persistence/mappers.js` must remove `_id`, serialize BSON dates through JSON normally, and convert these stored booleans to `0`/`1` for compatibility: customer DND/wrong-number/admin-review flags and all existing call boolean flags. Convert native `analysis`, `key_points`, `objections`, and `competitor_mentions` into the current `*_json` response fields only at the HTTP boundary.

- [ ] **Step 5: Run lifecycle tests**

Run: `npm test -- tests/persistence/mongo.test.js`
Expected: PASS, including 25 unique sequential IDs and all ten collection names.

- [ ] **Step 6: Commit infrastructure**

```bash
git add persistence tests/persistence/mongo.test.js
git commit -m "feat: add MongoDB persistence foundation"
```

### Task 3: Replace customer SQL with a customer repository

**Files:**
- Create: `repositories/customers.js`
- Create: `repositories/index.js`
- Create: `tests/repositories/customers.test.js`
- Create: `tests/routes/customers-feedback.test.js`
- Modify: `routes/customers.js`
- Modify: `index.js:449-636`

**Interfaces:**
- Produces: `createRepositories({ db, client }) -> { users, customers, calls, feedback, supervisorEvents, reporting, clients, agents, campaignConfigurations, supportTickets }`.
- Produces: `createCustomersRepository({ db, client, nextId })` with `create`, `findById`, `findByPhone`, `list`, `update`, `updateWorkflow`, `scheduleRetry`, `findEligibleForScheduler`, and `deleteWithRelations`.
- `deleteWithRelations(id)` returns `false` when absent and `true` after deleting the customer, calls, feedback, and supervisor events in one transaction.
- `findEligibleForScheduler({ slot, now, recentMinutes })` returns native customer documents ordered by priority.

- [ ] **Step 1: Write repository contract tests**

Cover defaults, numeric IDs, unique phone errors, list ordering, workflow booleans, retry count/date, slot/retry eligibility, 45-minute recent-call suppression, and transactional cascade deletion. Assert the duplicate error is normalized to:

```js
assert.equal(error.code, 'CUSTOMER_PHONE_EXISTS');
```

- [ ] **Step 2: Run the customer tests and verify the repository import fails**

Run: `npm test -- tests/repositories/customers.test.js`
Expected: FAIL with missing `repositories/customers`.

- [ ] **Step 3: Implement the repository with native MongoDB types**

Use `nextId(db, 'customers')`, BSON dates, BSON booleans, `$set`, and `$inc`. `findEligibleForScheduler` must use one aggregation that filters blocked customers, evaluates pending slot/retry conditions, performs a `$lookup` into calls newer than the cutoff, excludes matches, and sorts `{ priority_score: -1, created_at: -1 }`.

Implement deletion with the existing Mongo client session:

```js
await session.withTransaction(async () => {
  const calls = await db.collection('calls').find({ customer_id: id }, { session, projection: { id: 1 } }).toArray();
  const callIds = calls.map((call) => call.id);
  await db.collection('supervisor_events').deleteMany({ call_id: { $in: callIds } }, { session });
  await db.collection('feedback').deleteMany({ customer_id: id }, { session });
  await db.collection('calls').deleteMany({ customer_id: id }, { session });
  await db.collection('customers').deleteOne({ id }, { session });
});
```

- [ ] **Step 4: Rewire customer routes and scheduler helpers**

Change `routes/customers.js` to export `createCustomersRouter({ customers })`; keep validation and response text in the router. Replace `ensureCustomerForCall`, `getCustomerCallHistory` customer reads, `hydratePreCallIntelligence` updates, and scheduler eligibility SQL in `index.js` with repository calls. Do not expose `db` or collection handles to the router.

- [ ] **Step 5: Run customer tests and route smoke tests**

Mount `createCustomersRouter({ customers })` under `/api/customers` in a minimal Express/Supertest fixture. Assert the current create/list/get/update/workflow/retry/delete paths, status codes, messages, numeric IDs, and duplicate-phone `fieldErrors.phone` response.

Run: `npm test -- tests/repositories/customers.test.js tests/routes/customers-feedback.test.js`
Expected: PASS.

- [ ] **Step 6: Commit customer persistence**

```bash
git add repositories/customers.js repositories/index.js routes/customers.js index.js tests/repositories/customers.test.js
git commit -m "feat: move customers to MongoDB repository"
```

### Task 4: Replace call, feedback, and supervisor-event SQL

**Files:**
- Create: `repositories/calls.js`
- Create: `repositories/feedback.js`
- Create: `repositories/supervisor-events.js`
- Create: `tests/repositories/calls-feedback.test.js`
- Modify: `repositories/index.js`
- Modify: `routes/feedback.js`
- Modify: `index.js`
- Modify: `services/call-orchestration.js`
- Modify: `services/call-feedback.js`
- Modify: `services/post-call-pipeline.js`
- Modify: `services/crm-sync.js`

**Interfaces:**
- Produces: `calls.create`, `calls.createAndMarkCustomer`, `calls.findById`, `calls.findByTwilioSid`, `calls.updateById`, `calls.listHistoryForCustomer`, `calls.listRecentWithCustomers`, and `calls.findTranscriptWithCustomer`.
- Produces: `feedback.createManual`, `feedback.findByCallId`, `feedback.upsertForCall`, and `feedback.listWithCustomers`.
- Produces: `supervisorEvents.create({ callId, eventType, severity, payload })` and `supervisorEvents.listByCallId(callId, limit)`.
- Changes service injection to `{ repositories, ... }`; no service accepts `dbRun`, `dbGet`, or `dbAll`.

- [ ] **Step 1: Add failing call/event repository tests**

Test numeric IDs, unique non-null Twilio SID, atomic call/customer transition, callback-safe updates, descending history/recent lists, `$lookup` customer fields, native nested analysis arrays/objects, the 2 MiB complete-call-document limit, newest-first supervisor events, one call-derived feedback record after repeated upserts, and joined manual-feedback listing.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm test -- tests/repositories/calls-feedback.test.js`
Expected: FAIL with missing `repositories/calls`.

- [ ] **Step 3: Implement calls, feedback, and supervisor events**

`calls.createAndMarkCustomer` must allocate the call ID and execute the call insert plus customer status update in one transaction. `calls.updateById(id, patch)` must whitelist existing call fields, convert known date fields to `Date`, preserve native booleans/arrays/objects, and reject unknown keys with `code: 'INVALID_CALL_PATCH'`. Before insert/update, use `BSON.calculateObjectSize(candidate)` and reject documents larger than `2 * 1024 * 1024` bytes with `code: 'CALL_DOCUMENT_TOO_LARGE'`.

`calls.listRecentWithCustomers(25)` and `calls.findTranscriptWithCustomer(id)` use `$lookup`/`$unwind` and return fields matching the existing `/api/calls/recent` and transcript handlers. `feedback.upsertForCall` uses one `findOneAndUpdate` with `upsert: true`; the unique partial `call_id` index is the concurrency guard. `feedback.listWithCustomers` retains `customer_name` and newest-first ordering.

- [ ] **Step 4: Rewire active call paths**

Replace call SQL in `index.js` and feedback SQL in `routes/feedback.js` with repository calls. Export `createFeedbackRouter({ customers, feedback })`. Change these exact service signatures:

```js
saveCallFeedbackFromTranscript({ repositories, callSid, customerId, transcript, overwriteExisting = false })
processCompletedCallPipeline({ repositories, callSid })
applyCallOutcomeWorkflow({ repositories, callRecord, customer, providerStatus, inferredOutcome })
createSupervisorEvent({ supervisorEvents, callId, eventType, severity = 'info', payload = {} })
syncCallToCrm({ repositories, callId })
```

Update all callers in the same task so no mixed SQL/repository call path remains.

Update native-value handling in these services: use arrays/objects directly for analysis, key points, objections, competitors, and supervisor payloads; use `Array.isArray` when accepting old-shaped test fixtures during the refactor.

Extend `tests/routes/customers-feedback.test.js` with the current `POST /api/feedback/manual` and `GET /api/feedback` paths, including field errors, missing customer, numeric feedback ID, category response, and joined `customer_name`.

- [ ] **Step 5: Run call/event tests and syntax checks**

Run: `npm test -- tests/repositories/calls-feedback.test.js`
Expected: PASS.
Run: `node --check index.js`
Expected: exit 0.

- [ ] **Step 6: Commit call persistence**

```bash
git add repositories/calls.js repositories/feedback.js repositories/supervisor-events.js repositories/index.js routes/feedback.js index.js services/call-feedback.js services/call-orchestration.js services/post-call-pipeline.js services/crm-sync.js tests/repositories/calls-feedback.test.js tests/routes/customers-feedback.test.js
git commit -m "feat: move call and feedback workflows to MongoDB"
```

### Task 5: Replace reporting SQL

**Files:**
- Create: `repositories/reporting.js`
- Create: `tests/repositories/reporting.test.js`
- Modify: `repositories/index.js`
- Modify: `routes/reports.js`
- Modify: `services/reporting.js`

**Interfaces:**
- Produces: `reporting.buildRangeData({ start, end })` containing `callStats`, `feedbackStats`, `feedbackList`, `analyzedCalls`, `pendingItems`, `peakSlots`, and `scriptPerformance`.
- Produces: `createReportsRouter({ reporting, generateReportPDF, sendEmailWithAttachment, sendSimpleEmail })`.

- [ ] **Step 1: Add failing report fixture tests**

Seed fixed BSON dates and assert exact totals, average rating rounded by application code, outcome counts, five-minute slot strings, script averages, pending items, and current customer names from `$lookup`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- tests/repositories/reporting.test.js`
Expected: FAIL because the new repositories are missing.

- [ ] **Step 3: Implement reporting pipelines and keep formatting in the service**

Move `$match`, counts, conditional sums, averages, `$lookup`, grouping, sorting, projection, and limits into `repositories/reporting.js`. Keep `success_rate`, objection/competitor counting, report links, summary text, and weekly narrative construction in `services/reporting.js`.

- [ ] **Step 4: Rewire report callers**

Export `createReportsRouter({ reporting, generateReportPDF, sendEmailWithAttachment, sendSimpleEmail })` and inject the reporting repository into `buildReportData`/`buildWeeklySummary`. Remove SQL/JSON-text assumptions from reporting; native arrays must be handled with `Array.isArray`.

- [ ] **Step 5: Run report tests**

Run: `npm test -- tests/repositories/reporting.test.js`
Expected: PASS.

- [ ] **Step 6: Commit report persistence**

```bash
git add repositories/reporting.js repositories/index.js routes/reports.js services/reporting.js tests/repositories/reporting.test.js
git commit -m "feat: move reports to MongoDB aggregation"
```

### Task 6: Add ownership for approved inactive collections

**Files:**
- Create: `repositories/clients.js`
- Create: `repositories/agents.js`
- Create: `repositories/campaign-configurations.js`
- Create: `repositories/support-tickets.js`
- Create: `tests/repositories/catalogs.test.js`
- Modify: `repositories/index.js`

**Interfaces:**
- Each repository produces `create(document)` and `findById(id)` only.
- `supportTickets` additionally produces `listOpen({ limit = 50 })`.
- None of these repositories is exposed through a new HTTP route or UI in this phase.

- [ ] **Step 1: Write failing minimal contract tests**

For each collection, assert numeric IDs, BSON timestamps, `findById`, and the spec's required relationship/status fields. Assert support tickets order by priority descending then creation descending.

- [ ] **Step 2: Run and verify missing-module failures**

Run: `npm test -- tests/repositories/catalogs.test.js`
Expected: FAIL on the first missing repository module.

- [ ] **Step 3: Implement four focused repositories**

Each `create` method must whitelist its collection's fields, allocate its own sequence (`clients`, `agents`, `campaign_configurations`, or `support_tickets`), set `created_at`/`updated_at`, and return the inserted document. Do not share a generic CRUD base and do not add update/delete behavior that has no consumer.

- [ ] **Step 4: Run catalog tests**

Run: `npm test -- tests/repositories/catalogs.test.js`
Expected: PASS.

- [ ] **Step 5: Commit collection ownership**

```bash
git add repositories/clients.js repositories/agents.js repositories/campaign-configurations.js repositories/support-tickets.js repositories/index.js tests/repositories/catalogs.test.js
git commit -m "feat: define MongoDB domain collection ownership"
```

### Task 7: Add Mongo-backed authentication and one-time provisioning

**Files:**
- Create: `repositories/users.js`
- Create: `auth/session.js`
- Create: `auth/middleware.js`
- Create: `routes/auth.js`
- Create: `scripts/provision-webmaster.js`
- Create: `public/login.html`
- Create: `tests/auth/provision-webmaster.test.js`
- Create: `tests/auth/auth-routes.test.js`
- Modify: `repositories/index.js`
- Modify: `public/admin.html`
- Modify: `index.js:22-25,700-718`

**Interfaces:**
- Produces: `users.createInitialWebmaster`, `users.findById`, `users.findByNormalizedUsername`, and `users.recordLogin`.
- Produces: `createSessionMiddleware(config)` and `requireSameOrigin(config)` from `auth/session.js`.
- Produces: `createAuthRouter({ users, bcrypt, sessionOptions })`.
- Produces: `createRequireRole({ users, role, htmlRedirect })`.
- Produces: `provisionInitialWebmaster({ users, username, password })` for CLI and tests.

- [ ] **Step 1: Write failing provisioning tests**

Assert username trimming/lowercase normalization, minimum 12-character password, bcrypt hash verification, absence of plaintext fields, role `webmaster`, active status, duplicate username rejection, and second active webmaster rejection.

- [ ] **Step 2: Write failing HTTP auth tests**

Use a tiny Express fixture plus Supertest. Assert wrong credentials return `401`, correct credentials set an `HttpOnly`/`SameSite=Lax` cookie, `/auth/session` returns MongoDB roles, logout clears the cookie, disabled/auth-version-changed users are rejected, and non-webmaster users receive `403`.

- [ ] **Step 3: Run auth tests and verify failure**

Run: `npm test -- tests/auth/*.test.js`
Expected: FAIL with missing auth/user modules.

- [ ] **Step 4: Implement user repository and provisioning service**

Normalize usernames with `String(value).trim().toLowerCase()`. Hash with:

```js
const passwordHash = await bcrypt.hash(password, 12);
```

Before insert, check both the normalized username and `{ roles: 'webmaster', active: true }`; reject rather than update/upsert. Set `initial_webmaster: true` so the unique partial index also closes the concurrent-provisioning race. Export the service function for tests. The CLI reads username from `--username`, obtains the password from a no-echo raw-mode TTY reader or newline-terminated stdin, rejects any `--password` argument, prints no hash/password, overwrites the local password variable in `finally`, and always closes MongoDB.

- [ ] **Step 5: Implement signed sessions and authorization**

Configure `cookie-session` with `name: 'ai_call_agent_session'`, `keys: [config.cookieSecret]`, `httpOnly: true`, `sameSite: 'lax'`, `secure: config.nodeEnv === 'production'`, and fixed `maxAge: 8 * 60 * 60 * 1000`. Set Express `trust proxy` to `1` in production so secure cookies work behind the later DigitalOcean reverse proxy. Store only `userId`, `authVersion`, and `issuedAt`. Middleware reloads the user on every request and trusts roles only from the returned MongoDB document. Login compares missing usernames against one process-wide fixed bcrypt dummy hash before returning `401`.

Apply `express-rate-limit` to `POST /auth/login` with `windowMs: 15 * 60 * 1000`, `limit: 10`, `standardHeaders: true`, and `legacyHeaders: false`; return a generic `429` JSON response without echoing the username.

Add same-origin checking for authenticated browser mutation methods (`POST`, `PUT`, `PATCH`, `DELETE`) by comparing the parsed `Origin` host/protocol to `PUBLIC_BASE_URL`. Auth login and Twilio endpoints use their own controls.

- [ ] **Step 6: Protect the existing application without renaming business routes**

Mount `/auth` and `/login.html` publicly. Serve `/admin.html` behind HTML redirect middleware. Protect `/api/**`, `/call/start`, recording/transcript/report endpoints, and operator escalation with `webmaster` middleware. Leave `/health` and Twilio-required TwiML/callback/WebSocket entry points outside session auth.

Add a small logout control and `401` redirect handling to `public/admin.html`; keep the existing dashboard layout/workflows. `public/login.html` posts to `/auth/login` and redirects to `/admin.html` only on success.

- [ ] **Step 7: Run auth tests**

Run: `npm test -- tests/auth/*.test.js`
Expected: PASS.

- [ ] **Step 8: Commit authentication**

```bash
git add repositories/users.js repositories/index.js auth/session.js auth/middleware.js routes/auth.js scripts/provision-webmaster.js public/login.html public/admin.html index.js tests/auth/provision-webmaster.test.js tests/auth/auth-routes.test.js
git commit -m "feat: add Mongo-backed webmaster authentication"
```

### Task 8: Add runtime configuration, Mongo health, structured logs, and graceful shutdown

**Files:**
- Create: `config/runtime-config.js`
- Create: `logging/logger.js`
- Create: `middleware/request-context.js`
- Create: `tests/health-and-logging.test.js`
- Create: `tests/application-contracts.test.js`
- Modify: `index.js`
- Modify: active route/service error logging call sites
- Modify: `.env.example`

**Interfaces:**
- Produces: `loadRuntimeConfig(env) -> frozen config` with no secret values in thrown messages.
- Produces: `createLogger({ sink, nodeEnv })` with `debug`, `info`, `warn`, and `error`.
- Produces: `requestContext({ logger })` middleware.
- Produces: `startApplication({ env = process.env, dependencies = {} } = {}) -> { app, server, mongoClient, stop }` from `index.js` for tests and process startup. Tests may inject Mongo/Twilio/logger dependencies; production uses defaults.

- [ ] **Step 1: Add failing configuration/health/log-redaction tests**

Assert missing `MONGODB_URI`, `MONGODB_DB_NAME`, or `COOKIE_SECRET` prevents listen; ordinary startup creates no user; `CUSTOMER_PHONE` and `CUSTOMER_NAME` are not required production startup values; healthy ping returns the exact safe payload; failed ping returns `503`; logs parse as JSON; and this fixture never appears in serialized logs:

```js
const forbidden = [
  'mongodb+srv://user:password@example.mongodb.net',
  'super-secret-cookie-key',
  '+919876543210',
  'CUSTOMER: private transcript text'
];
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/health-and-logging.test.js`
Expected: FAIL with missing config/logger modules.

- [ ] **Step 3: Implement configuration and logger**

`loadRuntimeConfig` returns namespaced values and reports only missing variable names. `createLogger` emits one JSON object per line with `timestamp`, `level`, `event`, and safe context. Its recursive redactor replaces keys matching `/password|secret|token|authorization|cookie|mongodb.*uri/i`, masks phone-shaped values, and drops transcript/feedback/review text fields.

- [ ] **Step 4: Make health Mongo-aware and startup explicit**

Replace the current `/health` body with:

```js
const databaseUp = await pingMongo(db);
res.status(databaseUp ? 200 : 503).json({
  ok: databaseUp,
  database: databaseUp ? 'up' : 'down',
  timestamp: new Date().toISOString()
});
```

`startApplication({ env, dependencies })` must validate configuration, connect/ping, ensure collections/indexes, create repositories/routers, start the scheduler, then listen. It must not call any user-creation method. Store the interval handle. `stop()` clears the interval, closes HTTP/WebSocket listeners, and closes MongoDB. SIGTERM/SIGINT call `stop()` once. Keep `if (require.main === module) startApplication().catch(...)` as the only automatic startup path.

In `tests/application-contracts.test.js`, inject a Twilio client whose `calls.create()` returns `{ sid: 'CA_TEST_001' }`. Through the real app factory, assert login protection and the existing customer/feedback/report routes plus `/api/calls/initiate/:customerId`, `/api/calls/recent`, supervisor event lookup/escalation, and transcript lookup. Assert numeric IDs and the existing snake_case fields rather than snapshots of irrelevant HTML.

- [ ] **Step 5: Replace sensitive console output**

Use event names such as `server.ready`, `scheduler.tick_failed`, `call.requested`, `call.status_received`, `pipeline.failed`, and `websocket.closed`. Do not log destination/source phone numbers, full provider URLs, cookies, credentials, transcripts, feedback text, or raw request bodies.

- [ ] **Step 6: Document safe environment keys**

Add placeholders only to `.env.example`:

```dotenv
MONGODB_URI=mongodb+srv://username:password@cluster.example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=ai_call_agent
COOKIE_SECRET=generate-a-random-secret-at-deployment
TWILIO_VALIDATE_SIGNATURES=true
```

Add comments that real values belong in deployment secrets and webmaster credentials are never startup variables.

- [ ] **Step 7: Run health/log tests and the full suite**

Run: `npm test -- tests/health-and-logging.test.js tests/application-contracts.test.js`
Expected: PASS.
Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 8: Commit runtime hardening**

```bash
git add config/runtime-config.js logging/logger.js middleware/request-context.js index.js routes/customers.js routes/feedback.js routes/reports.js services/call-feedback.js services/call-orchestration.js services/crm-sync.js services/email.js services/openai.js services/pdf.js services/post-call-pipeline.js services/reporting.js services/twilio.js .env.example tests/health-and-logging.test.js tests/application-contracts.test.js
git commit -m "feat: add Mongo health and structured runtime logs"
```

### Task 9: Validate Twilio public entry points without session auth

**Files:**
- Create: `middleware/twilio-validation.js`
- Create: `tests/twilio-validation.test.js`
- Modify: `index.js`
- Modify: `config/runtime-config.js`

**Interfaces:**
- Produces: `createTwilioWebhookValidator({ authToken, publicBaseUrl, enabled })`.
- Produces: `validateTwilioWebSocketUpgrade({ request, authToken, publicBaseUrl }) -> boolean`.

- [ ] **Step 1: Write failing valid/invalid signature tests**

Generate signatures with the installed Twilio SDK helper rather than hard-coded hashes. Cover GET query parameters, form POST fields, the lowercase WebSocket header `x-twilio-signature`, proxy-facing HTTPS URL reconstruction, disabled validation only when `NODE_ENV !== 'production'`, and `403` for absent/invalid signatures.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- tests/twilio-validation.test.js`
Expected: FAIL with missing validation module.

- [ ] **Step 3: Implement SDK-backed validation**

Use `twilio.validateRequest(authToken, signature, exactExternalUrl, params)` for HTTP and the WebSocket handshake. Never implement HMAC logic manually. Derive the URL from configured `PUBLIC_BASE_URL` plus the original path/query; do not trust arbitrary forwarded host headers.

- [ ] **Step 4: Apply validation only to provider-controlled routes**

Protect `/call/twiml`, `/call/status`, `/call/recording-status`, `/call/scripted/*`, and the `/call/stream` upgrade. Do not apply it to `/call/start` because that route uses webmaster session authorization instead.

- [ ] **Step 5: Run Twilio and full tests**

Run: `npm test -- tests/twilio-validation.test.js`
Expected: PASS.
Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit provider validation**

```bash
git add middleware/twilio-validation.js config/runtime-config.js index.js tests/twilio-validation.test.js
git commit -m "feat: validate public Twilio entry points"
```

### Task 10: Remove SQLite and dead SQL-backed route modules

**Files:**
- Delete: `db.js`
- Delete: `routes/calls.js`
- Delete: `routes/twiml.js`
- Delete: `routes/whatsapp.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `tests/sqlite-removal.test.js`

**Interfaces:**
- Consumes: all MongoDB repositories and active route tests from Tasks 2–9.
- Produces: an application tree with no SQLite runtime/fallback path.

- [ ] **Step 1: Write the architecture guard test**

`tests/sqlite-removal.test.js` recursively scans tracked `.js`/`.json` files outside `node_modules`, `docs`, and `tests` and fails on:

```js
const forbidden = [
  /require\(['"]sqlite3['"]\)/,
  /\bdbRun\b/,
  /\bdbGet\b/,
  /\bdbAll\b/,
  /DATABASE_URL/,
  /CREATE TABLE/i,
  /\bSELECT\s+/i,
  /\bINSERT\s+INTO\b/i
];
```

Also assert `package.json.dependencies.sqlite3 === undefined` and `db.js` does not exist.

- [ ] **Step 2: Run the guard and verify it fails against current leftovers**

Run: `npm test -- tests/sqlite-removal.test.js`
Expected: FAIL listing `db.js`, `sqlite3`, and any remaining SQL callers.

- [ ] **Step 3: Remove SQLite and unmounted duplicates**

Run `npm uninstall sqlite3`, delete `db.js`, and delete the three unmounted route modules only after `rg` confirms `index.js` imports none of them. Remove `DATABASE_URL` documentation/configuration. Do not delete any `.db` file outside this repository or any persistent volume in this application-only plan.

- [ ] **Step 4: Update application documentation**

Replace SQLite setup in `README.md` with MongoDB Atlas configuration, one-time webmaster provisioning, login, health response, and local test instructions. State explicitly that DigitalOcean deployment and UAT setup are documented separately later.

- [ ] **Step 5: Run architecture guard and full verification**

Run: `npm test -- tests/sqlite-removal.test.js`
Expected: PASS.
Run: `npm test`
Expected: all tests PASS.
Run: `npm ls sqlite3`
Expected: no installed `sqlite3` package.
Run: `rg -n "sqlite3|DATABASE_URL|dbRun|dbGet|dbAll|CREATE TABLE|SELECT |INSERT INTO" --glob '!docs/**' --glob '!tests/**' .`
Expected: no matches.

- [ ] **Step 6: Commit SQLite removal**

```bash
git add db.js routes/calls.js routes/twiml.js routes/whatsapp.js package.json package-lock.json .env.example README.md tests/sqlite-removal.test.js
git commit -m "refactor: remove SQLite persistence"
```

### Task 11: Verify against an empty non-production Atlas database and prepare the DigitalOcean handoff

**Files:**
- Create: `docs/runbooks/mongodb-atlas-application-readiness.md`
- Modify: `README.md`

**Interfaces:**
- Produces: a verified Mongo-backed application artifact and a concise input checklist for the separate DigitalOcean production-deployment plan.

- [ ] **Step 1: Create an isolated non-production Atlas database**

Use an Atlas database user scoped `readWrite` to only the test database and an IP access-list entry limited to the executor's temporary source IP. Do not load sample data and do not import SQLite.

- [ ] **Step 2: Run the complete suite with Atlas integration enabled**

Run with `MONGODB_TEST_URI` and a unique `MONGODB_TEST_DB_NAME`; tests must clear only that exact test database after validating its name ends in `_test`.

Run: `npm test`
Expected: all tests PASS against Atlas.

- [ ] **Step 3: Exercise provisioning and authentication**

Pipe a test-only password to `npm run provision:webmaster -- --username atlas-readiness-webmaster`; verify one user exists, `password_hash` passes bcrypt comparison, no plaintext password field exists, and a second run exits non-zero without changing the document.

- [ ] **Step 4: Exercise application acceptance without live customer data**

Start the app against the empty Atlas database, confirm `/health` returns `200`, log in, create one synthetic customer using a non-routable test number accepted by validation, exercise customer CRUD/manual feedback/report previews, restart the app, and confirm records/authentication persist. Do not place the production test call in this phase; that belongs to the DigitalOcean cutover checklist.

- [ ] **Step 5: Write the handoff runbook**

Document:

- required deployment secrets/config names without values;
- Atlas cluster/database/user names selected by the operator;
- the production Droplet public egress IP still needed for the Atlas access list;
- the exact start, provision, health, login, and final test-call commands/endpoints;
- the one-replica constraint;
- the fact that Google Cloud and UAT are excluded;
- the acceptance evidence from this task.

Do not include connection strings, passwords, tokens, phone numbers, or cookies.

- [ ] **Step 6: Run final repository verification**

Run: `npm test`
Expected: all tests PASS.
Run: `git diff --check`
Expected: exit 0.
Run: `git status --short`
Expected: only the runbook/README changes intended for this task before commit.

- [ ] **Step 7: Commit the verified handoff**

```bash
git add docs/runbooks/mongodb-atlas-application-readiness.md README.md
git commit -m "docs: add MongoDB production-readiness runbook"
```

## Completion Gate

This plan is complete only when all of the following are true:

- all automated tests pass on the in-memory replica set and isolated non-production Atlas database;
- the server refuses to listen without required MongoDB/cookie configuration;
- startup creates no users;
- the provisioning command creates one non-overwritable webmaster with only a bcrypt hash;
- existing dashboard/API workflows use MongoDB repositories and preserve their route/response contracts;
- `/health` returns `503` when MongoDB is unavailable;
- logs are structured and redacted;
- Twilio public endpoints validate signatures in production;
- `sqlite3`, `db.js`, SQL helpers, `DATABASE_URL`, and dead SQL route files are absent;
- no Google Cloud or DigitalOcean deployment automation has been introduced in this phase;
- the separate DigitalOcean plan has the exact MongoDB/application inputs it needs.
