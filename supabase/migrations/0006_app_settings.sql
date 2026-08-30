-- 0006_app_settings.sql — additive half of phase 2.
-- The destructive half (dropping person columns from customers) is 0007,
-- applied after the pipeline is repointed, so every commit in between works.

create table app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Sessions are stateless, so a password change cannot be noticed without a
-- value to compare the token against.
alter table users add column password_changed_at timestamptz not null default now();
