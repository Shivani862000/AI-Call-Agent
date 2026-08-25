# Tenant User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tenant administrators a safe, responsive UI and tenant-scoped API for managing all administrator and agent accounts in their tenant.

**Architecture:** Reuse the existing `createUserService` tenant operations and strengthen them with actor self-protection. Replace the legacy agent-only router with a dependency-injectable tenant-user router while preserving its old endpoints, then add a dedicated app-shell page with its own client controller and styles.

**Tech Stack:** Node.js, Express 4, Mongoose 8, bcrypt, browser-native HTML/CSS/JavaScript, Node test runner

**Spec:** `docs/superpowers/specs/2026-08-25-tenant-user-management-design.md`

## Global Constraints

- Tenant users may have only `CLIENT_ADMIN` or `CLIENT_AGENT` roles.
- Every user lookup and mutation must be scoped by `req.tenantId`.
- A tenant administrator cannot demote, suspend, archive, or reset the password of their own account.
- An active tenant must always retain at least one active `CLIENT_ADMIN`.
- Password values and hashes must never appear in API responses or rendered UI.
- Existing `/api/users/agents` endpoints remain compatible.
- No schema expansion, invitation emails, or hard deletion is included.

---

### Task 1: Strengthen tenant-user domain safeguards

**Files:**
- Modify: `src/webmaster/user-service.js`
- Modify: `test/webmaster-users.test.js`

**Interfaces:**
- Consumes: existing `createUserService({ UserModel, TenantModel, ... })`
- Produces: existing `updateTenantUser`, `replacePassword`, and `transitionTenantUser` methods with self-protection based on `actor.username`

- [ ] **Step 1: Write failing self-protection and out-of-tenant tests**

Add tests with a `UserModel.findOne()` query stub returning `{ _id: 'self', username: 'admin', tenantId: 't1', role: 'CLIENT_ADMIN', status: 'active', __v: 1 }`. Assert that:

```js
await assert.rejects(
  service.updateTenantUser('t1', 'self', {
    username: 'admin', email: 'admin@example.test', role: 'CLIENT_AGENT'
  }, 1, { username: 'admin' }),
  error => error.code === 'SELF_ROLE_CHANGE_FORBIDDEN' && error.status === 403
);

await assert.rejects(
  service.transitionTenantUser('t1', 'self', 'suspend', 1, { username: 'admin' }),
  error => error.code === 'SELF_STATUS_CHANGE_FORBIDDEN' && error.status === 403
);

await assert.rejects(
  service.replacePassword('self', 'long-enough-password', 1, { username: 'admin' }, 't1'),
  error => error.code === 'SELF_PASSWORD_CHANGE_FORBIDDEN' && error.status === 403
);
```

Also verify an out-of-tenant ID produces `USER_NOT_FOUND` without calling `findOneAndUpdate`.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test test/webmaster-users.test.js`

Expected: FAIL because self-targeted tenant operations are currently allowed and password replacement does not load the target first.

- [ ] **Step 3: Implement self-protection in the service**

Add focused helpers:

```js
function isSelf(user, actor) {
  return Boolean(user?.username && actor?.username && user.username === actor.username);
}

function rejectSelfRoleChange(user, patch, actor) {
  if (isSelf(user, actor) && patch.role != null && patch.role !== user.role) {
    throw problem(403, 'SELF_ROLE_CHANGE_FORBIDDEN', 'You cannot change your own tenant role');
  }
}
```

Call the role helper after `updateTenantUser` loads its tenant-scoped target. In `transitionTenantUser`, reject a self-targeted transition unless it leaves the current status unchanged. In `replacePassword`, when `tenantId` is supplied, first load `{ _id: id, tenantId }`, return `USER_NOT_FOUND` when absent, and reject a matching actor username before hashing or updating. Retain the existing version filters and last-active-admin transaction guard.

- [ ] **Step 4: Run focused service tests**

Run: `node --test test/webmaster-users.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the domain change**

```bash
git add src/webmaster/user-service.js test/webmaster-users.test.js
git commit -m "feat: guard tenant user administration"
```

---

### Task 2: Expose complete tenant-scoped user HTTP APIs

