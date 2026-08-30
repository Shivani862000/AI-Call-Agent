-- 0003_harden_rls_and_search_path.sql
--
-- Two findings from `get_advisors --type security`:
--
-- 1. system_logs (added in 0002) had RLS disabled while every other public
--    table has it enabled. Anything in the `public` schema is reachable through
--    PostgREST, so an unprotected table is readable by the anon role.
--    No policies are created deliberately: RLS with zero policies denies all
--    access to anon/authenticated, and the application connects as the service
--    role, which bypasses RLS entirely. That matches the other ten tables.
--
-- 2. Both trigger functions had a role-mutable search_path, so a caller could
--    shadow an unqualified name. The bodies reference only NEW/OLD and
--    pg_catalog builtins, so an empty search_path is safe.

alter table public.system_logs enable row level security;

alter function public.calls_sync_status()     set search_path = '';
alter function public.calls_sync_status_upd() set search_path = '';
