# P08 Authoritative Contact Policy

**Goal:** Explicit refusals and suppression survive stale workflow updates and prevent further disallowed contact across every calling path.
**Spec:** [P08 remediation contract](../2026-09-08-APPLICATION_GAP_REMEDIATION_PLAN.md#p08--make-contact-restrictions-authoritative-and-monotonic).
**Dependencies:** reviewed P01/P07; [domain contract](../APPLICATION_DOMAIN_CONTRACTS.md). Durable revisions ship with P09/P10 in migration `0021_contact_and_call_attempts.sql`.
**Architecture:** A shared contact vocabulary/policy, patient-turn intent detection, and patient-owned contact events. Transactions lock the patient before deciding restrictions, modifying dependent queue work and recording the decision.

## Global Constraints

- Current remediation branch, existing authorization and masking preserved, no unrelated changes.
- Tests use only audited disposable infrastructure and nondialable fixtures. No live database, provider, notifications, push, merge or deployment.
- Canonical consent is `unknown|granted|refused`; legacy `denied` maps to `refused` and `pending` to `unknown` at one compatibility boundary. Unknown consent retains current behavior; never infer a legal consent grant from interest or ordinary completion.
- Patient restrictions are authoritative. An AGENT may report a restriction; restoring suppressed/refused contact requires an ADMIN's explicit current-revision decision and evidence. No import or ordinary transport update relaxes restrictions.
- Use `dbTx()` and append-only numbered migrations. Schema-free corrections may ship at `0019`; durable contact/attempt state belongs to the coordinated `0021` expansion, with RLS and reviewed grants. No later task edits a committed distributed migration.
- A local pause/cancel prevents future admission; it cannot promise a provider has terminated an already submitted call.

### Task 1: Correct vocabulary, intent and schema-free suppression writes

**Create:** `src/contact-policy.js`, `test/contact-policy.test.js`, focused guarded workflow tests.
**Modify:** `src/patient-rules.js`, `src/queue-rules.js`, `src/call-management.js`, `src/scheduler.js`, `routes/customers.js`, `routes/patients.js`, `services/call-orchestration.js`, affected test manifest.

1. [x] Preserve the literal failing baseline already recorded in `GAP_REMEDIATION_EVIDENCE.md`: patient text `I am not interested.` currently returned `interested`. Add patient-turn cases for wrong number, refusal with an apostrophe, Hindi/transliterated supported negatives, assistant-only wording and genuinely interested/callback/completed examples. Negative phrases take precedence over positives and callbacks. Assistant scripts or an analysis paraphrase cannot supply explicit contact permission; retain source/evidence distinctions.
2. [x] Centralize consent normalization and update every caller, including priority scoring, queue eligibility, manual calls, due-query filtering and workflow validation. Invalid explicit values are field errors rather than becoming permissive defaults. Fix boolean parsing so the string `false` cannot become a do-not-call flag through truthiness.
3. [x] Remove the stale customer snapshot's unconditional consent initialization/write from `applyCallOutcomeWorkflow`, including `consent_given` granting based on a transport/workflow label. Ordinary status/analysis completion must not modify consent. Recognized wrong-number/not-interested outcomes persist `patients.do_not_call = 1`; durable queue cancellation and stale-event ordering remain Task 2.
4. [x] Patient ordinary edits preserve restrictions and cannot accidentally default them back to permissive values. Workflow edits use explicit field presence and reject invalid status/consent values. Restoration attempts return an actionable conflict until the reviewed revision endpoint exists; durable transaction locking remains Task 2.
5. [ ] Real database race/rollback tests exercise refusal followed by stale completion, existing suppressed patient edits, wrong-number persistence after queue deletion, explicit denied compatibility, no automatic grant, and rollback after injected dependent-write failure. Assert no provider request on blocked paths. Commit only the schema-free portion with accurate evidence; Task 2 remains open.

#### Task 1 implementation evidence — 9 September 2026

- Added `src/contact-policy.js` as the single compatibility boundary for `unknown|granted|refused`, legacy `denied`/`pending`, boolean flags and patient-turn contact intent. Negative/refusal patterns run before callbacks/interest; assistant-only transcript wording cannot create patient permission.
- Updated queue rules, manual call admission, scheduler filtering, patient/customer normalization and workflow validation. Ordinary patient/customer edits cannot relax an existing do-not-call, wrong-number or refused-consent restriction; invalid explicit consent is a field error. `applyCallOutcomeWorkflow` no longer grants consent for `consent_given` or ordinary completion, and recognized refusal/wrong-number outcomes monotonically persist the patient restriction.
- Focused verification: `node --test test/contact-policy.test.js test/queue-rules.test.js test/patient-rules.test.js test/call-orchestration.test.js` — **28 passed, 0 failed, 0 skipped**. The pure tests use no database/provider/network. Task 1's requested real DB race/rollback evidence and durable queue cancellation remain open and are intentionally not claimed here.

### Task 2: Integrate versioned contact events with the durable lifecycle

Execute together with P09/P10's `0021` design and migration release, after Task 1 review.

1. Add patient contact revision and durable restriction/review fields; an append-only event records patient, actor/source attempt, evidence reference, expected/new revision, decision and timestamp. Existing restrictions are preserved during expansion/backfill. Tables have appropriate RLS/grants; processing state is not exposed through the public Data API.
2. Implement one contact event transaction that locks the patient, rejects stale permissive changes, persists restriction/evidence/revision, cancels newly disallowed queued retries, and records related attempt effects atomically. Restrictive evidence remains effective if it arrives after older permissive work. A restore endpoint requires ADMIN and current expected revision; report conflicts without overwriting current evidence.
3. Integrate all patient/workflow/contact writers and the P09 admission decision. With two database connections and barriers, interleave refusal with old analysis/completion, explicit staff edit and dispatch. Refusal committed before the dispatch decision means no provider submission. Cover rollback and restart without sleeps or duplicated mocked SQL as proof.
4. Document the externally unverified remote-hangup limitation and stage activation with P09/P10. Do not call P08 complete from pure tests or schema-free fixes alone.

Review each task separately. The controller owns main progress/evidence; implementers write their bounded report and named-files commit, without spawning subagents. Rollback of schema-free changes is an application revert; `0021` uses the coordinated expand/compatibility recovery contract, never a destructive down migration.
