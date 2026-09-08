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

## P04 — Call response privacy (partial implementation)

Date: 8 September 2026. Prerequisite: `6869a5f`.

- One shared serializer limits AGENT recent/detail/incoming/live responses to operational fields and masked contact labels. Raw phones/emails, provider payloads, nested joins, transcripts, analysis and recording references are excluded; ADMIN retains authorized data.
- Working product assumption announced after an optional clarification: media, transcript, analysis PDF and supervisor-payload reads require ADMIN. The same restriction covers inline free text. The unanswered clarification remains a policy confirmation item; P02 is not complete.
- Read/export/media call IDs reject zero, noncanonical spellings and overflow before effects. Recordings and transcript responses use `no-store`. Desktop/mobile queue labels and search preserve masked contacts.
- Before: `node --test test/call-response-privacy.test.js` — 1 pass, 7 fail, reproducing raw contact leaks in all four read paths, AGENT media dispatch, invalid-ID dispatch and transcript caching.
- After: `node --test test/call-response-privacy.test.js test/auth-session-state.test.js test/authorization-routes.test.js test/auth-security.test.js test/user-rules.test.js test/csp-http-deployment.test.js` — 38 pass, 0 fail, 0 skip. Customer page inline JavaScript parses successfully; `git diff --check` is clean.
- Test boundary: real HTTP/auth/serialization and route handlers with synthetic database rows, analysis results and in-memory state. No real database/provider/storage/PDF access. Browser behavior, all nested routers, broader patient free text and real database sessions remain unverified.

These two P04 changes are locally implemented; P04 as a whole and its release gates remain open.

## P05 — Legacy callback containment (partial implementation)

Date: 8 September 2026. Prerequisite: `9710dd2`.

- `/call/status` and `/call/recording-status` default to 404 before database access. Explicit legacy enablement requires the existing configured header/query provider secret; missing/wrong/array credentials return 401, including requests carrying an ADMIN cookie.
- Removed full query logging from the status handler. Environment examples document `ENABLE_LEGACY_CALL_WEBHOOKS=false`. The canonical callback's supported string-credential behavior is retained.
- Before: four legacy HTTP regressions failed; a separate credential-shape regression failed (array accepted). After: the named legacy/webhook/privacy/session/hotfix suite passes 45 tests, with no failures/skips; also available as `npm run test:remediation`.
- Verification uses synthetic credentials, real handlers/middleware and intercepted database boundaries. An authenticated status fixture reaches its read handler without logging the secret. No live provider configuration or database was inspected or changed.

Provider use of legacy URLs and exact recording origins are pending user/integration evidence. This is containment, not verified restoration of provider compatibility. P05 recording fetch hardening and callback schema checks, and P10 replay/correlation remain open. No deployment is authorized by this evidence.

## P06 — Database log privacy (partial implementation)

Date: 8 September 2026. Prerequisite: `d0f3f61`.

- Configuration snapshots report the selected database source variable and presence instead of its URL. Initialization and idle pool errors use a fixed diagnostic mapping; arbitrary driver messages/causes are not propagated from initialization. Failed pools are closed.
- Before: `node --test test/config-redaction.test.js` — 3 failures, reproducing raw URL/password/query-token logging and driver-message propagation.
- After: redaction plus existing database URL selection tests — 11 pass. Combined `npm run test:remediation` — 56 pass, 0 fail, 0 skip. `git diff --check` is clean.
- The real configuration snapshot and DB initialization code run with an inert dotenv and fake pool; no database connection or real credentials are loaded. Success uses a synthetic `0019` schema row. This does not establish real schema/runtime compatibility.

P06 remains open for Docker context/image-layer exclusion proof, runtime upgrade and full isolated image startup, broader application/provider error paths, and operational credential-exposure assessment. P04–P06 are partial local implementations, not complete release gates.
