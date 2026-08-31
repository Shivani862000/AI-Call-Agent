-- 0016_customer_queue_intended_visit.sql
-- The queue row already carries whether the donor wants to come in; it now also
-- carries when they said they would. Since the centre takes walk-ins and books
-- nothing, the donor's own words are more use to the team than the derived
-- eligibility date, which stays as a fallback for a yes with no time given.
drop view customer_queue;
create view customer_queue as
select
  c.*,
  trim(p.first_name || coalesce(' ' || p.last_name, '')) as name,
  p.phone, p.normalized_phone, p.email,
  p.preferred_language,
  null::text as preferred_dialect,
  p.preferred_call_slot as preferred_slot,
  p.do_not_call, p.consent_status,
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
