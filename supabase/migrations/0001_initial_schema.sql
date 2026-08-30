-- 0001_initial_schema.sql  (generated from the SQLite schema, then hand-augmented)

create table customers (
  id bigint generated always as identity primary key,
  name text not null,
  phone text not null,
  preferred_slot text default '10:00',
  status text default 'pending',
  created_at timestamptz default now(),
  customer_value text default 'standard',
  urgency_level text default 'normal',
  priority_score integer default 50,
  ai_score integer default 50,
  preferred_language text default 'hi',
  preferred_dialect text,
  do_not_call integer default 0,
  consent_status text default 'unknown',
  last_contact_outcome text,
  scheduled_datetime timestamptz,
  next_retry_at timestamptz,
  retry_count integer default 0,
  wrong_number_flag integer default 0,
  admin_review_required integer default 0,
  callback_requested_at timestamptz,
  last_called_at timestamptz,
  best_call_slot text,
  pickup_rate_score integer default 0,
  outstanding_issues text,
  pending_follow_ups text,
  last_sentiment_score double precision,
  last_sentiment_label text,
  revenue_stage text default 'unassigned',
  revenue_estimate double precision default 0,
  campaign_name text,
  service_interest text,
  call_type text default 'REVIEW_CALL',
  last_competitor_mention text,
  dnd_checked_at timestamptz,
  default_agent_id bigint,
  video_sent integer default 0,
  attempt_count integer default 0,
  failed_reason text,
  normalized_phone text,
  auto_retry_enabled integer default 0,
  locked_at timestamptz,
  is_manual integer default 0,
  last_visit_date date
);

