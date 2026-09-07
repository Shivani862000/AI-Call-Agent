-- 0018_drop_calls_cascade.sql
--
-- 0017 replaced the cascading customer_id foreign key, but dropped it by the
-- name Postgres would have generated (calls_customer_id_fkey) rather than the
-- name it actually had (calls_customer_fk). The drop silently did nothing, the
-- add created a second constraint alongside it, and the cascade stayed live --
-- so deleting a queue entry would still have taken the patient's call history
-- with it, while the schema looked fixed.
--
-- Dropped by lookup rather than by name, so any leftover cascade goes whatever
-- it happens to be called.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
      from pg_constraint
     where conrelid = 'calls'::regclass
       and contype = 'f'
       and confdeltype = 'c'                        -- 'c' = ON DELETE CASCADE
       and conkey = array[(select attnum from pg_attribute
                            where attrelid = 'calls'::regclass and attname = 'customer_id')]
  loop
    execute format('alter table calls drop constraint %I', constraint_name);
  end loop;
end $$;
