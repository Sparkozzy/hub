-- ============================================================
-- MINDFLOW HUB — CLIENT FEEDBACKS (PromptOps Quality Gate)
-- Execute no Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.client_feedbacks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    client_name TEXT,
    user_email TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp'
        CHECK (channel IN ('whatsapp', 'voz', 'instagram', 'fup')),
    phone_numbers TEXT NOT NULL,
    current_behavior TEXT NOT NULL,
    forbidden_behavior TEXT,
    expected_behavior TEXT NOT NULL,
    exception_rule TEXT,
    ai_validation_score INT,
    ai_validation_feedback JSONB DEFAULT '{}'::jsonb,
    attachments JSONB DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'pendente'
        CHECK (status IN ('pendente', 'em_analise', 'aplicado', 'rejeitado')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_feedbacks_client_id
    ON public.client_feedbacks (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_feedbacks_status
    ON public.client_feedbacks (status);
