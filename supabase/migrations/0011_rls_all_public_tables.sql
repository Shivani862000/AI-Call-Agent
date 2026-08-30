-- 0011_rls_all_public_tables.sql
--
-- Every table in `public` is reachable through PostgREST, so RLS belongs in the
-- schema rather than relying on a project-level default. app_settings (0006)
-- and the tables created in 0001 were never enabled by a migration: on older
-- projects they were switched on out of band, and a project rebuilt from these
-- files alone would not have had it.
--
-- No policies are created deliberately. RLS with zero policies denies
-- anon/authenticated outright, and the app connects as the service role, which
-- bypasses RLS entirely.
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind = 'r'
       and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    raise notice 'enabled RLS on %', t.relname;
  end loop;
end $$;
