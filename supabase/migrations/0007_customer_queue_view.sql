-- 0007_customer_queue_view.sql
--
-- Reads move off the person columns on `customers` without rewriting ~26
-- queries: the view exposes patient data under the legacy column names, so
-- `SELECT * FROM customer_queue` returns what `SELECT * FROM customers` used
-- to, and downstream code that reads `customer.name` keeps working.
--
-- Writes still target `customers` directly; a joined view is not updatable.

create view customer_queue as
select
  c.id,
  c.status,
  c.created_at,
  c.customer_value,
  c.urgency_level,
  c.priority_score,
  c.ai_score,
  c.last_contact_outcome,
  c.scheduled_datetime,
  c.next_retry_at,
  c.retry_count,
  c.wrong_number_flag,
  c.admin_review_required,
  c.callback_requested_at,
  c.last_called_at,
  c.best_call_slot,
  c.pickup_rate_score,
  c.outstanding_issues,
  c.pending_follow_ups,
  c.last_sentiment_score,
  c.last_sentiment_label,
  c.revenue_stage,
  c.revenue_estimate,
  c.campaign_name,
  c.service_interest,
  c.call_type,
  c.last_competitor_mention,
  c.default_agent_id,
  c.video_sent,
  c.attempt_count,
  c.failed_reason,
  c.auto_retry_enabled,
  c.locked_at,
  c.is_manual,
  c.patient_id,

  -- Person data, under the names the existing code already reads.
  trim(p.first_name || coalesce(' ' || p.last_name, '')) as name,
  p.phone,
  p.normalized_phone,
  p.email,
  p.preferred_language,
  null::text as preferred_dialect,   -- patients does not carry a dialect; kept so legacy reads do not break
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
  coalesce(p.last_donation_date, p.last_test_date) as last_visit_date
from customers c
join patients p on p.id = c.patient_id;
