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

Provider use of legacy URLs and exact recording origins are pending user/integration evidence. This is containment, not verified restoration of provider compatibility. P05 recording fetch hardening and callback schema checks were subsequently verified below; P10 replay/correlation remains open. No deployment is authorized by this evidence.

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

## P07 — Import and schedule preservation

Date: 9 September 2026. Prerequisites: reviewed P01 `ed9a3e6`, controller baseline `5ff850e`. Implementation `c1fba27`, review fixes `346d294`; independent spec and quality review approved the final scoped change. [Execution plan](remediation-execution/P07-import-schedule-preservation.md).

- Imports carry header presence into allowlisted update patches. Omitted fields and all existing contact restrictions survive; explicit nullable blanks clear visibly, and blank required fields/non-nullable language reject. Creates use separate defaults. Protected restriction headers cannot become writes through an internal header map.
- Preview resolves reference and normalized phone, reports conflicts/duplicate targets, and captures `xmin`. Confirmation locks and revalidates each patient in `dbTx`, rejects stale/deleted/newly conflicting identities, and applies only previewed fields. Tokens remain user-owned, expiring and single use. The UI shows bounded field changes/clears and actionable failures; consumed-token confirmation remains disabled until a new preview succeeds.
- Schedule edits compare instants, preserving retry/status/attempt/manual/lock state for equivalent times and unrelated edits. Validation checks the exact persisted instant and component consistency in Asia/Kolkata; past, disallowed-hour and impossible calendar timestamps reject without writes. Valid changed future schedules retain supported rescheduling behavior.

Behavior and verification:

- Initial regressions: import unit **12 pass / 5 fail**; actual schedule routes **0/2 pass**; actual import routes **0/5 pass**, reproducing the reported defects.
- Initial implementation: complete audited unit suite **315 passed**, including authorization/session/privacy tests; import routes **5 passed** and schedule routes **2 passed**. The sandbox's loopback-listen denial was resolved by the authorized local-binding rerun, which passed.
- Review found validation of a different timestamp from the one saved and permissive normalization of an impossible date. Final targeted results: import unit **17 passed**, import route/DB **6 passed**, schedule route/DB **3 passed**; no failures/skips. The latter cover canonical-time rejection and exact no-write assertions, valid offset equivalence and actual rescheduling.
- Added a fault after a real transactional import update: the failed row's exact values, `updated_at` and `xmin` are restored, a sanitized failure is returned, and another valid row commits. This adds missing rollback evidence around the existing real `dbTx`; it is not a claim that the prior transaction implementation was broken.
- Inline patient-page script parsing, JavaScript syntax and `git diff --check` passed. Full unit tests were not redundantly repeated after the scoped fix; affected files were rerun and independently reviewed.

The tests use actual patient/customer routers and guarded application DB helpers with owned, nondialable fixtures and inert provider boundaries. The 5 MiB/5,000-row limits and ADMIN import guards remain. Schema stays `0019`; no live data or external service was used. P08 owns ordinary patient/contact edits and P16 owns batching/multi-instance import persistence. Hosted CI, browser workflows and rollout remain separate evidence gates.

## P05 — Recording and callback boundaries

Date: 9 September 2026. Implementation `2582266`, independent scoped spec and quality review approved. [Execution plan and detailed evidence](remediation-execution/P05-recording-boundaries.md). Schema remains `0019`.

The real pipeline download and authenticated playback share exact-origin HTTPS retrieval, validation of every DNS answer, pinned TLS, streaming size/type/deadline limits, independently validated opt-in redirects and client cancellation. Callback shape/size and recording metadata are validated before effects. Storage signing validates object keys, configured origin and returned destination; failures omit raw external errors. Playback responses, including denial, use private/no-store.

Initial regressions reproduced arbitrary pipeline/playback destinations and malformed callbacks reaching processing. Final audited `npm run test:unit`: **336 passed**, no failures, cancellations or skips; includes ten retrieval, seven actual consumer/callback and four storage boundary tests. Diff checks passed. No DB schema/query changed, so no repeated DB suite was needed. Expected test diagnostics remain a nonblocking fixture cleanup item for P06/final review.

Controller verified preserved ADMIN media/transcript/analysis guards and scalar-secret legacy authentication. Provider origins and representative fixtures are still unavailable: empty origins deny retrieval and redirects default disabled. This is local boundary verification, not provider compatibility or rollout evidence. P10 replay/correlation and P12 successful-audio lifetime/recovery remain separate work. No live provider, storage or database access, deployment or notification was used.

## P06 — Dependency compatibility and audit

Date: 9 September 2026. Implementation `3089b35`, scoped review fix `f47f739`; independent spec/quality review approved. [Execution plan and initial evidence](remediation-execution/P06-runtime-packaging.md). Schema remains `0019`.

Pinned csv-parse 7.0.2, Multer 2.3.0 and Nodemailer 9.1.1, plus a documented qs 6.16.0 override. Express stays at 4.22.2 with body-parser 1.20.6. The fresh baseline audit reported six vulnerable package entries (four moderate, two high); the final unchanged dependency graph reports **zero vulnerabilities**. This is the audit result at verification time, not a guarantee against later advisories.

The CSV prototype regression failed against 5.6.0 and passed after update. Actual CSV/XLSX import, production form/query parsers, customer upload bounds and captured mail composition passed. Final audited unit suite: **342/342** on local Node 22.22.2. The owned Node24/PostgreSQL17 harness initially passed seven patient import tests; review added exact malformed and over-5MiB patient Multer checks, bringing that focused suite to **9/9**, with no returned token, count change or sentinel mutation/version change. Dependency audit and full unit suite were not repeated for this test-only follow-up.

