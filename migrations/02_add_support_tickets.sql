-- Create sequence for support tickets
CREATE SEQUENCE IF NOT EXISTS support_tickets_sequence_seq START 1000;

-- Create support_tickets table
CREATE TABLE IF NOT EXISTS public.support_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id VARCHAR(50) UNIQUE NOT NULL,
    sequence INTEGER NOT NULL DEFAULT nextval('support_tickets_sequence_seq'),
    tenant_id UUID,
    type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'NEW',
    reporter_username VARCHAR(255) NOT NULL,
    reporter_role VARCHAR(50),
    assignee_username VARCHAR(255),
    internal_update TEXT,
    resolution_note TEXT,
    page_url VARCHAR(1000),
    page_title VARCHAR(255),
    context_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure users table has email and status columns (tenant_id, etc. if needed)
-- We'll add them safely
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email') THEN
        ALTER TABLE public.users ADD COLUMN email VARCHAR(255) UNIQUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'status') THEN
        ALTER TABLE public.users ADD COLUMN status VARCHAR(20) DEFAULT 'active';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'tenant_id') THEN
        ALTER TABLE public.users ADD COLUMN tenant_id UUID;
    END IF;
END $$;
