-- 0010_drop_clients.sql
-- The clients table was a second, older patient record whose UI had already
-- been reduced to a redirect stub. Its one live behaviour -- annual reminder
-- calls -- is now the `annual-reminder` rule in app_settings.auto_queue, so
-- this is removal rather than reimplementation.
drop table clients;
