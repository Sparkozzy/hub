require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { rateLimit } = require('express-rate-limit');

// ============================================================
// VALIDAÇÃO DE AMBIENTE
// ============================================================
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('[FATAL] Variáveis SUPABASE_URL e SUPABASE_KEY são obrigatórias.');
  process.exit(1);
}

if (IS_PRODUCTION && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.includes('troque-isso'))) {
  console.error('[FATAL] Defina uma SESSION_SECRET forte no ambiente de produção.');
  process.exit(1);
}

// ============================================================
// SUPABASE CLIENT (principal)
// ============================================================
const jwt = require('jsonwebtoken');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Retorna as credenciais de um cliente para uso no frontend (anon key)
 */
async function getClientAnonConfig(clientId) {
  if (!clientId || clientId === '2') {
    return { supabaseUrl: process.env.SUPABASE_URL, supabaseKey: process.env.SUPABASE_KEY };
  }
  const { data } = await supabase
    .from('client_configurations')
    .select('supabase_url, supabase_anon_key')
    .eq('client_id', clientId)
    .maybeSingle();
  if (!data) return { supabaseUrl: process.env.SUPABASE_URL, supabaseKey: process.env.SUPABASE_KEY };
  return { supabaseUrl: data.supabase_url, supabaseKey: data.supabase_anon_key };
}

// ============================================================
// APP & MIDDLEWARE
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;
const recentDisparosMap = new Map();

// Map para armazenar conexões SSE ativas: executionId -> Set de res
const liveSseClients = new Map();
// Map para vincular call_id -> executionId
const callToExecutionMap = new Map();

function broadcastSseEvent(executionId, data) {
  const clients = liveSseClients.get(executionId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const clientRes of clients) {
    try {
      clientRes.write(payload);
    } catch (err) {
      console.warn('[SSE] Erro ao enviar payload:', err.message);
    }
  }
}

// Endpoint de Webhook público para receber eventos da Retell AI (e pings de teste 200 OK)
const handleRetellWebhook = async (req, res) => {
  try {
    const event = req.body || {};
    const eventName = event.event || 'ping';
    const callData = event.call || event;
    const callId = callData.call_id;

    console.log(`[Retell Webhook] Evento recebido: ${eventName} | call_id: ${callId || 'N/A'}`);

    // Se for teste do painel da Retell AI ou ping sem call_id, responde 200 OK imediatamente!
    if (!callId) {
      return res.status(200).json({ ok: true, message: 'Retell webhook test ping received successfully' });
    }

    let executionId = callToExecutionMap.get(callId);
    if (!executionId) {
      for (const [execId, info] of recentDisparosMap.entries()) {
        if (Date.now() - info.createdAt < 600000) {
          executionId = execId;
          callToExecutionMap.set(callId, execId);
          break;
        }
      }
    }

    if (executionId) {
      let tObj = callData.transcript_object || callData.transcript_with_tool_calls || null;
      if (Array.isArray(tObj) && tObj.length === 0) tObj = null;

      const callPayload = {
        call_id: callId,
        status: callData.call_status,
        disconnection_reason: callData.disconnection_reason,
        Duracao: callData.duration_ms ? callData.duration_ms / 1000 : 0,
        transcript: callData.transcript || '',
        transcript_object: tObj,
        public_log_url: callData.public_log_url || callData.eavesdrop_url || null,
        eavesdrop_url: callData.eavesdrop_url || null,
        recording_url: callData.recording_url || '',
        created_at: callData.start_timestamp ? new Date(callData.start_timestamp).toISOString() : new Date().toISOString()
      };

      let stage = 'IN_PROGRESS';
      let stageLabel = 'Em Chamada ao Vivo';
      let isFinished = false;

      const callStatus = String(callData.call_status || '').toLowerCase();
      const reason = String(callData.disconnection_reason || '').toLowerCase();

      if (reason !== '' || ['ended', 'completed', 'error'].includes(callStatus)) {
        isFinished = true;
        stage = 'COMPLETED';
        stageLabel = 'Chamada Finalizada';
      } else if (callStatus === 'registered') {
        stage = 'RINGING';
        stageLabel = 'Discando / Tocando no telefone...';
      }

      broadcastSseEvent(executionId, {
        type: eventName,
        executionId,
        call_id: callId,
        stage,
        stageLabel,
        isFinished,
        call: callPayload
      });
    }

    return res.status(200).json({ ok: true, received: true });
  } catch (err) {
    console.error('[Retell Webhook Error]:', err.message);
    return res.status(200).json({ ok: true, warning: err.message });
  }
};

app.use('/api/webhooks/retell', express.json({ limit: '50mb' }), handleRetellWebhook);
app.use('/webhooks/retell', express.json({ limit: '50mb' }), handleRetellWebhook);

// Trust proxy — necessário para Easypanel/Traefik
app.set('trust proxy', true);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// Sessão segura
app.use(session({
  secret: process.env.SESSION_SECRET || 'mindflow-hub-session-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,                 // Compatível com Traefik / Easypanel reverse proxy
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,   // 8 horas
  },
}));

// Rate limiting na rota de login: máx 10 tentativas por 15 minutos por IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
  skipSuccessfulRequests: true, // só conta as falhas
});

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  const publicPaths = ['/', '/api/', '/redefinir-senha', '/dev-login', '/dev-client-login', '/hub', '/dashboard', '/disparo', '/cliente', '/dashboard-style.css', '/dashboard-app.js'];
  if (publicPaths.some(p => req.path === p || req.path.startsWith('/api/'))) return next();
  if (/\.(html|css|js)$/.test(req.path)) return res.redirect('/');
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(requireAuth);

// ============================================================
// DIAGNÓSTICO DO DASHBOARD
// ============================================================
app.get('/api/dashboard/status', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const clientDb = getActiveClientDb(req);
    const { count, error: countError } = await clientDb
      .from('Retell_calls_Mindflow')
      .select('*', { count: 'exact', head: true });
    if (countError) {
      return res.json({ ok: false, error: countError.message, code: countError.code, count: null });
    }
    const { data: latest } = await clientDb
      .from('Retell_calls_Mindflow')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1);
    res.json({
      ok: true,
      totalRows: count,
      latestRecord: latest?.[0]?.created_at || null,
      clientDb: clientDb === supabase ? 'default' : 'custom',
    });
  } catch (err) {
    res.json({ ok: false, error: err.message, count: null });
  }
});

// ============================================================
// DEBUG (remover depois que o login funcionar)
// ============================================================
app.get('/api/debug', (req, res) => {
  res.json({
    hasSession: !!req.session,
    hasUser: !!req.session?.user,
    sessionID: req.sessionID || null,
    user: req.session?.user ? { id: req.session.user.id, email: req.session.user.email, name: req.session.user.name, active_client: req.session.user.active_client } : null,
    cookies: req.headers.cookie || null,
    protocol: req.protocol,
    secure: req.secure,
    host: req.get('host'),
    xForwardedProto: req.get('x-forwarded-proto'),
    xForwardedFor: req.get('x-forwarded-for'),
  });
});

app.get('/api/debug/login-test', async (req, res) => {
  // Cria sessão fake sem Supabase — testa se cookie funciona
  req.session.user = { id: 'debug', email: 'debug@test.com', name: 'Debug User', phone: '', client_access: [], active_client: null };
  req.session.save((err) => {
    if (err) {
      console.error('[Debug] Erro ao salvar sessão:', err.message);
      return res.status(500).json({ error: 'Falha ao salvar sessão: ' + err.message });
    }
    console.log('[Debug] Sessão salva com sucesso. ID:', req.sessionID);
    res.json({ ok: true, sessionID: req.sessionID, message: 'Sessão criada. Agora acesse /api/debug para verificar.' });
  });
});

