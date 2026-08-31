-- Every review call now ends by telling the donor when they become eligible
-- again and asking whether they want a slot booked. That answer is the reason
-- the call was worth placing, so it is stored on the call rather than left for
-- someone to find by reading the transcript back.
--
-- The agent has no calendar: this records intent for the team to act on, not a
-- confirmed appointment.
alter table calls
  add column redonation_interest text
    check (redonation_interest in ('yes', 'no', 'unclear')),
  add column redonation_note text;

-- The working queue is "who said yes", which is a small slice of all calls.
create index if not exists idx_calls_redonation_interest
  on calls (redonation_interest)
  where redonation_interest is not null;