**Files:**
- Modify: `routes/users.js`
- Create: `test/tenant-users-http.test.js`

**Interfaces:**
- Consumes: `createUserService` methods from Task 1 and `req.adminSession`, `req.tenantId`
- Produces: `createUsersRouter({ userService })` plus the existing default router export; HTTP endpoints `GET/POST /`, `PATCH /:userId`, `POST /:userId/password`, and `POST /:userId/lifecycle`

- [ ] **Step 1: Write failing router composition tests**

Build an Express test app that injects `req.adminSession` and `req.tenantId`, mounts `createUsersRouter({ userService })`, and records service calls. Verify:

```js
assert.equal((await fetch(`${base}?role=CLIENT_ADMIN&status=active&search=ann`)).status, 200);
assert.equal((await fetch(base, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'ann', email: 'ann@example.test', role: 'CLIENT_ADMIN', password: 'temporary-pass' })
})).status, 201);
assert.equal((await fetch(`${base}/u1`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ patch: { username: 'ann', email: 'ann@example.test', role: 'CLIENT_AGENT' }, expectedVersion: 2 })
})).status, 200);
```

Cover password and lifecycle endpoints, `CLIENT_AGENT` receiving `403`, tenant ID always coming from the request rather than the body, and a `WebmasterError` retaining its status/code/field errors.

- [ ] **Step 2: Run the router tests and confirm they fail**

Run: `node --test test/tenant-users-http.test.js`

Expected: FAIL because `createUsersRouter` and the full endpoints do not exist.

- [ ] **Step 3: Refactor the router and preserve agent compatibility**

Implement `createUsersRouter({ userService = defaultUserService } = {})`. Instantiate the default service with `User`, `Tenant`, `mongoose.startSession`, an audit service, and the global password policy. Apply one router-level middleware:

```js
router.use((req, res, next) => {
  if (req.adminSession?.role !== 'CLIENT_ADMIN') {
    return res.status(403).json({ error: 'Only tenant administrators can manage users' });
  }
  return next();
});
```

Normalize list pagination to `page >= 1`, `1 <= pageSize <= 100`, and pass only `role`, `status`, and a 100-character `search`. Translate `WebmasterError` with `res.status(error.status).json(error.toResponse())`; return a generic `500` response for other errors. Keep `/agents` list/create/archive/restore as adapters that force role `CLIENT_AGENT` and use the same service.

Export both forms:

```js
const router = createUsersRouter();
module.exports = router;
module.exports.createUsersRouter = createUsersRouter;
```

- [ ] **Step 4: Run router and legacy authorization tests**

