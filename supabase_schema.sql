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
