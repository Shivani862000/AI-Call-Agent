# P01 Isolated Test Infrastructure Execution Plan

**Goal:** Make every local/CI test and test migration incapable of reaching application databases or providers, and run the existing real database regressions in disposable PostgreSQL.
**Architecture:** An audited test manifest, import-safe migrations and a runner-owned database identity guard. Use pinned Testcontainers for lifecycle and an internal Docker network for the database test workload; sanitized disposable source staging must exclude environment files, credentials and archived databases.
**Tech stack:** CommonJS, node:test, pg, Docker Desktop/Linux CI, pinned Testcontainers.
**Spec:** [Application remediation contract](../2026-09-08-APPLICATION_GAP_REMEDIATION_PLAN.md).
**Status:** Complete in `fe84465`; verification recorded below.

## Global Constraints

- Work on the existing `codex/remediation-fixes` branch and current checkout, preserving untracked review documents.
- Do not run existing unrestricted npm test or load application .env files before the isolation guards are in place.
- Never connect to UAT/production, place calls, send notifications, push, merge or deploy. Docker operations touch only UUID-named resources owned by this runner.
- Preserve schema 0019; migrations remain append-only under the existing numbered runner.
- No genuine credential or archived database enters a test/build context. Both DB tests and the DB must have no external egress; prefer an internal network with no published database port.
- Node 24 / PostgreSQL 17 are the disposable lab targets. Read-only Supabase dashboard inspection on 2026-09-09 verified both managed projects at PostgreSQL 17.6.1.166; the upstream PostgreSQL 17.6 lab matches the major/patch line but does not prove Supabase role or extension equivalence.
- Verify the patch against actual owned PostgreSQL, not only mocked SQL. Do not silently skip required tests or use flaky sleeps. Finish one implementation item and its review before the next implementation agent.

### Task 1: Establish and prove isolated tests

### P01 — Make tests and migrations demonstrably isolated

**Owner:** Backend/QA. **Gaps:** F12, F20; R01, R05, R18. **Dependencies:** none.

**Create:** `scripts/test-isolated.js`, `scripts/test-migrate.js`, `test/support/database.js`, `test/support/provider-fakes.js`, `test/database-isolation.test.js`, `test/fixture-cleanup.test.js`.
**Modify:** `scripts/migrate.js`, `db.js`, `package.json`, `package-lock.json`, `test/support/fixtures.js`, `test/schema-triggers.test.js`, `test/daily-call-limit.test.js`, `test/retention.test.js`, `test/outbound-context.test.js`, every other test importing DB/startup/providers, and both CI/deploy workflows.

