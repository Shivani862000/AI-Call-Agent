-- 0021_calls_no_response.sql
--
-- Calls the patient answered and then gave nothing on ("Hello? Hello?", then
-- gone). iCallMate reports these as completed like any connected call; the
-- post-call pipeline now marks them outcome = 'no_response'.

-- What the live call saw of the patient: 'engaged', 'declined' or
-- 'no_response'. Null for calls placed before this existed, and for inbound
-- calls, which have no identity step.
alter table calls add column engagement text;

-- Once a call is known to have produced nothing, a late "completed" from the
-- provider must not turn it back into a completed call. Five code paths write
-- outcome = 'completed' when a call disconnects, and some of them run after
-- the pipeline has finished, so the rule lives here rather than in each.
-- Named to sort before calls_sync_status_update, so status follows the kept
-- outcome.
create or replace function calls_keep_no_response() returns trigger as $$
begin
  if old.outcome = 'no_response'
     and coalesce(new.outcome, '') in ('', 'completed', 'answered', 'in_progress', 'ringing', 'queued', 'initiated') then
    new.outcome := old.outcome;
    new.outcome_detail := old.outcome_detail;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger calls_keep_no_response_update before update of outcome on calls
  for each row execute function calls_keep_no_response();
