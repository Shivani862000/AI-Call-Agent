# Webmaster Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete, responsive, Webmaster-only platform console for tenants, users, platform settings, integrations, policies, health, and audit history while prohibiting permanent application-record deletion and preventing PII, PHI, password, and secret disclosure.

**Architecture:** Add a dedicated `/webmaster.html` control plane and `/api/webmaster` router to the existing Express/Mongoose application. Focused domain services own authorization, lifecycle transitions, settings inheritance, encryption, audit creation, notifications, and aggregate-only operational reporting; the browser receives safe DTOs and never performs security redaction.

**Tech Stack:** Node.js, Express 4, MongoDB/Mongoose 8, browser-native ES modules, HTML/CSS, bcrypt, Node `crypto` AES-256-GCM, Nodemailer, `express-rate-limit`, and `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-24-webmaster-console-design.md`

## Global Constraints

- Only `WEBMASTER` accounts with `platformAccessLevel: OWNER | ADMIN` may access `/webmaster.html` or `/api/webmaster`.
- `SUPPORT_TEAM`, `CLIENT_ADMIN`, and `CLIENT_AGENT` receive no webmaster access.
- Owners alone replace write-only secrets and manage Webmaster Admin accounts; secret values are never returned, logged, audited, partially displayed, or exported.
- Tenant operational snapshots are aggregate-only and structurally exclude PII/PHI.
- No application record is permanently deleted. Existing delete routes become archive transitions; archived records remain retained and recoverable.
- Global settings support registered tenant overrides; resolution order is tenant override, persisted global default, then environment/application fallback.
- The console has no global cross-entity search and no CSV/data export.
- Sensitive actions use an accessible confirmation popup without password re-entry.
- The complete console ships responsively for desktop, tablet, and mobile.
- Do not add a frontend framework, bundler, or new runtime dependency.

## File Structure

### Backend foundations

- Modify `src/models/User.js`: platform access level, lifecycle status, timestamps, password-change metadata.
- Modify `src/models/Tenant.js`: extended tenant profile, limits, overrides, lifecycle, timestamps.
- Modify `src/models/Customer.js`, `src/models/Call.js`, `src/models/Agent.js`, `src/models/Feedback.js`: archive metadata and active-query support.
- Create `src/models/PlatformSettings.js`: singleton non-secret settings and policies.
- Create `src/models/IntegrationSecret.js`: encrypted secret envelope and replacement metadata.
- Create `src/models/AuditEvent.js`: immutable application audit record.
- Create `src/models/NotificationDelivery.js`: lifecycle-notification delivery state.
- Create `src/webmaster/errors.js`: stable safe domain errors.
- Create `src/webmaster/authorization.js`: actor resolution and Owner/Admin middleware.
- Create `src/webmaster/redaction.js`: recursive safe audit/error redaction.
- Create `src/webmaster/audit-service.js`: append-only audit creation/query.
- Create `src/webmaster/settings-registry.js`: exact setting, integration, override, fallback, and secret definitions.
- Create `src/webmaster/settings-service.js`: global/override/effective settings and optimistic concurrency.
- Create `src/webmaster/secret-service.js`: AES-256-GCM storage and internal-only resolution.
- Create `src/webmaster/tenant-service.js`: tenant lifecycle, profile, initial-admin transaction, and safe operational aggregates.
- Create `src/webmaster/user-service.js`: tenant-user and platform-team invariants/lifecycle/password updates.
- Create `src/webmaster/notification-service.js`: lifecycle email creation, delivery records, and retries.
- Create `src/webmaster/dashboard-service.js`: safe platform dashboard aggregates and attention items.
- Create `src/webmaster/policy-middleware.js`: maintenance and dynamic rate-limit policy access.

### API

- Create `routes/webmaster/index.js`: compose the domain router and translate safe domain errors.
- Create `routes/webmaster/dashboard.js`, `tenants.js`, `users.js`, `platform-users.js`, `settings.js`, `integrations.js`, `audit.js`, and `notifications.js`: thin section routers.
- Modify `src/api-routes.js`: mount the webmaster router, enrich auth responses, and role-aware root routing.
- Modify `index.js`: protect the webmaster page, apply maintenance behavior, and use dynamic configured limits.
- Modify `src/auth.js`: status-aware credentials/session actor data and removal of webmaster tenant fallback.
- Modify `src/authorization.js`: application archive operations and correct current role names.

### Existing runtime integrations and preservation

- Modify `services/icallmate.js`, `services/gemini.js`, `src/websocket-bridge.js`, `src/services/email-service.js`, `services/slack-support.js`, and relevant calls in `src/api-routes.js`: consume internally resolved database-over-environment integration configuration.
- Modify `routes/customers.js`, `routes/users.js`, `routes/clients.js`, `routes/campaigns.js`, `routes/agents.js`, and call-history routes in `src/api-routes.js`: replace deletes with archive transitions and exclude archived rows by default.
- Modify `public/customers.html`, `public/customer-list.js`, and other affected existing UI copy: replace Delete with Archive and explain preservation.
- Modify `.env.example` and `.env.production.example`: document `WEBMASTER_SECRETS_KEY` and safe fallbacks without adding real secrets.

### Frontend

- Create `public/webmaster.html`: semantic shell and section mounts.
- Create `public/webmaster.css`: neutral VikiTech responsive design and accessible states.
- Create `public/webmaster-api.js`: safe API client and field-error handling.
- Create `public/webmaster-components.js`: dialogs, status badges, pagination, forms, empty/loading/error states.
- Create `public/webmaster.js`: section routing, state, actions, and view rendering.
- Modify `public/login.html`: role-aware post-login and existing-session routing.

### Tests

