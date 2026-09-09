-- 0026_call_campaign_snapshot.sql
-- Preserve campaign attribution on call history when queue rows are removed or
-- a configuration display name changes.

alter table calls add column campaign_id bigint;
alter table calls add column campaign_name text;

update calls call_row
   set campaign_id = customer.campaign_id,
       campaign_name = coalesce(customer.campaign_name, cfg.name)
  from customers customer
  left join campaign_configs cfg on cfg.id = customer.campaign_id
 where call_row.customer_id = customer.id
   and (call_row.campaign_id is null or call_row.campaign_name is null);

alter table calls
  add constraint calls_campaign_id_fkey
  foreign key (campaign_id) references campaign_configs(id) on delete set null;
create index calls_campaign_id_idx on calls(campaign_id);

create or replace function calls_set_campaign_snapshot() returns trigger as $$
declare
  source_campaign_id bigint;
  source_campaign_name text;
  config_name text;
begin
  if new.customer_id is not null
     and (new.campaign_id is null or new.campaign_name is null) then
    select customer.campaign_id, customer.campaign_name, cfg.name
      into source_campaign_id, source_campaign_name, config_name
      from customers customer
      left join campaign_configs cfg on cfg.id = customer.campaign_id
     where customer.id = new.customer_id;

    if new.campaign_id is null then
      new.campaign_id := source_campaign_id;
    end if;
    if new.campaign_name is null then
      new.campaign_name := coalesce(source_campaign_name, config_name);
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists calls_set_campaign_snapshot_trg on calls;
create trigger calls_set_campaign_snapshot_trg
  before insert or update of customer_id, campaign_id, campaign_name on calls
  for each row execute function calls_set_campaign_snapshot();

-- Rebuild the compatibility view from its current 0021 definition. `c.*`
-- includes the 0025 campaign_id column and preserves all columns added by
-- earlier migrations (contact revision and redonation fields).
drop view customer_queue;
create view customer_queue as
select
  c.*,
  trim(p.first_name || coalesce(' ' || p.last_name, '')) as name,
  p.phone,
  p.normalized_phone,
  p.email,
  p.preferred_language,
  null::text as preferred_dialect,
  p.preferred_call_slot as preferred_slot,
  p.do_not_call,
  p.consent_status,
  p.last_donation_date,
  p.last_test_date,
  p.blood_group,
  p.gender,
  p.date_of_birth,
  p.reference_id,
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
