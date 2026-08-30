-- 0009_customers_updated_at.sql
-- The queue's upserts touch updated_at to record that an entry was re-queued.
-- The column never existed; every other table in the schema has one.
drop view customer_queue;
alter table customers add column updated_at timestamptz not null default now();
create view customer_queue as
select
  c.*,
  trim(p.first_name || coalesce(' ' || p.last_name, '')) as name,
  p.phone, p.normalized_phone, p.email,
  p.preferred_language,
  null::text as preferred_dialect,
  p.preferred_call_slot as preferred_slot,
  p.do_not_call, p.consent_status,
  p.last_donation_date, p.last_test_date, p.blood_group, p.gender,
  p.date_of_birth, p.reference_id,
  p.status as patient_status,
  coalesce(p.last_donation_date, p.last_test_date) as last_visit_date
from customers c
join patients p on p.id = c.patient_id;