- Create `test/webmaster-authorization.test.js`.
- Create `test/webmaster-models.test.js`.
- Create `test/webmaster-redaction-audit.test.js`.
- Create `test/webmaster-settings-secrets.test.js`.
- Create `test/webmaster-tenants.test.js`.
- Create `test/webmaster-users.test.js`.
- Create `test/webmaster-notifications-policies.test.js`.
- Create `test/webmaster-dashboard-privacy.test.js`.
- Create `test/webmaster-routes.test.js`.
- Create `test/webmaster-ui.test.js`.
- Modify `test/auth-security.test.js` and relevant existing route/UI tests to use current roles and archive semantics.

---

### Task 1: Status-aware Webmaster authorization and login routing

**Files:**
- Modify: `src/models/User.js`
- Modify: `src/models/Tenant.js`
- Create: `src/webmaster/errors.js`
- Create: `src/webmaster/authorization.js`
- Modify: `src/auth.js`
- Modify: `src/api-routes.js`
- Modify: `index.js`
- Modify: `public/login.html`
- Create: `test/webmaster-authorization.test.js`
- Modify: `test/auth-security.test.js`

**Interfaces:**
- Produces: `createWebmasterAuthorization({ UserModel, TenantModel, env }) -> { resolveActor, requireWebmaster, requireOwner }`.
- Produces: `resolveActor(session) -> Promise<{ username, role: 'WEBMASTER', platformAccessLevel: 'OWNER'|'ADMIN', source: 'environment'|'database' }>`.
- Produces: domain errors with `{ status, code, message, fieldErrors }`.
- Consumes later: every `/api/webmaster` route uses `req.webmasterActor` set by `requireWebmaster`.

- [ ] **Step 1: Replace stale role tests and write failing authorization/status tests**

```js
test('environment webmaster resolves as owner and support is rejected', async () => {
  const auth = createWebmasterAuthorization({
    UserModel: { findOne: async () => null },
    TenantModel: {},
    env: { ADMIN_USERNAME: 'root' }
  });
  assert.equal((await auth.resolveActor({ username: 'root', role: 'WEBMASTER' })).platformAccessLevel, 'OWNER');
  await assert.rejects(auth.resolveActor({ username: 'support', role: 'SUPPORT_TEAM' }), error => error.code === 'WEBMASTER_FORBIDDEN');
});

test('database webmaster must be active and assigned owner or admin access', async () => {
  const UserModel = { findOne: async () => ({ username: 'wm', role: 'WEBMASTER', status: 'suspended', platformAccessLevel: 'ADMIN' }) };
  const auth = createWebmasterAuthorization({ UserModel, TenantModel: {}, env: {} });
  await assert.rejects(auth.resolveActor({ username: 'wm', role: 'WEBMASTER' }), error => error.code === 'ACCOUNT_INACTIVE');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test test/auth-security.test.js test/webmaster-authorization.test.js`  
Expected: FAIL because the new model fields and authorization factory do not exist, and stale `AGENT`/`ADMIN` expectations do not match the current role enum.

- [ ] **Step 3: Add lifecycle/access fields and safe domain errors**

```js
const PLATFORM_ACCESS_LEVELS = ['OWNER', 'ADMIN'];
platformAccessLevel: {
  type: String,
  enum: PLATFORM_ACCESS_LEVELS,
  default: null,
  validate: {
    validator(value) { return this.role === 'WEBMASTER' ? Boolean(value) : value == null; },
    message: 'Platform access level is valid only for Webmaster accounts'
  }
},
status: { type: String, enum: ['active', 'suspended', 'archived'], default: 'active' },
password_changed_at: { type: Date, default: null }
```

Use Mongoose timestamps `{ createdAt: 'created_at', updatedAt: 'updated_at' }` for both User and Tenant. Export `WebmasterError` helpers from `src/webmaster/errors.js` so routes never expose raw database/provider errors.

- [ ] **Step 4: Implement actor resolution and Owner middleware**

```js
function createWebmasterAuthorization({ UserModel, env = process.env }) {
  async function resolveActor(session) {
    if (session?.role !== 'WEBMASTER') throw forbidden('WEBMASTER_FORBIDDEN');
    if (session.username === String(env.ADMIN_USERNAME || '').trim()) {
      return { username: session.username, role: 'WEBMASTER', platformAccessLevel: 'OWNER', source: 'environment' };
    }
    const user = await UserModel.findOne({ username: session.username }).lean();
    if (!user || user.status !== 'active') throw forbidden('ACCOUNT_INACTIVE');
    if (!['OWNER', 'ADMIN'].includes(user.platformAccessLevel)) throw forbidden('WEBMASTER_ACCESS_UNASSIGNED');
    return { id: String(user._id), username: user.username, role: 'WEBMASTER', platformAccessLevel: user.platformAccessLevel, source: 'database' };
  }
  return { resolveActor, requireWebmaster: middleware(resolveActor), requireOwner: ownerMiddleware(resolveActor) };
}
```

- [ ] **Step 5: Make login/session responses status-aware and role-aware**

Update `verifyCredentials` to query username or email, require `user.status === 'active'`, require an active tenant for tenant roles, and return `platformAccessLevel` for Webmasters. Remove the `requireTenantAccess` behavior that silently assigns a Webmaster the first tenant. Add `/webmaster.html` to protected paths and route successful/existing Webmaster sessions to it in `public/login.html`; non-Webmasters continue to `/admin.html`.

- [ ] **Step 6: Run authorization tests**

Run: `node --test test/auth-security.test.js test/webmaster-authorization.test.js`  
Expected: PASS with current `WEBMASTER`, `CLIENT_ADMIN`, and `CLIENT_AGENT` role names; Support Team and inactive principals are denied.

- [ ] **Step 7: Commit**

```bash
git add src/models/User.js src/models/Tenant.js src/webmaster/errors.js src/webmaster/authorization.js src/auth.js src/api-routes.js index.js public/login.html test/auth-security.test.js test/webmaster-authorization.test.js
git commit -m "feat: add webmaster authorization foundation"
```

### Task 2: Application-wide archival instead of permanent deletion

