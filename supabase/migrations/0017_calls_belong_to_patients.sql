-- 0017_calls_belong_to_patients.sql
--
-- A call belonged to a queue entry, and a patient could only ever have one
-- queue entry: customers_patient_id_key made patient_id unique, and every
-- scheduling site upserted onto it. So "schedule a call" meant "overwrite this
-- patient's single row", and removing one call deleted every call that patient
-- had ever had, recordings included, because calls.customer_id cascaded.
--
-- Calls now belong to the patient. Each scheduled call is its own row with its
-- own id, and deleting one leaves both the patient's history and their other
-- scheduled calls untouched.

-- 1. A call records who was phoned, independently of any queue entry.
alter table calls add column patient_id bigint references patients(id) on delete set null;

update calls c
   set patient_id = cu.patient_id
  from customers cu
 where cu.id = c.customer_id
   and c.patient_id is null;

create index if not exists idx_calls_patient_id on calls (patient_id);

-- Filled from the queue entry on insert, so no calling site has to remember
-- and none can drift. Explicit values are respected.
create or replace function calls_set_patient_id() returns trigger as $$
begin
  if new.patient_id is null and new.customer_id is not null then
    select patient_id into new.patient_id from customers where id = new.customer_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists calls_set_patient_id_trg on calls;
create trigger calls_set_patient_id_trg
  before insert on calls
  for each row execute function calls_set_patient_id();

-- 2. Removing a queue entry must not destroy what already happened. The call
--    keeps its patient and loses only the link to the entry that produced it.
alter table calls alter column customer_id drop not null;
alter table calls drop constraint if exists calls_customer_id_fkey;
alter table calls
  add constraint calls_customer_id_fkey
  foreign key (customer_id) references customers(id) on delete set null;

-- 3. More than one call may be scheduled for the same patient. The plain index
--    stays for lookups; only uniqueness goes.
drop index if exists customers_patient_id_key;
