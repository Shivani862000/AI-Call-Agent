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

## P00b — Additional pure behavior reproductions

Date: 9 September 2026. Application behavior baseline: `8aa79ec`; P01 infrastructure changes are concurrently uncommitted and were not used by these reproductions.

An explicitly audited DB-free Node stdin program, launched with `env -i PATH="$PATH" NODE_ENV=test node`, imported only the pure `services/call-orchestration.js` and `src/patient-import.js` code (the latter's helper/config dependencies do not initialize DB, dotenv, providers or timers). It used a nondialable all-zero fixture number and an `example.invalid` email. No file, database, provider or notification mutation occurred.

- F05: `detectConversationOutcome({ transcriptText: 'CUSTOMER: I am not interested.' })` returned `interested`, failing the expected `not_interested` assertion.
- F04: a first-name/phone-only import matching a refused, suppressed, inactive patient generated an update payload containing `consent_status: unknown`, `do_not_call: 0` and `status: active`.
- F04: that same upload generated `notes: null` and `email: null` despite neither column being present.

Result: three intended behavior failures, exit 1. This proves the pure classification/payload defects; persisted import behavior and contact-event races still require P07/P08 real-route/database regressions. No post-fix result is claimed here.

Additional F17/F18 baseline on 9 September: the unchanged actual `services/reporting.js` module was evaluated in a VM with its sole `../db` import replaced by synthetic results (two scalar queries/five list queries asserted). No application DB module, dotenv, provider, timer or network was loaded. Calling `buildReportData` with one positive unrated call produced `service_recovery_count: 1` instead of 0. Supplying ten negative rated calls produced a recovery total of 6 instead of 10, reproducing the display-limit-derived count. Both checks failed as intended (exit 1). This proves report classification/aggregation behavior with known inputs; P14 still needs real SQL population and rendered-output verification.

## P01/P02 — Deployed PostgreSQL major verification

Date: 9 September 2026. The user identified Supabase as the managed database. Read-only navigation in the already-authenticated Supabase dashboard showed these **Service versions → Postgres version** values:

| Project | Reported version | Evidence surface |
| --- | --- | --- |
| `ai-call-agent-kcpathdb-dev` | `17.6.1.166` | [General settings](https://supabase.com/dashboard/project/zedslcznathmuaetllgn/settings/general) |
| `ai-call-agent-kcpathdb` | `17.6.1.166` | [General settings](https://supabase.com/dashboard/project/quaorcrmgmzozjbehadl/settings/general) |

This resolves the PostgreSQL-major prerequisite for a PG17 lab. It does not establish equivalence of Supabase extensions, roles, view grants, storage policies or production behavior. No SQL was executed, records read, credentials revealed, settings saved or service lifecycle action taken. The temporary research tab was closed afterward.

The production project overview also displayed an Advisor warning for the `public.customer_queue` SECURITY DEFINER view and a “No backups” overview label. Those are actionable inputs for P03/P04 permission and recovery assessment; they are not proof of an exposed Data API or absence of an independently managed backup. Neither was dismissed or modified.

## P01 — Disposable database testing and fixture cleanup

Date: 9 September 2026. Implementation commits `fe84465`, `75a1f49`, `1d41757`, `5a6945c`, `ed9a3e6`; supporting task documentation `4b9c8cf`. [Execution plan and detailed evidence](remediation-execution/P01-isolated-tests.md).

- Audited explicit unit/DB manifests reject unknown, stale and empty selections. `npm test` is a safe unit alias; `test:isolated` runs the audited unit and database groups. The browser command explicitly fails until P17 supplies its harness. Both workflow test jobs use the isolated command; no actual GitHub Actions run is claimed.
- UUID-owned PostgreSQL and Node workloads use an inspected internal Docker network with no published DB port, minimal synthetic environment, nondialable fixtures and purpose-bound connection identities checked before client construction. The lab pins PostgreSQL 17.6 and the available Node 24.20.0 image by digest. Application tests use a non-superuser trusted server login; migration ownership is separate.
- Synthetic anon/authenticated roles cannot read a real application-visible patient sentinel, perform schema DDL or assume the owner role. A controlled RLS-disabled negative case exposes that same sentinel, then restores RLS and reconfirms denial. This establishes the tested base-table boundary; the existing `customer_queue` SECURITY DEFINER view and actual Supabase grants remain P04 work.
- Test staging excludes nested environment, service-account/client-secret/Gmail-key variants, key material, archived databases/backups and symlinks. All exclusion experiments use dummy files in a separate temporary fixture directory.
- Cleanup tracks durable call IDs as well as queue/patient ownership. Injected assertion and migration failures clean or roll back their owned effects. SIGINT during workload and a deterministic pre-assignment provisioning barrier both leave no UUID-owned Docker resources; final cleanup retries the resource inventory after in-flight creation settles.

Verification sequence, with no unexpected skips:

- Initial complete isolated run: **307 unit + 18 DB assertions passed**, 19 fresh migrations, zero on repeat. Preserved remediation suite: **56 passed**; safe `npm test` alias: **307 passed**.
- After restricted-role/fixture fixes: full DB suite **20 passed**. Later targeted staging/identity checks **6 passed**; final role suite at `ed9a3e6` **5 passed**, including existing-row RLS, negative control and zero-client rejection for missing/mismatched identities. Full suites were not redundantly repeated after these scoped test-only refinements.
- Intentional outer migration failure and interrupted runs exited nonzero and reported `cleaned: true`; exact-name Docker inspection found no owned network/container. Syntax and `git diff --check` passed.

No shared database, genuine credential, provider, call or notification was used. Supabase extension/role equivalence, production image compatibility, deployment isolation and browser coverage retain their separate release gates.