// ============================================================
// ROTAS DE PÁGINAS
// ============================================================
app.get('/', (req, res) => {
  if (req.session?.user) {
    // Usuário interno (MindFlow ou multi-cliente) → dashboard admin
    // Cliente externo (só tem o próprio tenant) → /cliente
    const isClient = req.session.user.client_access?.length === 1
      && req.session.user.client_access[0].client_id !== '2';
    return res.redirect(isClient ? '/cliente' : '/dashboard');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/redefinir-senha', (req, res) => {
  res.sendFile(path.join(__dirname, 'redefinir-senha.html'));
});

// Dev login — cria sessão sem senha (apenas em desenvolvimento)
if (!IS_PRODUCTION) {
  app.get('/dev-login', async (req, res) => {
    // Busca todos os clientes disponíveis para o dev
    let clientAccess = [];
    try {
      const { data: clients } = await supabase
        .from('client_configurations')
        .select('client_id, client_name, supabase_url, supabase_service_key');

      clientAccess = (clients || []).map(c => ({
        client_id: c.client_id,
        client_name: c.client_name,
        role: 'admin',
        supabase_url: c.supabase_url,
        service_key: c.supabase_service_key,
      }));
    } catch (err) {
      console.error('[DevLogin] Erro:', err.message);
    }

    // Busca dados reais de um usuario do Auth para o dev
    let devUserId = 'dev-user';
    let devEmail = 'dev@mindflow.ia';
    let devName = 'Dev MindFlow';
    let devPhone = '';
    try {
      const { data: cfg } = await supabase
        .from('client_configurations')
        .select('supabase_service_key')
        .eq('client_id', '2')
        .single();
      if (cfg) {
        const adminClient = createClient(process.env.SUPABASE_URL, cfg.supabase_service_key);
        const { data: authData } = await adminClient.auth.admin.listUsers();
        // Tenta achar o Pedro primeiro (dev principal), senao pega o primeiro
        const targetEmail = 'pedroernestozimmermann@gmail.com';
        const targetUser = authData?.users?.find(u => u.email === targetEmail)
          || authData?.users?.[0];
        if (targetUser) {
          devUserId = targetUser.id;
          devEmail = targetUser.email;
          const um = targetUser.user_metadata || {};
          devName = um.full_name || targetUser.email;
          devPhone = um.phone || '';
        }
      }
    } catch {}

    req.session.user = {
      id: devUserId,
      email: devEmail,
      name: devName,
      phone: devPhone,
      client_access: clientAccess,
      active_client: '2', // Mindflow como padrao
    };
    req.session.save(() => res.redirect('/dashboard'));
  });

  // Dev client login — simula sessão de cliente externo
  app.get('/dev-client-login', async (req, res) => {
    let clientAccess = [];
    let activeClient = null;
    let clientName = 'Cliente Teste';
    try {
      const { data: clients } = await supabase
        .from('client_configurations')
        .select('client_id, client_name, supabase_url, supabase_service_key')
        .neq('client_id', '2')
        .limit(1);

      if (clients && clients.length > 0) {
        const c = clients[0];
        clientAccess = [{
          client_id: c.client_id,
          client_name: c.client_name,
          role: 'admin',
          supabase_url: c.supabase_url,
          service_key: c.supabase_service_key,
        }];
        activeClient = c.client_id;
        clientName = c.client_name;
      }
    } catch (err) {
      console.error('[DevClientLogin] Erro:', err.message);
    }

    if (!activeClient) {
      return res.send('<h1>Nenhum cliente encontrado na tabela client_configurations (client_id != 2).</h1>');
    }

    req.session.user = {
      id: 'dev-client-user',
      email: 'cliente@teste.com',
      name: clientName,
      phone: '',
      client_access: clientAccess,
      active_client: activeClient,
    };
    req.session.save(() => res.redirect('/cliente'));
  });
}

app.get('/hub', (req, res) => {
  console.log('[Hub] Acessou /hub | hasUser:', !!req.session?.user, '| cookies:', req.headers.cookie ? 'present' : 'absent');
  if (!req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'hub.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard-style.css', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dashboard-style.css'));
});

app.get('/dashboard-app.js', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dashboard-app.js'));
});

app.get('/disparo', (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'disparo.html'));
});

app.get('/cliente', (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  // Serve o mesmo dashboard, o frontend adapta via JS (pathname === '/cliente')
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ============================================================
// HELENA CRM — CONFIG
// ============================================================
const HELENA_CONFIG = {
  // URL base do CRM white label (domínio customizado MindFlow)
  crmUrl: process.env.HELENA_CRM_URL || 'https://chat.mindflow.com.br',
  // URL base da API do Helena (provisionamento de contas, etc.)
  apiUrl: process.env.HELENA_API_URL || 'https://api.helena.app/v1',
  // Token de parceiro (gerado na aba Integração do painel Super Admin)
  partnerToken: process.env.HELENA_PARTNER_TOKEN || '',
  // Chave secreta para assinar JWT de SSO (compartilhada com o Helena)
  jwtSecret: process.env.HELENA_JWT_SECRET || process.env.SESSION_SECRET || '',
  // TTL do JWT em horas
  jwtTtlHours: 8,
};

// ============================================================
// DASHBOARD ANALYTICS BACKEND (hub_backend — Python FastAPI)
// ============================================================
const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL || 'https://hub-backend.bkpxmb.easypanel.host';

/**
 * Proxy transparente para o hub_backend (analytics + WhatsApp).
 * Repassa o client_id ativo da sessão via header X-Client-ID.
 */
async function proxyToDashboardBackend(req, res, path, method = 'GET') {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const clientId = req.session.user.active_client || '2';
  const qs = new URLSearchParams(req.query).toString();
  const url = `${DASHBOARD_API_URL}${path}${qs ? '?' + qs : ''}`;

  try {
    const response = await fetch(url, {
      method,
      headers: { 'X-Client-ID': clientId },
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    return res.status(response.status).json(data);
  } catch (err) {
    console.error(`[Proxy] Erro ao consultar hub_backend (${path}):`, err.message);
    return res.status(502).json({ error: 'Falha ao consultar o backend analítico.' });
  }
}

// ============================================================
// API: HELENA JWT (SSO — Single Sign-On)
// ============================================================
app.get('/api/helena/jwt', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });

  if (!HELENA_CONFIG.jwtSecret) {
    return res.status(500).json({ error: 'JWT secret não configurado. Defina HELENA_JWT_SECRET.' });
  }

  const user = req.session.user;
  const now = Math.floor(Date.now() / 1000);

  // Busca a role do Helena baseada no client_access
  const activeAccess = user.client_access?.find(c => c.client_id === user.active_client);
  const helenaRole = activeAccess?.role === 'admin' ? 'Admin' : 'Atendente';

  const payload = {
    iss: process.env.APP_URL || 'https://hub.mindflow.com.br',
    sub: user.id,
    aud: 'helena-crm-embed',
    iat: now,
    exp: now + (HELENA_CONFIG.jwtTtlHours * 3600),
    user_metadata: {
      full_name: user.name,
      email: user.email,
      phone: user.phone || '',
    },
    app_metadata: {
      tenant_id: user.active_client || 'mindflow_default',
      helena_role: helenaRole,
      allowed_queues: ['vendas', 'suporte'],
      channels_access: ['whatsapp_main'],
    },
  };

  const token = jwt.sign(payload, HELENA_CONFIG.jwtSecret, { algorithm: 'HS256' });

  res.json({
    token,
    crmUrl: HELENA_CONFIG.crmUrl,
    expiresIn: HELENA_CONFIG.jwtTtlHours * 3600,
  });
});

// ============================================================
// API: CLIENT DISPATCH CONFIG (agente + prompt do cliente)
// ============================================================
const CLIENT_DISPATCH_MAP = {
  '2': { id: '2', name: 'MindFlow Outbound Frio', agent_id: 'agent_f95ee856fb3d220f42171318dc', prompt_id: '20', from_number: '+554823980162' },
  '3': { id: '3', name: 'ATS Tecnologia', agent_id: 'agent_4f1dba5e5432cd193d324754bf', prompt_id: '33', from_number: '+554823980162' },
  '4': { id: '4', name: 'MyGain', agent_id: 'agent_f1603ca4baa2d88297d1ae9c40', prompt_id: '34', from_number: '+554823980162' },
  '5': { id: '5', name: 'Kravi', agent_id: 'agent_7b9e7d53c933c83f73155662b9', prompt_id: '30', from_number: '+554823980162' },
};

app.get('/api/client/dispatch-config', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const user = req.session.user;
  const activeClientId = user.active_client || '2';

  const cfg = CLIENT_DISPATCH_MAP[activeClientId] || CLIENT_DISPATCH_MAP['2'];

  res.json({
    client_id: activeClientId,
    agent_id: cfg.agent_id,
    prompt_id: cfg.prompt_id,
    name: cfg.name,
    presets: Object.values(CLIENT_DISPATCH_MAP)
  });
});

// ============================================================
// API: HELENA CONFIG (expoe config pra debug/admin)
// ============================================================
app.get('/api/helena/config', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    crmUrl: HELENA_CONFIG.crmUrl,
    apiUrl: HELENA_CONFIG.apiUrl,
    hasPartnerToken: !!HELENA_CONFIG.partnerToken,
    jwtTtlHours: HELENA_CONFIG.jwtTtlHours,
  });
});

// ============================================================
// API: HELENA WEBHOOK (recebe eventos do CRM → processa com IA)
// ============================================================
app.post('/api/helena/webhook', async (req, res) => {
  const { event, tenant_id, data } = req.body;

  if (!event || !tenant_id) {
    return res.status(400).json({ error: 'Event e tenant_id são obrigatórios.' });
  }

  console.log(`[Helena Webhook] Evento: ${event} | Tenant: ${tenant_id}`);

  // Responde imediatamente (ack) — processamento é assíncrono
  res.status(200).json({ received: true });

  try {
    switch (event) {
      case 'message.created': {
        // Nova mensagem recebida → processar com IA da MindFlow
        await handleIncomingMessage(tenant_id, data);
        break;
      }
      case 'ticket.closed': {
        // Ticket encerrado → atualizar estado no Supabase
        if (data?.ticket_id) {
          await supabase
            .from('mindflow_engine.chat_sessions')
            .update({ bot_status: 'CLOSED', updated_at: new Date().toISOString() })
            .eq('helena_ticket_id', data.ticket_id);
        }
        break;
      }
      case 'ticket.assigned': {
        // Atendente humano assumiu
        if (data?.ticket_id) {
          await supabase
            .from('mindflow_engine.chat_sessions')
            .update({ bot_status: 'HUMAN_ACTIVE', updated_at: new Date().toISOString() })
            .eq('helena_ticket_id', data.ticket_id);
        }
        break;
      }
      default:
        console.log(`[Helena Webhook] Evento não tratado: ${event}`);
    }
  } catch (err) {
    console.error('[Helena Webhook] Erro no processamento:', err.message);
  }
});

