# P10 Call Events and Lifecycle Correlation

**Goal:** Match provider callbacks and media to the durable attempt that owns them. Unknown identifiers remain reviewable without changing another call.

## Bounded slice completed

- `src/call-events.js` defines exact attempt/request/provider identity extraction and matching. A supplied unknown provider identifier never falls back to a phone match; id-less compatibility is disabled unless `ALLOW_IDLESS_CALL_MATCH=true` and exactly one eligible attempt exists.
- `supabase/migrations/0022_call_event_inbox.sql` adds a durable, RLS-protected inbox for matched, unmatched, ambiguous and conflicting provider events. Payload storage is restricted to correlation and lifecycle fields.
- Authenticated outbound payloads now carry the reserved `attemptId` and request key in provider extra parameters. Media hydration uses those identifiers when present and no longer guesses outbound ownership from the latest phone row by default.
- The authenticated iCallMate callback persists event identity before applying a matched update. Unknown or ambiguous events are returned as safe unmatched responses and do not update calls, customers or analysis. If the inbox is unavailable, the callback refuses to guess and reports an unresolved persistence condition.

Verification: the pure identity suite passes **7/7**, the isolated unit suite passes **362/362**, and the isolated PostgreSQL suite passes **36/36** on schema `0022`.

## Still required before P10 completion

1. [ ] Apply one transport/disposition transition table to every callback, media, hangup and workflow writer, with duplicate-event fencing.
2. [ ] Audit existing provider IDs and add a reviewed uniqueness/backfill report before relying on historical identity.
3. [ ] Add bounded unaffiliated-media deadlines, restart reconciliation and accepted-with-lost-response tests. The current inbox prevents wrong writes but does not by itself complete lifecycle recovery.

No provider, notification, storage, deployment or live credential boundary was used by this slice.
