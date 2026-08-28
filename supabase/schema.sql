-- Supabase Schema Migration (Complete)
-- Replaces MongoDB and SQLite implementation

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-------------------------------------------------------------------------------
-- ENUMS
-------------------------------------------------------------------------------
CREATE TYPE archive_status AS ENUM ('active', 'suspended', 'archived', 'paused');
CREATE TYPE actor_access_level AS ENUM ('OWNER', 'ADMIN', 'SYSTEM');
CREATE TYPE audit_outcome AS ENUM ('success', 'failure');
CREATE TYPE notification_status AS ENUM ('pending', 'delivered', 'failed');
CREATE TYPE support_ticket_type AS ENUM ('BUG', 'IDEA', 'QUESTION');
CREATE TYPE support_ticket_status AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED');
CREATE TYPE user_role AS ENUM ('WEBMASTER', 'SUPPORT_TEAM', 'CLIENT_ADMIN', 'CLIENT_AGENT');
CREATE TYPE platform_access_level AS ENUM ('OWNER', 'ADMIN');

-------------------------------------------------------------------------------
-- 1. TENANTS
-------------------------------------------------------------------------------
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  primary_contact_name TEXT,
  primary_contact_email TEXT,
  primary_contact_phone TEXT,
  address TEXT DEFAULT '',
  timezone TEXT DEFAULT 'Asia/Kolkata',
  branding_display_name TEXT DEFAULT '',
  branding_primary_color TEXT DEFAULT '#155eef',
  plan TEXT DEFAULT 'standard',
  limits_users INTEGER DEFAULT 25,
  limits_monthly_calls INTEGER DEFAULT 10000,
  billing_contact TEXT DEFAULT '',
  internal_notes TEXT DEFAULT '',
  tags TEXT[] DEFAULT '{}',
  settings_overrides JSONB DEFAULT '{}',
  daily_report_time TEXT DEFAULT '19:00',
  status archive_status DEFAULT 'active',
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  archived_by TEXT DEFAULT NULL,
  archive_reason TEXT DEFAULT NULL,
  pre_archive_status TEXT DEFAULT NULL,
  lifecycle_guard_version INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-------------------------------------------------------------------------------
-- 2. USERS (Custom Users Table mapping to auth.users if needed)
-------------------------------------------------------------------------------
-- We keep a public.users table because the legacy system used password_hash locally. 
-- In Supabase, you would ideally migrate these to auth.users, but to guarantee
-- 100% functionality preservation without a massive rewrite of auth logic immediately,
-- we map the exact Mongo User schema.
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL,
  platform_access_level platform_access_level DEFAULT NULL,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  status archive_status DEFAULT 'active',
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  archived_by TEXT DEFAULT NULL,
  archive_reason TEXT DEFAULT NULL,
  pre_archive_status TEXT DEFAULT NULL,
  password_changed_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-------------------------------------------------------------------------------
-- 3. AGENTS
-------------------------------------------------------------------------------
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT DEFAULT NULL,
  client_name TEXT DEFAULT NULL,
  language TEXT DEFAULT 'hi',
  voice_pipeline TEXT DEFAULT 'legacy',
  stt_provider TEXT DEFAULT 'deepgram',
  llm_provider TEXT DEFAULT 'gemini',
  llm_model TEXT DEFAULT NULL,
  tts_provider TEXT DEFAULT 'native',
  tts_voice TEXT DEFAULT NULL,
  system_prompt TEXT DEFAULT NULL,
  opening_prompt TEXT DEFAULT NULL,
  status archive_status DEFAULT 'active',
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  archived_by TEXT DEFAULT NULL,
  archive_reason TEXT DEFAULT NULL,
  pre_archive_status TEXT DEFAULT NULL,
  is_active BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, slug)
);

-------------------------------------------------------------------------------
-- 4. CUSTOMERS
-------------------------------------------------------------------------------
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  preferred_slot TEXT DEFAULT '10:00',
  status TEXT DEFAULT 'pending',
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  archived_by TEXT DEFAULT NULL,
  archive_reason TEXT DEFAULT NULL,
  pre_archive_status TEXT DEFAULT NULL,
  customer_value TEXT DEFAULT 'standard',
  urgency_level TEXT DEFAULT 'normal',
  priority_score INTEGER DEFAULT 50,
  ai_score INTEGER DEFAULT 50,
  preferred_language TEXT DEFAULT 'hi',
  preferred_dialect TEXT,
  do_not_call INTEGER DEFAULT 0,
  consent_status TEXT DEFAULT 'unknown',
  last_contact_outcome TEXT,
  scheduled_datetime TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  retry_count INTEGER DEFAULT 0,
  wrong_number_flag INTEGER DEFAULT 0,
  admin_review_required INTEGER DEFAULT 0,
  callback_requested_at TIMESTAMP WITH TIME ZONE,
  last_called_at TIMESTAMP WITH TIME ZONE,
  best_call_slot TEXT,
  last_pickup_slot TEXT,
  pickup_rate_score INTEGER DEFAULT 0,
  outstanding_issues TEXT,
  pending_follow_ups TEXT,
  last_sentiment_score INTEGER,
  last_sentiment_label TEXT,
  revenue_stage TEXT DEFAULT 'unassigned',
  revenue_estimate INTEGER DEFAULT 0,
  campaign_name TEXT,
  service_interest TEXT,
  call_type TEXT DEFAULT 'REVIEW_CALL',
  last_competitor_mention TEXT,
  data_retention_until TIMESTAMP WITH TIME ZONE,
  dnd_checked_at TIMESTAMP WITH TIME ZONE,
  default_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  video_sent INTEGER DEFAULT 0,
  attempt_count INTEGER DEFAULT 0,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  next_attempt_at TIMESTAMP WITH TIME ZONE,
  failed_reason TEXT,
  scheduled_at TIMESTAMP WITH TIME ZONE,
  phone_number TEXT,
  normalized_phone TEXT,
  auto_retry_enabled INTEGER DEFAULT 0,
  locked_at TIMESTAMP WITH TIME ZONE,
  provider_request_id TEXT,
  is_manual INTEGER DEFAULT 0,
  last_visit_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-------------------------------------------------------------------------------
