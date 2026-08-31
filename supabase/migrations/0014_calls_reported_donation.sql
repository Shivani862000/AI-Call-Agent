-- 0014_calls_reported_donation.sql
-- The three-month follow-up asks a donor who has given blood again when and
-- where they did it. Both answers were spoken, acknowledged, and then existed
-- only inside the transcript, so the donation record was never updated and the
-- next follow-up asked the same question again.
--
-- Stored as free text on purpose: donors answer "pichle mahine" or "Delhi mein
-- kahin", not an ISO date. This is what they said, for a human to reconcile
-- against the record -- it is not a confirmed donation.
alter table calls
  add column reported_donation_date text,
  add column reported_donation_place text;
