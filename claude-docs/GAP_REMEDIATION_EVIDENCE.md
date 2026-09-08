# Remediation execution evidence

## P00a — HTTP authorization

Date: 8 September 2026. Branch: `codex/remediation-fixes`.
Starting commit: `95015780b0c2f02e415e6bfeb37375e2a735ca4a`.

**Status:** implemented and verified locally; deployment and operational verification pending P03a. This does not close P04's real database-backed session/privacy assessment or P05's provider callback trust work.

Changes:

- Extracted side-effect-free Express construction into `src/app.js`.
- Replaced case-sensitive string/regex access decisions with Express authorization-router boundaries and method-specific public exceptions.
- Rejected duplicate slashes before dispatch so nested mounts cannot bypass outer import permissions.
- Protected sensitive call operations independently of parameter spelling; ADMIN is required before positive safe-integer ID validation.
- Served protected HTML through fixed, authenticated file routes; generic static serving accepts asset types rather than HTML aliases.
- Preserved API JSON auth failures when mounted middleware trims the URL prefix.
- Replaced the old policy/source-text checks with HTTP route and emitted-header regressions; added the explicit DB-free `test:hotfix` command.

Verification:

- **Before:** `node --test test/authorization-routes.test.js` — 1 passed, 4 failed. Actual entrypoint/Express routing reached synthetic sensitive handlers for anonymous `/API/users` and AGENT `/api/Users`, and returned protected `/Settings.html` anonymously. The fourth failure showed a method-independent public exception.
- **Review regression:** the duplicate-slash test initially failed with AGENT `/api/customers//csv` reaching a synthetic handler (204); the early path rejection now returns 400 before dispatch. Patient import variants are covered too.
- **After:** `npm run test:hotfix` — 22 passed, 0 failed, 0 skipped. Covers anonymous/AGENT/ADMIN routing, URL/ID variants, static normalization, public/provider exceptions, valid workflows/assets, signed-token rules, user rules and actual HTTP/HTTPS CSP headers.
- `git diff --check` — passed after whitespace cleanup.

Test boundaries: temporary localhost HTTP listeners; real entrypoint, Express route registration and role middleware; session lookup and external handler bodies replaced with synthetic dependencies. Application DB/provider modules, dotenv loading, WebSocket/background startup and live requests were not executed. No full `npm test`, migrations, live calls, notifications, push or deployment.

The remaining original review IDs retain their planned/open status in the remediation plan. This evidence records one completed implementation item, not completion of the whole programme.

## P04 — Current session state (partial implementation)

Date: 8 September 2026. Branch: `codex/remediation-fixes`. Prerequisite: `5fb21d6`.

The session endpoint now uses authenticated current account state rather than the role in a signed cookie. Inactive/deleted accounts, unknown stored roles and stale-password tokens are rejected; database lookup failure returns 503. Existing cache semantics remain: local app invalidation is immediate, other processes/direct SQL are observed within 30 seconds.

- Before: `node --test test/auth-session-state.test.js` — 1 pass, 7 failures, including an ADMIN session response after demotion and 200 after deactivation.
- After: `node --test test/auth-session-state.test.js test/authorization-routes.test.js test/auth-security.test.js test/user-rules.test.js test/csp-http-deployment.test.js` — 30 pass, 0 fail, 0 skip.
- Real HTTP, signed cookies, authentication middleware, account cache and session handler; synthetic clock and database results. No shared database, provider, dotenv, WebSocket or background startup. Denied cases leave sensitive query/write/provider spies untouched.

P04 is still open for call-response privacy, media/free-text policy, complete route/ID coverage, database-backed revocation and session/logout assurance. No UAT or production verification is claimed.