**Files:**
- Modify: `src/models/Customer.js`
- Modify: `src/models/Call.js`
- Modify: `src/models/Agent.js`
- Modify: `src/models/Feedback.js`
- Modify: `routes/customers.js`
- Modify: `routes/users.js`
- Modify: `routes/clients.js`
- Modify: `routes/campaigns.js`
- Modify: `routes/agents.js`
- Modify: `src/api-routes.js`
- Modify: `src/authorization.js`
- Modify: `public/customers.html`
- Modify: `public/customer-list.js`
- Create: `test/application-archival.test.js`

**Interfaces:**
- Produces: `archiveFields(actor, reason) -> { status: 'archived', archived_at, archived_by, archive_reason }`.
- Produces: `activeRecordFilter(extra = {}) -> { ...extra, status: { $ne: 'archived' } }` for Mongoose-backed records.
- Produces: archive responses `{ message, archivedCount?, resource }`; no application route calls `deleteOne`, `deleteMany`, or SQL `DELETE FROM`.

- [ ] **Step 1: Write a failing source-level preservation test**

```js
const destructiveFiles = ['routes/customers.js', 'routes/users.js', 'routes/clients.js', 'routes/campaigns.js', 'routes/agents.js', 'src/api-routes.js'];
for (const file of destructiveFiles) {
  const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
  assert.doesNotMatch(source, /deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|DELETE\s+FROM/i, file);
}
```

Also assert affected browser copy contains “Archive” and does not offer destructive “Delete all records” actions.

- [ ] **Step 2: Run the preservation test and verify it fails**

Run: `node --test test/application-archival.test.js`  
Expected: FAIL on current customer, user, client, campaign, agent, and call-history delete statements.

- [ ] **Step 3: Add archive metadata and shared filters**

Add `status`, `archived_at`, `archived_by`, and `archive_reason` where absent. Create `src/webmaster/lifecycle.js` with exact helpers:

```js
function archiveFields(actor, reason = '') {
  return { status: 'archived', archived_at: new Date(), archived_by: actor?.username || 'system', archive_reason: String(reason).trim() || null };
}
function activeRecordFilter(extra = {}) { return { ...extra, status: { $ne: 'archived' } }; }
```

- [ ] **Step 4: Convert all destructive routes into archive transitions**

Keep existing HTTP methods temporarily for compatibility only where the current UI calls them, but make them update archival fields and return `200`; add explicit `POST /:id/archive` and `POST /:id/restore` endpoints for new UI code. Replace SQL `DELETE FROM` with `UPDATE ... SET status = 'archived', archived_at = ?, archived_by = ?`. Bulk actions archive matching records and preserve call history.

- [ ] **Step 5: Exclude archived records from active operational queries and update UI copy**

Apply active filters to lists, schedulers, and call initiation. Archived records are returned only when `status=archived` is explicitly authorized. Replace confirmation text with: `Archive this record? It will be retained and can be restored later.`

- [ ] **Step 6: Run archival and regression tests**

Run: `node --test test/application-archival.test.js test/auth-security.test.js test/database-safety.test.js`  
Expected: PASS; no application-record hard-delete statement remains in runtime route code.

- [ ] **Step 7: Commit**

```bash
git add src/models/Customer.js src/models/Call.js src/models/Agent.js src/models/Feedback.js src/webmaster/lifecycle.js routes/customers.js routes/users.js routes/clients.js routes/campaigns.js routes/agents.js src/api-routes.js src/authorization.js public/customers.html public/customer-list.js test/application-archival.test.js
git commit -m "feat: preserve records with archival lifecycle"
```

### Task 3: Persistence, redaction, immutable audit, and encrypted secrets

**Files:**
- Create: `src/models/PlatformSettings.js`
- Create: `src/models/IntegrationSecret.js`
- Create: `src/models/AuditEvent.js`
- Create: `src/models/NotificationDelivery.js`
- Create: `src/webmaster/redaction.js`
- Create: `src/webmaster/audit-service.js`
- Create: `src/webmaster/secret-service.js`
- Modify: `.env.example`
- Modify: `.env.production.example`
- Create: `test/webmaster-models.test.js`
- Create: `test/webmaster-redaction-audit.test.js`
- Create: `test/webmaster-settings-secrets.test.js`

**Interfaces:**
- Produces: `sanitizeForAudit(value) -> deeply redacted clone`.
- Produces: `createAuditService({ AuditEventModel }).record({ actor, action, target, tenantId, before, after, requestId, outcome })`.
- Produces: `createSecretService({ IntegrationSecretModel, env, randomBytes }).replaceSecret({ integration, key, value, actor })`, `.getMetadata(integration, key)`, and internal-only `.resolveSecret(integration, key)`.
- Secret key format: `WEBMASTER_SECRETS_KEY` is base64 for exactly 32 bytes.

- [ ] **Step 1: Write failing schema, redaction, immutability, and encryption tests**