Run: `node --test test/tenant-users-http.test.js test/auth-security.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the API change**

```bash
git add routes/users.js test/tenant-users-http.test.js
git commit -m "feat: add tenant user management api"
```

---

### Task 3: Add the tenant administrator user-management page

**Files:**
- Create: `public/users.html`
- Create: `public/users.js`
- Create: `public/users.css`
- Modify: `public/app-shell.js`
- Modify: `src/auth.js`
- Create: `test/tenant-users-ui.test.js`

**Interfaces:**
- Consumes: `window.AppShell.fetchJson`, `escapeHtml`, `ensureAuthenticatedSession`, `showAlert`, and Task 2 `/api/users` endpoints
- Produces: responsive `/users.html`; `UsersPage` controller functions for list, forms, pagination, and lifecycle actions; role-gated desktop/mobile navigation

- [ ] **Step 1: Write failing UI contract tests**

Read static files and assert:

```js
assert.match(html, /id="userSearch"/);
assert.match(html, /id="userRoleFilter"/);
assert.match(html, /id="userStatusFilter"/);
assert.match(html, /id="userFormModal"/);
assert.match(source, /\/api\/users/);
assert.match(source, /expectedVersion/);
assert.match(source, /CLIENT_ADMIN/);
assert.match(source, /CLIENT_AGENT/);
assert.doesNotMatch(source, /password_hash|innerHTML\s*=.*password/i);
assert.ok(PROTECTED_HTML_PATHS.has('/users.html'));
```

Also assert `app-shell.js` appends `/users.html` only after a `CLIENT_ADMIN` session is known, and CSS includes `:focus-visible`, `prefers-reduced-motion`, and a mobile breakpoint.

- [ ] **Step 2: Run the UI tests and confirm they fail**

Run: `node --test test/tenant-users-ui.test.js`

Expected: FAIL because the page assets and protected path do not exist.

- [ ] **Step 3: Implement page shell and forms**

Build `users.html` with the existing `.app-shell`, `.sidebar`, `.page-header`, `.table-card`, `.table-wrap`, `.modal-backdrop`, and `.poc-form-grid` patterns. Include semantic labels, an alert container, loading/empty states, server-pagination controls, a create/edit modal with username/email/role and create-only password, a password-reset modal, and a confirmation modal for lifecycle operations. Load `app-shell.js` before `users.js`.

- [ ] **Step 4: Implement the browser controller**

Maintain state:

```js
const state = {
  session: null, items: [], page: 1, pageSize: 25, total: 0, totalPages: 1,
  filters: { search: '', role: '', status: '' }, editing: null, pendingAction: null
};
```

Use `URLSearchParams` for list calls. Escape every user-controlled rendered value. Disable self role/lifecycle/password actions client-side by comparing `item.username` with `state.session.username`, while treating the API as authoritative. Send `expectedVersion` with every update. On successful mutation, close the modal, show a success alert, and reload the current page; if an archive empties the page, load the previous page. Display `fieldErrors` next to inputs and keep modal state on failure.

- [ ] **Step 5: Add responsive and accessible styles**

Use a desktop table at widths above 720px and user cards below it. Ensure buttons have visible focus states, dialogs scroll within the viewport, destructive actions use the existing danger palette, status/role badges do not rely on color alone, and reduced-motion disables transitions.

- [ ] **Step 6: Add role-gated navigation and page protection**

Add `/users.html` to `PROTECTED_HTML_PATHS`. In `ensureAuthenticatedSession`, when `session.role === 'CLIENT_ADMIN'`, append the Users item to `NAV_ITEMS`, rebuild the generated mobile tab bar, and append a Users link to existing `.nav-list` and `.mobile-dock` navigation only when absent. A direct visit by `CLIENT_AGENT` must redirect to `/admin.html` from `users.js` after session resolution.

- [ ] **Step 7: Run UI tests**

Run: `node --test test/tenant-users-ui.test.js`

Expected: PASS.

- [ ] **Step 8: Commit the UI change**

```bash
git add public/users.html public/users.js public/users.css public/app-shell.js src/auth.js test/tenant-users-ui.test.js
git commit -m "feat: add tenant user management ui"
```

---

### Task 4: Verify compatibility and complete the feature

**Files:**
- Modify if required by failures: files changed in Tasks 1–3 only

**Interfaces:**
- Consumes: complete tenant-user management service, API, and UI
- Produces: verified feature with no regressions

- [ ] **Step 1: Run all tenant-user focused tests together**

Run: `node --test test/webmaster-users.test.js test/tenant-users-http.test.js test/tenant-users-ui.test.js test/auth-security.test.js`

Expected: PASS with zero failures.

- [ ] **Step 2: Run repository formatting checks**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 3: Run the complete automated test suite**

Run: `npm test`

Expected: all tests pass. If a pre-existing failure is unrelated, rerun the failing test against the pre-feature commit to establish that baseline before reporting it.

- [ ] **Step 4: Review tenant isolation and secret handling**

Search the implementation:

```bash
rg -n "findOne|findOneAndUpdate|countDocuments" routes/users.js src/webmaster/user-service.js
rg -n "password_hash|password" public/users.html public/users.js
```

Confirm every management mutation delegates with `req.tenantId`, no request body tenant ID is used, and browser code contains no password rendering or persisted password state.

- [ ] **Step 5: Commit any verification-only fixes**

```bash
git add routes/users.js src/webmaster/user-service.js public/users.html public/users.js public/users.css public/app-shell.js src/auth.js test/webmaster-users.test.js test/tenant-users-http.test.js test/tenant-users-ui.test.js
git commit -m "fix: complete tenant user management verification"
```
