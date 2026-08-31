-- 0015_calls_intended_visit.sql
-- The centre takes walk-ins during opening hours and has no appointment system,
-- so nothing is booked and nobody calls the donor back. What is worth keeping
-- is when the donor said they intend to come, so the team knows to expect them.
--
-- Free text on purpose: donors answer "agle mahine ki 5 tareekh, subah 10 baje",
-- not a timestamp. It is what they said, not a commitment either side has made.
alter table calls
  add column intended_visit_note text;