```js
test('secret encryption round trips internally without returning plaintext metadata', async () => {
  const store = fakeSecretStore();
  const service = createSecretService({ IntegrationSecretModel: store, env: { WEBMASTER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') } });
  const metadata = await service.replaceSecret({ integration: 'gemini', key: 'apiKey', value: 'top-secret', actor: owner });
  assert.deepEqual(metadata, { configured: true, source: 'database', updatedAt: fixedDate, updatedBy: 'owner' });
  assert.equal(JSON.stringify(metadata).includes('top-secret'), false);
  assert.equal(await service.resolveSecret('gemini', 'apiKey'), 'top-secret');
});

test('audit redaction removes nested credentials and patient content', () => {
  assert.deepEqual(sanitizeForAudit({ password: 'x', nested: { apiKey: 'y', transcript: 'z' }, status: 'active' }), {
    password: '[redacted]', nested: { apiKey: '[redacted]', transcript: '[redacted]' }, status: 'active'
  });
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `node --test test/webmaster-models.test.js test/webmaster-redaction-audit.test.js test/webmaster-settings-secrets.test.js`  
Expected: FAIL because the models and services do not exist.

- [ ] **Step 3: Implement strict schemas and append-only audit service**

Use strict schemas with timestamps. `AuditEvent` has no update/delete service methods. Its safe fields are `actor`, `actorAccessLevel`, `action`, `targetType`, `targetId`, `tenantId`, `before`, `after`, `requestId`, `outcome`, `failureCode`, and `created_at`. Redact recursively before model construction.

- [ ] **Step 4: Implement AES-256-GCM secret envelopes**

```js
const iv = randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
const authTag = cipher.getAuthTag();
```

Store base64 ciphertext, IV, tag, and `encryptionVersion: 1`. `getMetadata` projects no encrypted fields. `resolveSecret` is exported only from the backend service instance and falls back to the registry's environment key when no database record exists.

- [ ] **Step 5: Document key configuration safely**

Add comments to both env examples:

```dotenv
# Base64-encoded 32-byte key used only to encrypt database-managed integration secrets.
WEBMASTER_SECRETS_KEY=
```

- [ ] **Step 6: Run focused tests**

Run: `node --test test/webmaster-models.test.js test/webmaster-redaction-audit.test.js test/webmaster-settings-secrets.test.js`  
Expected: PASS, including assertions that metadata/audits contain no plaintext, ciphertext, partial secret, password, PII, or PHI.

- [ ] **Step 7: Commit**

```bash
git add src/models/PlatformSettings.js src/models/IntegrationSecret.js src/models/AuditEvent.js src/models/NotificationDelivery.js src/webmaster/redaction.js src/webmaster/audit-service.js src/webmaster/secret-service.js .env.example .env.production.example test/webmaster-models.test.js test/webmaster-redaction-audit.test.js test/webmaster-settings-secrets.test.js
git commit -m "feat: add secure webmaster persistence"
```

### Task 4: Settings registry, inheritance, and runtime integration resolution

**Files:**
- Create: `src/webmaster/settings-registry.js`
- Create: `src/webmaster/settings-service.js`
- Modify: `services/icallmate.js`
- Modify: `services/gemini.js`
- Modify: `src/websocket-bridge.js`
- Modify: `src/services/email-service.js`
- Modify: `services/slack-support.js`
- Modify: `src/api-routes.js`
- Modify: `src/config.js`
- Modify: `test/webmaster-settings-secrets.test.js`
- Modify: `test/icallmate-config.test.js`
- Modify: `test/deepgram-transcript.test.js`

**Interfaces:**
- Produces: `SETTING_DEFINITIONS`, `INTEGRATION_DEFINITIONS`, `OVERRIDABLE_KEYS`.
- Produces: `createSettingsService({ PlatformSettingsModel, TenantModel, auditService, env }).getGlobal()`, `.updateSection(section, patch, expectedVersion, actor)`, `.getEffectiveForTenant(tenantId)`, `.setTenantOverrides(tenantId, overrides, expectedVersion, actor)`.
- Produces: internal `getIntegrationRuntimeConfig(integration, tenantId?) -> Promise<{ settings, secrets }>`; it is never mounted directly as an API response.

- [ ] **Step 1: Write failing inheritance, allowlist, and provider-precedence tests**

```js
test('tenant override wins over global and environment fallback', async () => {
  const service = createSettingsService(fakes({ global: { defaults: { timezone: 'UTC' } }, tenant: { settingsOverrides: { 'defaults.timezone': 'Asia/Kolkata' } } }));
  const result = await service.getEffectiveForTenant('tenant-1');
  assert.equal(result.effective.defaults.timezone, 'Asia/Kolkata');
  assert.equal(result.inherited.defaults.timezone, false);
});

