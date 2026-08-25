# Webmaster Console Design

**Date:** 2026-08-24  
**Status:** Approved in conversation; awaiting written-spec review  
**Application:** AI Call Agent / VikiTech platform administration

## Purpose

Build a dedicated, responsive control plane where authorized Webmasters manage tenants, tenant users, platform administrators, global settings, tenant overrides, integrations, policies, operational health, notifications, and immutable audit history.

The console is separate from tenant-facing operations. It must never expose patient or customer personally identifiable information (PII) or protected health information (PHI), and the application must not provide permanent-delete behavior for application records. Existing destructive routes outside the new console are included in the preservation work and become archive transitions.

## Product Decisions

- Only users with the `WEBMASTER` role may access the console or its APIs.
- The existing `SUPPORT_TEAM` role has no console access, including read-only access.
- Webmasters have an additional platform access level: `OWNER` or `ADMIN`.
- Owners can perform every webmaster action, including replacing integration secrets and managing Webmaster Admin accounts.
- Webmaster Admins can manage tenants, tenant users, non-secret global settings, tenant overrides, policies, notifications, and audit views. They cannot replace secrets or manage Owner accounts.
- Tenant admins continue to manage agents within their own tenant. Webmasters can manage tenant admins and agents across all tenants.
- Tenant operational views contain aggregate statistics and service health only. They exclude names, phone numbers, email addresses, addresses, transcripts, recordings, free-text feedback, external identifiers, and any other PII/PHI.
- Tenant, user, customer, call, client, campaign, agent, feedback, audit, notification, and other application records are never permanently deleted. Lifecycle actions use suspension, archiving, and restoration.
- Passwords are entered manually by an authorized administrator. Passwords and password hashes are never returned by an API or displayed after submission.
- Sensitive actions use a confirmation popup. Password re-entry is not required.
- Tenant administrators receive email notifications when their tenant or account is suspended, restored, or archived.
- The release includes the complete console rather than a deliberately reduced first phase. Work may still be implemented and verified in internal milestones.
- The console is a neutral VikiTech platform-administration experience, visually distinct from tenant-facing Path Lab screens.
- The console supports desktop, tablet, and mobile layouts.
- The feature does not include global search or CSV exports.

## Chosen Architecture

Use the current Express, MongoDB/Mongoose, and browser-native JavaScript stack. Add a dedicated webmaster page with focused browser modules and dedicated webmaster API modules. Do not introduce a frontend framework or merge webmaster controls into the tenant operations UI.

This approach provides a strong security boundary without requiring a build pipeline or broad frontend migration. Backend modules remain the source of truth for permissions, redaction, validation, effective configuration, lifecycle rules, and audit recording.

### Boundaries

1. **Webmaster shell:** navigation, session-aware rendering, responsive layout, alerts, confirmation dialogs, and section routing.
2. **Dashboard:** platform aggregates, tenant health, integration readiness, failures, recent audit activity, and attention items.
3. **Tenant management:** lifecycle, profile, contacts, branding, plan, limits, reporting defaults, notes, tags, and tenant overrides.
4. **Tenant-user management:** tenant admins and agents, including credentials, roles, lifecycle, and password replacement.
5. **Platform-team management:** Owner-only creation and management of Webmaster Admin accounts.
6. **Integration management:** provider configuration plus Owner-only write-only secret replacement.
7. **Policy management:** retention, rate limits, maintenance mode, session/password policies, feature flags, supported providers, notification defaults, and platform defaults.
8. **Audit history:** immutable, redacted records of webmaster changes.
9. **Tenant operational snapshot:** aggregate-only metrics produced by a dedicated redacted API, not by reusing patient/customer endpoints.

Each browser area consumes a dedicated API contract. Browser code must not infer authorization or attempt to redact sensitive backend payloads; the server returns only data that the caller is permitted to receive.

## Roles and Authorization

### Role matrix

