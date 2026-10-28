require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('SIGTERM', () => {
  console.log('[PROCESS] Received SIGTERM signal.');
});
process.on('exit', (code) => {
  console.log(`[PROCESS] Process exited with code: ${code}`);
});

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { rateLimit } = require('express-rate-limit');
const ExcelJS = require('exceljs');

// ============================================================
// VALIDAÇÃO DE AMBIENTE
// ============================================================
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.warn('[AVISO] SUPABASE_URL ou SUPABASE_KEY não informados via env. Utilizando credenciais padrão do projeto.');
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ghayhpwthdbmnpsptcnb.supabase.co';
  process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoYXlocHd0aGRibW5wc3B0Y25iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY3MTI3MTMsImV4cCI6MjA2MjI4ODcxM30.S2eyQXNn222n7eHMAXIzfAub8dBiWYlOSyXGFo1LIpA';
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.includes('troque-isso')) {
  console.warn('[AVISO] SESSION_SECRET não definida ou padrão. Utilizando segredo padrão seguro.');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'mindflow-hub-session-secret-key-2026';
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
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const targets = new Set();

  if (executionId && liveSseClients.has(executionId)) {
    for (const c of liveSseClients.get(executionId)) targets.add(c);
  }
  if (data && data.call_id && liveSseClients.has(data.call_id)) {
    for (const c of liveSseClients.get(data.call_id)) targets.add(c);
  }

  if (targets.size === 0) return;
  for (const clientRes of targets) {
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
        if (['user_declined', 'user-declined'].includes(reason)) {
          stageLabel = 'Chamada Recusada pelo Lead (user_declined)';
        } else if (['user_hangup', 'user-hangup'].includes(reason)) {
          stageLabel = 'Finalizada pelo Lead (user_hangup)';
        } else if (['agent_hangup', 'agent-hangup'].includes(reason)) {
          stageLabel = 'Finalizada pelo Agente (agent_hangup)';
        } else if (['voicemail_reached', 'voicemail'].includes(reason)) {
          stageLabel = 'Caixa Postal Atingida (voicemail)';
        } else if (['inactivity'].includes(reason)) {
          stageLabel = 'Encerrada por Inatividade (inactivity)';
        } else if (['dial_no_answer', 'no-answer', 'no_answer'].includes(reason)) {
          stageLabel = 'Não Atendeu (no_answer)';
        } else if (['dial_busy', 'busy'].includes(reason)) {
          stageLabel = 'Linha Ocupada (busy)';
        } else if (reason.includes('error') || reason === 'dial_failed' || callStatus === 'error') {
          stageLabel = `Falha na Chamada (${reason || 'erro'})`;
        } else {
          stageLabel = reason ? `Chamada Encerrada (${reason})` : 'Chamada Finalizada';
        }
      } else if (['ongoing', 'in_progress', 'in-progress'].includes(callStatus)) {
        stage = 'IN_PROGRESS';
        stageLabel = 'Em Chamada ao Vivo';
      } else if (['registered', 'ringing'].includes(callStatus)) {
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

// Trust proxy — 1 hop para Traefik no Easypanel
app.set('trust proxy', 1);

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
  validate: { trustProxy: false },
});

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  const publicPaths = ['/', '/health', '/api/', '/redefinir-senha', '/dev-login', '/dev-client-login', '/hub', '/dashboard', '/disparo', '/checkup', '/projetos', '/cliente', '/prompt-ops', '/dashboard-style.css', '/dashboard-app.js', '/mindflow-core.css'];
  if (publicPaths.some(p => req.path === p || req.path.startsWith('/api/'))) return next();
  if (/\.(html|css|js)$/.test(req.path)) return res.redirect('/');
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'hub' }));

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

// Páginas de apresentação e institucionais públicas
app.get(['/apresentacao-institucional.html', '/apresentacao-institucional', '/apresentacao'], (req, res) => {
  res.sendFile(path.join(__dirname, 'apresentacao-institucional.html'));
});

app.get(['/apresentacao-institucional.pdf', '/apresentacao-pdf'], (req, res) => {
  res.sendFile(path.join(__dirname, 'apresentacao-institucional.pdf'));
});

app.get(['/demonstracao-atendimento.html', '/design-agent-ops.html', '/estrategia-mindflow.html', '/mindflow-design-system.html', '/mindflow-prototype.html', '/mindflow-site-institucional.html', '/raciocinio-design-mindflow.html', '/sistema-visual-mindflow.html', '/site-disparo.html', '/tavily-editorial.html'], (req, res) => {
  const fileName = req.path.replace(/^\//, '');
  res.sendFile(path.join(__dirname, fileName));
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/prompt-ops', (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  const isMindFlowMember = req.session.user.client_access?.some(c => String(c.client_id) === '2');
  if (!isMindFlowMember) {
    return res.status(403).send('<h1>403 Proibido: Acesso restrito aos engenheiros da MindFlow.</h1>');
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'prompt-ops.html'));
});