test('unknown tenant override keys are rejected', async () => {
  await assert.rejects(service.setTenantOverrides('t1', { 'security.ownerRole': 'CLIENT_AGENT' }, 1, actor), error => error.code === 'INVALID_OVERRIDE_KEY');
});
```

- [ ] **Step 2: Run settings/provider tests and verify they fail**

Run: `node --test test/webmaster-settings-secrets.test.js test/icallmate-config.test.js test/deepgram-transcript.test.js`  
Expected: FAIL because registry-based resolution is missing.

- [ ] **Step 3: Define exact registered configuration**

Register application/support identity, timezone/report defaults, tenant/user/call limits, maintenance mode/message, feature flags, password/session policy bounds, notification templates, rate limits, retention-to-archive classifications, and supported providers. Register iCallMate, Gemini, Deepgram, SMTP, Slack, and webhook safe fields and secret-to-environment mappings. Only registered non-security keys are tenant-overridable.

- [ ] **Step 4: Implement versioned settings updates and effective values**

Return `{ global, overrides, effective, inherited, version }`. Use `findOneAndUpdate({ singletonKey: 'platform', __v: expectedVersion }, { $set: validatedPatch, $inc: { __v: 1 } })`; throw `SETTINGS_CONFLICT` when no document matches.

- [ ] **Step 5: Route runtime providers through internal resolution**

Resolve configuration immediately before provider use rather than once at module load. Pass resolved iCallMate credentials/options into existing payload builders, resolved Gemini/Deepgram keys into call/transcription creation, resolved SMTP config into transporter creation, and resolved Slack/webhook configuration into notifier calls. Keep environment values as fallback through the registry.

- [ ] **Step 6: Verify integration resolution and existing provider behavior**

Run: `node --test test/webmaster-settings-secrets.test.js test/icallmate-config.test.js test/icallmate-preflight.test.js test/deepgram-transcript.test.js test/media-bridge-auth.test.js`  
Expected: PASS; fake database values win, environment fallbacks continue to work, and no provider test receives secret metadata through a UI/API DTO.

- [ ] **Step 7: Commit**

```bash
git add src/webmaster/settings-registry.js src/webmaster/settings-service.js services/icallmate.js services/gemini.js src/websocket-bridge.js src/services/email-service.js services/slack-support.js src/api-routes.js src/config.js test/webmaster-settings-secrets.test.js test/icallmate-config.test.js test/deepgram-transcript.test.js
git commit -m "feat: resolve platform and integration settings"
```

### Task 5: Tenant management and PII/PHI-free operational snapshots

**Files:**
- Create: `src/webmaster/tenant-service.js`
- Create: `routes/webmaster/tenants.js`
- Create: `test/webmaster-tenants.test.js`
- Create: `test/webmaster-dashboard-privacy.test.js`

**Interfaces:**
- Produces: `createTenantService(deps).list(filters)`, `.createWithAdmin(input, actor)`, `.update(id, patch, expectedVersion, actor)`, `.transition(id, transition, expectedVersion, actor)`, `.getOperationalSnapshot(id)`.
- Produces safe tenant DTO fields: profile, contacts, plan, limits, status, settings metadata, timestamps, and version.
- Operational snapshot returns counts/ratios/trends/health only; no customer documents or free text.

- [ ] **Step 1: Write failing tenant transaction, lifecycle, conflict, and privacy tests**

```js
test('operational snapshot exposes aggregates and no seeded identifiers', async () => {
  const service = createTenantService(fakeDepsWithCustomer({ name: 'Patient One', phone: '+919999999999', transcript: 'private words' }));
  const snapshot = await service.getOperationalSnapshot('tenant-1');
  const json = JSON.stringify(snapshot);
  assert.equal(json.includes('Patient One'), false);
  assert.equal(json.includes('9999999999'), false);
  assert.equal(json.includes('private words'), false);
  assert.deepEqual(Object.keys(snapshot), ['tenant', 'usage', 'calls', 'feedback', 'integrations', 'notifications']);
});
```

Also test that create-with-admin uses one transaction, duplicate email produces field errors, and suspend/archive/restore never calls delete.

- [ ] **Step 2: Run tenant/privacy tests and verify they fail**

Run: `node --test test/webmaster-tenants.test.js test/webmaster-dashboard-privacy.test.js`  
Expected: FAIL because the service and route do not exist.

- [ ] **Step 3: Implement profile validation and atomic create-with-admin**

Validate name, contact email/phone, timezone, `HH:mm` report time, plan, non-negative integer limits, branding values, notes length, tags, initial-admin username/email/password, and override allowlist. Use a Mongoose session transaction to create the tenant and bcrypt-hashed initial `CLIENT_ADMIN`, then record one linked audit event without password data.

- [ ] **Step 4: Implement lifecycle rules and optimistic conflicts**

Use explicit transitions `suspend | archive | restore`; set status/timestamps, retain all records, and reject stale `expectedVersion`. Suspending or archiving a tenant blocks login/operations through Task 1 checks.

- [ ] **Step 5: Implement database-side aggregate snapshots**

Use `countDocuments` and aggregation projections grouped by status/date/category. Never use `.find()` on Customer/Call/Feedback for the snapshot and never project names, phones, email, transcript, recording, review text, or external IDs.

- [ ] **Step 6: Add thin tenant routes and run tests**

Routes: `GET/POST /tenants`, `GET/PATCH /tenants/:tenantId`, `POST /tenants/:tenantId/lifecycle`, `GET /tenants/:tenantId/operations`, and `PUT /tenants/:tenantId/overrides`.  
Run: `node --test test/webmaster-tenants.test.js test/webmaster-dashboard-privacy.test.js`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/webmaster/tenant-service.js routes/webmaster/tenants.js test/webmaster-tenants.test.js test/webmaster-dashboard-privacy.test.js
git commit -m "feat: add safe tenant management"
```

### Task 6: Tenant users and Owner-managed platform team

**Files:**
- Create: `src/webmaster/user-service.js`
- Create: `routes/webmaster/users.js`
- Create: `routes/webmaster/platform-users.js`
- Modify: `routes/users.js`
- Create: `test/webmaster-users.test.js`

**Interfaces:**
- Produces: `.listTenantUsers`, `.createTenantUser`, `.updateTenantUser`, `.replacePassword`, `.transitionTenantUser`, `.listPlatformUsers`, `.createWebmasterAdmin`, `.transitionPlatformUser`, `.transferOwnership`.
- Safe user DTO: `id`, `username`, `email`, `role`, `tenantId`, `status`, `platformAccessLevel`, `createdAt`, `updatedAt`, `passwordChangedAt`, `version`.

- [ ] **Step 1: Write failing role, password, last-admin, and last-owner tests**

```js
test('safe user DTO never contains credentials', () => {
  const dto = toSafeUser({ username: 'agent', password_hash: 'hash', password: 'plain', role: 'CLIENT_AGENT' });
  assert.equal('password_hash' in dto, false);
  assert.equal('password' in dto, false);
});

test('last active owner cannot be archived', async () => {
  await assert.rejects(service.transitionPlatformUser('owner-1', 'archive', 2, owner), error => error.code === 'LAST_OWNER_REQUIRED');
});
```

- [ ] **Step 2: Run user tests and verify they fail**

Run: `node --test test/webmaster-users.test.js`  
Expected: FAIL because user-service interfaces do not exist.

- [ ] **Step 3: Implement tenant-user management**

Allow only `CLIENT_ADMIN` and `CLIENT_AGENT`; require globally unique normalized username/email; hash manually entered passwords; set `password_changed_at`; enforce at least one active tenant admin while tenant is active; keep tenant reassignment as a separate confirmed update; use archive/suspend/restore transitions only.

- [ ] **Step 4: Implement Owner-only platform-team invariants**

Owners create `WEBMASTER + ADMIN` accounts, suspend/archive/restore Admins, and transfer ownership by promoting an active Admin before demoting the current Owner. No operation can leave zero active Owners. Webmaster Admin callers receive `OWNER_REQUIRED` before target lookup.

