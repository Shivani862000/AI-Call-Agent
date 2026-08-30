# Patient Records — Phase 1 (spec + plan)

**Date:** 2026-08-30 · **Status:** approved, ready to build

## Goal

A patient management screen — add, edit, remove, import — with contact details
visible to admins and masked for agents.

## Why a new table

`clients` is already a patient-shaped table but its UI is a 14-line redirect
stub. `customers` is the outbound call queue: one row per call cycle, 44
columns, 11 of them person data. Neither is the right home, so `patients`
becomes the person of record.

All three tables are empty on dev and production, so there is no data migration.

## Phasing

| Phase | Scope |
| --- | --- |
| **1 (this)** | `patients` table, management screen, Excel import. `customers` gains `patient_id`, written but not read. Call pipeline untouched. |
| 2 | Repoint the pipeline to read person data via `patient_id`; drop the duplicated columns. ~95 query sites. |
| 3 | Retire `clients`, fold annual reminders into `patients`. |

Splitting matters because phase 2 touches the scheduler, media bridge, call
orchestration, CRM sync and reporting. Bundling it would mean no working screen
until all of it landed.

## Schema — `patients`

| Group | Columns |
| --- | --- |
| Identity | `first_name` (required), `last_name`, `reference_id` (unique when present) |
| Contact | `phone` (required), `normalized_phone` (unique), `email` |
| Calling | `preferred_call_slot`, `preferred_language` (`en`/`hi`) |
| Clinical | `date_of_birth`, `gender`, `blood_group` |
| Service | `last_donation_date`, `last_test_date` |
| Consent | `do_not_call`, `consent_status`, `consent_updated_at` |
| Admin | `status`, `notes`, `created_by`, `updated_by`, `created_at`, `updated_at` |

Plus `customers.patient_id` → `patients(id)` ON DELETE SET NULL.

`normalized_phone` is unique, mirroring the `customers` fix, so one person
cannot be entered twice in different formats.

## Contact masking

Server-side only. A full value must never reach an agent's browser.

- Agents receive `phone_masked` (`••••••3210`) and `email_masked`; the real
  columns are not in the response at all.
- Admins receive the real values.
- Agents may **create** a patient (they type the number) but cannot read it
  back afterwards.
- An agent PATCH touching `phone` or `email` is **rejected**, not ignored.
- Masking uses the last 4 digits of `normalized_phone`, so formatting does not
  change what is shown. Numbers under 4 digits mask entirely.

**Accepted trade-off:** an agent may search by full number and learn whether it
is on file. Blocking it would break the inbound-call workflow to close a leak
that requires already knowing the answer.

## Screen

Plain language throughout — "Mobile number", "Best time to call", "Last blood
donation". Add and edit share one form in a toggle panel, matching the Users
page. Validation appears inline beside the field.

List columns: Name · Contact · Language · Last service · Status. Contact renders
masked or full by role, same column either way so the layout does not shift.

Two removals, deliberately different:
- **Remove from calling list** — soft, sets status inactive, keeps history. Both roles.
- **Delete permanently** — admin only, confirms by typing the patient's name,
  blocked when the patient has call history.

Do-not-call shows as a red badge in the list, not buried in the form: the person
managing the list must see at a glance who the system must not dial.

Empty state: "No patients yet — add one, or import a spreadsheet."

## Excel import

**Template download** produces an `.xlsx` with correct headers and one example
row. Without it, header guessing is the main source of failed imports.

**Two steps, nothing written until the second:**
1. Upload → parse and validate → summary (`142 new, 8 updates, 3 problems`) with
   per-row plain-language messages.
2. Confirm → applies **the validated rows held from the preview**, not a
   re-parse, so what is written is exactly what was approved.

Header matching is case- and separator-insensitive (`First Name`, `first_name`,
`FirstName`). Matching against existing patients uses `reference_id` first, then
`normalized_phone`.

Limits: 5,000 rows, 5 MB. Accepts `.xlsx`, `.xls`, `.csv`.

**Library: `exceljs`** (MIT, maintained). Not npm `xlsx`, which is frozen at
0.18.5 with unpatched prototype-pollution and ReDoS advisories.

**Caveat:** the pending preview lives in server memory with a short TTL —
consistent with existing live-call state, safe at `replicas: 1`, but another
thing pinning us to one replica. A restart mid-import means re-uploading.

## Build order

1. Migration `0005`: `patients`, indexes, `customers.patient_id`
2. `src/patient-rules.js` — masking, validation, normalisation (pure, unit-tested)
3. `routes/patients.js` — CRUD with role-aware serialisation
4. `src/patient-import.js` — header matching, row validation, new/update classification (pure)
5. Import endpoints — template, preview, commit
6. `public/patients.html` + nav + RBAC wiring
7. Browser verification and RBAC tests

## Testing

Unit, no database: masking (including sub-4-digit numbers), header matching, row
validation, new-vs-update classification.

Against dev: an agent cannot read a contact through **any** endpoint — list,
detail, search, import preview — and an agent PATCH touching contact fields is
rejected. Most likely requirement to regress, so it gets explicit tests.

## Out of scope

Call pipeline still reads `customers`; `clients` untouched; `patient_id` written
but not read.
