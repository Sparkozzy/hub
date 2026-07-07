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
// SUPABASE CLIENT
// ============================================================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ============================================================
// APP & MIDDLEWARE
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// Sessão segura
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PRODUCTION,        // HTTPS obrigatório em produção
    sameSite: IS_PRODUCTION ? 'strict' : 'lax',
    maxAge: 8 * 60 * 60 * 1000,  // 8 horas
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
  const publicPaths = ['/', '/api/', '/redefinir-senha', '/dev-login', '/hub', '/dashboard', '/disparo', '/dashboard-style.css', '/dashboard-app.js'];
  if (publicPaths.some(p => req.path === p || req.path.startsWith('/api/'))) return next();
  if (/\.(html|css|js)$/.test(req.path)) return res.redirect('/');
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(requireAuth);

// ============================================================
// ROTAS DE PÁGINAS
// ============================================================
app.get('/', (req, res) => {
  if (req.session?.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/redefinir-senha', (req, res) => {
  res.sendFile(path.join(__dirname, 'redefinir-senha.html'));
});

// Dev login — cria sessão sem senha (apenas em desenvolvimento)
if (!IS_PRODUCTION) {
  app.get('/dev-login', (req, res) => {
    req.session.user = {
      id: 'dev-user',
      email: 'dev@mindflow.ia',
      name: 'Dev MindFlow',
    };
    req.session.save(() => res.redirect('/dashboard'));
  });
}

app.get('/hub', (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'hub.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard-style.css', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.sendFile(path.join(__dirname, 'dashboard-style.css'));
});

app.get('/dashboard-app.js', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.sendFile(path.join(__dirname, 'dashboard-app.js'));
});

app.get('/disparo', (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'disparo.html'));
});

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

  // Login OK — salva na sessão Express
  const displayName = data.user.user_metadata?.full_name || data.user.email;
  req.session.user = {
    id: data.user.id,
    email: data.user.email,
    name: displayName,
  };

  return res.json({ ok: true, name: displayName });
});

// ============================================================
// API: CONFIG (para Supabase Client-side)
// ============================================================
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY
  });
});