- [ ] **Step 5: Keep tenant-admin agent management and convert removal to archive**

Update existing `/api/users/agents/:id` behavior to archive the agent and add restoration, while retaining strict `req.tenantId` ownership checks.

- [ ] **Step 6: Add routes and run tests**

Tenant routes: `GET/POST /tenants/:tenantId/users`, `PATCH /tenants/:tenantId/users/:userId`, `POST /tenants/:tenantId/users/:userId/password`, and `POST /tenants/:tenantId/users/:userId/lifecycle`. Platform routes are `GET/POST /platform-users`, `PATCH /platform-users/:userId`, `POST /platform-users/:userId/password`, `POST /platform-users/:userId/lifecycle`, and `POST /platform-users/transfer-ownership`.  
Run: `node --test test/webmaster-users.test.js test/auth-security.test.js`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/webmaster/user-service.js routes/webmaster/users.js routes/webmaster/platform-users.js routes/users.js test/webmaster-users.test.js
git commit -m "feat: manage tenant and platform users"
```

### Task 7: Lifecycle notifications, policies, maintenance, and dynamic limits

**Files:**
- Create: `src/webmaster/notification-service.js`
- Create: `src/webmaster/policy-middleware.js`
- Create: `routes/webmaster/notifications.js`
- Modify: `src/services/email-service.js`
- Modify: `index.js`
- Create: `test/webmaster-notifications-policies.test.js`

**Interfaces:**
- Produces: `notificationService.sendLifecycle({ tenant, users, event, actor }) -> Promise<delivery[]>` and `.retry(id, actor)`.
- Produces: `createMaintenanceMiddleware({ settingsProvider })`.
- Produces: `createConfiguredRateLimit({ settingsProvider, scope, fallback })` using `express-rate-limit` async `limit`.

- [ ] **Step 1: Write failing delivery-failure, template, maintenance, and rate-limit tests**

```js
test('email failure does not reverse lifecycle state and is retryable', async () => {
  const service = createNotificationService({ mailer: { send: async () => { throw new Error('offline'); } }, DeliveryModel: fakeDeliveries });
  const [delivery] = await service.sendLifecycle(input);
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.retryable, true);
  assert.equal(JSON.stringify(delivery).includes('smtp-password'), false);
});
```

Test maintenance permits Webmaster operations, permits safe tenant GETs, and rejects tenant mutations with `503 MAINTENANCE_MODE`.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `node --test test/webmaster-notifications-policies.test.js`  
Expected: FAIL because notification and policy services do not exist.

- [ ] **Step 3: Refactor email sending for resolved runtime configuration**

Export `createEmailService({ getRuntimeConfig, nodemailer })` with `.send({ to, subject, html })`. Construct/cache transporters by safe config version; never log auth values or recipient-associated message bodies.

- [ ] **Step 4: Implement lifecycle notification recording and retry**

Render the configured tenant/account suspended, archived, and restored templates with tenant-safe variables. Persist `pending -> delivered|failed`, sanitized provider failure code, retry count, and timestamps. Call notifications after state/audit success and return warnings without rollback.

- [ ] **Step 5: Implement policy middleware**

Read cached settings with a 30-second maximum cache age. Maintenance blocks non-Webmaster `POST`, `PUT`, `PATCH`, and compatibility `DELETE` application operations. Dynamic limiter callbacks use validated integer settings and current hard-coded values as fallbacks.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/webmaster-notifications-policies.test.js test/config.test.js`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/webmaster/notification-service.js src/webmaster/policy-middleware.js routes/webmaster/notifications.js src/services/email-service.js index.js test/webmaster-notifications-policies.test.js
git commit -m "feat: enforce platform policies and notifications"
```

### Task 8: Dashboard, settings, integrations, audit APIs, and route composition

**Files:**
- Create: `src/webmaster/dashboard-service.js`
- Create: `routes/webmaster/dashboard.js`
- Create: `routes/webmaster/settings.js`
- Create: `routes/webmaster/integrations.js`
- Create: `routes/webmaster/audit.js`
- Create: `routes/webmaster/index.js`
- Modify: `src/api-routes.js`
- Create: `test/webmaster-routes.test.js`
- Modify: `test/webmaster-dashboard-privacy.test.js`

**Interfaces:**
- Dashboard DTO: `{ tenants, users, usage, health, integrations, recentAudit, attentionItems }` with aggregate values only.
- Integration read DTO: `{ id, enabled, provider, settings, secrets: { [key]: { configured, source, updatedAt, updatedBy } } }`.
- Paginated DTO: `{ items, page, pageSize, total, totalPages }`.

- [ ] **Step 1: Write failing route-contract and role-isolation tests**

```js
test('admin cannot call owner secret endpoint and response never echoes submitted value', async () => {
  const adminResponse = await request(router, 'PUT', '/integrations/gemini/secrets/apiKey', adminSession, { value: 'secret' });
  assert.equal(adminResponse.status, 403);
  const ownerResponse = await request(router, 'PUT', '/integrations/gemini/secrets/apiKey', ownerSession, { value: 'secret' });
  assert.equal(ownerResponse.status, 200);
  assert.equal(JSON.stringify(ownerResponse.body).includes('secret'), false);
});
```

Also test Support Team rejection, stable field errors, `404` after authorization, optimistic conflict `409`, no `DELETE` methods, pagination caps, and absence of export routes.

- [ ] **Step 2: Run route tests and verify they fail**

Run: `node --test test/webmaster-routes.test.js test/webmaster-dashboard-privacy.test.js`  
Expected: FAIL because composed routes do not exist.

- [ ] **Step 3: Implement dashboard and attention aggregation**

Count tenants/users by lifecycle, aggregate call usage/failures, read provider configured/degraded metadata, include failed notifications and limits approached, and fetch only already-redacted audit DTOs.

- [ ] **Step 4: Implement thin section routers**

Settings exposes `GET /settings`, `PATCH /settings/:section`, `GET/PUT /tenants/:id/overrides`. Integrations exposes `GET /integrations`, `PATCH /integrations/:id`, and Owner-only `PUT /integrations/:id/secrets/:key`. Audit exposes filtered/paginated GET only. Notifications exposes filtered GET and retry POST.

- [ ] **Step 5: Compose and mount `/api/webmaster`**

Mount `requireWebmaster` before all section routers and `requireOwner` on Owner-only handlers. Translate `WebmasterError` to `{ error: message, code, fieldErrors }`; log only correlation ID and safe code for unexpected failures.

- [ ] **Step 6: Run API and privacy tests**

Run: `node --test test/webmaster-routes.test.js test/webmaster-dashboard-privacy.test.js test/webmaster-authorization.test.js test/webmaster-settings-secrets.test.js`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/webmaster/dashboard-service.js routes/webmaster/dashboard.js routes/webmaster/settings.js routes/webmaster/integrations.js routes/webmaster/audit.js routes/webmaster/index.js src/api-routes.js test/webmaster-routes.test.js test/webmaster-dashboard-privacy.test.js
git commit -m "feat: expose secure webmaster APIs"
```

