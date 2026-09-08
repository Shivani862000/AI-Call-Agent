# P00a Authorization Hotfix Execution Plan

**Goal:** Prevent URL spelling and parameter variants from bypassing authentication or ADMIN checks.
**Branch:** `codex/remediation-fixes`. **Schema:** unchanged (`0019`).
**Spec:** [Remediation contract](../2026-09-08-APPLICATION_GAP_REMEDIATION_PLAN.md).

This item implements HTTP authorization only. P03a deployment, P04 database-backed session/privacy checks and P05 callback authentication remain separate items.

- [x] Add DB-free HTTP regressions against the actual entrypoint and registered route patterns. Replace handler bodies with sentinels and block database, provider, dotenv and background-job imports.
- [x] Run the named regression file; capture authentication/role bypass failures before editing production code.
- [x] Extract `createApp` without startup side effects. Replace independent string matching with Express authorization-router boundaries; keep explicit public/provider routes and existing AGENT workflows.
- [x] Serve protected HTML only through explicit authenticated routes. Restrict generic static serving to assets/known public fragments so encoded filenames and normalized paths cannot expose protected pages.
- [x] Keep API auth failures consistently JSON when Express has trimmed a mounted prefix. Enforce ADMIN before validating sensitive operation IDs.
- [x] Address review finding: reproduce duplicate-slash import bypass, reject ambiguous paths before dispatch and verify the regression.
- [x] Run the targeted HTTP/auth/user regressions and actual CSP-header checks through `npm run test:hotfix`; inspect the diff and update evidence. Do not run unrestricted database tests, migrate, push or deploy as part of P00a.

**Result:** Local implementation verified with 22 passing focused tests; no skips. The original DB-free suite failed in four groups before the fix, including anonymous `/API/users`, AGENT `/api/Users`, and anonymous `/Settings.html`. A further duplicate-slash import regression failed before its correction. P03a deployment verification and real DB-backed session/privacy tests remain open. No application/database/provider startup was performed.