| Capability | Owner | Webmaster Admin | Other roles |
| --- | --- | --- | --- |
| Open webmaster console | Yes | Yes | No |
| View dashboard and tenant health | Yes | Yes | No |
| Manage tenants and tenant overrides | Yes | Yes | No |
| Manage tenant admins and agents | Yes | Yes | No |
| Manage non-secret global settings | Yes | Yes | No |
| View integration configuration status | Yes | Yes | No |
| Replace integration secrets | Yes | No | No |
| Manage Webmaster Admin accounts | Yes | No | No |
| Change or disable an Owner | No self-demotion; controlled owner transfer only | No | No |
| View audit history | Yes | Yes | No |

The environment-based legacy Webmaster account is treated as an Owner. A persisted Webmaster with no access level is denied console access until explicitly assigned `OWNER` or `ADMIN`; seed/migration logic assigns the initial known Webmaster as Owner.

Every webmaster route requires both an authenticated session and the `WEBMASTER` role. Owner-only handlers perform a second access-level check. UI visibility follows these permissions for usability, but server enforcement is mandatory.

Authentication must reject suspended or archived users and users whose tenant is suspended or archived. Existing sessions are revalidated against current user and tenant status on protected webmaster operations so a lifecycle change takes effect without waiting for cookie expiry.

## Information Architecture and User Experience

The console opens at `/webmaster.html`. Successful login routing is role-aware:

- `WEBMASTER` goes to `/webmaster.html`.
- `CLIENT_ADMIN` and `CLIENT_AGENT` go to the tenant operations entry point.
- `SUPPORT_TEAM` does not gain webmaster access and continues to its separately authorized destination, if one exists.

The responsive shell contains these sections:

### Overview

- Active, suspended, and archived tenant totals.
- Active, suspended, and archived user totals by role.
- Platform call-volume and failure aggregates without tenant-customer identifiers.
- Tenant health and usage against configured limits.
- Integration configured/unconfigured/degraded status.
- Recent immutable audit events.
- Attention items such as failed notifications, misconfigured providers, limits approached, or suspended dependencies.

### Tenants

The list shows tenant name, status, plan, primary contact, timezone, effective reporting schedule, limits summary, and last update. It supports status filtering and pagination but no cross-entity global search or export.

Creating a tenant is one guided workflow that creates:

1. The tenant profile and defaults.
2. Optional per-tenant overrides.
3. The initial `CLIENT_ADMIN` account with a manually entered password.
4. One audit event that links the related changes without recording the password.

Tenant fields include name, status, primary contact, email, phone, address, timezone, daily report time, branding, plan, user limits, call limits, billing contact, internal notes, and internal tags.

Lifecycle actions:

- **Suspend:** block authentication and operational activity while preserving all data.
- **Archive:** block authentication and operational activity, exclude the tenant from active views, and retain it in archived views.
- **Restore:** return a suspended or archived tenant to active status after validation.

There is no tenant-delete button, route, service operation, or cascading deletion.

### Application-wide preservation

Existing tenant-facing routes that permanently delete customers, calls, client records, campaigns, agent configurations, or users are converted to archive transitions. Existing UI labels that say “delete” are replaced with “archive,” confirmation copy explains that the record remains retained, and normal active queries exclude archived records unless an archived view is explicitly requested. Filesystem rotation for ephemeral logs and cleanup of test-only temporary files are infrastructure housekeeping rather than application-record deletion and are not affected by this rule.

### Users

Webmasters can list tenant users by tenant, role, and lifecycle status. Supported actions are create, edit username/email, change between `CLIENT_ADMIN` and `CLIENT_AGENT`, replace a password, suspend, archive, and restore.

Constraints:

- Usernames and emails remain globally unique under the current data model.
- A tenant must retain at least one active `CLIENT_ADMIN` unless the tenant itself is suspended or archived.
- Role changes cannot move users between tenants implicitly; tenant reassignment is a separate confirmed action or is disallowed in the initial implementation if referential safety cannot be guaranteed.
- Password input is write-only and is hashed with the existing bcrypt policy.
- Passwords, password hashes, and credential-derived values never enter response payloads or audit metadata.
- Tenant admins retain their existing tenant-scoped agent-management capabilities.

### Platform Team

Owners can create and manage `WEBMASTER` accounts with the `ADMIN` access level. Owners may suspend or archive Webmaster Admins. An Owner cannot remove or demote the last active Owner. Owner transfer requires a confirmed action that promotes another active Webmaster before demoting the current Owner.

Webmaster Admins cannot view platform-team credential fields beyond safe account metadata and cannot perform platform-team mutations.

### Integrations

The console represents every existing integration category:

- Calling/iCallMate.
- AI provider and model configuration.
- Speech-to-text/Deepgram.
- Email/SMTP.
- Slack/support notifications.
- Webhooks.
- Additional providers registered through the same server-side integration definition interface.

Non-secret fields such as provider selection, endpoint, sender identity, model, timeout, enabled state, and safe account labels may be read and edited according to role. Secret fields are Owner-only and write-only.

For every secret, the read API returns only:

- A boolean `configured` state.
- The source (`database` or `environment`) when safe to reveal.
- The last replacement timestamp.
- The username of the replacing Owner, when safe.

It never returns secret text, a partial secret, a suffix, an encrypted value, or a reversible derivative. Submitting a blank secret leaves the existing value unchanged. Replacing a secret creates a redacted audit event.

### Policies and Global Settings

Editable global settings include:

- Application name and support contacts.
- Default timezone and reporting schedule.
- Default tenant, user, and call limits.
- Maintenance mode and maintenance message.
- Platform feature flags.
- Password and session policies within limits supported by the application.
- Notification defaults and templates.
- Supported AI, calling, transcription, email, Slack, and webhook providers.
- Request and operation rate limits.
- Data-retention classifications.

Retention settings never cause deletion. They control how long data remains in active operational views before being archived or moved to a colder logical tier. Archived data remains retained and auditable.

Maintenance mode blocks tenant operational mutations and communicates the configured message. Webmaster access remains available so an Owner or Webmaster Admin can restore service.

### Audit History

Audit events are append-only and cannot be edited, archived, or deleted through application APIs. The view supports pagination and filters for time, actor, action category, tenant, target type, and outcome. It does not support export.

An event contains actor identity and access level, timestamp, action, target type and identifier, tenant identifier where relevant, redacted before/after values, request correlation identifier, outcome, and safe failure metadata.

Secret values, passwords, password hashes, tokens, authorization headers, PII, PHI, transcripts, recordings, and free-text patient/customer content are excluded from audit payloads.

### Tenant Operational Snapshot

The Webmaster can open a tenant context from the tenant list. This opens a platform-administration snapshot, not the existing patient operations screens.

Allowed data includes counts, trends, call completion/failure ratios, queue depth, provider health, notification status, feature configuration, quota usage, and aggregate feedback categories. The endpoint must aggregate in the database and project only allowed fields. It must not fetch customer documents into the browser or rely on frontend masking.

## Data Model

### User additions

- `platformAccessLevel`: nullable enum `OWNER | ADMIN`; valid only for `WEBMASTER`.
- `status`: expanded lifecycle enum `active | suspended | archived`.
- `updated_at`: timestamp for conflict detection and auditing.
- Optional `password_changed_at` for security visibility without credential exposure.

### Tenant additions

- Contact, address, timezone, branding, plan, billing, notes, and tag fields.
- Structured limits for users, calls, and other supported quotas.
- `settingsOverrides` containing only approved override keys.
- Lifecycle status `active | suspended | archived`.
- Version/timestamp data for optimistic conflict detection.

### PlatformSettings

A singleton document stores non-secret platform defaults, feature flags, policies, provider selection, notification templates, retention classifications, maintenance configuration, and a schema version. Updates validate the full affected section and use optimistic concurrency.