/**
 * Processa mensagem recebida do Helena com IA da MindFlow
 */
async function handleIncomingMessage(tenantId, data) {
  const { ticket_id, chat_id, sender, message } = data || {};
  if (!ticket_id || !message?.body) return;

  // 1. Busca ou cria sessão no Supabase
  const { data: session } = await supabase
    .from('mindflow_engine.chat_sessions')
    .select('*')
    .eq('helena_ticket_id', ticket_id)
    .maybeSingle();

  if (!session) {
    // Busca tenant_id interno
    const { data: tenant } = await supabase
      .from('mindflow_engine.tenants')
      .select('id')
      .eq('helena_tenant_id', tenantId)
      .maybeSingle();

    if (!tenant) {
      console.warn(`[Helena] Tenant não encontrado: ${tenantId}`);
      return;
    }

    await supabase.from('mindflow_engine.chat_sessions').insert({
      tenant_id: tenant.id,
      helena_ticket_id: ticket_id,
      customer_phone: sender?.phone || chat_id,
      bot_status: 'BOT_ACTIVE',
      conversation_context: { messages: [] },
    });
  } else if (session.bot_status !== 'BOT_ACTIVE') {
    // Se não está em modo bot, ignora (humano está atendendo)
    console.log(`[Helena] Ticket ${ticket_id} em modo ${session.bot_status}, ignorando.`);
    return;
  }

  // 2. Processa com IA
  const startTime = Date.now();
  let aiResponse = null;
  let tokensUsed = 0;

  try {
    // TODO: Integrar com o motor de IA real (OpenAI / Anthropic / n8n)
    // Por enquanto, placeholder que responde via API do Helena
    aiResponse = `[MindFlow IA] Mensagem recebida: "${message.body.substring(0, 100)}". Resposta automática em desenvolvimento.`;

    // 3. Envia resposta via API do Helena
    if (HELENA_CONFIG.partnerToken) {
      await fetch(`${HELENA_CONFIG.apiUrl}/tickets/${ticket_id}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HELENA_CONFIG.partnerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'text',
          body: aiResponse,
          from_bot: true,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } else {
      console.log('[Helena] PARTNER_TOKEN não configurado — resposta não enviada.');
    }
  } catch (err) {
    console.error('[Helena] Erro ao processar IA:', err.message);
  }

  // 4. Log de execução
  const execTime = Date.now() - startTime;
  const { data: sess } = await supabase
    .from('mindflow_engine.chat_sessions')
    .select('id')
    .eq('helena_ticket_id', ticket_id)
    .maybeSingle();

  if (sess) {
    await supabase.from('mindflow_engine.ai_execution_logs').insert({
      session_id: sess.id,
      incoming_prompt: message.body,
      ai_response: aiResponse,
      tokens_used: tokensUsed,
      model_name: 'pending-integration',
      execution_time_ms: execTime,
    });
  }

  // 5. Atualiza contexto da sessão
  await supabase
    .from('mindflow_engine.chat_sessions')
    .update({
      last_interaction_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('helena_ticket_id', ticket_id);
}

// ============================================================
// API: LOGIN (com Supabase Auth)
// ============================================================
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: username.toLowerCase().trim(),
    password: password,
  });

  if (error || !data?.user) {
    // Mensagem genérica — nunca revelamos se o e-mail existe ou não
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }

  // Login OK — busca vínculos com clientes
  const meta = data.user.user_metadata || {};
  const displayName = meta.full_name || data.user.email;
  const userEmail = data.user.email.toLowerCase().trim();
  const userPhone = meta.phone || '';

  let clientAccess = [];
  let activeClient = null;

  try {
    // Nova tabela: uma linha por user, client_ids em array
    const { data: accessRow } = await supabase
      .from('user_client_access')
      .select('client_ids, role')
      .eq('user_email', userEmail)
      .maybeSingle();

    if (accessRow && accessRow.client_ids && accessRow.client_ids.length > 0) {
      // Buscar detalhes de cada cliente
      const clientIdTexts = accessRow.client_ids.map(String);
      const { data: clients } = await supabase
        .from('client_configurations')
        .select('client_id, client_name, supabase_url, supabase_service_key')
        .in('client_id', clientIdTexts);

      const clientMap = new Map((clients || []).map(c => [String(c.client_id), c]));

      clientAccess = accessRow.client_ids.map(cid => {
        const id = String(cid);
        const cfg = clientMap.get(id);
        return {
          client_id: id,
          client_name: cfg?.client_name || id,
          role: accessRow.role,
          supabase_url: cfg?.supabase_url || process.env.SUPABASE_URL,
          service_key: cfg?.supabase_service_key || process.env.SUPABASE_KEY,
        };
      });

      // Cliente ativo: Mindflow (client_id='2') se disponível, senão o primeiro
      activeClient = clientAccess.find(c => c.client_id === '2')?.client_id
        || clientAccess[0]?.client_id || null;
    }
  } catch (err) {
    console.error('[Login] Erro ao buscar user_client_access:', err.message);
  }

  req.session.user = {
    id: data.user.id,
    email: userEmail,
    name: displayName,
    phone: userPhone,
    client_access: clientAccess,
    active_client: activeClient,
  };

  console.log('[Login] Salvando sessão para:', userEmail, '| sessionID:', req.sessionID);

  req.session.save((err) => {
    if (err) {
      console.error('[Login] Erro ao salvar sessão:', err.message);
      return res.status(500).json({ error: 'Erro ao criar sessão.' });
    }
    console.log('[Login] Sessão salva com sucesso. Cookie secure:', IS_PRODUCTION, '| sameSite: lax');
    const isClient = clientAccess.length === 1 && clientAccess[0].client_id !== '2';
    return res.json({ ok: true, name: displayName, active_client: activeClient, is_client: isClient });
  });
});

// ============================================================
// API: CONFIG (para Supabase Client-side)
// ============================================================
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    appUrl: process.env.APP_URL || `http://localhost:${PORT}`
  });
});

// ============================================================
// SYNC: AGENTES — Retell API → Supabase (retell_agents)
// ============================================================
const RETELL_API_KEY = process.env.RETELL_API_KEY;
let RETELL_AGENTS_CACHE = []; // fallback em memória

