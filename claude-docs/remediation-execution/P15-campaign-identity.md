# P15 Durable campaign identity (partial implementation)

Date: 9 September 2026. Prerequisite: durable queue/customer rows and campaign configuration table.

## Implemented in this slice

- Migration `0025_campaign_identity.sql` adds `customers.campaign_id`, backfills legacy campaign names, adds a foreign key/index, and resolves legacy name-only writes through a database trigger.
- Migration `0026_call_campaign_snapshot.sql` adds `calls.campaign_id`/`campaign_name`, backfills and trigger-populates call snapshots, and appends `campaign_id` to the existing queue view without changing earlier columns.
- Customer create/update payloads accept `campaign_id` while preserving the existing campaign name compatibility field.
- Campaign reporting projects configuration IDs and resolves spend through the durable ID, while retaining the historical queue/call label for review.
- The isolated PostgreSQL regression now covers call snapshots, queue-view projection, rename continuity and spend/count attribution.

## Verification

- `npm run test:unit`: **371/371 passed**.
- `npm run test:db`: **44/44 passed** through schema `0026`; database files run sequentially against the owned test database to prevent fixture races.
- Syntax checks for the changed customer and reporting routes passed.

## Remaining before P15 completion

1. [ ] Backfill and review ambiguous/unknown campaign names in the shared environments.
2. [ ] Carry campaign ID through every import, admission/attempt history, export and UI selector.
3. [ ] Verify view grants/security options and the archive/deletion policy with production stakeholders.

No live data, campaign configuration or provider boundary was changed.
