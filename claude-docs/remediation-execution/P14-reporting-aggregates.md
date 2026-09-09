# P14 Reporting aggregates and rating semantics (partial implementation)

Date: 9 September 2026. Prerequisite: durable patient ownership for feedback and call history.

## Implemented in this slice

- Service-recovery classification no longer treats a missing rating as a 0/low rating. Only negative sentiment or an explicit 1–2 rating qualifies.
- The report query exposes a full-period recovery count with a window aggregate before the display limit. The queue remains bounded for the dashboard, while the KPI is no longer derived from six visible rows.
- Owner dashboard cards and alert counts use a separate full seven-day aggregate; the rendered alert detail list remains bounded to twelve items.
- Added an isolated PostgreSQL regression with ten negative calls and one unrated positive call.
- Added an isolated PostgreSQL regression with fifteen owner alerts to prove counts are not derived from the bounded detail list.

## Verification

- `npm run test:unit`: **371/371 passed**.
- `npm run test:db`: **44/44 passed** on schema `0026`.
- Focused report regressions confirm `service_recovery_count = 10`, a six-item display queue, and owner alert totals that exceed the twelve-item detail list.

## Remaining before P14 completion

1. [ ] Audit every dashboard/export aggregate for display-limit derivation and patient-role policy.
2. [ ] Add full-period tests for revenue, callbacks, sentiment, script and campaign aggregates, including empty/null data.
3. [ ] Verify rendered dashboard labels and date/time-zone boundaries in browser coverage.

No live data, notification or deployment boundary was used.