### IntegrationSecret

One record per registered secret stores an integration key identifier, encrypted ciphertext, initialization vector, authentication tag, encryption version, replacement metadata, and timestamps. Encryption uses AES-256-GCM with a dedicated 32-byte key supplied through an environment variable. The encryption key is never stored in MongoDB.

Database secrets override environment fallbacks. Existing environment values remain valid initial fallbacks and can be replaced from the console without exposing them.

### AuditEvent

An append-only collection stores the safe audit fields described above. Application code exposes create and read operations only. No update or delete route is implemented.

### NotificationDelivery

Records tenant/account lifecycle email attempts, recipient category, template, safe metadata, delivery status, retry count, timestamps, and a redacted failure reason. It does not store patient/customer data or SMTP credentials.

## Settings Resolution

Effective tenant configuration is resolved in this order:

1. Valid tenant override.
2. Persisted global default.
3. Existing application/environment default.

The API returns global values, explicit overrides, and effective values as distinct fields so the UI never mistakes an inherited value for an override. Secret resolution follows the separate database-secret-over-environment rule and never returns resolved secret text.

Only settings explicitly registered as tenant-overridable can appear in `settingsOverrides`. Platform security invariants, encryption configuration, Owner permissions, audit behavior, and no-delete rules cannot be overridden per tenant.

## API Design

All webmaster APIs live under `/api/webmaster` and reject non-Webmaster roles before accessing domain services. Resource areas include:

- `/dashboard`
- `/tenants`
- `/tenants/:tenantId/operations`
- `/tenants/:tenantId/users`
- `/platform-users`
- `/settings`
- `/integrations`
- `/policies`
- `/audit-events`
- `/notification-deliveries`

Mutation APIs accept an expected version or update timestamp for conflict detection. Validation failures return a stable error code, summary, and field-error map. Authorization failures return `403` without revealing target existence. Missing resources return `404` only after authorization permits knowledge of the resource.

No webmaster resource exposes an HTTP `DELETE` operation. Suspend and archive actions use explicit state-transition endpoints or validated updates.

Domain services centralize lifecycle rules, effective settings, encryption, secret metadata, redaction, audit creation, and notifications. Routes remain thin and do not duplicate these policies.

## Change and Notification Flow

For a normal webmaster mutation:

1. Authenticate the session and reload the actor's current status/access level.
2. Authorize the requested capability.
3. Validate input and the expected resource version.
4. Apply the state change.
5. Append a redacted audit event containing safe before/after fields.
6. If required, attempt the lifecycle email and record its delivery status.
7. Return the updated safe resource plus notification status.

An email failure does not roll back a valid tenant or user state change. The response makes the delivery failure visible, the dashboard creates an attention item, and the delivery record supports a later manual retry. A secret update never returns the submitted value even in the immediate success response.

## Error Handling

- Field validation is displayed next to the relevant control.
- Permission failures use a clear forbidden state without sensitive detail.
- Optimistic-concurrency conflicts tell the user the record changed and require a refresh before resubmission.
- Integration tests expose safe diagnostic codes and correlation identifiers; provider responses are sanitized before storage or display.
- Partial notification failure is shown as a warning after the underlying state change succeeds.
- Dashboard widgets fail independently so one provider outage does not blank the entire console.
- Maintenance mode and archived/suspended states produce explicit, non-sensitive messages at login and operation boundaries.

## Visual and Responsive Design

The console uses a neutral VikiTech identity and administration-oriented information density. It does not reuse tenant-specific Path Lab branding.

- Desktop: persistent sidebar, page header, summary cards, data tables, and detail drawers or dialogs.
- Tablet: collapsible sidebar and horizontally resilient tables/cards.
- Mobile: compact header, section drawer, stacked summaries, card-based resource rows, and full-height edit sheets.
- All controls have visible focus states, semantic labels, keyboard operation, meaningful empty/loading/error states, and accessible confirmation dialogs.
- Status never relies on color alone.
- Secret inputs explain that stored values cannot be retrieved and blank submissions do not replace them.

