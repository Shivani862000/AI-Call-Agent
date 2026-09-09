# P06 Runtime, Dependencies and Packaging

**Goal:** Ship the application on a verified supported runtime, exclude credentials and archived patient data from images, and remove confirmed dependency vulnerabilities.
**Spec:** [P06 remediation contract](../2026-09-08-APPLICATION_GAP_REMEDIATION_PLAN.md#p06--remove-secret-leakage-and-move-to-a-supported-runtime).
**Dependencies:** reviewed P01 isolated harness; existing log-redaction commit `8aa79ec`; P03 governs deployment. This file is the implementation plan, not authorization to publish an image or restart a live service.

## Global Constraints

- Current remediation branch, schema `0019` for this task, preserved route/role behavior and unrelated files.
- No production/UAT credentials or archived databases enter any build or test context. Use synthetic sentinels in a separate temporary fixture directory; never create/remove dummy credential files at real credential paths in the repository.
- Node 24 LTS across development, CI, migration execution and images. Preserve Express 4 routing; do not accept an audit tool's automatic Express 5 upgrade.
- Existing custom migrations, `node:test`, lockfile, audited manifests and disposable testing remain authoritative. No live calls, notifications, database access, push, merge or deployment.
- Real image startup and representative application operations are required; a version print or a source-pattern test alone is insufficient.

## Verified inputs, 9 September 2026

- The [official Node release page](https://nodejs.org/en/about/previous-releases) lists Node 24 as LTS and Node 20 as EOL. It lists 24.21.0 as current LTS, but that exact Docker tag was unavailable during P01. The actually tested Node 24.20.0 image digest is `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e` for `node:24-bookworm-slim`. Verify the selected platform digest/version at implementation; use the actually available supported image and record any newer unavailable patch.
- Read-only `npm audit --json` reported 6 vulnerable package entries: 4 moderate and 2 high. Installed versions were csv-parse 5.6.0, Express 4.22.2/body-parser 1.20.6/qs 6.15.3, Multer 2.2.0, and Nodemailer 9.0.6. The count includes parent packages affected by a transitive advisory; it is not six independently exploitable application defects.
- Fixed releases were verified in primary sources: [Multer 2.3.0](https://github.com/expressjs/multer/releases/tag/v2.3.0), [Nodemailer 9.1.1](https://github.com/nodemailer/nodemailer/releases/tag/v9.1.1), [qs 6.16.0](https://github.com/ljharb/qs/releases/tag/v6.16.0), and [csv-parse 7.0.2 advisory](https://github.com/advisories/GHSA-8cw4-87c7-c6xx). Confirm registry availability and changelogs before installation.

### Task 1: Update vulnerable dependencies without changing the framework

1. Inspect actual uses: customers import `{ parse }` from `csv-parse/sync`; patient/customer uploads use Multer; mailer creates a Nodemailer transport; Express exposes qs in query parsing. Add or reuse behavioral compatibility cases for these entry points, including malformed/oversized multipart input, dangerous CSV column names and bounded parsing. Never send real mail.
2. Update to fixed Multer 2.3.0, Nodemailer 9.1.1 and csv-parse 7.0.2 (or a subsequently verified compatible security patch). Resolve qs at 6.16.0 or later compatible patched 6.x, using a documented override if Express 4's transitive range requires it. Keep Express 4; do not run `npm audit fix --force`. Commit lockfile changes and any necessary small adapter changes together.
3. Verify synthetic CSV/XLSX preview and import, form/query parsing, login/authorization URL variants and captured email composition with existing plus focused tests. Run the audited affected suites once after final changes; a lockfile-only assertion is not compatibility evidence. Re-run `npm audit --json`, documenting exact remaining advisories and reachability instead of suppressing them. Fix actionable high/critical findings in the changed dependency graph.
4. Commit named files and a bounded report. Controller arranges separate review before Task 2.

### Task 2: Exclude secrets and boot the pinned production image

1. Expand `.dockerignore` for root/nested environment files, Gmail and service-account keys, OAuth client-secret names, private key material and archive/backup patterns including `feedback.db.archived-20260830`. Exclude development scratch/SDD state. Keep only required runtime assets.
2. Add a build-context test using only dummy sentinels in a fresh temporary fixture context. Exercise Docker's actual ignore/build behavior and inspect all resulting image layers: excluded sentinel bytes must be absent. A control with the exclusion deliberately removed must reveal the sentinel. Never use the genuine archived database or credentials in this experiment.
3. Pin the Node 24 image by verified digest, align package engine/local version guidance and every CI/migration job, and use the locked dependency install. Review native bcrypt and fonts/PDF runtime assets; do not strip assets needed for valid startup. The current deployment workflow targets `linux/amd64`: boot that image in the rehearsal, recording Docker Desktop emulation if used. A successful ARM64 lab boot alone does not verify the deployment target. Record platform support and the observed Node patch; emulated timings are not production throughput evidence.
4. Boot the real image against owned PostgreSQL with a seeded administrator, synthetic required configuration and disabled outbound/digest/scheduler work. Use a sanitized image context; mount no genuine `.env` or credential file. Exercise login/password verification, representative Excel import, PDF/font generation, and a provider-fake WebSocket path. Verify readiness and clean up owned resources. Add these checks to the existing isolated harness without giving the workload external egress.
5. Record exact image digest/build identity and test evidence, update README, run `git diff --check`, and commit named files. Live log-history/credential-exposure assessment is a separately recorded operational scope; successful local tests do not prove historical secrets were never exposed.

### Task 3: Finish application/provider log privacy

1. Inventory actual provider request/response/error log paths. In particular, `services/icallmate.js` redacts callback/media URL tokens but currently preserves the `ukey` field in returned request metadata. Omit secret-bearing fields and raw signed URLs completely; use fixed diagnostic metadata for database/provider errors rather than arbitrary response bodies.
2. Capture representative startup, submission, callback, recording/storage and failure logs with synthetic credentials containing URL encoding and short/long values. Assert no full URL, password, API key, webhook/media/storage token or sensitive provider payload escapes. Retain actionable status/error codes and call/attempt identifiers according to response policy.
3. Verify actual route/service paths with inert providers. Record the bounded audited coverage and any outstanding operational log/rotation questions. Commit separately after review; never rotate or disclose live credentials as a side effect of testing.

Rollback: dependency/image changes revert to the prior reviewed local revision; no schema change. Preserve prior image/config identities for P03's release runner. Reverting to a vulnerable package is an emergency operational decision, not a completed remediation state.
