# P14 Reporting aggregates and rating semantics (partial implementation)

Date: 9 September 2026. Prerequisite: durable patient ownership for feedback and call history.

## Implemented in this slice

- Service-recovery classification no longer treats a missing rating as a 0/low rating. Only negative sentiment or an explicit 1–2 rating qualifies.
- The report query exposes a full-period recovery count with a window aggregate before the display limit. The queue remains bounded for the dashboard, while the KPI is no longer derived from six visible rows.
- Added an isolated PostgreSQL regression with ten negative calls and one unrated positive call.

## Verification

- `npm run test:unit`: **367/367 passed**.
- `npm run test:db`: **40/40 passed** on schema `0024`.
- Focused report regression confirms `service_recovery_count = 10` and a six-item display queue.

## Remaining before P14 completion

1. [ ] Audit every dashboard/export aggregate for display-limit derivation and patient-role policy.
2. [ ] Add full-period tests for revenue, callbacks, sentiment, script and campaign aggregates, including empty/null data.
3. [ ] Verify rendered dashboard labels and date/time-zone boundaries in browser coverage.

No live data, notification or deployment boundary was used.