async function syncRetellAgents() {
  if (!RETELL_API_KEY) {
    console.warn('[SyncAgents] RETELL_API_KEY ausente, pulando sync.');
    return;
  }
  try {
    console.log('[SyncAgents] Buscando agentes da Retell API...');
    const retellRes = await fetch('https://api.retellai.com/list-agents', {
      headers: { Authorization: `Bearer ${RETELL_API_KEY}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!retellRes.ok) throw new Error(`Retell API: ${retellRes.status}`);

    const agentsRaw = await retellRes.json();

    // Dedup por agent_id
    const seen = new Map();
    (agentsRaw || []).forEach(a => {
      if (a.agent_id && a.agent_name && !seen.has(a.agent_id)) {
        seen.set(a.agent_id, { agent_id: a.agent_id, agent_name: a.agent_name.trim(), updated_at: new Date().toISOString() });
      }
    });
    const agents = Array.from(seen.values());

    // Preserva prompt_id existente (mapeamento manual não pode ser sobrescrito)
    try {
      const { data: existing } = await supabase
        .from('retell_agents')
        .select('agent_id, prompt_id')
        .not('prompt_id', 'is', null);
      if (existing) {
        const promptMap = new Map(existing.map(r => [r.agent_id, r.prompt_id]));
        agents.forEach(a => {
          if (promptMap.has(a.agent_id)) a.prompt_id = promptMap.get(a.agent_id);
        });
      }
    } catch {}

    // Upsert no Supabase
    const { error } = await supabase.from('retell_agents').upsert(agents, { onConflict: 'agent_id' });
    if (error) {
      // Tabela pode não existir ainda — mantém cache em memória como fallback
      console.warn('[SyncAgents] Upsert falhou (tabela retell_agents existe?):', error.message);
    } else {
      console.log(`[SyncAgents] ${agents.length} agentes upsertados.`);
    }

    // Remove agentes que não existem mais na Retell
    const retellIdSet = new Set(agents.map(a => a.agent_id));
    if (retellIdSet.size > 0) {
      const { data: allInDb } = await supabase.from('retell_agents').select('agent_id');
      const orphanIds = (allInDb || []).filter(r => !retellIdSet.has(r.agent_id)).map(r => r.agent_id);
      if (orphanIds.length > 0) {
        const { error: delErr } = await supabase.from('retell_agents').delete().in('agent_id', orphanIds);
        if (delErr) {
          console.warn('[SyncAgents] Erro ao remover agentes órfãos:', delErr.message);
        } else {
          console.log(`[SyncAgents] ${orphanIds.length} agentes órfãos removidos.`);
        }
      }
    }

    // Cache em memória como fallback rápido
    RETELL_AGENTS_CACHE = agents.map(a => ({ id: a.agent_id, name: a.agent_name }));
  } catch (err) {
    console.error('[SyncAgents] Erro:', err.message);
  }
}

// ============================================================
// API: AGENTES (lê do Supabase, com fallback para cache local)
// ============================================================
app.get('/api/agents', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    let agentsList = [];

    // Lê da tabela retell_agents no Supabase
    const { data, error } = await supabase
      .from('retell_agents')
      .select('agent_id, agent_name, prompt_id')
      .order('agent_name', { ascending: true });

    if (!error && data && data.length > 0) {
      agentsList = data.map(a => ({ id: a.agent_id, name: a.agent_name, prompt_id: a.prompt_id || null }));
    } else if (RETELL_AGENTS_CACHE.length > 0) {
      agentsList = RETELL_AGENTS_CACHE;
    } else {
      await syncRetellAgents();
      agentsList = RETELL_AGENTS_CACHE;
    }

    // Filtra agentes para clientes (active_client !== '2')
    const activeClientId = req.session.user.active_client || '2';
    if (activeClientId !== '2') {
      const activeClientObj = req.session.user.client_access?.find(c => c.client_id === activeClientId);
      const clientName = activeClientObj?.client_name || '';
      if (clientName) {
        // Normaliza removendo espaços e termos genéricos
        const normClient = clientName.toLowerCase().replace(/\s+/g, '').replace('comercial', '');
        agentsList = agentsList.filter(a => {
          if (!a.name) return false;
          // Remove "whatsapp" e "whats" da comparação para evitar falso-positivo com o cliente ATS
          const normAgent = a.name.toLowerCase().replace(/\s+/g, '').replace(/whats(app)?/g, '');
          return normAgent.includes(normClient) || normClient.includes(normAgent) || 
                 (normClient === 'ats' && normAgent.includes('ats'));
        });
      } else {
        agentsList = [];
      }
    }

    return res.json(agentsList);
  } catch (err) {
    console.error('[Agents] Erro:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar agentes.' });
  }
});

// Refresh manual
app.post('/api/agents/refresh', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  await syncRetellAgents();
  res.json({ ok: true, count: RETELL_AGENTS_CACHE.length });
});

// Sync inicial + a cada 6 horas
syncRetellAgents();
setInterval(syncRetellAgents, 6 * 60 * 60 * 1000);

// ============================================================
// API: PROMPTS (lista de prompts da tabela Prompts)
// ============================================================
const PROMPTS_CACHE = { data: null, timestamp: 0 };
const PROMPTS_CACHE_TTL = 600_000; // 10 minutos

app.get('/api/prompts', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const now = Date.now();
    let promptsList = [];

    if (PROMPTS_CACHE.data && now - PROMPTS_CACHE.timestamp < PROMPTS_CACHE_TTL) {
      promptsList = PROMPTS_CACHE.data;
    } else {
      // Usa service key pra burlar RLS
      const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.MASTER_SUPABASE_SERVICE_KEY;
      const adminClient = serviceKey
        ? createClient(process.env.SUPABASE_URL, serviceKey)
        : supabase;

      let { data, error } = await adminClient
        .from('Prompts')
        .select('*')
        .order('id', { ascending: true })
        .limit(200);

      if (error) {
        console.error('[Prompts] Erro na query:', error.message, error.code, error.details);
        return res.status(500).json({ error: 'Erro ao buscar prompts.' });
      }

      promptsList = (data || []).map(p => {
        const nome = p['Nome do cliente'] || p.nome_cliente || p.nome || p.name || p.client_name || '';
        return {
          id: p.id,
          'Nome do cliente': (nome || '').trim() || `Prompt #${p.id}`,
        };
      });

      PROMPTS_CACHE.data = promptsList;
      PROMPTS_CACHE.timestamp = now;
    }

    // Filtragem por cliente (se não for admin/Mindflow)
    const activeClientId = req.session.user.active_client || '2';
    if (activeClientId !== '2') {
      const { data: clientCfg } = await supabase
        .from('client_configurations')
        .select('prompt_id')
        .eq('client_id', activeClientId)
        .maybeSingle();

      const targetPromptId = clientCfg?.prompt_id;
      if (targetPromptId) {
        promptsList = promptsList.filter(p => p.id === targetPromptId);
      } else {
        promptsList = [];
      }
    }

    res.json(promptsList);
  } catch (err) {
    console.error('[Prompts] Erro:', err.message);
    res.status(500).json({ error: 'Erro ao buscar prompts.' });
  }
});

// Mapeamento automático de telefone dos membros da equipe
const TEAM_MEMBER_PHONES = [
  { keywords: ['pedro'], phone: '5547991089099' },
  { keywords: ['renato'], phone: '554196852463' },
  { keywords: ['ryan'], phone: '554896027108' },
  { keywords: ['mariah'], phone: '554896112406' },
  { keywords: ['ivan'], phone: '554797804224' },
  { keywords: ['wandrey'], phone: '557988768794' },
  { keywords: ['hay', 'haylan'], phone: '5511989118774' },
];

function getTeamPhone(email, name, existingPhone) {
  if (existingPhone && existingPhone.replace(/\D/g, '').length >= 10) {
    return existingPhone;
  }
  const str = `${email || ''} ${name || ''}`.toLowerCase();
  const found = TEAM_MEMBER_PHONES.find(member =>
    member.keywords.some(k => str.includes(k))
  );
  return found ? found.phone : (existingPhone || '');
}

// Lista de Provedores de Telefonia e Roteamento Inteligente por DDD
const TELEPHONY_PROVIDERS = [
  { id: 'auto', name: 'Automático (IA / Roteamento por DDD)', value: 'auto' },
  { id: '+554823980162', name: 'Twilio Brasil (+55 48)', value: '+554823980162' },
  { id: '555196506656', name: 'Wavoip (+55 51)', value: '555196506656' },
  { id: '+41996852463', name: 'SONAVOIP (+41)', value: '+41996852463' },
  { id: '11111', name: 'IFIX (11111)', value: '11111' },
  { id: 'iatizeia', name: 'Iatizeia', value: 'iatizeia' }
];

function getOptimalProvidersChain(phoneNumber, userSelectedProvider) {
  const allProviders = ['+554823980162', '555196506656', '+41996852463', '11111', 'iatizeia'];

  if (userSelectedProvider && userSelectedProvider !== 'auto') {
    const fallbacks = allProviders.filter(p => p !== userSelectedProvider);
    return [userSelectedProvider, ...fallbacks];
  }

  let digits = (phoneNumber || '').replace(/\D/g, '');
  if (digits.startsWith('55')) digits = digits.slice(2);
  const ddd = digits.slice(0, 2);

  if (['41', '51', '53', '54', '55'].includes(ddd)) {
    return ['555196506656', '+554823980162', '+41996852463', '11111', 'iatizeia'];
  } else if (['47', '48', '49'].includes(ddd)) {
    return ['+554823980162', '555196506656', '+41996852463', '11111', 'iatizeia'];
  } else if (['11', '12', '13', '14', '15', '16', '17', '18', '19'].includes(ddd)) {
    return ['11111', '+554823980162', '555196506656', '+41996852463', 'iatizeia'];
  } else if (['71', '73', '74', '75', '77', '79', '81', '82', '83', '84', '85', '86', '87', '88', '89'].includes(ddd)) {
    return ['+554823980162', '555196506656', '+41996852463', '11111', 'iatizeia'];
  }

  return ['+554823980162', '555196506656', '+41996852463', '11111', 'iatizeia'];
}

// ============================================================
// API: CHECK SESSION
// ============================================================
app.get('/api/check', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const user = req.session.user;
  const activeClient = user.client_access?.find(c => c.client_id === user.active_client);
  const phone = getTeamPhone(user.email, user.name, user.phone) || '5547991089099';
  res.json({
    name: user.name || 'Pedro Ernesto',
    email: user.email || 'pedroernestozimmermann@gmail.com',
    phone: phone,
    client_access: (user.client_access || []).map(c => ({
      client_id: c.client_id,
      client_name: c.client_name,
      role: c.role,
    })),
    active_client: user.active_client || '2',
    active_client_name: activeClient?.client_name || 'Mindflow',
  });
});

app.get('/api/telephony-providers', (req, res) => {
  res.json(TELEPHONY_PROVIDERS);
});

// ============================================================
// API: SWITCH CLIENT (troca o cliente ativo na sessão)
// ============================================================
app.post('/api/switch-client', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id é obrigatório.' });

  // Verifica se o usuário tem acesso a este cliente
  const access = req.session.user.client_access?.find(c => c.client_id === client_id);
  if (!access) return res.status(403).json({ error: 'Sem acesso a este cliente.' });

  req.session.user.active_client = client_id;
  req.session.save(() => res.json({
    ok: true,
    active_client: client_id,
    active_client_name: access.client_name,
  }));
});

