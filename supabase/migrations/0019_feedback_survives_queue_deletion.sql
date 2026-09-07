-- 0019_feedback_survives_queue_deletion.sql
--
-- 0017 and 0018 stopped a deleted queue entry from taking the patient's calls
-- with it, but feedback still cascaded from customers -- so removing a call
-- from the list still destroyed that patient's review text and rating.
--
-- Feedback belongs to the call it came from, and that call now survives. It
-- keeps call_id and loses only the link to the queue entry.
alter table feedback alter column customer_id drop not null;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
      from pg_constraint
     where conrelid = 'feedback'::regclass
       and contype = 'f'
       and confdeltype = 'c'
       and conkey = array[(select attnum from pg_attribute
                            where attrelid = 'feedback'::regclass and attname = 'customer_id')]
  loop
    execute format('alter table feedback drop constraint %I', constraint_name);
  end loop;
end $$;

alter table feedback
  add constraint feedback_customer_id_fkey
  foreign key (customer_id) references customers(id) on delete set null;