-- 5. CALLS
-------------------------------------------------------------------------------
CREATE TABLE calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  legacy_customer_ref_hash TEXT,
  customer_phone_ref_hash TEXT,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  call_type TEXT NOT NULL,
  status TEXT NOT NULL,
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  archived_by TEXT DEFAULT NULL,
  archive_reason TEXT DEFAULT NULL,
  pre_archive_status TEXT DEFAULT NULL,
  outcome TEXT,
  provider_call_id TEXT DEFAULT NULL,
  context_state TEXT DEFAULT NULL,
  call_direction TEXT DEFAULT 'outbound',
  call_source TEXT DEFAULT NULL,
  client_name TEXT DEFAULT NULL,
  provider_payload_json JSONB DEFAULT NULL,
  recording_url TEXT DEFAULT NULL,
  transcript TEXT DEFAULT NULL,
  transcript_status TEXT,
  duration_seconds INTEGER DEFAULT 0,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  extracted_review_text TEXT,
  extracted_rating INTEGER,
  sentiment_label TEXT,
  sentiment TEXT,
  analysis_summary TEXT,
  analysis_status TEXT,
  analysis_json JSONB,
  analysis_completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_calls_tenant_phone_started ON calls(tenant_id, customer_phone_ref_hash, started_at DESC);

-------------------------------------------------------------------------------
-- 6. CAMPAIGNS
-------------------------------------------------------------------------------
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  service_name TEXT DEFAULT NULL,
  monthly_spend_inr INTEGER DEFAULT 0,
  status archive_status DEFAULT 'active',
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  archived_by TEXT DEFAULT NULL,
  archive_reason TEXT DEFAULT NULL,
  pre_archive_status TEXT DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

-------------------------------------------------------------------------------
-- 7. CLIENTS
-------------------------------------------------------------------------------
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  date_of_birth TEXT DEFAULT NULL,
  last_visit_date TEXT NOT NULL,
  treatment_type TEXT NOT NULL,
  annual_reminder_enabled INTEGER DEFAULT 1,
  annual_reminder_slot TEXT DEFAULT '10:00',
  next_annual_reminder_date TEXT DEFAULT NULL,
  last_annual_reminder_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  last_annual_reminder_year INTEGER DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  status archive_status DEFAULT 'active',
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  archived_by TEXT DEFAULT NULL,
  archive_reason TEXT DEFAULT NULL,
  pre_archive_status TEXT DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, phone)
);

-------------------------------------------------------------------------------
-- 8. FEEDBACK
-------------------------------------------------------------------------------
CREATE TABLE feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  category TEXT,
  source TEXT DEFAULT 'manual',
  status archive_status DEFAULT 'active',
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  archived_by TEXT DEFAULT NULL,
  archive_reason TEXT DEFAULT NULL,
  pre_archive_status TEXT DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-------------------------------------------------------------------------------
-- 9. AUDIT EVENTS
-------------------------------------------------------------------------------
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor TEXT NOT NULL,
  actor_access_level actor_access_level NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  before_state JSONB DEFAULT NULL,
  after_state JSONB DEFAULT NULL,
  request_id TEXT DEFAULT NULL,
  outcome audit_outcome NOT NULL,
  failure_code TEXT DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_events_created_at ON audit_events(created_at DESC);
CREATE INDEX idx_audit_events_tenant_created ON audit_events(tenant_id, created_at DESC);

-------------------------------------------------------------------------------
-- 10. NOTIFICATION DELIVERIES
-------------------------------------------------------------------------------
CREATE TABLE notification_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  account_id UUID REFERENCES users(id) ON DELETE CASCADE,
  recipient_category TEXT NOT NULL,
  template TEXT NOT NULL,
  event TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  status notification_status DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  failure_code TEXT DEFAULT NULL,
  failure_reason TEXT DEFAULT NULL,
  last_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_notification_tenant_status ON notification_deliveries(tenant_id, status, created_at DESC);