// ============================================================
// API: CLIENT CONFIG (retorna config do cliente ativo para o frontend)
// ============================================================
app.get('/api/client-config', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const activeClientId = req.session.user.active_client;
  const access = req.session.user.client_access?.find(c => c.client_id === activeClientId);

  if (!access) {
    return res.json({
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_KEY,
    });
  }

  res.json({
    supabaseUrl: access.supabase_url,
    supabaseKey: access.service_key,
    appUrl: process.env.APP_URL || `http://localhost:${PORT}`,
    client_id: access.client_id,
    client_name: access.client_name,
    role: access.role,
  });
});

// ============================================================
// API: LOGOUT
// ============================================================
app.post('/api/logout', async (req, res) => {
  // Invalida também o token no Supabase (boa prática)
  await supabase.auth.signOut().catch(() => {});
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// ============================================================
// API: DISPARO DE LIGAÇÃO (BFF)
// ============================================================
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 30, // limite maior para usuários logados
  message: { error: "Muitas solicitações de disparo vindas deste IP. Tente novamente após 15 minutos." },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.post('/api/submit-lead', submitLimiter, async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const {
    nome,
    telefone,
    email,
    contexto,
    agent_id,
    prompt_id,
    is_scheduled,
    scheduled_date,
    scheduled_time
  } = req.body;

  if (!nome || typeof nome !== 'string' || !telefone || typeof telefone !== 'string') {
    return res.status(400).json({ error: "Nome e telefone são obrigatórios." });
  }

  const apiUrl = process.env.WEBHOOK_URL || "https://call-github.bkpxmb.easypanel.host/webhook";
  const apiKey = process.env.WEBHOOK_API_KEY || process.env.PYTHON_API_KEY || "mf_sk_2026_pre_call_xK9v3Qm7bR4wT1nZ";

  function formatE164Phone(raw) {
    let digits = (raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('5555')) {
      digits = digits.slice(2);
    }
    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
      return '+' + digits;
    }
    return '+55' + digits;
  }

  const formattedPhone = formatE164Phone(telefone);

  try {
    let quando_ligar = "";
    if (is_scheduled && scheduled_date && scheduled_time) {
      quando_ligar = `${scheduled_date}T${scheduled_time}:00-03:00`;
    }

    const providerChain = getOptimalProvidersChain(formattedPhone, req.body.from_number);
    let lastError = null;
    let successData = null;

    for (const fromProvider of providerChain) {
      const pythonPayload = {
        nome: nome.toUpperCase(),
        email: email || "",
        numero: formattedPhone,
        contexto: contexto || "",
        agent_id: agent_id || "agent_f95ee856fb3d220f42171318dc",
        Prompt_id: prompt_id || "20",
        execution_id: crypto.randomUUID(),
        quando_ligar: quando_ligar,
        workflow_name: "pre_call_processing",
        from_number: fromProvider
      };

      recentDisparosMap.set(pythonPayload.execution_id, { createdAt: Date.now(), phone: formattedPhone, nome: pythonPayload.nome });
      console.log(`[BFF] Tentando disparo com provedor ${fromProvider} para ${pythonPayload.nome} (${pythonPayload.execution_id})`);

      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(pythonPayload),
          signal: AbortSignal.timeout(12000)
        });

        if (response.ok) {
          const resText = await response.text();
          let json;
          try { json = JSON.parse(resText); } catch { json = { ok: true, raw: resText }; }
          successData = { ...json, execution_id: pythonPayload.execution_id, provider_used: fromProvider };
          break;
        } else {
          const errorText = await response.text();
          console.warn(`[BFF] Provedor ${fromProvider} falhou com status ${response.status}: ${errorText}`);
          lastError = errorText;
        }
      } catch (err) {
        console.warn(`[BFF] Excecao com provedor ${fromProvider}: ${err.message}`);
        lastError = err.message;
      }
    }

    if (!successData) {
      throw new Error(lastError || "Todos os provedores de telefonia falharam.");
    }

    return res.status(202).json({
      message: "Lead processado com sucesso.",
      execution_id: successData.execution_id,
      provider_used: successData.provider_used
    });

  } catch (error) {
    console.error("[BFF ERROR] Erro na integração com API Python:", error.message);
    return res.status(500).json({
      error: `Erro ao enviar lead: ${error.message}`
    });
  }
});

app.get('/api/call-status/:executionId', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const { executionId } = req.params;

  if (!executionId) {
    return res.status(400).json({ error: 'ID de execução inválido.' });
  }

  const clientDb = getActiveClientDb(req);
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json'
  };

  try {
    let execution = null;
    let call = null;

    // 1. Tenta buscar da tabela workflow_executions
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(executionId)) {
      const execUrl = `${supabaseUrl}/rest/v1/workflow_executions?trigger_event_id=eq.${executionId}&select=status,output_data,error_details,created_at,updated_at&limit=1`;
      const execRes = await fetch(execUrl, { headers, signal: AbortSignal.timeout(6000) }).catch(() => null);
      if (execRes && execRes.ok) {
        const execData = await execRes.json();
        execution = execData?.[0] || null;
      }
    }

    let callId = execution?.output_data?.call_id || (executionId.startsWith('call_') ? executionId : null);

    // 2. Busca da tabela Retell_calls_Mindflow no Supabase
    if (callId) {
      const { data: callRows } = await clientDb
        .from('Retell_calls_Mindflow')
        .select('call_id,status,disconnection_reason,Duracao,Nome,transcript,transcript_object,public_log_url,recording_url,created_at')
        .eq('call_id', callId)
        .limit(1);

      call = callRows?.[0] || null;
    }

    // Se ainda não achamos o callId, busca a chamada mais recente do Supabase nos últimos 3 minutos
    if (!callId) {
      const { data: recentCalls } = await clientDb
        .from('Retell_calls_Mindflow')
        .select('call_id,status,disconnection_reason,Duracao,Nome,transcript,transcript_object,public_log_url,recording_url,created_at')
        .order('created_at', { ascending: false })
        .limit(1);

      if (recentCalls && recentCalls[0]) {
        const callTime = new Date(recentCalls[0].created_at).getTime();
        if (Date.now() - callTime < 180000) {
          callId = recentCalls[0].call_id;
          call = recentCalls[0];
        }
      }
    }

    const disparoInfo = recentDisparosMap.get(executionId);
    const minStartTime = disparoInfo ? (disparoInfo.createdAt - 15000) : (Date.now() - 45000);

    // 3. Busca a chamada ao vivo na Retell AI (tempo real 100%)
    if (process.env.RETELL_API_KEY) {
      try {
        if (callId) {
          // Se já temos o callId, busca diretamente o status atualizado do Retell em tempo real
          const getRes = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
            headers: {
              'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
              'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(4000)
          });
          if (getRes.ok) {
            const rCall = await getRes.json();
            let tObj = rCall.transcript_object || rCall.transcript_with_tool_calls || call?.transcript_object || null;
            if (Array.isArray(tObj) && tObj.length === 0) tObj = null;

            call = {
              call_id: rCall.call_id,
              status: rCall.call_status || call?.status,
              disconnection_reason: rCall.disconnection_reason || call?.disconnection_reason,
              Duracao: rCall.duration_ms ? rCall.duration_ms / 1000 : (call?.Duracao || 0),
              transcript: rCall.transcript || call?.transcript || '',
              transcript_object: tObj,
              public_log_url: rCall.public_log_url || rCall.eavesdrop_url || call?.public_log_url || null,
              eavesdrop_url: rCall.eavesdrop_url || null,
              recording_url: rCall.recording_url || call?.recording_url || '',
              created_at: rCall.start_timestamp ? new Date(rCall.start_timestamp).toISOString() : call?.created_at
            };
          }
        } else {
          // Se ainda não temos o callId, lista as chamadas recentes para capturar a chamada iniciada
          const listRes = await fetch('https://api.retellai.com/v2/list-calls', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ limit: 10 }),
            signal: AbortSignal.timeout(4000)
          });
          if (listRes.ok) {
            const listCalls = await listRes.json();
            if (Array.isArray(listCalls) && listCalls.length > 0) {
              // Filha e ordena da mais recente para a mais antiga
              const validCalls = listCalls.filter(c => {
                const callTime = c.start_timestamp ? new Date(c.start_timestamp).getTime() : 0;
                return callTime >= minStartTime;
              }).sort((a, b) => (b.start_timestamp || 0) - (a.start_timestamp || 0));

              // 1. Procura primeiro qualquer chamada com status 'ongoing' ou 'registered'
              let rCall = validCalls.find(c => ['ongoing', 'registered', 'in_progress', 'in-progress'].includes(String(c.call_status || '').toLowerCase()));
              
              // 2. Se a chamada já finalizou, prioriza a chamada recente onde o usuário/lead efetivamente interagiu
              if (!rCall && validCalls.length > 0) {
                rCall = validCalls.find(c => {
                  const tObj = c.transcript_object || c.transcript_with_tool_calls || [];
                  return Array.isArray(tObj) && tObj.some(m => m.role === 'user' || m.speaker === 'user' || m.role === 'customer');
                });
                // Fallback para a chamada mais recente iniciada após o clique
                if (!rCall) {
                  rCall = validCalls[0];
                }
              }

              if (rCall) {
                callId = rCall.call_id;
                let tObj = rCall.transcript_object || rCall.transcript_with_tool_calls || null;
                if (Array.isArray(tObj) && tObj.length === 0) tObj = null;

                call = {
                  call_id: rCall.call_id,
                  status: rCall.call_status,
                  disconnection_reason: rCall.disconnection_reason,
                  Duracao: rCall.duration_ms ? rCall.duration_ms / 1000 : 0,
                  transcript: rCall.transcript || '',
                  transcript_object: tObj,
                  public_log_url: rCall.public_log_url || rCall.eavesdrop_url || null,
                  eavesdrop_url: rCall.eavesdrop_url || null,
                  recording_url: rCall.recording_url || '',
                  created_at: rCall.start_timestamp ? new Date(rCall.start_timestamp).toISOString() : new Date().toISOString()
                };
              }
            }
          }
        }
      } catch (rErr) {
        console.warn('[CallStatus] Retell API fetch error:', rErr.message);
      }
    }

    // 4. Classificação amigável de status e etapas
    let stage = 'INITIATING'; 
    let stageLabel = 'Iniciando ligação...';
    let isFinished = false;

    if (call) {
      const callStatus = String(call.status || '').toLowerCase();
      const reason = String(call.disconnection_reason || '').toLowerCase();

      // Verifica se o lead (usuário) respondeu a chamada
      const transcriptArray = Array.isArray(call.transcript_object) ? call.transcript_object : [];
      const userSpoke = transcriptArray.some(m => m.role === 'user' || m.speaker === 'user' || m.role === 'customer');

      // Se possui motivo de desconexão ou status encerrado, marca como finalizada
      if (reason !== '' || ['ended', 'completed', 'error'].includes(callStatus)) {
        isFinished = true;

        if (['user_declined', 'user-declined'].includes(reason)) {
          stage = 'BUSY';
          stageLabel = 'Ligação Recusada pelo Lead';
        } else if (['voicemail_reached', 'voicemail'].includes(reason) || (!userSpoke && ['inactivity', 'user_hangup'].includes(reason))) {
          stage = 'NO_ANSWER';
          stageLabel = 'Caixa Postal / Recusada';
        } else if (['dial_no_answer', 'no-answer', 'no_answer'].includes(reason)) {
          stage = 'NO_ANSWER';
          stageLabel = 'Não Atendeu (dial no answer)';
        } else if (['dial_busy', 'busy'].includes(reason)) {
          stage = 'BUSY';
          stageLabel = 'Linha Ocupada';
        } else if (reason.includes('error') || reason === 'dial_failed' || callStatus === 'error') {
          stage = 'FAILED';
          stageLabel = 'Falha na Chamada';
        } else {
          if (!userSpoke && transcriptArray.length > 0) {
            stage = 'NO_ANSWER';
            stageLabel = 'Caixa Postal / Sem Resposta do Lead';
          } else {
            stage = 'COMPLETED';
            stageLabel = 'Chamada Finalizada';
          }
        }
      } else if (['ongoing', 'in_progress', 'in-progress'].includes(callStatus)) {
        stage = 'IN_PROGRESS';
        stageLabel = 'Em Chamada ao Vivo';
      } else if (callStatus === 'registered') {
        stage = 'RINGING';
        stageLabel = 'Discando / Tocando no telefone...';
      }
    } else if (execution) {
      if (['RUNNING', 'PENDING'].includes(execution.status)) {
        stage = 'INITIATING';
        stageLabel = 'Processando disparo...';
      } else if (execution.status === 'FAILED') {
        isFinished = true;
        stage = 'FAILED';
        stageLabel = execution.error_details || 'Falha na execução do disparo';
      }
    }

    return res.json({
      ok: true,
      execution_id: executionId,
      call_id: callId,
      execution,
      call,
      stage,
      stageLabel,
      isFinished
    });
  } catch (error) {
    console.error('[BFF] Erro ao buscar status da ligação:', error.message);
    return res.status(500).json({ error: 'Erro ao buscar status.' });
  }
});

