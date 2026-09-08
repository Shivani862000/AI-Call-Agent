# P06 Database Log Privacy Execution Plan

**Goal:** Keep database credentials out of configuration, pool-error and initialization-failure output.
**Branch:** `codex/remediation-fixes`. **Prerequisite:** `d0f3f61`. **Schema:** `0019` unchanged.
**Spec:** [P06 remediation contract](../2026-09-08-APPLICATION_GAP_REMEDIATION_PLAN.md).

This is the DB-free logging portion of P06. Runtime/image compatibility, sanitized Docker context proof, broader application/provider logs and incident/rotation assessment remain open.

Files: modify `src/config.js`, `db.js`; create `test/config-redaction.test.js` and `src/database-error.js` only if a shared safe error mapping is needed.

- [x] Execute configuration snapshots with synthetic URL-encoded passwords and query tokens; assert no full URL or credential appears and the selected database configuration is still reported as present.
- [x] Execute the actual `initializeDatabase` function with an inert dotenv and fake `pg.Pool`. Simulate failed connect and idle pool errors containing credentials; capture output and thrown errors. No connection or environment file is loaded.
- [x] Replace the raw database URL in snapshots with selected source-variable and presence metadata. Limit database diagnostics to a fixed mapping of known error codes; never include arbitrary connection error messages or causes. Failed initialization closes the failed pool before propagating a sanitized error.
- [x] Verify successful schema `0019` initialization with a synthetic pool, known error diagnostics, unknown-error fallback, and the existing URL selection rules. `test:remediation` passes 56 tests with no failures/skips. Update evidence and commit.

Rollback: revert this isolated code commit; no schema change or live connection is involved. Broader release controls remain P03/P06 gates.