CREATE INDEX idx_notification_status ON notification_deliveries(status, created_at DESC);

-------------------------------------------------------------------------------
-- 11. INTEGRATION SECRETS
-------------------------------------------------------------------------------
CREATE TABLE integration_secrets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  integration TEXT NOT NULL,
  key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  encryption_version INTEGER DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_by_access_level actor_access_level NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(integration, key)
);

-------------------------------------------------------------------------------
-- 12. PLATFORM SETTINGS
-------------------------------------------------------------------------------
CREATE TABLE platform_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  singleton_key TEXT DEFAULT 'platform' UNIQUE NOT NULL,
  schema_version INTEGER DEFAULT 1,
  application JSONB DEFAULT '{}',
  defaults JSONB DEFAULT '{}',
  feature_flags JSONB DEFAULT '{}',
  policies JSONB DEFAULT '{}',
  providers JSONB DEFAULT '{}',
  notification_templates JSONB DEFAULT '{}',
  retention JSONB DEFAULT '{}',
  maintenance JSONB DEFAULT '{}',
  ownership_guard_version INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-------------------------------------------------------------------------------
-- 13. SUPPORT TICKETS
-------------------------------------------------------------------------------
CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL UNIQUE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  type support_ticket_type NOT NULL,
  description TEXT NOT NULL,
  status support_ticket_status DEFAULT 'NEW',
  reporter_username TEXT NOT NULL,
  reporter_role TEXT NOT NULL,
  page_url TEXT NOT NULL,
  page_title TEXT NOT NULL,
  context_json JSONB NOT NULL,
  assignee_username TEXT DEFAULT NULL,
  internal_update TEXT DEFAULT NULL,
  resolution_note TEXT DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_support_tickets_updated_at ON support_tickets(updated_at DESC);

-------------------------------------------------------------------------------
-- 14. SUPPORT TICKET COUNTER
-------------------------------------------------------------------------------
CREATE TABLE support_ticket_counters (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL DEFAULT 0
);

-------------------------------------------------------------------------------
-- TRIGGERS FOR UPDATED_AT
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_agents_updated_at BEFORE UPDATE ON agents FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_calls_updated_at BEFORE UPDATE ON calls FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_notification_deliveries_updated_at BEFORE UPDATE ON notification_deliveries FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_integration_secrets_updated_at BEFORE UPDATE ON integration_secrets FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_platform_settings_updated_at BEFORE UPDATE ON platform_settings FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_support_tickets_updated_at BEFORE UPDATE ON support_tickets FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-------------------------------------------------------------------------------
-- ROW LEVEL SECURITY (RLS)
-------------------------------------------------------------------------------
-- Note: As a general rule, WEBMASTER has global access. 
-- Tenants are isolated by tenant_id.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

-- Tenants Policy
CREATE POLICY "Tenants are viewable by Webmaster or users of that tenant" ON tenants
  FOR SELECT USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER' OR
    (current_setting('request.jwt.claims', true)::jsonb->>'tenantId')::uuid = id
  );

CREATE POLICY "Tenants are modifiable by Webmaster" ON tenants
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER'
  );

-- Users Policy
CREATE POLICY "Users are viewable by Webmaster or users of that tenant" ON users
  FOR SELECT USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER' OR
    (current_setting('request.jwt.claims', true)::jsonb->>'tenantId')::uuid = tenant_id
  );

CREATE POLICY "Users are modifiable by Webmaster" ON users
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER'
  );

-- General Tenant-Scoped Policy Template
-- Applicable to Agents, Customers, Calls, Campaigns, Clients, Feedback
CREATE POLICY "Tenant isolation for Agents" ON agents
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER' OR
    (current_setting('request.jwt.claims', true)::jsonb->>'tenantId')::uuid = tenant_id
  );

CREATE POLICY "Tenant isolation for Customers" ON customers
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER' OR
    (current_setting('request.jwt.claims', true)::jsonb->>'tenantId')::uuid = tenant_id
  );

CREATE POLICY "Tenant isolation for Calls" ON calls
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER' OR
    (current_setting('request.jwt.claims', true)::jsonb->>'tenantId')::uuid = tenant_id
  );

CREATE POLICY "Tenant isolation for Campaigns" ON campaigns
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER' OR
    (current_setting('request.jwt.claims', true)::jsonb->>'tenantId')::uuid = tenant_id
  );

CREATE POLICY "Tenant isolation for Clients" ON clients
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER' OR
    (current_setting('request.jwt.claims', true)::jsonb->>'tenantId')::uuid = tenant_id
  );

CREATE POLICY "Tenant isolation for Feedback" ON feedback
  FOR ALL USING (
    current_setting('request.jwt.claims', true)::jsonb->>'role' = 'WEBMASTER' OR
    (current_setting('request.jwt.claims', true)::jsonb->>'tenantId')::uuid = tenant_id
  );
