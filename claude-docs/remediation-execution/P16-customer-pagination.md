# P16 Customer-list pagination (bounded first slice)

Date: 9 September 2026. Prerequisite: P07 import limits and current customer queue identity.

## Scope

- Preserve the existing array response for callers that do not request pagination.
- Add an opt-in cursor response for `GET /api/customers?page_size=<n>&cursor=<token>` with a default page size of 50 and a maximum of 100.
- Order by the existing priority, creation time and ID tie-breakers so inserts between page reads do not duplicate or skip an already returned row.
- Reject malformed cursors and page sizes before querying.

## Verification

The isolated database regression will seed multiple queue rows, traverse all pages, assert complete unique coverage and verify the legacy response shape. It will also exercise malformed cursors and the maximum page-size bound.

## Remaining P16 work

The browser still loads the legacy unbounded response and paginates in memory. Import batching, workload measurement, and pagination for other capped reports remain separate tasks.
