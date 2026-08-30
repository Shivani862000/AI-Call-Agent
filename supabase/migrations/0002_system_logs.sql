-- 0002_system_logs.sql
create table system_logs (
  id      bigint generated always as identity primary key,
  ts      timestamptz not null default now(),
  level   text not null,
  event   text not null,
  details jsonb
);

create index system_logs_ts_idx    on system_logs(ts desc);
create index system_logs_event_idx on system_logs(event);
create index system_logs_level_idx on system_logs(level) where level in ('WARN','ERROR');
