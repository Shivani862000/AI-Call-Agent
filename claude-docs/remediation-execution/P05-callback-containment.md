# P05 Legacy Callback Containment Execution Plan

**Goal:** Prevent unauthenticated legacy status/recording callbacks from mutating calls.
**Branch:** `codex/remediation-fixes`. **Prerequisite:** `9710dd2`. **Schema:** unchanged (`0019`).
**Spec:** [P05 and provider containment contract](../2026-09-08-APPLICATION_GAP_REMEDIATION_PLAN.md).

Repository search found legacy handlers but no active application URL generator targeting them. This does not prove the provider dashboard has no consumers. The user has been asked for active legacy routes and exact recording origins. The canonical iCallMate callback already supports a configured header/query secret; no provider signature capability is assumed.

Files: modify `src/icallmate-webhook.js`, `src/api-routes.js`, `.env.example`, `test/support/privacy-app.js`, `test/support/authorization-app.js`; create `test/legacy-callback-auth.test.js`.

- [x] Reproduce HTTP access to `/call/status` and `/call/recording-status` with no credential, using real handlers and synthetic DB boundaries. Expect 404 while disabled and zero effects.
- [x] Add `requireLegacyCallWebhook(req, res, next)`: default disabled; only explicit `ENABLE_LEGACY_CALL_WEBHOOKS=true` activates it. Enabled requests require the existing timing-safe header/query secret check before handler execution. Missing or invalid credentials return 401; array-shaped credentials are rejected.
- [x] Attach the guard to both actual route registrations, including all methods handled by `/call/status`. Test case/trailing slash and signed user cookies cannot bypass provider authentication.
- [x] Remove raw callback query logging because a verified provider may supply the secret there. Test synthetic secrets are absent from captured logs.
- [x] Run the focused legacy/webhook/session/privacy/hotfix suite; 45 pass, no failures/skips. Add the explicit DB-free `test:remediation` command, update evidence and commit this containment item.

Enablement requires confirmation that active provider clients can send the configured credential. Default disablement is containment, not restored legacy compatibility. No deployment occurs here. Recording retrieval, payload validation, canonical callback replay/correlation and provider fixtures remain open P05/P10 work. Restore only via a reviewed authenticated configuration; reverting the guard reopens mutation access.
