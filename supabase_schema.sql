-- Supabase Migration Schema

-- Custom Users table for authentication
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'AGENT',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Customers
CREATE TABLE IF NOT EXISTS public.customers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL UNIQUE,
    preferred_slot VARCHAR(10) DEFAULT '10:00',
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Calls
CREATE TABLE IF NOT EXISTS public.calls (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    called_at TIMESTAMP WITH TIME ZONE,
    outcome VARCHAR(20),
    provider_call_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Feedback
CREATE TABLE IF NOT EXISTS public.feedback (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    call_id INTEGER REFERENCES calls(id) ON DELETE CASCADE,
    review_text TEXT,
    category VARCHAR(10),
    stars INTEGER,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- App State
CREATE TABLE IF NOT EXISTS public.app_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Call Supervisor Events
CREATE TABLE IF NOT EXISTS public.call_supervisor_events (
    id SERIAL PRIMARY KEY,
    call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    event_type VARCHAR(40) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info',
    payload_json TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Campaign Configs
CREATE TABLE IF NOT EXISTS public.campaign_configs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    service_name VARCHAR(100),
    monthly_spend_inr REAL DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Agents
CREATE TABLE IF NOT EXISTS public.agents (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(120) NOT NULL UNIQUE,
    description TEXT,
    client_name VARCHAR(100),
    language VARCHAR(20) DEFAULT 'hi',
    voice_pipeline VARCHAR(30) DEFAULT 'legacy',
    stt_provider VARCHAR(30) DEFAULT 'deepgram',
    llm_provider VARCHAR(30) DEFAULT 'gemini',
    llm_model VARCHAR(120),
    tts_provider VARCHAR(30) DEFAULT 'native',
    tts_voice VARCHAR(120),
    system_prompt TEXT,
    opening_prompt TEXT,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Clients
CREATE TABLE IF NOT EXISTS public.clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL UNIQUE,
    date_of_birth DATE,
    last_visit_date DATE NOT NULL,
    treatment_type VARCHAR(120) NOT NULL,
    annual_reminder_enabled INTEGER DEFAULT 1,
    annual_reminder_slot VARCHAR(10) DEFAULT '10:00',
    next_annual_reminder_date DATE,
    last_annual_reminder_at TIMESTAMP WITH TIME ZONE,
    last_annual_reminder_year INTEGER,
    notes TEXT,
    linked_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =========================================================================
-- MULTITENANT MIGRATION ADDITIONS
-- =========================================================================

-- 1. Create Tenants Table
CREATE TABLE IF NOT EXISTS public.tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    primary_contact JSONB DEFAULT '{}'::jsonb,
    address TEXT DEFAULT '',
    timezone VARCHAR(80) DEFAULT 'Asia/Kolkata',
    daily_report_time VARCHAR(5) DEFAULT '19:00',
    branding JSONB DEFAULT '{"displayName": "", "primaryColor": "#155eef"}'::jsonb,
    plan VARCHAR(64) DEFAULT 'standard',
    limits JSONB DEFAULT '{"users": 25, "monthlyCalls": 10000}'::jsonb,
    billing_contact VARCHAR(254) DEFAULT '',
    internal_notes TEXT DEFAULT '',
    tags JSONB DEFAULT '[]'::jsonb,
    settings_overrides JSONB DEFAULT '{}'::jsonb,
    status VARCHAR(50) DEFAULT 'active',
    archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    archived_by VARCHAR(255) DEFAULT NULL,
    archive_reason TEXT DEFAULT NULL,
    pre_archive_status VARCHAR(50) DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Modify Users Table
ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS platform_access_level VARCHAR(50) DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS archived_by VARCHAR(255) DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS archive_reason TEXT DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pre_archive_status VARCHAR(50) DEFAULT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE;

-- 3. Add tenant_id to existing resource tables
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
ALTER TABLE public.feedback ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;

DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'support_tickets') THEN
        ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- 4. Create AuditEvents Table
CREATE TABLE IF NOT EXISTS public.audit_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor VARCHAR(255) NOT NULL,
    actor_access_level VARCHAR(50),
    action VARCHAR(255) NOT NULL,
    target_type VARCHAR(255),
    target_id VARCHAR(255),
    tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
    request_id VARCHAR(255),
    outcome VARCHAR(50),
    failure_code VARCHAR(255),
    before_state JSONB DEFAULT NULL,
    after_state JSONB DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON public.audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_id ON public.audit_events(tenant_id, created_at DESC);

-- 5. Create IntegrationSecrets Table
CREATE TABLE IF NOT EXISTS public.integration_secrets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    integration VARCHAR(128) NOT NULL,
    key VARCHAR(128) NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(integration, key)
);

-- 6. Create PlatformSettings Table
CREATE TABLE IF NOT EXISTS public.platform_settings (
    singleton_key VARCHAR(50) PRIMARY KEY DEFAULT 'platform',
    schema_version INTEGER DEFAULT 1,
    application JSONB DEFAULT '{}'::jsonb,
    defaults JSONB DEFAULT '{}'::jsonb,
    feature_flags JSONB DEFAULT '{}'::jsonb,
    policies JSONB DEFAULT '{}'::jsonb,
    providers JSONB DEFAULT '{}'::jsonb,
    notification_templates JSONB DEFAULT '{}'::jsonb,
    retention JSONB DEFAULT '{}'::jsonb,
    maintenance JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Add RLS Policies
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
