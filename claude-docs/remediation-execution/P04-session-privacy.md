# P04 Session and Call Privacy Execution Plan

**Goal:** Make session responses honor current account state and remove restricted contact data from AGENT call responses.
**Branch:** `codex/remediation-fixes`. **Prerequisite commit:** `5fb21d6`. **Schema:** unchanged (`0019`).
**Spec:** [P04 remediation contract](../2026-09-08-APPLICATION_GAP_REMEDIATION_PLAN.md).

Execute inline with the planning, debugging and test-first skills. The user selected groups 3–7, keeping one reviewable item at a time. This bounded P04 implementation uses synthetic database results; full P01 database isolation, the complete route inventory, and operational release checks remain open.

## Session state

Files: modify `src/authorization.js`, `src/api-routes.js`, `test/authorization-routes.test.js`; create `test/support/privacy-app.js`, `test/auth-session-state.test.js`.

- [x] Load the actual auth middleware and API handlers through an allowlisted CommonJS test loader. Substitute only configuration, database/provider boundaries and unused routers. Throw on unknown imports. Bind an ephemeral localhost server and send signed cookies over HTTP.
- [x] Reproduce the session endpoint returning ADMIN for a token whose current account is AGENT, or authenticated for a deactivated/deleted account. Assert `response.body.role === 'AGENT'` after demotion and `response.status === 401` after deactivation.
- [x] Route session inspection through `requireAdminAuth`, and serialize `req.adminSession` instead of re-reading token claims. Preserve the existing 30-second account cache; verify app invalidation and expiry behavior with a controlled clock.
- [x] Check expired tokens, password resets, missing/invalid roles, database failure, API casing and protected mutations. Denied requests must produce no sensitive query/write/provider effects.
- [x] Run the session regressions together with the four `test:hotfix` files; 30 pass, 0 fail/skip. Record results and commit the session fix separately.

## Call response privacy

Files: create `src/call-serialization.js`, `test/call-response-privacy.test.js`; modify `src/api-routes.js`, `src/authorization.js` and affected UI consumers.

- [x] Record the AGENT recording/transcript/PDF decision before changing those permissions. Working product assumption, announced while the optional user question remains unanswered: ADMIN-only media, reports, supervisor payloads and inline analysis/transcript text. AGENT retains operational call metadata and existing masked contact labels. This is an implementation choice pending product confirmation, not a claim the full P02 policy assessment is closed.
- [x] Send real HTTP requests to recent, detail, incoming and live call endpoints with synthetic contact and provider-payload sentinels. AGENT JSON must exclude raw contacts; ADMIN JSON must preserve authorized data. Cover nested analysis/patient/queue content and in-memory rows.
- [x] Introduce one role-aware serializer on all four call read responses. Preserve a useful masked contact label in desktop/mobile queue rendering and search. Apply the working free-text/media policy consistently to inline fields and direct endpoints.
- [x] Verify allowed workflows and denied requests before query/network/file effects; the eight call-privacy tests plus session/hotfix suite pass (38 total, no failures/skips). Parse the modified customer-page script, update evidence and commit.

Still open in P04: full nested router/method/ID inventory, database-backed revocation and multi-process session/logout assurance, broader patient/queue free-text policy, and authenticated browser verification. This plan does not claim these gates are complete.

Rollback: revert the individual implementation commit on this branch. No migration, live DB access, provider call, push or deployment is part of this item. A code rollback would restore the identified exposure and requires an access restriction before release.
