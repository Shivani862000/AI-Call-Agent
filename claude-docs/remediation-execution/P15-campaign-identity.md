# P15 Durable campaign identity (partial implementation)

Date: 9 September 2026. Prerequisite: durable queue/customer rows and campaign configuration table.

## Implemented in this slice

- Migration `0025_campaign_identity.sql` adds `customers.campaign_id`, backfills legacy campaign names, adds a foreign key/index, and resolves legacy name-only writes through a database trigger.
- Customer create/update payloads accept `campaign_id` while preserving the existing campaign name compatibility field.
- Campaign reporting resolves the current configuration name through the durable ID, so renaming a campaign does not create a second attribution bucket.
- Added an isolated PostgreSQL regression for name rename continuity.

## Verification

- `npm run test:unit`: **367/367 passed**.
- `npm run test:db`: **41/41 passed** on schema `0025`.
- Syntax checks for the changed customer and reporting routes passed.

## Remaining before P15 completion

1. [ ] Backfill and review ambiguous/unknown campaign names in the shared environments.
2. [ ] Carry campaign ID through every import, admission/attempt history, export and UI selector.
3. [ ] Add spend/count aggregation tests and verify deletion/rename policy with production stakeholders.

No live data, campaign configuration or provider boundary was changed.