// ============================================================
// API: CHECK SESSION
// ============================================================
app.get('/api/check', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ name: req.session.user.name });
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
  const apiKey = process.env.WEBHOOK_API_KEY || "";

  try {
    let quando_ligar = "";
    if (is_scheduled && scheduled_date && scheduled_time) {
      // Formato esperado: ISO 8601 (-03:00) -> YYYY-MM-DDTHH:MM:SS-03:00
      quando_ligar = `${scheduled_date}T${scheduled_time}:00-03:00`;
    }

    const pythonPayload = {
      nome: nome.toUpperCase(),
      email: email || "",
      numero: telefone,
      contexto: contexto || "",
      agent_id: agent_id || "agent_1e4cfa23e3910c557d82167949",
      Prompt_id: prompt_id || "24",
      execution_id: crypto.randomUUID(),
      quando_ligar: quando_ligar,
      workflow_name: "pre_call_processing"
    };

    console.log(`[BFF] Enviando lead para ${apiUrl}: ${pythonPayload.nome} (${pythonPayload.execution_id})`);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(pythonPayload),
      signal: AbortSignal.timeout(12000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || `Erro na API remota: ${response.status}`);
    }

    return res.status(202).json({
      message: "Lead processado com sucesso.",
      execution_id: pythonPayload.execution_id
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

  if (!executionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(executionId)) {
    return res.status(400).json({ error: 'ID de execução inválido.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json'
  };

  try {
    const execUrl = `${supabaseUrl}/rest/v1/workflow_executions?trigger_event_id=eq.${executionId}&select=status,output_data,error_details&limit=1`;
    const execRes = await fetch(execUrl, { headers, signal: AbortSignal.timeout(8000) });
    if (!execRes.ok) throw new Error(`Erro no Supabase: ${execRes.status}`);
    const execData = await execRes.json();
    const execution = execData?.[0] || null;
    let call = null;

    if (execution?.status === 'SUCCESS' && execution.output_data?.call_id) {
      const callId = execution.output_data.call_id;
      const callUrl = `${supabaseUrl}/rest/v1/Retell_calls_Mindflow?call_id=eq.${callId}&select=status,disconnection_reason,Duracao,Nome,created_at&limit=1`;
      const callRes = await fetch(callUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (callRes.ok) {
        const callData = await callRes.json();
        call = callData?.[0] || null;
      }
    }

    return res.json({ execution, call });
  } catch (error) {
    console.error('[BFF] Erro ao buscar status da ligação:', error.message);
    return res.status(500).json({ error: 'Erro ao buscar status.' });
  }
});

// ============================================================
// API: CHAMADAS E ESTATÍSTICAS
// ============================================================
app.get('/api/calls', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase
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

app.get('/api/stats', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { count, error: countError } = await supabase
      .from('Retell_calls_Mindflow')
      .select('*', { count: 'exact', head: true });

    const { data: recent, error: recentError } = await supabase
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

/** Cache em memória para dados processados (evita N chamadas concorrentes ao Supabase) */
let callsCache = { data: null, timestamp: 0 };
const CACHE_TTL = 30_000; // 30 segundos

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

/** Busca e processa todas as calls do Supabase com cache */
async function fetchProcessedCalls(agent, startDate, endDate) {
  const now = Date.now();

  // Refresh cache se expirou
  if (!callsCache.data || now - callsCache.timestamp > CACHE_TTL) {
    console.log('[Cache] Atualizando cache de calls do Supabase...');

    // Usar paginação para não sobrecarregar
    let allData = [];
    let start = 0;
    const batchSize = 5000;

    while (true) {
      const { data, error } = await supabase
        .from('Retell_calls_Mindflow')
        .select('call_id,to_number,Nome,Email,agent_name,created_at,recording_url,combined_cost,Duracao,disconnection_reason')
        .range(start, start + batchSize - 1)
        .order('created_at', { ascending: true });

      if (error || !data || data.length === 0) break;
      allData = allData.concat(data);
      if (data.length < batchSize) break;
      start += batchSize;
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

    callsCache.data = calls;
    callsCache.timestamp = now;
    console.log(`[Cache] Cache atualizado: ${calls.length} calls processadas`);
  }

  // Aplicar filtros em cima do cache
  let filtered = callsCache.data;

  if (agent) {
    filtered = filtered.filter(c => c.agent_name === agent);
  }
  if (startDate) {
    const startMs = new Date(startDate + 'T00:00:00').getTime();
    filtered = filtered.filter(c => c.created_at >= startMs);
  }
  if (endDate) {
    const endMs = new Date(endDate + 'T23:59:59').getTime();
    filtered = filtered.filter(c => c.created_at <= endMs);
  }

  return filtered;
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

app.get('/metrics', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const calls = await fetchProcessedCalls(req.query.agent, req.query.start_date, req.query.end_date);
    if (!calls.length) {
      return res.json({
        total_calls: 0, unique_leads: 0, total_hooks: 0, total_conversas: 0, total_interesse: 0,
        total_cost: 0, avg_ligacoes_por_lead: 0, custo_por_lead: 0, custo_por_interesse: 0,
        taxa_interesse_por_lead: 0, avg_density: 0, avg_pressure: 0
      });
    }
    const totalCalls = calls.length;
    const uniqueLeads = new Set(calls.map(c => c.to_number)).size;
    const totalHooks = calls.filter(c => c.is_hook).length;
    const totalConversas = calls.filter(c => c.is_conversa).length;
    const totalInteresse = calls.filter(c => c.is_interesse).length;
    const totalCost = calls.reduce((s, c) => s + c.combined_cost, 0);
    const avgDensity = calls.reduce((s, c) => s + c.densidade_tentativas, 0) / totalCalls;
    const avgPressure = calls.reduce((s, c) => s + c.pressao_recente, 0) / totalCalls;

    res.json({
      total_calls: totalCalls,
      unique_leads: uniqueLeads,
      total_hooks: totalHooks,
      total_conversas: totalConversas,
      total_interesse: totalInteresse,
      total_cost: Math.round(totalCost * 100) / 100,
      avg_ligacoes_por_lead: Math.round((totalCalls / uniqueLeads) * 100) / 100,
      custo_por_lead: Math.round((totalCost / uniqueLeads) * 100) / 100,
      custo_por_interesse: totalInteresse > 0 ? Math.round((totalCost / totalInteresse) * 100) / 100 : 0,
      taxa_interesse_por_lead: Math.round((totalInteresse / uniqueLeads) * 10000) / 100,
      avg_density: Math.round(avgDensity * 1000) / 1000,
      avg_pressure: Math.round(avgPressure * 1000) / 1000,
    });
  } catch (err) {
    console.error('[Dashboard] Erro em /metrics:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/funnel', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const calls = await fetchProcessedCalls(req.query.agent, req.query.start_date, req.query.end_date);
    if (!calls.length) {
      return res.json({ leads_totais: 0, leads_iniciados: 0, hook_15s: 0, conversa_45s: 0, interesse_90s: 0, total_calls_volume: 0 });
    }

    const leadsByNumber = new Map();
    calls.forEach(c => {
      if (!leadsByNumber.has(c.to_number)) leadsByNumber.set(c.to_number, []);
      leadsByNumber.get(c.to_number).push(c);
    });

    const leadsTotais = leadsByNumber.size;
    let hook15s = 0, conversa45s = 0, interesse90s = 0;

    leadsByNumber.forEach(leadCalls => {
      if (leadCalls.some(c => c.is_hook)) hook15s++;
      if (leadCalls.some(c => c.is_conversa)) conversa45s++;
      if (leadCalls.some(c => c.is_interesse)) interesse90s++;
    });

    res.json({
      leads_totais: leadsTotais,
      leads_iniciados: leadsTotais,
      hook_15s: hook15s,
      conversa_45s: conversa45s,
      interesse_90s: interesse90s,
      total_calls_volume: calls.length,
    });
  } catch (err) {
    console.error('[Dashboard] Erro em /funnel:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/disconnections', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const calls = await fetchProcessedCalls(req.query.agent, req.query.start_date, req.query.end_date);
    const isDetailed = req.query.detailed === 'true';

    if (isDetailed) {
      const groups = new Map();
      calls.forEach(c => {
        const key = c.disconnection_reason || 'Não informado / Normal';
        if (!groups.has(key)) groups.set(key, { reason: key, category: c.disconnection_category, count: 0 });
        groups.get(key).count++;
      });
      const data = Array.from(groups.values()).sort((a, b) => b.count - a.count);
      const total = data.reduce((s, d) => s + d.count, 0);
      res.json(data.map(d => ({ ...d, percentage: Math.round((d.count / total) * 10000) / 100 })));
    } else {
      const groups = new Map();
      calls.forEach(c => {
        const cat = c.disconnection_category;
        if (!groups.has(cat)) groups.set(cat, { disconnection_category: cat, count: 0 });
        groups.get(cat).count++;
      });
      const data = Array.from(groups.values()).sort((a, b) => b.count - a.count);
      const total = data.reduce((s, d) => s + d.count, 0);
      res.json(data.map(d => ({ category: d.disconnection_category, count: d.count, percentage: Math.round((d.count / total) * 10000) / 100 })));
    }
  } catch (err) {
    console.error('[Dashboard] Erro em /disconnections:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/hours', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const calls = await fetchProcessedCalls(req.query.agent, req.query.start_date, req.query.end_date);
    const hourMap = new Map();

    calls.forEach(c => {
      const d = new Date(c.created_at);
      const hour = String(d.getHours()).padStart(2, '0');
      if (!hourMap.has(hour)) hourMap.set(hour, { hour: `${hour}:00`, call_count: 0, interest_count: 0 });
      const entry = hourMap.get(hour);
      entry.call_count++;
      if (c.is_interesse) entry.interest_count++;
    });

    const data = Array.from(hourMap.values()).sort((a, b) => a.hour.localeCompare(b.hour));
    data.forEach(d => {
      d.conversion_rate = Math.round((d.interest_count / d.call_count) * 10000) / 100;
    });
    res.json(data);
  } catch (err) {
    console.error('[Dashboard] Erro em /hours:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/fatigue', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const calls = await fetchProcessedCalls(req.query.agent, req.query.start_date, req.query.end_date);

    const buckets = new Map();
    calls.forEach(c => {
      const n = c.n_tentativas_anteriores;
      let label;
      if (n === 0) label = '1ª Ligação';
      else if (n === 1) label = '2ª Ligação';
      else if (n === 2) label = '3ª Ligação';
      else if (n <= 4) label = '4-5 Ligações';
      else if (n <= 9) label = '6-10 Ligações';
      else label = '11+ Ligações';

      if (!buckets.has(label)) buckets.set(label, { attempt_bucket: label, call_count: 0, interest_count: 0, density_sum: 0, pressure_sum: 0, min_order: n });
      const b = buckets.get(label);
      b.call_count++;
      if (c.is_interesse) b.interest_count++;
      b.density_sum += c.densidade_tentativas;
      b.pressure_sum += c.pressao_recente;
      if (n < b.min_order) b.min_order = n;
    });

    const data = Array.from(buckets.values())
      .sort((a, b) => a.min_order - b.min_order)
      .map(b => ({
        attempt_bucket: b.attempt_bucket,
        call_count: b.call_count,
        interest_count: b.interest_count,
        conversion_rate: Math.round((b.interest_count / b.call_count) * 10000) / 100,
        avg_density: Math.round((b.density_sum / b.call_count) * 1000) / 1000,
        avg_pressure: Math.round((b.pressure_sum / b.call_count) * 1000) / 1000,
      }));

    res.json(data);
  } catch (err) {
    console.error('[Dashboard] Erro em /fatigue:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/agents', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data } = await supabase.from('Retell_calls_Mindflow').select('agent_name');
    const agents = [...new Set(data.map(d => d.agent_name).filter(Boolean))].sort();
    res.json(agents);
  } catch (err) {
    console.error('[Dashboard] Erro em /agents:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/calls', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const calls = await fetchProcessedCalls(req.query.agent, req.query.start_date, req.query.end_date);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const minDuration = parseFloat(req.query.min_duration);
    const maxDuration = parseFloat(req.query.max_duration);

    let filtered = [...calls];

    // Filtros de duração
    if (!isNaN(minDuration)) filtered = filtered.filter(c => c.Duracao >= minDuration);
    if (!isNaN(maxDuration)) filtered = filtered.filter(c => c.Duracao <= maxDuration);

    const total = filtered.length;
    const pages = Math.ceil(total / limit) || 1;
    const offset = (page - 1) * limit;
    const data = filtered.slice(offset, offset + limit).map(c => ({
      call_id: c.call_id,
      to_number: c.to_number,
      Nome: c.Nome,
      Email: c.Email,
      agent_name: c.agent_name,
      created_at: new Date(c.created_at).toISOString(),
      recording_url: c.recording_url,
      combined_cost: c.combined_cost,
      Duracao: c.Duracao,
      disconnection_category: c.disconnection_category,
      n_tentativas_anteriores: c.n_tentativas_anteriores,
      densidade_tentativas: c.densidade_tentativas,
      pressao_recente: c.pressao_recente,
    }));

    res.json({ total, page, limit, pages, data });
  } catch (err) {
    console.error('[Dashboard] Erro em /calls:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// API: PLATAFORMAS (protegida)
// ============================================================
app.get('/api/platforms', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json(PLATFORMS);
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
