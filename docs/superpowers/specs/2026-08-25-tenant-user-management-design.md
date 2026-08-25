# Tenant User Management Design

## Goal

Give `CLIENT_ADMIN` users a tenant-scoped interface for managing every `CLIENT_ADMIN` and `CLIENT_AGENT` account in their own tenant. No tenant administrator may read or mutate users from another tenant.

## User experience

Add a responsive `/users.html` page to the existing application shell and show its navigation link only to `CLIENT_ADMIN` sessions. The page lists tenant users with search, role, and status filters. It supports creating users, editing username/email/role, setting a temporary password, suspending/reactivating accounts, and archiving/restoring accounts.

Actions use confirmation dialogs where they can remove access. Forms show field-specific validation and server errors. Passwords are accepted only in create/reset forms and are never returned by the API.

## API and authorization

Extend the tenant-scoped `/api/users` router with list, create, update, password-reset, suspend, reactivate, archive, and restore operations. Existing `/api/users/agents` routes remain available for compatibility.

Every query and mutation includes `req.tenantId`. Every endpoint requires a `CLIENT_ADMIN` session. The API rejects attempts to change the current administrator's own role or status, archive their account, or reset their own password through this management flow. It also rejects any operation that would leave an active tenant without an active `CLIENT_ADMIN`.

Updates use the model version for optimistic concurrency. Responses use a safe user DTO containing identity, tenant role, status, archive metadata, timestamps, and version—but never password data.

## Data flow and boundaries

The browser obtains the current session from `/api/auth/session`, then calls `/api/users` with filter and pagination parameters. The users router delegates validation and tenant-safe mutations to a focused tenant-user service. The service owns invariants and returns safe DTOs; route handlers translate known service errors to stable HTTP status codes and response bodies.

No schema expansion or email invitation workflow is included. A tenant administrator supplies an initial or replacement temporary password directly.

## Failure handling

Validation failures return `422` with field errors, duplicate username/email returns `409`, stale versions return `409`, missing or out-of-tenant users return `404`, and policy violations return `403` or `409` as appropriate. Unexpected failures return a generic `500` message without exposing internals.

The UI retains filters and current results when a mutation fails, displays the error near the relevant form or action, and reloads the current page after a successful mutation.

## Testing

Service tests cover tenant filters, safe DTOs, duplicate handling, optimistic concurrency, self-protection, and the last-active-admin invariant. HTTP tests cover authorization, cross-tenant isolation, validation, and lifecycle actions. UI tests verify the page structure, role-gated navigation, available actions, and absence of credential rendering. The full existing Node test suite must remain green.

