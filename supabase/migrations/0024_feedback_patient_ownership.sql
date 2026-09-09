-- 0024_feedback_patient_ownership.sql
-- Feedback is retained history. Anchor it to the durable patient instead of
-- the disposable queue entry that happened to collect it.

alter table feedback add column patient_id bigint;

update feedback f
   set patient_id = coalesce(c.patient_id, customer.patient_id)
  from calls c
  left join customers customer on customer.id = c.customer_id
 where f.call_id = c.id
   and f.patient_id is null;

update feedback f
   set patient_id = customer.patient_id
  from customers customer
 where customer.id = f.customer_id
   and f.patient_id is null;

do $$
begin
  if exists (select 1 from feedback where patient_id is null) then
    raise exception 'feedback rows without a durable patient cannot be migrated';
  end if;
end $$;

alter table feedback alter column patient_id set not null;
alter table feedback
  add constraint feedback_patient_id_fkey
  foreign key (patient_id) references patients(id) on delete restrict;
create index feedback_patient_id_idx on feedback(patient_id, submitted_at desc);

create or replace function feedback_set_patient_id() returns trigger as $$
begin
  if new.patient_id is null and new.call_id is not null then
    select patient_id into new.patient_id from calls where id = new.call_id;
  end if;
  if new.patient_id is null and new.customer_id is not null then
    select patient_id into new.patient_id from customers where id = new.customer_id;
  end if;
  if new.patient_id is null then
    raise exception 'feedback requires a durable patient';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists feedback_set_patient_id_trg on feedback;
create trigger feedback_set_patient_id_trg
  before insert or update of patient_id, customer_id, call_id on feedback
  for each row execute function feedback_set_patient_id();