create table clients (
  id bigint generated always as identity primary key,
  name text not null,
  phone text not null unique,
  date_of_birth date,
  last_visit_date date not null,
  treatment_type text not null,
  annual_reminder_enabled integer default 1,
  annual_reminder_slot text default '10:00',
  next_annual_reminder_date date,
  last_annual_reminder_at timestamptz,
  last_annual_reminder_year integer,
  notes text,
  linked_customer_id bigint,
  status text default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table agents (
  id bigint generated always as identity primary key,
  name text not null unique,
  slug text not null unique,
  description text,
  client_name text,
  language text default 'hi',
  voice_pipeline text default 'legacy',
  stt_provider text default 'deepgram',
  llm_provider text default 'gemini',
  llm_model text,
  tts_provider text default 'native',
  tts_voice text,
  system_prompt text,
  opening_prompt text,
  is_default integer default 0,
  is_active integer default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table users (
  id bigint generated always as identity primary key,
  username text not null unique,
  password_hash text not null,
  role text default 'AGENT',
  created_at timestamptz default now()
);

create table campaign_configs (
  id bigint generated always as identity primary key,
  name text not null unique,
  service_name text,
  monthly_spend_inr double precision default 0,
  status text default 'active',
  created_at timestamptz default now()
);

create table calls (
  id bigint generated always as identity primary key,
  customer_id bigint not null,
  called_at timestamptz,
  outcome text,
  provider_call_id text,
  created_at timestamptz default now(),
  idempotency_key text,
  status text default 'pending',
  updated_at timestamptz,
  call_direction text default 'outbound',
  call_source text default 'icallmate',
  did text,
  answered_at timestamptz,
  ended_at timestamptz,
  media_packets integer default 0,
  last_event text,
  notes text,
  provider_payload_json text,
  transcript_text text,
  consent_detected integer default 0,
  language text,
  extracted_rating integer,
  extracted_review_text text,
  feedback_saved_at timestamptz,
  recording_sid text,
  recording_url text,
  recording_status text,
  recording_object_key text,
  transcript_status text default 'pending',
  transcript_source text,
  analysis_status text default 'pending',
  analysis_summary text,
  summary text,
  analysis_json text,
  key_points_json text,
  report_excerpt text,
  analysis_completed_at timestamptz,
  outcome_detail text,
  fallback_triggered integer default 0,
  sentiment_label text,
  sentiment text,
  sentiment_score double precision,
  call_duration integer default 0,
  ai_talk_time integer default 0,
  patient_talk_time integer default 0,
  quality_score integer default 0,
  timeline_events text,
  extracted_entities text,
  hot_lead_score integer default 0,
  next_action_at timestamptz,
  follow_up_task text,
  crm_sync_status text default 'pending',
  revenue_attribution_status text default 'pending',
  call_script_version text default 'hindi-feedback-v1',
  call_type text default 'REVIEW_CALL',
  competitor_mentions_json text,
  objections_json text,
  interest_detected integer default 0,
  callback_requested integer default 0,
  human_escalation_requested integer default 0,
  supervisor_alert_level text default 'normal',
  consent_message_played integer default 0,
  live_sentiment_score double precision,
  live_sentiment_label text,
  live_red_flag integer default 0,
  agent_id bigint
);

create table feedback (
  id bigint generated always as identity primary key,
  customer_id bigint not null,
  call_id bigint,
  review_text text,
  category text,
  stars integer,
  submitted_at timestamptz default now(),
  source text default 'manual'
);

create table call_supervisor_events (
  id bigint generated always as identity primary key,
  call_id bigint not null,
  event_type text not null,
  severity text default 'info',
  payload_json text,
  created_at timestamptz default now()
);

create table support_tickets (
  id bigint generated always as identity primary key,
  ticket_id text not null unique,
  type text not null,
  description text not null,
  status text default 'NEW' not null,
  reporter_username text not null,
  reporter_role text not null,
  page_url text not null,
  page_title text not null,
  context_json text not null,
  assignee_username text,
  internal_update text,
  resolution_note text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table app_state (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

-- ── foreign keys (enforced, unlike the SQLite original) ──────────────────────
alter table calls                  add constraint calls_customer_fk
  foreign key (customer_id) references customers(id) on delete cascade;
alter table feedback               add constraint feedback_customer_fk
  foreign key (customer_id) references customers(id) on delete cascade;
alter table feedback               add constraint feedback_call_fk
  foreign key (call_id) references calls(id) on delete cascade;
alter table call_supervisor_events add constraint supervisor_call_fk
  foreign key (call_id) references calls(id) on delete cascade;
alter table clients                add constraint clients_customer_fk
  foreign key (linked_customer_id) references customers(id) on delete set null;

-- ── indexes ──────────────────────────────────────────────────────────────────
create unique index customers_normalized_phone_key
  on customers(normalized_phone) where normalized_phone is not null;
create index calls_customer_id_idx           on calls(customer_id);
create index calls_provider_call_id_idx      on calls(provider_call_id);
create index calls_created_at_idx            on calls(created_at desc);
create index feedback_customer_id_idx        on feedback(customer_id);
create index feedback_call_id_idx            on feedback(call_id);
create index supervisor_call_id_idx          on call_supervisor_events(call_id);
create index support_tickets_status_updated_idx
  on support_tickets(status, updated_at desc);

-- ── check constraints ────────────────────────────────────────────────────────
-- Only added where the full value set is provable from the code.
-- customers.status / calls.outcome are deliberately left unconstrained: their
-- values are written from several call sites and a wrong CHECK is an outage.
alter table users add constraint users_role_chk
  check (upper(role) in ('ADMIN','AGENT'));
alter table support_tickets add constraint support_tickets_type_chk
  check (type in ('BUG','IDEA','QUESTION'));
alter table support_tickets add constraint support_tickets_status_chk
  check (status in ('NEW','IN_PROGRESS','RESOLVED'));
alter table support_tickets add constraint support_tickets_role_chk
  check (reporter_role in ('ADMIN','AGENT'));

-- ── calls.status mirrors calls.outcome (port of the two SQLite triggers) ─────
create or replace function calls_sync_status() returns trigger as $$
begin
  if coalesce(new.outcome, '') <> '' and coalesce(new.status, 'pending') = 'pending' then
    new.status := new.outcome;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger calls_sync_status_ins before insert on calls
  for each row execute function calls_sync_status();

create or replace function calls_sync_status_upd() returns trigger as $$
begin
  if coalesce(new.outcome, '') <> coalesce(old.outcome, '')
     and coalesce(new.outcome, '') <> '' then
    new.status := new.outcome;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger calls_sync_status_update before update of outcome on calls
  for each row execute function calls_sync_status_upd();