### Task 9: Responsive console shell and overview

**Files:**
- Create: `public/webmaster.html`
- Create: `public/webmaster.css`
- Create: `public/webmaster-api.js`
- Create: `public/webmaster-components.js`
- Create: `public/webmaster.js`
- Create: `test/webmaster-ui.test.js`

**Interfaces:**
- `webmasterApi.request(path, options)`, `.get`, `.post`, `.patch`, `.put`; 401 redirects to login and safe API errors preserve `code/fieldErrors`.
- Components: `openConfirm({ title, message, confirmLabel, tone }) -> Promise<boolean>`, `renderStatus`, `renderPagination`, `setViewState`.
- Sections: `overview`, `tenants`, `users`, `platform-team`, `integrations`, `policies`, `audit`.

- [ ] **Step 1: Write failing structural, access, and responsive UI tests**

```js
test('webmaster shell exposes all required sections and no export control', () => {
  const html = read('public/webmaster.html');
  for (const section of ['overview', 'tenants', 'users', 'platform-team', 'integrations', 'policies', 'audit']) {
    assert.match(html, new RegExp(`data-section="${section}"`));
  }
  assert.doesNotMatch(html, /export|csv/i);
});
```

Assert CSS includes breakpoints at `1024px` and `640px`, visible `:focus-visible`, reduced-motion behavior, and non-color status labels.

- [ ] **Step 2: Run UI tests and verify they fail**

Run: `node --test test/webmaster-ui.test.js`  
Expected: FAIL because webmaster assets do not exist.

- [ ] **Step 3: Build semantic shell and API client**

Create a neutral VikiTech sidebar/drawer, page header, section mounts, alert region, loading/error/empty containers, and logout. On boot fetch `/api/auth/session`; reject non-Webmasters and render Owner/Admin access level. Use hashes such as `#overview` without adding a router dependency.

- [ ] **Step 4: Build accessible common components**

Confirmation uses `<dialog>` with focus return, Escape/cancel behavior, destructive-tone copy that says archive rather than delete, and a Promise result. Field errors bind with `aria-describedby`; status badges include text; pagination uses buttons and current-page semantics.

- [ ] **Step 5: Render dashboard and safe tenant operations**

Render counts, health, aggregate usage/failures, integration readiness, recent audit, and attention items. Tenant operations show only fields from the aggregate snapshot and contain no links to customer, transcript, feedback-detail, recording, or existing tenant patient screens.

- [ ] **Step 6: Run UI tests**

Run: `node --test test/webmaster-ui.test.js`  
Expected: PASS for shell structure, safe links, role visibility hooks, accessibility primitives, and responsive rules.

- [ ] **Step 7: Commit**

```bash
git add public/webmaster.html public/webmaster.css public/webmaster-api.js public/webmaster-components.js public/webmaster.js test/webmaster-ui.test.js
git commit -m "feat: add webmaster console shell"
```

### Task 10: Tenant, user, and platform-team screens

**Files:**
- Modify: `public/webmaster.html`
- Modify: `public/webmaster.css`
- Modify: `public/webmaster-components.js`
- Modify: `public/webmaster.js`
- Modify: `test/webmaster-ui.test.js`

**Interfaces:**
- Tenant form payload matches Task 5 profile/limits/override validation.
- User forms send password only on create/password replacement and immediately clear the field.
- Lifecycle actions send `{ transition, expectedVersion, reason }` after confirmation.

- [ ] **Step 1: Add failing UI behavior/source tests**

Assert the tenant workflow includes initial admin fields, user rows expose archive/suspend/restore but no delete, owner-only platform-team controls use `data-owner-only`, secret/password fields are never repopulated, and tenant operations have no PII labels.

- [ ] **Step 2: Run UI tests and verify they fail**

Run: `node --test test/webmaster-ui.test.js`  
Expected: FAIL on missing forms and actions.

- [ ] **Step 3: Implement tenant list/detail/create/edit/lifecycle UI**

Include status filter and pagination, extended profile tabs, limits, branding, notes/tags, global-vs-override indicators, initial-admin creation, archive/suspend/restore popups, version conflict refresh, notification warning display, and aggregate-only operations drawer.

- [ ] **Step 4: Implement tenant-user UI**

Include tenant/role/status filters, create/edit, explicit tenant reassignment confirmation, manual password replacement, role changes, archive/suspend/restore, last-admin error display, password clearing after submit, and no credential rendering.

- [ ] **Step 5: Implement Owner-only platform-team UI**

Hide the navigation entry and controls from Admins, while relying on API authorization. Owners can create Webmaster Admins, transition them, and transfer ownership with clear confirmation and last-owner conflict handling.

- [ ] **Step 6: Run UI and service tests**