- [x] Inventory database creation, `.env` loading, provider requests, timer startup, and fixture cleanup before executing tests. Separate an audited unit-file manifest from database/browser groups.
- [x] Use pinned `@testcontainers/postgresql` development tooling for ephemeral PostgreSQL provisioning and container lifecycle. Keep `scripts/test-isolated.js` a thin orchestration/ownership wrapper; disable reuse and define cleanup on success/failure/interruption. Select a PostgreSQL image matching the deployed major once verified. The library supplies connection details, not proof of safe application behavior. [Official PostgreSQL module documentation](https://node.testcontainers.org/modules/postgresql/).
- [x] Implement the project-specific run identity and endpoint guard in both `db.js`'s test connection path and the test migration entry point, before constructing a DB client. Permit only the endpoint/database/user owned by the current runner; reject arbitrary supplied URLs, remote Docker targets and aliases without an explicit supported ownership contract. Production connection configuration remains separate.
- [x] Verify effective port bindings and egress on macOS Docker Desktop and Linux CI. Require loopback-only published ports or run the test workload entirely on an isolated internal network without publishing the DB. Testcontainers network creation/port mapping alone does not establish egress blocking or loopback binding; use a small verified Docker-network adapter where needed, and fail closed if isolation cannot be established. [Official networking documentation](https://node.testcontainers.org/features/networking/).
- [x] Pass a minimal child environment, not inherited application credentials. Set `DATABASE_URL` explicitly to the owned target before importing DB code. Suppress implicit dotenv loading in the test path. A variable called `TEST_DATABASE_URL`, a database-name suffix, or URL inequality alone does not prove isolation.
- [x] Refactor migrations into an import-safe `runMigrations({ connectionString, migrationsDir, expectedVersion })` function. The guarded test entry point supplies the runner-owned connection; the production CLI resolves deployment configuration separately. Validate ownership before constructing a `pg.Client`/`Pool`.
- [x] Use UUID fixture identities, no timestamp-derived dialable numbers, disabled scheduler/digest/inbound work, provider fakes and enforced egress blocking. Provision only the extensions/roles actually required by the migration set; test Supabase role/RLS behavior separately with equivalent restricted roles.
- [x] Fix the actual schema-trigger fixture's cleanup in `finally`: feedback/supervisor dependents, calls by both call ID and durable patient ID, queue entries, patient, then pool close. Track IDs before any assertion can fail. Clean only runner-owned data/resources, including on SIGINT and failed migration.
- [x] Add subprocess tests proving unsafe/missing/alias configurations create zero DB clients, migrations resolve the intended target, repeated bootstrap is idempotent, and cleanup survives an injected assertion failure. Demonstrate fresh migration plus real database tests with zero unexpected CI skips.
- [x] Expose the following commands and use them consistently throughout this plan. Land `package.json`, lockfile, test discovery and both workflow invocations in the same commit. Preserve `test:hotfix`; make `npm test` a safe documented alias, never a silent empty glob. In CI, absent disposable infrastructure or zero discovered required tests is a failure; safe local unit execution may report database coverage as not run.

```text
npm run test:unit
npm run test:db
npm run test:db -- --file test/schema-triggers.test.js
npm run test:browser
npm run test:isolated
```

`test:db`/`test:browser`/`test:isolated` own provisioning, guarded migration, execution, and cleanup. Never substitute `TEST_DATABASE_URL=... npm run migrate`. Commit after zero-connect rejection and disposable execution evidence are recorded.


#### Concrete execution steps

- [x] Audit transitive imports of each test file. Write an explicit unit/database manifest that fails on unclassified tests and empty selections.
- [x] First add failing subprocess regressions that spy on client construction: arbitrary/missing/mismatched ownership configuration must construct zero clients. Refactor `db.js` so test mode suppresses dotenv and calls an ownership validator before `new Pool`.
- [x] Expose `runMigrations({ connectionString, migrationsDir, expectedVersion })` without import side effects. A guarded test entrypoint validates the same runner identity before any client. CLI-only dotenv resolution belongs in `if (require.main === module)`.
- [x] Provision a UUID-named disposable DB and runner with a pinned PostgreSQL module. Verify internal network and no public DB port through actual Docker inspection, not only requested options. Produce a runner-owned identity artifact consumed by DB and migration guards.
- [x] Stage only sanitized source and dependencies into disposable test resources; child environment contains only synthetic configuration. Disable scheduler, digest and inbound/outbound providers; inject provider fakes for tests that need them. No reuse and deterministic cleanup in finally/on interruption.
- [x] Replace timestamp-derived telephone fixtures with nondialable UUID-based identities; fix the actual trigger-test cleanup to handle retained calls and dependents even after assertions fail.
- [x] Make `npm test` a safe unit alias; preserve `test:hotfix` and `test:remediation`. Implement `test:unit`, `test:db` (including --file), `test:isolated`, and an explicit browser command that fails clearly until P17 supplies the browser harness. Update both workflow test invocations coherently.
- [x] Run unit safety regressions, fresh migration and required DB regressions; prove cleanup after success, failed assertion and failed migration. Re-run only affected suites after fixes. Write evidence with exact commands/counts and no credentials.
- [x] Commit only this task's source/tests/lockfile/workflow/Tier2 files. Do not edit the main remediation/evidence register; the controller owns those. No subagents; a separate reviewer will be dispatched by the controller.

Rollback: revert this isolated infrastructure commit without database migration; no live resources are changed. Ownership/network guard failures fail closed. Missing infrastructure is an explicit failed DB job, never permission to select an environment URL.

## Completion evidence

- Implementation commit: `fe84465`.
- `npm run test:isolated`: 307 unit and 18 database assertions passed; zero failures and zero skips. Fresh migration applied 19 files and repeated bootstrap applied zero.
- `npm run test:db -- --file test/schema-triggers.test.js`: 3 passed, zero failures/skips after final image digest and cleanup-owner changes.
- `npm run test:remediation`: 56 passed, zero failures/skips.
- `npm run test:browser`: fails explicitly with `browser harness is unavailable until P17`.
- Docker inspection after runs found no owned `ai-call-agent-test-*` containers or networks.
- Full execution detail and limitations: `.superpowers/sdd/P01-isolated-tests/task-1-a7ed436f-report.md`.