// ============================================================
// TEMPO REAL: SSE (Server-Sent Events) & RETELL WEBHOOKS
// ============================================================

// 1. Endpoint SSE para o navegador escutar em tempo real (< 100ms de latência)
app.get('/api/calls/stream/:executionId', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const { executionId } = req.params;
  if (!executionId) return res.status(400).json({ error: 'Execution ID required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', executionId })}\n\n`);

  if (!liveSseClients.has(executionId)) {
    liveSseClients.set(executionId, new Set());
  }
  liveSseClients.get(executionId).add(res);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = liveSseClients.get(executionId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) liveSseClients.delete(executionId);
    }
  });
});

// 2. Endpoint de Webhook para receber eventos da Retell AI (e responder pings de teste com 200 OK)
app.all('/api/webhooks/retell', express.json(), async (req, res) => {
  try {
    const event = req.body || {};
    const eventName = event.event || 'ping';
    const callData = event.call || event;
    const callId = callData.call_id;

    console.log(`[Retell Webhook] Evento recebido: ${eventName} | call_id: ${callId || 'N/A'}`);

    // Se for teste do painel da Retell AI ou ping sem call_id, responde 200 OK imediatamente!
    if (!callId) {
      return res.status(200).json({ ok: true, message: 'Retell webhook test ping received successfully' });
    }

    let executionId = callToExecutionMap.get(callId);

    if (!executionId) {
      for (const [execId, info] of recentDisparosMap.entries()) {
        if (Date.now() - info.createdAt < 600000) {
          executionId = execId;
          callToExecutionMap.set(callId, execId);
          break;
        }
      }
    }

    if (executionId) {
      let tObj = callData.transcript_object || callData.transcript_with_tool_calls || null;
      if (Array.isArray(tObj) && tObj.length === 0) tObj = null;

      const callPayload = {
        call_id: callId,
        status: callData.call_status,
        disconnection_reason: callData.disconnection_reason,
        Duracao: callData.duration_ms ? callData.duration_ms / 1000 : 0,
        transcript: callData.transcript || '',
        transcript_object: tObj,
        public_log_url: callData.public_log_url || callData.eavesdrop_url || null,
        eavesdrop_url: callData.eavesdrop_url || null,
        recording_url: callData.recording_url || '',
        created_at: callData.start_timestamp ? new Date(callData.start_timestamp).toISOString() : new Date().toISOString()
      };

      let stage = 'IN_PROGRESS';
      let stageLabel = 'Em Chamada ao Vivo';
      let isFinished = false;

      const callStatus = String(callData.call_status || '').toLowerCase();
      const reason = String(callData.disconnection_reason || '').toLowerCase();

      if (reason !== '' || ['ended', 'completed', 'error'].includes(callStatus)) {
        isFinished = true;
        stage = 'COMPLETED';
        stageLabel = 'Chamada Finalizada';
      } else if (callStatus === 'registered') {
        stage = 'RINGING';
        stageLabel = 'Discando / Tocando no telefone...';
      }

      broadcastSseEvent(executionId, {
        type: eventName,
        executionId,
        call_id: callId,
        stage,
        stageLabel,
        isFinished,
        call: callPayload
      });
    }

    return res.status(200).json({ ok: true, received: true });
  } catch (err) {
    console.error('[Retell Webhook Error]:', err.message);
    return res.status(200).json({ ok: true, warning: err.message });
  }
});

// ============================================================
// API: CHAMADAS E ESTATÍSTICAS
// ============================================================
app.get('/api/calls', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const clientDb = getActiveClientDb(req);
    const { data, error } = await clientDb
      .from('Retell_calls_Mindflow')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error('[BFF] Erro ao buscar chamadas:', err.message);
    return res.status(500).json({ error: 'Erro ao buscar chamadas.' });
  }
});

function cleanTranscriptForCsv(raw) {
  if (!raw) return '';
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      return parsed
        .filter(m => m && (m.content || m.text))
        .map(m => {
          const speaker = (m.role === 'user' || m.speaker === 'user') ? 'Lead' : 'Agente';
          const text = (m.content || m.text || '').replace(/\r?\n/g, ' ').trim();
          return `${speaker}: ${text}`;
        })
        .filter(t => t.length > 7)
        .join(' | ');
    }
    if (typeof parsed === 'object' && parsed.transcript) {
      return cleanTranscriptForCsv(parsed.transcript);
    }
  } catch {}
  return String(raw).replace(/\[\{.*?\}\]/g, '').replace(/\r?\n/g, ' ').trim();
}

function formatPhoneForCsv(phone) {
  if (!phone) return '';
  const clean = String(phone).trim();
  return clean ? `'${clean}` : '';
}

function formatDateForCsv(val) {
  if (!val) return '';
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toISOString().replace('T', ' ').slice(0, 19);
    }
  } catch {}
  return String(val);
}