Run: `node --test test/webmaster-ui.test.js test/webmaster-tenants.test.js test/webmaster-users.test.js`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/webmaster.html public/webmaster.css public/webmaster-components.js public/webmaster.js test/webmaster-ui.test.js
git commit -m "feat: add webmaster tenant and user screens"
```

### Task 11: Integration, policy, notification, and audit screens

**Files:**
- Modify: `public/webmaster.html`
- Modify: `public/webmaster.css`
- Modify: `public/webmaster-components.js`
- Modify: `public/webmaster.js`
- Modify: `test/webmaster-ui.test.js`

**Interfaces:**
- Integration forms consume safe settings plus secret metadata only.
- Blank secret input omits the secret request; nonblank secret input uses the Owner-only replacement endpoint and is cleared immediately.
- Audit/notification lists consume paginated DTOs and provide filters, not export.

- [ ] **Step 1: Write failing no-secret-read and complete-section UI tests**

```js
test('secret controls are write-only and never render stored values', () => {
  const source = read('public/webmaster.js');
  assert.doesNotMatch(source, /secret\.(value|ciphertext|suffix)/);
  assert.match(source, /input\.value\s*=\s*''/);
  assert.match(source, /configured/);
});
```

Assert every requested policy and integration category is present, audit filters exist, notification retry exists, and no export action exists.

- [ ] **Step 2: Run UI tests and verify they fail**

Run: `node --test test/webmaster-ui.test.js`  
Expected: FAIL on missing integration/policy/audit rendering.

- [ ] **Step 3: Implement integration forms**

Render calling/iCallMate, Gemini/AI, Deepgram, SMTP, Slack, webhook, and registered additional providers. Show configured/source/last-updated metadata. Show secret replacement inputs only to Owners, never use placeholder text derived from a stored secret, omit blank values, and clear values after any response.

- [ ] **Step 4: Implement policy forms**

Render application/support identity, timezone/report defaults, plan limits, maintenance/message, feature flags, password/session bounds, rate limits, retention-to-archive classifications, notification templates, and supported providers. Show explicit global, override, and effective values where relevant.

- [ ] **Step 5: Implement audit and notification delivery views**

Add time/actor/action/tenant/target/outcome filters, pagination, safe before/after display, failed-delivery attention states, and retry buttons. Do not add editable audit controls or export.

- [ ] **Step 6: Run UI and security tests**

Run: `node --test test/webmaster-ui.test.js test/webmaster-settings-secrets.test.js test/webmaster-redaction-audit.test.js test/webmaster-notifications-policies.test.js`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public/webmaster.html public/webmaster.css public/webmaster-components.js public/webmaster.js test/webmaster-ui.test.js
git commit -m "feat: complete webmaster settings screens"
```

### Task 12: Full verification, privacy scan, responsive QA, and documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-24-webmaster-console-design.md` only if implementation revealed a factual mismatch
- Modify: affected source/test files only when verification exposes a defect

**Interfaces:**
- No new interfaces; this task verifies the complete release against the spec.

- [ ] **Step 1: Run the entire automated test suite**

Run: `npm test`  
Expected: all existing and new tests PASS with zero failures.

- [ ] **Step 2: Run preservation and sensitive-data source scans**

Run: `rg -n "deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|DELETE FROM" routes src --glob '!scripts/**'`  
Expected: no application-record destructive operation; any infrastructure-only match must be outside application data paths and documented.

Run: `rg -n "password_hash|ciphertext|authTag|recording_url|transcript|review_text|phone|customerName" public/webmaster* routes/webmaster src/webmaster/dashboard-service.js`  
Expected: no secret fields or PII/PHI projection/rendering; legitimate password input and explicit server-side exclusion tests may match only in their narrow validation paths.

- [ ] **Step 3: Start the app and perform role/access smoke tests**

Run: `npm run dev`  
Expected: server starts without configuration/schema errors. Verify Webmaster Owner routes to `/webmaster.html`; Webmaster Admin lacks Owner controls; Support Team, tenant admin, and tenant agent receive 403 for `/api/webmaster`; suspended/archived principals cannot operate.

- [ ] **Step 4: Perform responsive and accessibility QA**

At widths 1440, 1024, 768, 390, and 320 pixels, verify navigation, cards, tables/card rows, forms, dialogs, drawers, focus order, Escape behavior, visible focus, status text, loading/empty/error states, and no horizontal page overflow. Fix any observed issue and rerun `node --test test/webmaster-ui.test.js`.

- [ ] **Step 5: Perform complete workflow smoke tests**

Create a tenant with initial admin; edit profile/limits/overrides; suspend/archive/restore tenant and user; replace a password; manage a Webmaster Admin as Owner; replace each integration secret and verify it cannot be read back; change a policy; enable/disable maintenance; inspect audit events; retry a failed notification; open a tenant operational snapshot and confirm it contains aggregates only.

- [ ] **Step 6: Document operations and recovery**

Update README with console URL, role hierarchy, environment Owner behavior, `WEBMASTER_SECRETS_KEY` generation using `openssl rand -base64 32`, database-over-environment precedence, archive/restore semantics, maintenance recovery, notification retry, and the fact that secrets/PII/PHI cannot be viewed in the console.

- [ ] **Step 7: Re-run full verification and inspect the diff**

Run: `npm test`  
Expected: all tests PASS.

Run: `git diff --check && git status --short`  
Expected: no whitespace errors; only intentional implementation files plus the user's pre-existing unrelated changes are listed.

- [ ] **Step 8: Commit final hardening**

```bash
git add README.md public/webmaster.html public/webmaster.css public/webmaster-api.js public/webmaster-components.js public/webmaster.js routes/webmaster src/webmaster src/models src/auth.js src/api-routes.js src/authorization.js src/config.js src/services/email-service.js services routes index.js test .env.example .env.production.example
git commit -m "feat: complete webmaster platform console"
```
