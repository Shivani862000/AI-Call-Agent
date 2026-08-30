-- 0004_user_management.sql
--
-- Credentials move fully into the database. Until now `users` held only the
-- login and hash; the bootstrap and the production boot check both depended on
-- ADMIN_USERNAME / ADMIN_PASSWORD_HASH in the environment.

alter table users add column is_active     integer     not null default 1;
alter table users add column updated_at    timestamptz not null default now();
alter table users add column last_login_at timestamptz;
alter table users add column created_by    text;

-- Logins are case-insensitive in practice (people type Vikrant@... and
-- vikrant@...), so uniqueness has to be too, or you get two accounts that look
-- identical in the UI and only one of which can ever log in.
create unique index users_username_lower_key on users (lower(username));

create index users_active_admin_idx on users (role) where is_active = 1;