app.get('/api/export-calls', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const clientId = req.session.user.active_client || '2';
    let calls = [];

    // 1. Tenta buscar do hub_backend (FastAPI) com page=1 e limite de 5000
    try {
      const response = await fetch(`${DASHBOARD_API_URL}/calls?page=1&limit=5000`, {
        headers: { 'X-Client-ID': String(clientId) },
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        const result = await response.json();
        calls = result.data || result.calls || result.items || (Array.isArray(result) ? result : []);
      }
    } catch (errBackend) {
      console.warn('[BFF Export CSV] hub_backend falhou, tentando Supabase fallback:', errBackend.message);
    }

    // 2. Fallback: Se o backend analítico não retornou nada, busca no Supabase do cliente ativo
    if (!calls.length) {
      try {
        const clientDb = getActiveClientDb(req);
        const { data, error } = await clientDb
          .from('Retell_calls_Mindflow')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(2000);

        if (!error && data && data.length) {
          calls = data;
        }
      } catch (errSupa) {
        console.warn('[BFF Export CSV] Supabase fallback falhou:', errSupa.message);
      }
    }

    if (!calls.length) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(404).send('Nenhuma ligação encontrada para o cliente selecionado.');
    }

    // Mapeamento de colunas amigáveis
    const columns = [
      { key: 'call_id', label: 'ID Chamada' },
      { key: 'created_at', label: 'Data/Hora' },
      { key: 'lead_name', label: 'Nome do Lead' },
      { key: 'lead_phone', label: 'Telefone' },
      { key: 'agent_name', label: 'Agente' },
      { key: 'duration_seconds', label: 'Duração (s)' },
      { key: 'disconnection_reason', label: 'Motivo Desconexão' },
      { key: 'recording_url', label: 'URL Gravação' },
      { key: 'transcript', label: 'Transcrição' }
    ];

    const headerRow = columns.map(c => `"${c.label}"`).join(';');
    const bodyRows = calls.map(item => {
      return columns.map(col => {
        let val = item[col.key];
        if (val === undefined || val === null) {
          if (col.key === 'created_at') val = item.start_timestamp || item.created_at || '';
          else if (col.key === 'duration_seconds') val = item.duration || item.duration_seconds || item.call_length_seconds || '';
          else if (col.key === 'lead_phone') val = item.from_number || item.to_number || item.lead_phone || '';
          else if (col.key === 'agent_name') val = item.agent_id || item.agent_name || '';
          else val = '';
        }

        // Tratamento específico de cada campo
        if (col.key === 'transcript') {
          val = cleanTranscriptForCsv(val);
        } else if (col.key === 'lead_phone') {
          val = formatPhoneForCsv(val);
        } else if (col.key === 'created_at') {
          val = formatDateForCsv(val);
        } else if (typeof val === 'object') {
          val = JSON.stringify(val);
        }

        const str = String(val).replace(/\r?\n/g, ' ').replace(/"/g, '""');
        return `"${str}"`;
      }).join(';');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ligacoes_mindflow.csv"');

    const bom = '\uFEFF';
    return res.send(bom + headerRow + '\n' + bodyRows);

  } catch (err) {
    console.error('[BFF] Erro ao gerar CSV:', err);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(500).send(`Erro ao gerar arquivo CSV: ${err.message}`);
  }
});

app.get('/api/stats', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const clientDb = getActiveClientDb(req);
    const { count, error: countError } = await clientDb
      .from('Retell_calls_Mindflow')
      .select('*', { count: 'exact', head: true });

    const { data: recent, error: recentError } = await clientDb
      .from('Retell_calls_Mindflow')
      .select('status, Duracao, Marcada, disconnection_reason')
      .order('created_at', { ascending: false })
      .limit(150);

    if (countError || recentError) throw countError || recentError;

    let totalDuration = 0;
    let validDurationCount = 0;
    let meetingsScheduled = 0;
    let completedCalls = 0;

    recent.forEach(c => {
      if (c.Duracao) {
        const seconds = parseFloat(c.Duracao.replace(/[^\d.]/g, ''));
        if (!isNaN(seconds)) {
          totalDuration += seconds;
          validDurationCount++;
        }
      }
      
      const isMarcada = c.Marcada && (
        c.Marcada.toLowerCase().includes('sim') || 
        c.Marcada.toLowerCase().includes('true') || 
        c.Marcada === '1'
      );
      if (isMarcada) {
        meetingsScheduled++;
      }
      
      if (c.status === 'completed') {
        completedCalls++;
      }
    });

    const avgDuration = validDurationCount > 0 ? Math.round(totalDuration / validDurationCount) : 0;
    const rate = count > 0 ? Math.round((meetingsScheduled / recent.length) * 100) : 0;

    return res.json({
      total: count,
      avgDuration: avgDuration,
      meetingsScheduled: meetingsScheduled,
      successRate: rate,
      completedCalls: completedCalls
    });
  } catch (err) {
    console.error('[BFF] Erro ao calcular estatísticas:', err.message);
    return res.status(500).json({ error: 'Erro ao calcular estatísticas.' });
  }
});

// ============================================================
// HELPERS DO DASHBOARD
// ============================================================

/** Cache em memória para dados processados (multicliente — chaveado por URL do Supabase) */
let callsCache = {};
const CACHE_TTL = 30_000; // 30 segundos

/** Lock para evitar múltiplos fetches paralelos do mesmo cliente */
const cacheLocks = {};

/** Mapeia disconnection_reason para categoria */
function mapDisconnectionCategory(reason, durationSec) {
  if (!reason || reason === 'null' || reason === '') {
    return durationSec > 15.0 ? 'Conversa Normal' : 'Não Atendeu';
  }
  const r = String(reason).toLowerCase().trim();
  if (['agent_hangup','user_hangup','inactivity','max_duration_reached','call_transfer'].includes(r))
    return 'Conversa Normal';
  if (['dial_no_answer','no-answer','voicemail_reached'].includes(r))
    return 'Não Atendeu';
  if (['user_declined','invalid_destination'].includes(r))
    return 'Bloqueado';
  if (['dial_busy','ivr_reached'].includes(r))
    return 'Ocupado';
  if (r.startsWith('telephony_provider_') || ['error_asr','error_retell','dial_failed'].includes(r))
    return 'Erro Técnico';
  return durationSec > 15.0 ? 'Conversa Normal' : 'Não Atendeu';
}

/** Busca e processa todas as calls do Supabase com cache (multicliente) */
async function fetchProcessedCalls(agent, startDate, endDate, clientSupabase) {
  const now = Date.now();
  const db = clientSupabase || supabase;

  // Cache key = client supabase URL (diferencia cache por cliente)
  const cacheKey = db === supabase ? '__main__' : (db._cacheKey || '__custom__');

  if (!callsCache[cacheKey]) {
    callsCache[cacheKey] = { data: null, timestamp: 0 };
  }
  const cache = callsCache[cacheKey];

  // Refresh cache se expirou (com lock para evitar fetches paralelos)
  if (!cache.data || now - cache.timestamp > CACHE_TTL) {
    // Se já tem um fetch em andamento, espera ele terminar
    if (cacheLocks[cacheKey]) {
      console.log(`[Cache] Aguardando fetch em andamento (${cacheKey})...`);
      await cacheLocks[cacheKey];
      // Depois de esperar, retorna os dados cacheados
      if (cache.data) {
        return applyFilters(cache.data, agent, startDate, endDate);
      }
    }

    // Criar lock
    let resolveLock;
    cacheLocks[cacheKey] = new Promise(r => { resolveLock = r; });

    try {
      console.log(`[Cache] Atualizando cache (${cacheKey})...`);

      // Limitar a 5,000 registros mais recentes
      let allData = [];
      const maxRecords = 5000;
      const batchSize = 5000;

      const { data, error } = await db
        .from('Retell_calls_Mindflow')
        .select('call_id,to_number,Nome,Email,agent_name,created_at,recording_url,combined_cost,Duracao,disconnection_reason')
        .range(0, batchSize - 1)
        .order('created_at', { ascending: false });

      if (error) {
        console.error(`[Cache] Erro ao buscar dados:`, error.message);
        allData = [];
      } else {
        allData = data || [];
      }

    if (allData.length === 0) return [];

    // Processar (transform + dedup + fatigue)
    let calls = allData.map(c => ({
      ...c,
      Duracao: (parseFloat(c.Duracao) || 0) / 1000,
      combined_cost: (parseFloat(c.combined_cost) || 0) / 100,
      created_at: new Date(c.created_at).getTime(),
    }));

    // Dedup
    const seen = new Map();
    calls.forEach(c => seen.set(c.call_id, c));
    calls = Array.from(seen.values());

    // Sort cronológico para fadiga
    calls.sort((a, b) => a.created_at - b.created_at);

    // Mapear categorias e flags
    calls.forEach(c => {
      c.disconnection_category = mapDisconnectionCategory(c.disconnection_reason, c.Duracao);
      c.is_hook = c.Duracao > 15 ? 1 : 0;
      c.is_conversa = c.Duracao > 45 ? 1 : 0;
      c.is_interesse = c.Duracao > 90 ? 1 : 0;
    });

    // Fadiga por lead
    const leadMap = new Map();
    calls.forEach(c => {
      if (!leadMap.has(c.to_number)) leadMap.set(c.to_number, []);
      leadMap.get(c.to_number).push(c);
    });
    calls.forEach(c => {
      const leadCalls = leadMap.get(c.to_number) || [];
      const idx = leadCalls.indexOf(c);
      const nAnteriores = idx;
      const firstContact = leadCalls[0].created_at;
      const horasDesdePrimeiro = (c.created_at - firstContact) / 3600000;
      const lastContact = idx > 0 ? leadCalls[idx - 1].created_at : c.created_at;
      const horasDesdeUltimo = (c.created_at - lastContact) / 3600000;
      c.n_tentativas_anteriores = nAnteriores;
      c.densidade_tentativas = nAnteriores / (horasDesdePrimeiro + 1);
      c.pressao_recente = nAnteriores / (horasDesdeUltimo + 1);
    });

    // Sort descendente para retorno
    calls.sort((a, b) => b.created_at - a.created_at);

    cache.data = calls;
    cache.timestamp = now;
    console.log(`[Cache] Cache atualizado (${cacheKey}): ${calls.length} calls`);
    } finally {
      // Liberar o lock sempre
      resolveLock();
      delete cacheLocks[cacheKey];
    }
  }

  return applyFilters(cache.data, agent, startDate, endDate);
}

