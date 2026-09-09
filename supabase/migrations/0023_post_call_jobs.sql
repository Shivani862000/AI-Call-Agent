-- 0023_post_call_jobs.sql
-- Durable, fenced post-call stage claims and retry schedule.

CREATE TABLE IF NOT EXISTS post_call_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id bigint NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('recording', 'transcription', 'analysis', 'finalization', 'completion')),
  input_revision text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'blocked', 'manual_review')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  claim_token text,
  claim_expires_at timestamptz,
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, stage, input_revision)
);

CREATE INDEX IF NOT EXISTS post_call_jobs_due_idx
  ON post_call_jobs (status, next_run_at, claim_expires_at);
CREATE INDEX IF NOT EXISTS post_call_jobs_call_idx
  ON post_call_jobs (call_id, stage, created_at DESC);

ALTER TABLE post_call_jobs ENABLE ROW LEVEL SECURITY;
