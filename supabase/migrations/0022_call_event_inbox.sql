-- 0022_call_event_inbox.sql
-- Durable quarantine for provider events that cannot be matched exactly.

CREATE TABLE IF NOT EXISTS call_event_inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL,
  provider_scope text NOT NULL,
  provider_call_id text,
  attempt_id bigint REFERENCES call_attempts(id) ON DELETE SET NULL,
  request_key text,
  event_name text NOT NULL,
  match_state text NOT NULL CHECK (match_state IN ('matched', 'unmatched', 'ambiguous', 'conflict')),
  match_reason text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  matched_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS call_event_inbox_scope_key
  ON call_event_inbox (provider_scope, event_key);
CREATE INDEX IF NOT EXISTS call_event_inbox_review_idx
  ON call_event_inbox (match_state, received_at DESC);
CREATE INDEX IF NOT EXISTS call_event_inbox_attempt_idx
  ON call_event_inbox (attempt_id, received_at DESC);

ALTER TABLE call_event_inbox ENABLE ROW LEVEL SECURITY;