app.get('/dashboard-style.css', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dashboard-style.css'));
});

app.get('/mindflow-core.css', (req, res) => {
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'mindflow-core.css'));
});

app.get('/dashboard-app.js', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dashboard-app.js'));
});

app.get(['/disparo', '/disparo.html'], (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'disparo.html'));
});

app.get(['/checkup', '/checkup.html'], (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'checkup.html'));
});

app.get(['/projetos', '/projetos.html'], (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'projetos.html'));
});

app.get(['/zapi-connect', '/zapi-connect.html'], (req, res) => {
  if (!req.session?.user && (!req.query.instanceId || !req.query.token)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'zapi-connect.html'));
});

// ============================================================
// MINDFLOW SENTINEL — TELEMETRIA Z-API & SAÚDE DAS IAS
// ============================================================
const zapiStatusMap = new Map();

// Webhook para receber eventos de desconexão em tempo real da Z-API
app.post('/api/webhooks/zapi/disconnected', async (req, res) => {
  try {
    const body = req.body || {};
    const instanceId = body.instanceId || body.instance_id || 'default';
    const clientName = body.clientName || 'Cliente';
    
    console.warn(`[SENTINEL ALERT] Z-API Desconectada! Instância: ${instanceId} | Cliente: ${clientName}`);
    
    zapiStatusMap.set(instanceId, {
      connected: false,
      status: 'DISCONNECTED',
      disconnectedAt: new Date().toISOString(),
      clientName: clientName
    });

    res.status(200).json({ ok: true, alert: 'Z-API Disconnection logged' });
  } catch (err) {
    console.error('[SENTINEL ERROR] Webhook Z-API:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para checagem ativa de status de uma instância Z-API
app.get('/api/zapi/status', async (req, res) => {
  const { instanceId, token } = req.query;

  if (!instanceId || !token) {
    // Se não informados os parâmetros, retorna status simulado/cached para a interface
    return res.json({
      connected: true,
      status: 'CONNECTED',
      lastCheck: new Date().toISOString()
    });
  }

  try {
    const zapiUrl = `https://api.z-api.io/instances/${instanceId}/token/${token}/status`;
    const response = await fetch(zapiUrl, { headers: { 'Client-Token': token } });
    const data = await response.json().catch(() => ({}));
    
    const isConnected = data.connected === true || data.status === 'CONNECTED';
    
    zapiStatusMap.set(instanceId, {
      connected: isConnected,
      status: isConnected ? 'CONNECTED' : 'DISCONNECTED',
      lastCheck: new Date().toISOString()
    });

    res.json({
      connected: isConnected,
      status: isConnected ? 'CONNECTED' : 'DISCONNECTED',
      raw: data,
      lastCheck: new Date().toISOString()
    });
  } catch (err) {
    console.error(`[Z-API CHECK FAILED] Instância ${instanceId}:`, err.message);
    res.json({
      connected: false,
      status: 'ERROR',
      error: err.message,
      lastCheck: new Date().toISOString()
    });
  }
});

// ============================================================
// Z-API AUTOMATION & QR-CODE CONNECT PROXY ENDPOINTS
// ============================================================
const DEFAULT_ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || '3F593841D8F6F1D722D88699EC5A47CF';
const DEFAULT_ZAPI_TOKEN = process.env.ZAPI_TOKEN || '11BBEB710E926E64F5AF73AD';
const DEFAULT_CLIENT_TOKEN = process.env.CLIENT_TOKEN || 'F5724b7f8bf0e456bbdad95a16886f435S';
const MY_WEBHOOK_URL = process.env.MY_WEBHOOK_URL || 'https://mindflow-ia-connect.loca.lt/webhook/zapi-connected';

const getZapiCreds = (req) => ({
  instanceId: req.query.instanceId || req.body?.instanceId || DEFAULT_ZAPI_INSTANCE_ID,
  token: req.query.token || req.body?.token || DEFAULT_ZAPI_TOKEN,
  clientToken: req.query.clientToken || req.body?.clientToken || DEFAULT_CLIENT_TOKEN
});

// 1. QR Code & Status Proxy
app.get('/api/qr-code', async (req, res) => {
  try {
    const { instanceId, token, clientToken } = getZapiCreds(req);
    if (!instanceId || !token) {
      return res.status(400).json({ error: 'Instance ID e Token são obrigatórios' });
    }

    // Verifica status primeiro
    const statusUrl = `https://api.z-api.io/instances/${instanceId}/token/${token}/status`;
    try {
      const statusRes = await fetch(statusUrl, {
        headers: { 'Client-Token': clientToken }
      });
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (statusData.connected) {
          return res.json({ 
            connected: true, 
            phone: statusData.phone || statusData.connectedPhone || statusData.zapId || null,
            instanceId 
          });
        }
      }
    } catch (e) {
      console.warn('[Z-API Proxy] Status check warning:', e.message);
    }

    // Se não estiver conectada, busca o QR Code
    const qrUrl = `https://api.z-api.io/instances/${instanceId}/token/${token}/qr-code`;
    const qrRes = await fetch(qrUrl, {
      headers: { 'Client-Token': clientToken }
    });

    if (qrRes.status === 403 || qrRes.status === 400) {
      return res.json({ connected: true, instanceId });
    }

    if (!qrRes.ok) {
      return res.status(qrRes.status).json({ error: 'Erro ao conectar com a Z-API' });
    }

    const qrData = await qrRes.json();
    if (qrData.connected) {
      return res.json({ 
        connected: true, 
        phone: qrData.phone || qrData.connectedPhone || qrData.zapId || null,
        instanceId 
      });
    }

    return res.json({ connected: false, base64: qrData.value, instanceId });
  } catch (error) {
    console.error('[Z-API Proxy] Erro ao buscar QR Code:', error.message);
    res.status(500).json({ error: 'Erro interno ao buscar QR Code' });
  }
});

// Endpoint de telemetria consolidada de todas as instâncias cadastradas (MindFlow Dev Operations)
app.get('/api/zapi/all-status', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });

  const instances = [
    { key: 'mindflow', name: 'Mindflow Oficial', client_name: 'Mindflow Oficial', instanceId: '3F5BBCC13F9441E00E5886B9FA2A227D', token: '64F4F81BE55EC5EDBA9696A0', clientToken: 'F5724b7f8bf0e456bbdad95a16886f435S' },
    { key: 'kravi_sac', name: 'Kravi SAC', client_name: 'Kravi SAC', instanceId: '3F8A8CFB6E84B0BA6E6B92B31FE9D931', token: '9EC21D107C4163E74F680818', clientToken: 'F5724b7f8bf0e456bbdad95a16886f435S' },
    { key: 'kravi_comercial', name: 'Kravi Comercial', client_name: 'Kravi Comercial', instanceId: '3F53014B6E8BE165D5DDE25F89A39EC6', token: '88891636BD921F9AA5D37E52', clientToken: 'F5724b7f8bf0e456bbdad95a16886f435S' },
    { key: 'ats', name: 'ATS Portaria Remota', client_name: 'ATS Portaria Remota', instanceId: '3F593841D8F6F1D722D88699EC5A47CF', token: '11BBEB710E926E64F5AF73AD', clientToken: 'F5724b7f8bf0e456bbdad95a16886f435S' },
    { key: 'devolvejus', name: 'DevolveJus', client_name: 'DevolveJus', instanceId: '3F7D488E0411C146C267A6F05C4968EE', token: 'D43AE3E8FFC686E9DC0D34ED', clientToken: 'F5724b7f8bf0e456bbdad95a16886f435S' },
    { key: 'mygain', name: 'MyGain', client_name: 'MyGain', instanceId: '3F5B9720BCBA4109714BFA27602D6B71', token: '4120836441EE8155F2B47D33', clientToken: 'F5724b7f8bf0e456bbdad95a16886f435S' },
    { key: 'mindflow_teste', name: 'Mindflow Teste', client_name: 'Mindflow Teste', instanceId: '3F588D53C27212C62711', token: '820E3AA869FA76FEFE33', clientToken: 'F5724b7f8bf0e456bbdad95a16886f435S' }
  ];

  const results = await Promise.all(instances.map(async (inst) => {
    try {
      const statusUrl = `https://api.z-api.io/instances/${inst.instanceId}/token/${inst.token}/status`;
      const response = await fetch(statusUrl, { headers: { 'Client-Token': inst.clientToken } });
      if (response.ok) {
        const data = await response.json();
        const isConnected = data.connected === true;
        return {
          ...inst,
          name: inst.name || inst.client_name,
          connected: isConnected,
          phone: data.phone || data.connectedPhone || data.zapId || null,
          statusLabel: isConnected ? 'Conectada' : 'Desconectada',
          status: isConnected ? 'CONNECTED' : 'DISCONNECTED',
          lastCheck: new Date().toISOString()
        };
      }
    } catch (e) {}
    return {
      ...inst,
      name: inst.name || inst.client_name,
      connected: false,
      statusLabel: 'Desconectada',
      status: 'DISCONNECTED',
      lastCheck: new Date().toISOString()
    };
  }));

  res.json(results);
});

