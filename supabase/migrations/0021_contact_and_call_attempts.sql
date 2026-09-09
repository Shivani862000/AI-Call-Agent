-- 0021_contact_and_call_attempts.sql
-- Durable identity and contact decisions for outbound admission.

alter table patients
  add column if not exists contact_revision bigint not null default 0,
  add column if not exists contact_restriction_source text,
  add column if not exists contact_restriction_evidence text,
  add column if not exists contact_restriction_updated_at timestamptz;

create table if not exists call_attempts (
  id bigint generated always as identity primary key,
  request_key text not null unique,
  patient_id bigint not null references patients(id) on delete restrict,
  customer_id bigint references customers(id) on delete set null,
  destination_snapshot text not null,
  call_type text not null default 'REVIEW_CALL',
  contact_revision bigint not null default 0,
  state text not null default 'reserved'
    check (state in ('reserved','submitting','submitted','submission_unknown','rejected','completed','failed','cancelled')),
  provider_scope text,
  provider_call_id text,
  provider_request_json text,
  provider_response_json text,
  decision_reason text,
  writer_id text,
  reserved_at timestamptz not null default now(),
  submitted_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists call_attempts_patient_state_idx
  on call_attempts(patient_id, state, reserved_at desc);
create index if not exists call_attempts_provider_id_idx
  on call_attempts(provider_scope, provider_call_id)
  where provider_call_id is not null;
create unique index if not exists call_attempts_active_provider_id_key
  on call_attempts(provider_scope, provider_call_id)
  where provider_call_id is not null and state in ('reserved','submitting','submitted','submission_unknown');

create table if not exists contact_events (
  id bigint generated always as identity primary key,
  patient_id bigint not null references patients(id) on delete restrict,
  actor_username text,
  source_type text not null,
  source_attempt_id bigint references call_attempts(id) on delete set null,
  evidence_ref text,
  expected_revision bigint not null,
  new_revision bigint not null,
  decision text not null check (decision in ('unknown','granted','refused')),
  created_at timestamptz not null default now(),
  unique (patient_id, new_revision)
);

create index if not exists contact_events_patient_created_idx
  on contact_events(patient_id, created_at desc);

alter table calls
  add column if not exists attempt_id bigint references call_attempts(id) on delete set null;
create unique index if not exists calls_attempt_id_key on calls(attempt_id)
  where attempt_id is not null;

-- 0011 predates these tables; zero policies keep processing state out of the
-- anonymous/authenticated Data API until reviewed grants are added.
alter table call_attempts enable row level security;
alter table contact_events enable row level security;

-- Expose the revision to the service-side stale-decision check while keeping
-- the existing queue response shape intact.
drop view customer_queue;
create view customer_queue as
select
  c.*,
  trim(p.first_name || coalesce(' ' || p.last_name, '')) as name,
  p.phone, p.normalized_phone, p.email,
  p.preferred_language,
  null::text as preferred_dialect,
  p.preferred_call_slot as preferred_slot,
  p.do_not_call, p.consent_status, p.contact_revision,
  p.last_donation_date, p.last_test_date, p.blood_group, p.gender,
  p.date_of_birth, p.reference_id,
  p.status as patient_status,
  coalesce(p.last_donation_date, p.last_test_date) as last_visit_date,
  latest.redonation_interest,
  latest.redonation_note,
  latest.intended_visit_note,
  case
    when latest.redonation_interest = 'yes' and p.last_donation_date is not null
      then p.last_donation_date + 90
  end as next_appointment_date
from customers c
join patients p on p.id = c.patient_id
left join lateral (
  select cl.redonation_interest, cl.redonation_note, cl.intended_visit_note
    from calls cl
   where cl.customer_id = c.id
     and cl.redonation_interest is not null
   order by cl.called_at desc nulls last, cl.id desc
   limit 1
) latest on true;