## Testing Strategy

### Authorization

- Verify every webmaster endpoint rejects unauthenticated users and all non-Webmaster roles.
- Verify Webmaster Admins cannot update secrets or manage Owners/platform users.
- Verify Owners can perform Owner-only actions.
- Verify the last active Owner cannot be suspended, archived, or demoted.
- Verify suspended/archived users and tenants lose access.

### Privacy and secrets

- Assert secret read endpoints never contain secret text, ciphertext, partial values, or reversible derivatives.
- Assert logs, errors, audit events, and notification records redact passwords and secrets.
- Seed tenant customer records containing identifiable values and assert operational-snapshot responses contain none of them.
- Verify the browser never calls customer, transcript, recording, or feedback-detail endpoints from webmaster tenant context.

### Lifecycle and preservation

- Verify tenant and user suspend/archive/restore transitions.
- Verify there are no application-record hard-delete routes, including the pre-existing customer, call, client, campaign, agent, and user routes.
- Verify archived records remain queryable in archived views and remain referenced by audits.
- Verify tenant-admin invariants and Owner invariants.

### Settings and integrations

- Verify global/default/environment resolution and tenant overrides.
- Verify invalid override keys are rejected.
- Verify maintenance mode preserves webmaster access and blocks tenant mutations.
- Verify configured rate limits and feature flags affect the intended requests.
- Verify encryption/decryption with key-version metadata without logging secret material.

### Audit and notifications

- Verify every mutation produces one complete, redacted audit event.
- Verify audit events cannot be updated or deleted through APIs.
- Verify lifecycle emails use the correct recipients and templates.
- Verify email failure preserves the state change and records a retryable failure.

### UI and regression

- Verify role-aware login routing.
- Verify desktop, tablet, and mobile layouts for every section.
- Verify keyboard navigation, focus management, dialog semantics, loading states, empty states, and field errors.
- Run the existing test suite to confirm tenant-facing operations continue to work.

## Delivery Structure

The complete release is implemented in testable milestones:

1. Authorization, role hierarchy, lifecycle enforcement, and role-aware routing.
2. Persistence models, audit infrastructure, encryption, and settings resolution.
3. Webmaster shell and overview.
4. Tenant lifecycle, tenant details, overrides, and safe operational snapshots.
5. Tenant-user and platform-team management.
6. Integrations, write-only secrets, policies, and maintenance/rate-limit behavior.
7. Notifications, audit UI, responsive/accessibility completion, privacy verification, and regression hardening.

All milestones are part of the same requested release. A milestone is complete only when its focused tests pass and it preserves the no-delete, no-secret-read, and no-PII/PHI invariants.

## Explicit Non-Goals

- Permanent deletion of tenants, users, customers, calls, clients, campaigns, agents, feedback, audit records, notification records, or other application data.
- Support Team access to the webmaster console.
- PII/PHI access or user impersonation from the webmaster console.
- Reusing tenant customer screens as webmaster operational views.
- Reading, revealing, copying, exporting, or partially displaying stored secrets.
- Global cross-entity search.
- CSV or other data exports.
- Introducing a frontend framework or separate build pipeline.

## Acceptance Criteria

The feature is accepted when an Owner can manage the complete platform configuration and tenant estate; a Webmaster Admin can perform all delegated non-secret operations; unauthorized roles cannot access the console; tenant administrators retain tenant-scoped agent management; application records can be suspended or archived and restored as appropriate but never permanently deleted; all existing integrations can be configured without secret disclosure; global defaults and tenant overrides resolve predictably; sensitive activity is immutably audited; lifecycle notifications are visible and retryable; the tenant operational snapshot contains no PII/PHI; and all console sections function across desktop, tablet, and mobile without regressing tenant operations.