// 2. Setup Webhook Automatically
app.get('/api/setup-webhook', async (req, res) => {
  try {
    const { instanceId, token, clientToken } = getZapiCreds(req);
    const customUrl = req.query.url;
    const finalWebhookUrl = customUrl ? `${customUrl}/webhook/zapi-connected` : MY_WEBHOOK_URL;
    const url = `https://api.z-api.io/instances/${instanceId}/token/${token}/update-webhook-connected`;
    
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'Client-Token': clientToken 
      },
      body: JSON.stringify({ value: finalWebhookUrl })
    });
    const data = await response.json().catch(() => ({}));

    res.json({ success: true, message: 'Webhook registrado com sucesso', data, registeredUrl: finalWebhookUrl });
  } catch (error) {
    console.error('[Z-API Proxy] Erro ao registrar webhook:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Disconnect Instance
app.get('/api/disconnect', async (req, res) => {
  try {
    const { instanceId, token, clientToken } = getZapiCreds(req);
    const url = `https://api.z-api.io/instances/${instanceId}/token/${token}/disconnect`;
    const response = await fetch(url, {
      headers: { 'Client-Token': clientToken }
    });
    const data = await response.json().catch(() => ({}));
    res.json({ success: true, message: 'Instância desconectada com sucesso!', data });
  } catch (error) {
    console.error('[Z-API Proxy] Erro ao desconectar:', error.message);
    res.status(500).json({ error: 'Erro ao desconectar' });
  }
});

// 4. Webhook Receiver
app.post('/webhook/zapi-connected', (req, res) => {
  const data = req.body || {};
  console.log('[Z-API Webhook] Connection event received:', data);
  res.status(200).send('OK');
});

// Endpoint de telemetria completa de todas as IAs
app.get('/api/sentinel/health', (req, res) => {
  const statuses = Array.from(zapiStatusMap.entries()).map(([instanceId, data]) => ({
    instanceId,
    ...data
  }));
  res.json({
    timestamp: new Date().toISOString(),
    instancesCount: statuses.length,
    statuses
  });
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
let activeBackendUrl = process.env.DASHBOARD_API_URL || null;

async function getBackendUrl() {
  if (activeBackendUrl) return activeBackendUrl;
  const candidates = [
    process.env.DASHBOARD_API_URL,
    'http://hub_hub-backend:8000',
    'http://hub-backend:8000',
    'http://localhost:8000',
    'https://hub-backend.bkpxmb.easypanel.host',
    'https://hub-backend-github.bkpxmb.easypanel.host',
  ].filter(Boolean);

  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.log(`[Proxy] Backend analítico conectado em: ${base}`);
        activeBackendUrl = base;
        return activeBackendUrl;
      }
    } catch (_) {}
  }
  return candidates[0] || 'http://hub_hub-backend:8000';
}

const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL || 'http://hub_hub-backend:8000';

/**
 * Proxy transparente para o hub_backend (analytics + WhatsApp).
 * Repassa o client_id ativo da sessão via header X-Client-ID.
 */
async function proxyToDashboardBackend(req, res, path, method = 'GET') {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const clientId = req.session.user.active_client || '2';
  const qs = new URLSearchParams(req.query).toString();
  const baseUrl = await getBackendUrl();
  const url = `${baseUrl}${path}${qs ? '?' + qs : ''}`;

  try {
    const response = await fetch(url, {
      method,
      headers: { 'X-Client-ID': clientId },
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    return res.status(response.status).json(data);
  } catch (err) {
    console.error(`[Proxy] Erro ao consultar hub_backend (${url}):`, err.message);
    activeBackendUrl = null;
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
  validate: { trustProxy: false },
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

app.get(['/api/call-status/:executionId', '/api/call-status'], async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const executionId = req.params.executionId || req.query.execution_id || req.query.executionId;

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
          const listRes = await fetch('https://api.retellai.com/v2/list-calls?limit=10', {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${process.env.RETELL_API_KEY}`
            },
            signal: AbortSignal.timeout(4000)
          });
          if (listRes.ok) {
            const listCalls = await listRes.json();
            if (Array.isArray(listCalls) && listCalls.length > 0) {
              const getCallMs = (c) => {
                if (typeof c.start_timestamp === 'number') return c.start_timestamp;
                if (c.start_timestamp) return new Date(c.start_timestamp).getTime() || 0;
                if (c.created_at) return new Date(c.created_at).getTime() || 0;
                return 0;
              };

              const validCalls = listCalls.filter(c => {
                const callTime = getCallMs(c);
                return callTime >= minStartTime || callTime === 0;
              }).sort((a, b) => getCallMs(b) - getCallMs(a));

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
                callToExecutionMap.set(rCall.call_id, executionId);
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
    const limit = parseInt(req.query.limit) || 1000;
    const cols = 'id, created_at, Nome, Numero, status, call_id, agent_id, agent_name, transcript, recording_url, disconnection_reason, from_number, to_number, Duracao, Marcada';
    
    let query = clientDb
      .from('Retell_calls_Mindflow')
      .select(cols)
      .order('id', { ascending: false })
      .limit(limit);

    const startDate = (req.query.start_date || req.query.startDate || '').trim();
    const endDate = (req.query.end_date || req.query.endDate || '').trim();
    const agent = (req.query.agent || '').trim();

    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      query = query.lte('created_at', endDate + 'T23:59:59');
    }
    if (agent && agent !== 'all' && agent !== 'Todos os Agentes') {
      query = query.eq('agent_id', agent);
    }

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ data: data || [], calls: data || [], pages: 1, page: 1 });
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

// ============================================================
// MOTOR DE EXPORTAÇÃO EXECUTIVA (EXCEL .xlsx & CSV .csv)
// ============================================================
const {
  generateMindFlowExcelBuffer,
  generateMindFlowCsvBuffer,
  formatarNomeAgenteExport
} = require('./mindflow-export-engine');

/**
 * Coleta dados filtrados para exportação com isolamento estrito de cliente
 */
async function fetchExportDataset(req) {
  if (!req.session?.user) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }

  const clientId = String(req.session.user.active_client || '2');
  let clientName = 'MINDFLOW';
  if (req.session.user.client_access && Array.isArray(req.session.user.client_access)) {
    const acc = req.session.user.client_access.find(c => String(c.client_id) === clientId);
    if (acc && acc.client_name) clientName = acc.client_name;
  }

  const isWhatsApp = req.query.tab === 'whatsapp' || req.query.is_whatsapp === 'true';
  const startDate = (req.query.start_date || req.query.startDate || '').trim();
  const endDate = (req.query.end_date || req.query.endDate || '').trim();
  const agent = (req.query.agent || '').trim();
  const isFiltered = Boolean(startDate || endDate || (agent && agent !== 'all' && agent !== 'Todos os Agentes'));

  let periodText = 'Todo o Histórico';
  if (startDate && endDate) {
    periodText = `${startDate.split('-').reverse().join('/')} a ${endDate.split('-').reverse().join('/')}`;
  } else if (startDate) {
    periodText = `A partir de ${startDate.split('-').reverse().join('/')}`;
  } else if (endDate) {
    periodText = `Até ${endDate.split('-').reverse().join('/')}`;
  }

  const agentFilterText = (agent && agent !== 'all') ? agent : 'Todos os Agentes';
  const safeLimit = isFiltered ? 5000 : 2500;
  let items = [];

  // 1. Chamadas telefônicas: Supabase direto do cliente (fonte primária com gravações e transcrições completas)
  if (!isWhatsApp) {
    try {
      const clientDb = getActiveClientDb(req);
      const cols = 'id, created_at, Nome, Numero, status, call_id, agent_id, agent_name, transcript, recording_url, disconnection_reason, from_number, to_number, Duracao, Marcada, call_summary';
      let query = clientDb
        .from('Retell_calls_Mindflow')
        .select(cols)
        .order('id', { ascending: false })
        .limit(safeLimit);

      if (startDate) query = query.gte('created_at', startDate.includes('T') ? startDate : startDate + 'T00:00:00');
      if (endDate) query = query.lte('created_at', endDate.includes('T') ? endDate : endDate + 'T23:59:59');
      if (agent && agent !== 'all' && agent !== 'Todos os Agentes') {
        query = query.or(`agent_id.eq.${agent},agent_name.ilike.%${agent}%`);
      }

      const { data, error } = await query;
      if (error) console.error('[Export Supabase Error]:', error.message);
      if (data && data.length) items = data;
    } catch (e) {
      console.error('[Export Supabase Catch]:', e.message);
    }
  }

  // 2. WhatsApp ou fallback de chamadas: consulta o hub_backend analítico usando getBackendUrl dinâmico
  if (!items.length) {
    try {
      const baseUrl = await getBackendUrl();
      const endpointPath = isWhatsApp ? '/whatsapp/chats' : '/calls';

      // Parâmetros compatíveis com FastAPI (le=100 por página)
      const apiParams = new URLSearchParams();
      apiParams.set('page', '1');
      apiParams.set('limit', '100');
      if (startDate) apiParams.set('start_date', startDate);
      if (endDate) apiParams.set('end_date', endDate);
      if (agent && agent !== 'all' && agent !== 'Todos os Agentes') apiParams.set('agent', agent);

      const response = await fetch(`${baseUrl}${endpointPath}?${apiParams.toString()}`, {
        headers: { 'X-Client-ID': clientId },
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const result = await response.json();
        items = result.data || result.calls || result.chats || (Array.isArray(result) ? result : []);
      }
    } catch (errBackend) {
      console.warn(`[Export Engine] hub_backend fallback falhou (${errBackend.message})`);
    }
  }

  return {
    items,
    isWhatsApp,
    clientName,
    periodText,
    isLimited: !isFiltered,
    agentFilterText
  };
}

// ROTA EXCEL (.xlsx)
app.get('/api/export-excel', async (req, res) => {
  try {
    const { items, isWhatsApp, clientName, periodText, isLimited, agentFilterText } = await fetchExportDataset(req);

    // Gera o documento Excel oficial perfeitamente estruturado mesmo para períodos com 0 chamadas
    const buffer = await generateMindFlowExcelBuffer(items, isWhatsApp, clientName, periodText, isLimited, agentFilterText);

    const clientSlug = clientName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'mindflow';
    const dateSlug = new Date().toISOString().slice(0, 10);
    const filename = `relatorio_executivo_${clientSlug}_${isWhatsApp ? 'whatsapp' : 'ligacoes'}_${dateSlug}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err) {
    if (err.status === 401) return res.status(401).json({ error: 'Unauthorized' });
    console.error('[API /api/export-excel Error]:', err);
    return res.status(500).send(`Erro ao gerar relatório Excel: ${err.message}`);
  }
});

// ROTA CSV (.csv)
app.get('/api/export-csv', async (req, res) => {
  try {
    const { items, isWhatsApp, clientName, periodText, isLimited, agentFilterText } = await fetchExportDataset(req);

    const buffer = generateMindFlowCsvBuffer(items, isWhatsApp, clientName, periodText, isLimited, agentFilterText);

    const clientSlug = clientName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'mindflow';
    const dateSlug = new Date().toISOString().slice(0, 10);
    const filename = `base_dados_${clientSlug}_${isWhatsApp ? 'whatsapp' : 'ligacoes'}_${dateSlug}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err) {
    if (err.status === 401) return res.status(401).json({ error: 'Unauthorized' });
    console.error('[API /api/export-csv Error]:', err);
    return res.status(500).send(`Erro ao gerar arquivo CSV: ${err.message}`);
  }
});

// ROTA RETROCOMPATÍVEL (/api/export-calls)
app.get('/api/export-calls', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  return res.redirect(`/api/export-csv${qs ? '?' + qs : ''}`);
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
      Duracao: (() => {
        const val = parseFloat(c.Duracao) || 0;
        return val > 1000 ? val / 1000 : val;
      })(),
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
// API: AGENDAMENTOS (BFF Native + Multicliente Supabase)
// ============================================================
async function handleAgendamentosMetrics(req, res) {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const clientDb = getActiveClientDb(req);
    const startDate = (req.query.start_date || req.query.startDate || '').trim();
    const endDate = (req.query.end_date || req.query.endDate || '').trim();
    const agent = (req.query.agent || '').trim();

    let query = clientDb.from('agendamentos').select('*').order('created_at', { ascending: false });

    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', endDate + 'T23:59:59');
    if (agent && agent !== 'all' && agent !== 'Todos os Agentes') query = query.eq('agent_id', agent);

    const { data: rows, error } = await query;
    if (error) throw error;

    const list = rows || [];
    const total = list.length;

    let totalVoice = 0;
    let totalWa = 0;
    let totalAgendado = 0;
    const byStatus = {};
    const byAgent = {};
    const byChannel = { ligacao: 0, whats: 0 };

    list.forEach(r => {
      const ch = (r.canal || 'ligacao').toLowerCase();
      if (ch.includes('whats')) {
        totalWa++;
        byChannel.whats = (byChannel.whats || 0) + 1;
      } else {
        totalVoice++;
        byChannel.ligacao = (byChannel.ligacao || 0) + 1;
      }

      const st = (r.status || 'agendado').toLowerCase();
      byStatus[st] = (byStatus[st] || 0) + 1;
      if (st.includes('agendad') || st.includes('confirm')) {
        totalAgendado++;
      }

      const ag = r.agent_id || r.agente || 'Sem Agente';
      byAgent[ag] = (byAgent[ag] || 0) + 1;
    });

    res.json({
      ok: true,
      total,
      totalVoice,
      totalWa,
      totalAgendado,
      byChannel,
      byStatus,
      byAgent,
      recentList: list.slice(0, 50)
    });
  } catch (err) {
    console.error('[API Agendamentos Metrics Error]:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function handleAgendamentosList(req, res) {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const clientDb = getActiveClientDb(req);
    const startDate = (req.query.start_date || req.query.startDate || '').trim();
    const endDate = (req.query.end_date || req.query.endDate || '').trim();
    const agent = (req.query.agent || '').trim();
    const canal = (req.query.canal || '').trim();
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '15', 10);

    let query = clientDb.from('agendamentos').select('*', { count: 'exact' });

    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', endDate + 'T23:59:59');
    if (agent && agent !== 'all' && agent !== 'Todos os Agentes') query = query.eq('agent_id', agent);
    if (canal && canal !== 'all') query = query.ilike('canal', `%${canal}%`);

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    query = query.order('created_at', { ascending: false }).range(from, to);

    const { data: rows, count, error } = await query;
    if (error) throw error;

    const totalCount = count || (rows ? rows.length : 0);
    res.json({
      ok: true,
      total: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit) || 1,
      data: rows || []
    });
  } catch (err) {
    console.error('[API Agendamentos List Error]:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

app.get('/agendamentos/metrics', handleAgendamentosMetrics);
app.get('/api/agendamentos/metrics', handleAgendamentosMetrics);
app.get('/agendamentos', handleAgendamentosList);
app.get('/api/agendamentos', handleAgendamentosList);

// ============================================================
// ENGINE DE TELEFONIA / DISPARO EM LOTE (PRE_CALL_PROCESSING)
// ============================================================
const PRE_CALL_API_URL = process.env.PRE_CALL_API_URL || 'https://call-github.bkpxmb.easypanel.host';
const PRE_CALL_API_KEY = process.env.PRE_CALL_API_KEY || 'mf_sk_2026_pre_call_xK9v3Qm7bR4wT1nZ';

// Iniciar Lote de Ligações via Planilha/CSV
app.post(['/api/disparo/iniciar-lote', '/api/disparo/schedule-batch'], async (req, res) => {
  try {
    const { 
      leads, 
      horario_inicio = '08:00', 
      horario_fim = '20:00', 
      frequencia = 60, 
      agent_id, 
      prompt_id, 
      contexto = '' 
    } = req.body;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Nenhum contato válido fornecido para o disparo.' });
    }

    console.log(`[DISPARO EM LOTE] Processando ${leads.length} contatos. Horário: ${horario_inicio}-${horario_fim}, Intervalo: ${frequencia}s, Agente: ${agent_id || 'Padrão'}`);

    // Coleta colunas adicionais para passar no CSV (a engine anexa automaticamente ao contexto do lead)
    const baseCols = ['numero', 'nome', 'email'];
    const extraColsSet = new Set();
    leads.forEach(l => {
      Object.keys(l).forEach(k => {
        const norm = k.toLowerCase().trim();
        if (!['numero', 'phone', 'telefone', 'nome', 'name', 'email', 'id', 'isvalid', 'formattedphone', 'date', 'empresa', 'company'].includes(norm)) {
          extraColsSet.add(norm);
        }
      });
    });
    // Garantir empresa/company se existir
    const hasEmpresa = leads.some(l => l.empresa || l.company);
    const extraCols = [];
    if (hasEmpresa) extraCols.push('empresa');
    extraCols.push(...Array.from(extraColsSet));

    const allHeaders = [...baseCols, ...extraCols];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const s = String(val).replace(/"/g, '""');
      return `"${s}"`;
    };

    let csvContent = allHeaders.join(',') + '\n';
    leads.forEach(l => {
      let num = l.numero || l.phone || l.telefone || '';
      num = String(num).replace(/[^\d+]/g, '');
      if (!num.startsWith('+')) {
        num = num.replace(/\D/g, '');
        if (num.length === 10 || num.length === 11) num = '55' + num;
        num = '+' + num;
      }

      const nome = l.nome || l.name || '';
      const email = l.email || '';
      const row = [escapeCsv(num), escapeCsv(nome), escapeCsv(email)];

      extraCols.forEach(col => {
        let val = '';
        if (col === 'empresa') {
          val = l.empresa || l.company || '';
        } else {
          const matchKey = Object.keys(l).find(k => k.toLowerCase().trim() === col);
          val = matchKey ? l[matchKey] : '';
        }
        row.push(escapeCsv(val));
      });
      csvContent += row.join(',') + '\n';
    });

    // Montar FormData nativo do Node.js
    const form = new FormData();
    const csvBlob = new Blob([csvContent], { type: 'text/csv' });
    form.append('file', csvBlob, 'disparos_lote.csv');
    form.append('horario_inicio', String(horario_inicio));
    form.append('horario_fim', String(horario_fim));
    form.append('frequencia', String(frequencia));
    if (agent_id) form.append('agent_id', String(agent_id));
    if (prompt_id) form.append('prompt_id', String(prompt_id));
    if (contexto) form.append('contexto', String(contexto));

    const response = await fetch(`${PRE_CALL_API_URL}/webhook/csv`, {
      method: 'POST',
      headers: {
        'X-API-Key': PRE_CALL_API_KEY
      },
      body: form
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('[DISPARO EM LOTE] Erro na engine pre_call:', result);
      return res.status(response.status || 500).json({
        error: result.error || result.message || 'Falha ao iniciar lote na engine de telefonia.'
      });
    }

    console.log('[DISPARO EM LOTE] Lote registrado com sucesso:', result);

    res.json({
      success: true,
      batch_id: result.batch_id,
      total_leads: result.total_leads || leads.length,
      horario_inicio,
      horario_fim,
      frequencia,
      message: `${result.total_leads || leads.length} ligações enviadas para a fila com sucesso!`
    });
  } catch (err) {
    console.error('[DISPARO EM LOTE] Erro inesperado:', err);
    res.status(500).json({ error: 'Erro interno ao processar o disparo em lote.' });
  }
});

// Listar Lotes Ativos
app.get(['/api/disparo/lotes-ativos', '/api/disparo/csv/active'], async (req, res) => {
  try {
    const response = await fetch(`${PRE_CALL_API_URL}/webhook/csv/active`, {
      method: 'GET',
      headers: {
        'X-API-Key': PRE_CALL_API_KEY
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Erro ao consultar fila na engine de telefonia.' });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[DISPARO EM LOTE] Erro ao buscar lotes ativos:', err);
    res.status(500).json({ error: 'Erro ao buscar lotes ativos.' });
  }
});

// Cancelar / Interromper Lote
app.post(['/api/disparo/cancelar-lote', '/api/disparo/csv/cancel'], async (req, res) => {
  try {
    const { batch_id } = req.body;
    if (!batch_id) {
      return res.status(400).json({ error: 'Identificador do lote (batch_id) é obrigatório.' });
    }

    const form = new FormData();
    form.append('batch_id', batch_id);

    const response = await fetch(`${PRE_CALL_API_URL}/webhook/csv/cancel`, {
      method: 'POST',
      headers: {
        'X-API-Key': PRE_CALL_API_KEY
      },
      body: form
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || 'Erro ao cancelar lote.' });
    }

    res.json({ success: true, message: 'Disparos do lote interrompidos com sucesso.', data });
  } catch (err) {
    console.error('[DISPARO EM LOTE] Erro ao cancelar lote:', err);
    res.status(500).json({ error: 'Erro interno ao cancelar lote.' });
  }
});

// Atualizar Ritmo / Intervalo entre Ligações
app.post(['/api/disparo/alterar-ritmo', '/api/disparo/csv/update-frequency'], async (req, res) => {
  try {
    const { batch_id, frequencia } = req.body;
    if (!batch_id || !frequencia) {
      return res.status(400).json({ error: 'Campos batch_id e frequencia são obrigatórios.' });
    }

    const response = await fetch(`${PRE_CALL_API_URL}/webhook/csv/update-frequency`, {
      method: 'POST',
      headers: {
        'X-API-Key': PRE_CALL_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ batch_id, frequencia: Number(frequencia) })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || 'Erro ao atualizar ritmo.' });
    }

    res.json({ success: true, message: 'Ritmo de chamadas atualizado com sucesso.', data });
  } catch (err) {
    console.error('[DISPARO EM LOTE] Erro ao atualizar ritmo:', err);
    res.status(500).json({ error: 'Erro interno ao atualizar ritmo.' });
  }
});

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

  // Se o usuário tem acesso à MindFlow (client_id === '2'), exibe a plataforma PromptOps
  const isMindFlowMember = user.client_access?.some(c => String(c.client_id) === '2');
  if (isMindFlowMember) {
    platforms.push({
      id: 'prompt-ops',
      name: 'PromptOps',
      description: 'Engenharia, Arena A/B e Evals de Prompts',
      url: '/prompt-ops',
      icon: 'terminal',
      internal: true,
    });
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
    name: 'Z-API Painel',
    description: 'Painel oficial Z-API',
    url: 'https://app.z-api.io/app',
    icon: 'chat',
  },
  {
    id: 'zapi-connect',
    name: 'Conexão WhatsApp Z-API',
    description: 'Conecte e espelhe o QR Code da sua instância Z-API',
    url: '/zapi-connect',
    icon: 'qr_code_scanner',
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