No production adapters, framework-major change, live DB/provider/SMTP operation or deployment was needed. Node24 production-image, context exclusion and representative-operation evidence is recorded in the P06 execution plan and was completed at `5eaa886`; provider/log-path inventory and historical exposure assessment remain Task 3.

## P08 — Contact policy, refusal precedence and schema-free suppression (Task 1 partial)

Date: 9 September 2026. Prerequisites: reviewed P01/P07; durable contact revisions and attempt admission remain P09/P10 work in migration `0021`.

- Added `src/contact-policy.js` as the shared compatibility boundary. Canonical consent is `unknown|granted|refused`; legacy `denied` maps to `refused` and `pending` to `unknown`. Boolean parsing treats string `false`, `0` and `off` as false, avoiding truthiness-based do-not-call writes.
- Conversation outcome detection now uses patient/customer/user transcript turns when speaker labels exist, evaluates wrong-number and refusal phrases before callbacks and positive-interest phrases, and does not use assistant-only wording as patient permission. The previous pure reproduction (`CUSTOMER: I am not interested.` → `interested`) is covered by the fixed regression.
- Queue rules, scheduler filtering and manual call admission all honor refused consent, do-not-call and wrong-number restrictions. Ordinary customer/patient edits reject invalid consent and cannot relax an existing restriction; `applyCallOutcomeWorkflow` no longer turns `consent_given` or ordinary completion into a consent grant. Wrong-number/not-interested outcomes persist a monotonic patient restriction using a null-safe predicate.
- Focused verification: `node --test test/contact-policy.test.js test/queue-rules.test.js test/patient-rules.test.js test/call-orchestration.test.js` — **28 passed, 0 failed, 0 skipped**. These tests are pure and use no database, provider, storage, notification or network boundary.

Task 1's two-worker refusal/stale-completion race, rollback after a dependent-write failure and provider-no-submit assertion remain open. The initial `0021` contact-event transaction and queue cancellation are now implemented and covered by the P09 focused DB test; full writer cutover, restoration endpoint and race evidence remain open, so P08 is not complete.

## P06 — Provider metadata log redaction follow-up

Date: 9 September 2026. Prerequisite: dependency/runtime work reviewed at `5eaa886`.

- `services/icallmate.js` now removes secret-bearing request/response fields (`ukey`, token, secret, API-key and authorization variants) recursively before metadata is returned to call routes for persistence or logging. Signed URL query values are replaced with `[redacted]`; existing callback/media URL handling is preserved.
- `node --test test/icallmate-log-privacy.test.js` passed **1/1** using synthetic credentials only. No provider, storage, database, mail or notification boundary was contacted.
- Historical system logs/image layers and live credential rotation remain operational assessments; this local change does not claim past exposure did or did not occur.

## P09 — Outbound admission contract (partial)

Date: 9 September 2026. Dependencies: schema-free P08 policy; durable attempt/contact lifecycle remains P09/P10 migration `0021` work.

- Added `services/outbound-admission.js` with deterministic attempt request keys, same-key idempotency, mismatched-payload conflict detection, current contact restriction checks, pause/capacity/daily-limit/cooldown decisions and explicit provider `submitted`, `rejected` and `submission_unknown` states. Unknown provider results are retained rather than treated as safe retries.
- Focused verification: `node --test test/outbound-admission.test.js` — **5 passed, 0 failed, 0 skipped**. Tests are pure and use no provider or database boundary.

The durable follow-up added migration `0021_contact_and_call_attempts.sql`, `reserveOutboundAttempt`/`recordAttemptSubmission`, and routed `/call/start`, `/api/calls/initiate/:customerId`, `/api/icallmate/outgoing-call`, the legacy `routes/calls.js` initiator and the scheduler through the reservation. Focused disposable PostgreSQL verification passed **1/1**; the audited database suite passed **36/36** and the isolated unit suite passed **355/355**. Two-worker race proof, provider replay/uncertainty reconciliation and event/media identity remain open; P09 is not complete.

## P10 — Exact call-event correlation (partial)

Date: 9 September 2026. Dependencies: P09 durable attempts and provider capability evidence.

- Added `src/call-events.js` with exact attempt/request/provider matching. Supplied unknown IDs remain unmatched; phone-only compatibility is off by default and only accepts one eligible candidate when explicitly enabled.
- Added `0022_call_event_inbox.sql` and routed the authenticated iCallMate callback through durable event quarantine before matched call updates. Outbound provider extra parameters now carry the attempt/request identity, and outbound media hydration prefers those identifiers over phone recency.
- Verification: identity tests **7/7**, isolated unit suite **362/362**, isolated PostgreSQL suite **36/36** on schema `0022`. Transport/disposition transition fencing, provider-ID historical audit and restart/timeout reconciliation remain open; P10 is not complete.

## P11 — Durable post-call job ownership (partial)

Date: 9 September 2026. Prerequisite: P09/P10 local lifecycle slices. [Execution plan and detailed evidence](remediation-execution/P11-post-call-jobs.md).

- Migration `0023_post_call_jobs.sql` adds revisioned, RLS-protected stage-job rows with retry state, due indexes, claim leases/tokens and call-delete cascade.
- `services/post-call-jobs.js` provides deterministic input revisions, bounded retry delays, row-locked claims and token-fenced completion/failure transitions. The post-call pipeline claims before work and records blocked/retry state for missing input or processing errors.
- Verification: isolated unit suite **364/364** and isolated PostgreSQL suite **37/37** passed after migrating through schema `0023`. The focused DB regression covers duplicate claims, wrong-token completion, retry state and cascade cleanup.

Stage-specific recovery, token-fenced final effects, boot/restart scans, notification outbox delivery and legacy backfill/reconciliation remain open. This is durable job ownership, not a claim of exactly-once completion. No provider, notification, storage or deployment boundary was used.
