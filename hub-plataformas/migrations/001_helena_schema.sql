-- ============================================================
-- MINDFLOW ENGINE — HELENA CRM INTEGRATION
-- Execute no Supabase SQL Editor
-- ============================================================

-- Schema dedicado
CREATE SCHEMA IF NOT EXISTS mindflow_engine;

-- Tabela de Tenancy — mapeia clientes MindFlow ↔ tenants Helena
CREATE TABLE IF NOT EXISTS mindflow_engine.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    helena_tenant_id VARCHAR(100) UNIQUE NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'PENDING_ONBOARDING')),
    helena_api_key TEXT,
    helena_api_base_url VARCHAR(255) DEFAULT 'https://api.helena.app/v1',
    supabase_url TEXT,
    supabase_service_key TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Controle de Estado do Chat (FSM)
CREATE TABLE IF NOT EXISTS mindflow_engine.chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES mindflow_engine.tenants(id) ON DELETE CASCADE,
    helena_ticket_id VARCHAR(100) NOT NULL,
    customer_phone VARCHAR(50) NOT NULL,
    bot_status VARCHAR(50) DEFAULT 'BOT_ACTIVE'
        CHECK (bot_status IN ('BOT_ACTIVE', 'HANDOVER_PENDING', 'HUMAN_ACTIVE', 'CLOSED')),
    conversation_context JSONB DEFAULT '{}'::jsonb,
    last_interaction_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Logs de Execução da IA
CREATE TABLE IF NOT EXISTS mindflow_engine.ai_execution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES mindflow_engine.chat_sessions(id) ON DELETE CASCADE,
    incoming_prompt TEXT NOT NULL,
    ai_response TEXT,
    tokens_used INT DEFAULT 0,
    model_name VARCHAR(100) DEFAULT 'pending-integration',
    execution_time_ms INT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_tenants_helena_id ON mindflow_engine.tenants(helena_tenant_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_ticket ON mindflow_engine.chat_sessions(helena_ticket_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON mindflow_engine.chat_sessions(bot_status);
CREATE INDEX IF NOT EXISTS idx_ai_logs_session ON mindflow_engine.ai_execution_logs(session_id);
