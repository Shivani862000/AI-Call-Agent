-- 0020_overview_dismissals.sql
--
-- Items hidden from "Needs attention" on the Overview page.
--
-- Hiding means the item has been handled, so it is shared: one person hiding
-- it clears it for everyone. The key names the source row and the reason
-- (call:123:complaint), so a complaint on a later call is a new key and shows
-- up again rather than staying hidden under the old one.
create table overview_dismissals (
  item_key     text primary key,
  dismissed_by text,
  dismissed_at timestamptz not null default now()
);

-- Same stance as 0011: no policies, so anon/authenticated are denied and the
-- app's service-role connection is unaffected.
alter table overview_dismissals enable row level security;
