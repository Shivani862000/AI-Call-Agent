-- 0008_customers_drop_person_columns.sql
--
-- Destructive half of phase 2, applied only now that nothing reads or writes
-- these columns: reads go through customer_queue, writes go through patients.
--
-- customers is now purely a call-attempt queue.

drop view customer_queue;

alter table customers
  drop column name,
  drop column phone,
  drop column normalized_phone,
  drop column preferred_language,
  drop column preferred_dialect,
  drop column do_not_call,
  drop column consent_status,
  drop column dnd_checked_at,
  drop column last_visit_date,
  drop column preferred_slot;

-- Every queue entry belongs to a patient. Enforced rather than assumed, so a
-- future insert cannot quietly recreate an orphan row.
alter table customers alter column patient_id set not null;

-- One open queue entry per patient, replacing the old unique index on
-- normalized_phone. This is what the ON CONFLICT (patient_id) upserts rely on.
create unique index customers_patient_id_key on customers (patient_id);

-- Rebuilt without the dropped columns; preferred_slot now comes from the
-- patient, which is where a person's preference belongs.
create view customer_queue as
select
  c.*,
  trim(p.first_name || coalesce(' ' || p.last_name, '')) as name,
  p.phone,
  p.normalized_phone,
  p.email,
  p.preferred_language,
  null::text as preferred_dialect,
  p.preferred_call_slot as preferred_slot,
  p.do_not_call,
  p.consent_status,
  p.last_donation_date,
  p.last_test_date,
  p.blood_group,
  p.gender,
  p.date_of_birth,
  p.reference_id,
  p.status as patient_status,
  coalesce(p.last_donation_date, p.last_test_date) as last_visit_date
from customers c
join patients p on p.id = c.patient_id;
