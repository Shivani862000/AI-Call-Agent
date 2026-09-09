# P16 Customer-list pagination (bounded first slice)

Date: 9 September 2026. Prerequisite: P07 import limits and current customer queue identity.

## Scope

- Preserve the existing array/`{patients}` responses for callers that do not request pagination.
- Add opt-in cursor responses for `GET /api/customers?page_size=<n>&cursor=<token>` and `GET /api/patients?page_size=<n>&cursor=<token>` with a default page size of 50 and a maximum of 100.
- Order by the existing priority, creation time and ID tie-breakers so inserts between page reads do not duplicate or skip an already returned row.
- Reject malformed cursors and page sizes before querying.

## Verification

The isolated database regressions seed multiple queue/patient rows, traverse all pages with filters, assert complete unique coverage and verify both legacy response shapes. They also exercise malformed cursors and the maximum page-size bound.

## Remaining P16 work

The browser still loads the legacy response and paginates in memory. Import batching, workload measurement, and pagination for other capped reports remain separate tasks.