function applyFilters(calls, agent, startDate, endDate) {
  let filtered = calls || [];
  if (agent) {
    filtered = filtered.filter(c => c.agent_name === agent || c.agent_id === agent);
  }
  if (startDate) {
    const startMs = new Date(startDate + 'T00:00:00').getTime();
    filtered = filtered.filter(c => {
      if (!c || !c.created_at) return false;
      const callMs = typeof c.created_at === 'number'
        ? (c.created_at < 1e11 ? c.created_at * 1000 : c.created_at)
        : new Date(String(c.created_at).replace(' ', 'T')).getTime();
      return !isNaN(callMs) && callMs >= startMs;
    });
  }
  if (endDate) {
    const endMs = new Date(endDate + 'T23:59:59').getTime();
    filtered = filtered.filter(c => {
      if (!c || !c.created_at) return false;
      const callMs = typeof c.created_at === 'number'
        ? (c.created_at < 1e11 ? c.created_at * 1000 : c.created_at)
        : new Date(String(c.created_at).replace(' ', 'T')).getTime();
      return !isNaN(callMs) && callMs <= endMs;
    });
  }
  return filtered;
}

/**
 * Cria uma instância Supabase para o cliente ativo na sessão do usuário.
 * Usa as credenciais armazenadas no session.client_access.
 */
function getActiveClientDb(req) {
  const user = req.session?.user;
  if (!user || !user.active_client || !user.client_access) return supabase;
  const access = user.client_access.find(c => c.client_id === user.active_client);
  if (!access) return supabase;
  const client = createClient(access.supabase_url, access.service_key);
  client._cacheKey = access.supabase_url;
  return client;
}

function buildFilterParams(agent, startDate, endDate) {
  const params = {};
  if (agent) params.agent = agent;
  if (startDate) params.startDate = startDate;
  if (endDate) params.endDate = endDate;
  return params;
}

// ============================================================
// DASHBOARD NATIVE — APIs (sem prefixo /api/, frontend espera assim)
// ============================================================

app.get('/metrics', (req, res) => proxyToDashboardBackend(req, res, '/metrics'));
app.get('/funnel', (req, res) => proxyToDashboardBackend(req, res, '/funnel'));
app.get('/disconnections', (req, res) => proxyToDashboardBackend(req, res, '/disconnections'));
app.get('/hours', (req, res) => proxyToDashboardBackend(req, res, '/hours'));
app.get('/fatigue', (req, res) => proxyToDashboardBackend(req, res, '/fatigue'));
app.get('/agents', (req, res) => proxyToDashboardBackend(req, res, '/agents'));
app.get('/calls', (req, res) => proxyToDashboardBackend(req, res, '/calls'));
app.post('/etl/trigger', (req, res) => proxyToDashboardBackend(req, res, '/etl/trigger', 'POST'));

// ============================================================
// API: WHATSAPP (proxy para hub_backend)
// ============================================================
app.get('/whatsapp/metrics', (req, res) => proxyToDashboardBackend(req, res, '/whatsapp/metrics'));
app.get('/whatsapp/funnel', (req, res) => proxyToDashboardBackend(req, res, '/whatsapp/funnel'));
app.get('/whatsapp/chats', (req, res) => proxyToDashboardBackend(req, res, '/whatsapp/chats'));
app.get('/whatsapp/hours', (req, res) => proxyToDashboardBackend(req, res, '/whatsapp/hours'));
app.get('/whatsapp/chats/:session_id/messages', (req, res) => {
  proxyToDashboardBackend(req, res, `/whatsapp/chats/${encodeURIComponent(req.params.session_id)}/messages`);
});

// ============================================================
// API: AGENDAMENTOS (proxy para hub_backend)
// ============================================================
app.get('/agendamentos', (req, res) => proxyToDashboardBackend(req, res, '/agendamentos'));

// ============================================================
// API: PLATAFORMAS (protegida)
// ============================================================
app.get('/api/platforms', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });

  // Plataformas globais
  const platforms = [...PLATFORMS];

  // Adicionar plataformas específicas do cliente ativo
  const user = req.session.user;
  if (user.active_client && user.client_access) {
    const access = user.client_access.find(c => c.client_id === user.active_client);
    if (access) {
      // Cliente tem Supabase próprio
      if (access.supabase_url !== process.env.SUPABASE_URL) {
        platforms.unshift({
          id: `client-supabase-${access.client_id}`,
          name: `Supabase (${access.client_name})`,
          description: `Banco de dados do cliente ${access.client_name}`,
          url: `https://supabase.com/dashboard/project/${access.supabase_url.replace('https://', '').replace('.supabase.co', '')}`,
          icon: 'database',
          client_specific: true,
        });
      }
    }
  }

  res.json(platforms);
});

// ============================================================
// START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MindFlow Hub rodando em http://0.0.0.0:${PORT} [${IS_PRODUCTION ? 'PRODUÇÃO' : 'desenvolvimento'}]`);
});

// ============================================================
// PLATFORM CONFIG — edite as URLs aqui
// ============================================================
const PLATFORMS = [
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Banco de dados e autenticação',
    url: 'https://supabase.com/dashboard/org/sdkymfktruvsdlqmkqeh',
    icon: 'database',
  },
  {
    id: 'n8n',
    name: 'n8n',
    description: 'Automação de workflows',
    url: 'https://n8n-mcp-n8n.bkpxmb.easypanel.host/projects/Lf5I2sykx1cKIGxc/workflows',
    icon: 'account_tree',
  },
  {
    id: 'hostinger',
    name: 'Hostinger',
    description: 'Hospedagem e domínios',
    url: 'https://hpanel.hostinger.com/',
    icon: 'dns',
  },
  {
    id: 'easypanel',
    name: 'Easypanel',
    description: 'Deploy e gerenciamento de servidores',
    url: 'https://easypanel.io',
    icon: 'rocket_launch',
  },
  {
    id: 'mlflow',
    name: 'MLFlow',
    description: 'Track de experimentos ML',
    url: 'https://mlflow.mindflow-ia.com/#/',
    icon: 'experiment',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Sparkozzy — repositórios de código',
    url: 'https://github.com/Sparkozzy',
    icon: 'code',
  },
  {
    id: 'zapi',
    name: 'Z-API',
    description: 'API de WhatsApp',
    url: 'https://app.z-api.io/app',
    icon: 'chat',
  },
  {
    id: 'trello-pi',
    name: 'Trello PI',
    description: 'Projetos Internos',
    url: 'https://trello.com/b/A7PITYlb/projetos-internos',
    icon: 'view_kanban',
  },
  {
    id: 'trello-pe',
    name: 'Trello PE',
    description: 'Projetos Externos',
    url: 'https://trello.com/b/uxzdcvl3/projetos-externos',
    icon: 'view_kanban',
  },
  {
    id: 'retell',
    name: 'Retell AI',
    description: 'Dashboard de voz e telefonia',
    url: 'https://dashboard.retellai.com/agents',
    icon: 'phone_in_talk',
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    description: 'Métricas e histórico de ligações',
    url: '/dashboard',
    icon: 'bar_chart',
    internal: true,
  },
  {
    id: 'formulario',
    name: 'Disparo de Ligação',
    description: 'Formulário de chamadas MindFlow',
    url: '/disparo',
    icon: 'smart_toy',
    internal: true,
  },
  {
    id: 'planilha',
    name: 'Planilha de Acessos',
    description: 'Senhas e logins das plataformas',
    url: 'https://docs.google.com/spreadsheets/d/1ONK3dt-YjmPG-zEDoOluPuH-44uMrDt-m5lZEBZtbDg/edit?pli=1&gid=894756518#gid=894756518',
    icon: 'key',
  },
];
