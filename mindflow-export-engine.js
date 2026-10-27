const ExcelJS = require('exceljs');

/**
 * Tradutor de motivos técnicos da Retell AI para termos comerciais claros
 */
function traduzirMotivo(reason, duracaoSegundos = 0) {
  const r = (reason || '').toLowerCase();
  
  if (r.includes('voicemail')) {
    return {
      motivo: 'Caixa Postal Detectada',
      categoria: 'Não Atendida',
      acao: 'Disparar mensagem no WhatsApp'
    };
  }
  if (r.includes('no_answer') || r.includes('dial_no_answer')) {
    return {
      motivo: 'Não Atendeu (Chamou até desligar)',
      categoria: 'Não Atendida',
      acao: 'Reagendar ligação para outro turno'
    };
  }
  if (r.includes('inactivity')) {
    return {
      motivo: 'Silêncio / Linha Muda',
      categoria: 'Não Atendida',
      acao: 'Verificar qualidade da rota/operadora'
    };
  }
  if (r.includes('invalid_destination') || r.includes('invalid_number')) {
    return {
      motivo: 'Número Inválido / Inexistente',
      categoria: 'Não Atendida',
      acao: 'Higienizar cadastro'
    };
  }
  if (r.includes('error_user_not_joined')) {
    return {
      motivo: 'Não Conectou (Falha na Conexão)',
      categoria: 'Não Atendida',
      acao: 'Reprogramar tentativa de discagem'
    };
  }
  if (r.includes('user_hangup')) {
    if (duracaoSegundos >= 20) {
      return {
        motivo: 'Atendida — Conversa Concluída pelo Lead',
        categoria: 'Atendida',
        acao: 'Verificar transcrição e follow-up'
      };
    } else {
      return {
        motivo: 'Desligou no Início (<20s)',
        categoria: 'Não Atendida',
        acao: 'Otimizar gancho de abertura do agente'
      };
    }
  }
  if (r.includes('agent_hangup')) {
    return {
      motivo: 'Atendida — Encerramento pelo Agente',
      categoria: 'Atendida',
      acao: 'Fluxo concluído pelo robô com sucesso'
    };
  }
  if (r.includes('transfer')) {
    return {
      motivo: 'Atendida — Transferida p/ Humano',
      categoria: 'Atendida',
      acao: 'Lead quente em atendimento direto'
    };
  }
  
  if (duracaoSegundos >= 20) {
    return {
      motivo: 'Atendida — Conversação Efetiva',
      categoria: 'Atendida',
      acao: 'Analisar transcrição da chamada'
    };
  }

  return {
    motivo: 'Tentativa sem Contato Efetivo',
    categoria: 'Não Atendida',
    acao: 'Programar nova tentativa'
  };
}

/**
 * Classificador de Temperatura / Interesse Comercial
 */
function calcularTemperaturaLead(isMarcada, duracaoSeg, reason, summary, transcript) {
  if (isMarcada) {
    return { label: '🔥 Quente (Agendado)', corArgb: 'FF059669', tag: 'Quente' };
  }
  
  const text = (String(summary || '') + ' ' + String(transcript || '')).toLowerCase();
  
  // Se tem indicativo explícito de desinteresse ou recusa
  if (text.includes('sem interesse') || text.includes('desinteresse') || text.includes('não interessado') || 
      text.includes('recusou') || text.includes('não tem interesse') || text.includes('não quer')) {
    return { label: '❄️ Frio (Desinteresse)', corArgb: 'FF64748B', tag: 'Frio' };
  }
  
  // Se tem indicativo positivo de interesse real
  if (text.includes('tem interesse') || text.includes('receptivo') || text.includes('fechar') || 
      text.includes('kit') || text.includes('solicitou retorno') || text.includes('potencial interesse') || 
      text.includes('pediu proposta') || text.includes('proposta')) {
    return { label: '🔥 Quente (Interesse)', corArgb: 'FF0D9488', tag: 'Quente' };
  }
  
  if (duracaoSeg >= 30) {
    return { label: '⚡ Morno (Potencial)', corArgb: 'FFD97706', tag: 'Morno' };
  }
  
  if (duracaoSeg > 0 && duracaoSeg < 30) {
    return { label: '❄️ Frio (Desinteresse)', corArgb: 'FF64748B', tag: 'Frio' };
  }
  
  return { label: '📵 Sem Contato', corArgb: 'FF94A3B8', tag: 'Sem Contato' };
}

function formatarTelefoneExport(num) {
  if (!num) return '-';
  let s = String(num).replace(/\D/g, '');
  if (!s) return '-';
  if (s.startsWith('55') && s.length >= 12) s = s.slice(2);
  if (s.length === 11) {
    return `+55 (${s.slice(0, 2)}) ${s.slice(2, 7)}-${s.slice(7)}`;
  } else if (s.length === 10) {
    return `+55 (${s.slice(0, 2)}) ${s.slice(2, 6)}-${s.slice(6)}`;
  }
  return `+55 ${s}`;
}

function formatarDuracaoExport(segundos) {
  const s = Math.round(Number(segundos) || 0);
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function extrairTurnoExport(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return 'Não especificado';
  const h = dateObj.getHours();
  if (h >= 6 && h < 12) return 'Manhã (08h - 12h)';
  if (h >= 12 && h < 18) return 'Tarde (12h - 18h)';
  return 'Noite (18h - 21h)';
}

function formatarNomeAgenteExport(c, nomeCliente = '') {
  const raw = String(c.agent_name || c.agent_id || 'Agente SDR');
  if (raw.toLowerCase().includes('ricardo gomes') || raw.toLowerCase().includes('ats') || String(nomeCliente).toUpperCase().includes('ATS')) {
    return 'Agente ATS';
  }
  return raw.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || 'Agente SDR';
}

/**
 * Gera a planilha executiva perfeita da MindFlow com auditoria de filtros e isolamento de cliente
 */
async function generateMindFlowExcelBuffer(items, isWhatsApp = false, clientName = 'MINDFLOW', periodText = 'Período Completo', isLimited = false, agentFilter = 'Todos os Agentes') {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MindFlow Platform';
  wb.lastModifiedBy = 'MindFlow Intelligence System';
  wb.created = new Date();
  wb.modified = new Date();

  // -------------------------------------------------------------------------
  // ABA 1: RESUMO EXECUTIVO (DASHBOARD & KPIs)
  // -------------------------------------------------------------------------
  const wsResumo = wb.addWorksheet('📊 Painel Executivo', {
    views: [{ showGridLines: true }]
  });

  wsResumo.columns = [
    { width: 4 },   // A - Margem esquerda
    { width: 30 },  // B - Card 1 / Col 1
    { width: 30 },  // C - Card 2 / Col 2
    { width: 30 },  // D - Card 3 / Col 3
    { width: 38 },  // E - Card 4 / Col 4
    { width: 4 }    // F - Margem direita
  ];

  // 1. BANNER INSTITUCIONAL DE CABEÇALHO (Linha 2)
  wsResumo.mergeCells('B2:E2');
  const hCell = wsResumo.getCell('B2');
  hCell.value = `RELATÓRIO EXECUTIVO DE OPERAÇÕES DE VOZ — ${clientName.toUpperCase()}`;
  hCell.font = { name: 'Segoe UI', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  hCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } }; // Midnight Navy
  hCell.alignment = { vertical: 'middle', horizontal: 'center' };
  wsResumo.getRow(2).height = 38;

  // 2. BLOCO DE AUDITORIA DE FILTROS & SEGURANÇA (Linhas 3 e 4)
  const agora = new Date();
  const dataExtracao = agora.toLocaleDateString('pt-BR') + ' às ' + agora.toLocaleTimeString('pt-BR').slice(0, 5);

  wsResumo.mergeCells('B3:E3');
  const fCell = wsResumo.getCell('B3');
  fCell.value = `🔒 CONTA: ${clientName.toUpperCase()}   |   📅 PERÍODO FILTRADO: ${periodText.toUpperCase()}   |   🤖 AGENTE: ${agentFilter.toUpperCase()}`;
  fCell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF00B5A0' } }; // Teal Destaque
  fCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  fCell.alignment = { vertical: 'middle', horizontal: 'center' };
  wsResumo.getRow(3).height = 24;

  wsResumo.mergeCells('B4:E4');
  const subCell = wsResumo.getCell('B4');
  subCell.value = `Documento emitido automaticamente pelo MindFlow Intelligence Hub em ${dataExtracao} • Uso restrito ao cliente.`;
  subCell.font = { name: 'Segoe UI', size: 8.5, italic: true, color: { argb: 'FF94A3B8' } };
  subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  subCell.alignment = { vertical: 'middle', horizontal: 'center' };
  wsResumo.getRow(4).height = 18;

  // 3. PROCESSAMENTO E CÁLCULO DE DADOS
  const totalRegistros = items.length;
  const leadsSet = new Set();
  let totalDuracaoSegundos = 0;
  let totalAtendidas = 0;
  let totalNaoAtendidas = 0;
  let totalReunioes = 0;
  let leadsQualificados = 0;

  const motivosMap = {};
  const agentesMap = {};
  const turnosMap = {
    'Manhã (08h - 12h)': { total: 0, atendidas: 0 },
    'Tarde (12h - 18h)': { total: 0, atendidas: 0 },
    'Noite (18h - 21h)': { total: 0, atendidas: 0 },
    'Não especificado': { total: 0, atendidas: 0 }
  };

  items.forEach(c => {
    // Identificação de Lead Único (Prioriza Telefone, Email, Nome, ID)
    const rawPhone = c.Numero || c.numero || c.lead_phone || c.from_number || c.to_number || c.phone;
    const leadKey = rawPhone || c.Email || c.email || c.Nome || c.nome || c.id || c.call_id;
    if (leadKey) leadsSet.add(String(leadKey).trim().toLowerCase());

    // Duração (ms -> seg)
    const rawDur = Number(c.Duracao || c.duracao || c.duration || c.duration_seconds || 0);
    const durSec = rawDur > 1000 ? Math.round(rawDur / 1000) : Math.round(rawDur);
    totalDuracaoSegundos += durSec;

    // Tradução e Categorização
    const rawReason = c.disconnection_reason || c.motivo || '';
    const trad = traduzirMotivo(rawReason, durSec);

    if (trad.categoria === 'Atendida') {
      totalAtendidas++;
    } else {
      totalNaoAtendidas++;
    }

    const isMarcada = c.Marcada === true || c.marcada === true || c.reuniao_marcada === true || 
                      (c.status && String(c.status).toLowerCase().includes('agendad'));
    if (isMarcada) totalReunioes++;

    // Temperatura
    const temp = calcularTemperaturaLead(isMarcada, durSec, rawReason, c.call_summary, c.transcript);
    if (temp.tag === 'Quente' || temp.tag === 'Morno') leadsQualificados++;

    // Turno
    let d = null;
    if (c.created_at || c.start_timestamp) {
      d = new Date(c.created_at || c.start_timestamp);
    }
    const turno = extrairTurnoExport(d);
    if (!turnosMap[turno]) turnosMap[turno] = { total: 0, atendidas: 0 };
    turnosMap[turno].total++;
    if (trad.categoria === 'Atendida') turnosMap[turno].atendidas++;

    // Motivos
    if (!motivosMap[trad.motivo]) {
      motivosMap[trad.motivo] = {
        motivo: trad.motivo,
        categoria: trad.categoria,
        acao: trad.acao,
        quantidade: 0
      };
    }
    motivosMap[trad.motivo].quantidade++;

    // Agrupamento estrito por agent_id para NUNCA duplicar o mesmo agente
    const cleanAgentName = formatarNomeAgenteExport(c, clientName);
    const agentKey = c.agent_id || cleanAgentName;
    if (!agentesMap[agentKey]) {
      agentesMap[agentKey] = {
        nome: cleanAgentName,
        total: 0,
        atendidas: 0,
        duracaoSeg: 0,
        reunioes: 0
      };
    }
    agentesMap[agentKey].total++;
    if (trad.categoria === 'Atendida') {
      agentesMap[agentKey].atendidas++;
      agentesMap[agentKey].duracaoSeg += durSec;
    }
    if (isMarcada) agentesMap[agentKey].reunioes++;
  });

  const leadsUnicos = leadsSet.size || totalRegistros;
  const taxaAtendimento = totalRegistros > 0 ? (totalAtendidas / totalRegistros) : 0;
  const tmaMedio = totalAtendidas > 0 ? Math.round(totalDuracaoSegundos / totalAtendidas) : 0;

  const horasTotais = Math.floor(totalDuracaoSegundos / 3600);
  const minTotais = Math.floor((totalDuracaoSegundos % 3600) / 60);
  const segRestantes = totalDuracaoSegundos % 60;
  const tempoTotalFormatado = horasTotais > 0 
    ? `${horasTotais}h ${minTotais}m` 
    : `${minTotais}m ${segRestantes}s`;

  // 4. RENDERIZADOR DE CARDS EXECUTIVOS
  function desenharCard(col, titleRow, valRow, titulo, valor, corPrimaria = 'FF0F172A', format = null) {
    const tCell = wsResumo.getCell(`${col}${titleRow}`);
    tCell.value = titulo.toUpperCase();
    tCell.font = { name: 'Segoe UI', size: 8, bold: true, color: { argb: 'FF64748B' } };
    tCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    tCell.alignment = { vertical: 'middle', horizontal: 'center' };
    tCell.border = {
      top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
    };

    const vCell = wsResumo.getCell(`${col}${valRow}`);
    vCell.value = valor;
    vCell.font = { name: 'Segoe UI', size: 15, bold: true, color: { argb: corPrimaria } };
    vCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    vCell.alignment = { vertical: 'middle', horizontal: 'center' };
    vCell.border = {
      bottom: { style: 'medium', color: { argb: corPrimaria } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
    };

    if (format) vCell.numFmt = format;
  }

  // Bloco 1 de KPIs (Linhas 6 e 7)
  wsResumo.getRow(6).height = 19;
  wsResumo.getRow(7).height = 30;
  desenharCard('B', 6, 7, '1. Total de Disparos', totalRegistros, 'FF0F172A');
  desenharCard('C', 6, 7, '2. Ligações Atendidas', totalAtendidas, 'FF10B981'); // Verde
  desenharCard('D', 6, 7, '3. Não Atendidas / Caixa', totalNaoAtendidas, 'FFEF4444'); // Coral
  desenharCard('E', 6, 7, '4. Leads Únicos Contatados', leadsUnicos, 'FF2563EB'); // Azul

  // Bloco 2 de KPIs (Linhas 9 e 10)
  wsResumo.getRow(9).height = 19;
  wsResumo.getRow(10).height = 30;
  desenharCard('B', 9, 10, 'Taxa de Atendimento (%)', taxaAtendimento, 'FF10B981', '0.0%');
  desenharCard('C', 9, 10, '5. Tempo Total Falado', tempoTotalFormatado, 'FF0F172A');
  desenharCard('D', 9, 10, 'TMA Médio (Atendidas)', `${Math.floor(tmaMedio/60)}m ${tmaMedio%60}s`, 'FF7C3AED'); // Roxo
  desenharCard('E', 9, 10, 'Leads Qualificados (Interesse)', leadsQualificados, 'FF0D9488'); // Teal

  // 5. TABELA 1: DETALHAMENTO DO STATUS DAS CHAMADAS (MOTIVOS EM PORTUGUÊS)
  wsResumo.mergeCells('B13:E13');
  const tableTitle = wsResumo.getCell('B13');
  tableTitle.value = 'DETALHAMENTO DO STATUS DAS CHAMADAS (VISÃO COMERCIAL & OPERACIONAL)';
  tableTitle.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FF0F172A' } };
  tableTitle.alignment = { vertical: 'bottom', horizontal: 'left' };
  wsResumo.getRow(13).height = 26;

  const headersT1 = ['Status Comercial da Ligação', 'Categoria', 'Quantidade', '% do Total'];
  wsResumo.getRow(14).values = ['', ...headersT1];
  wsResumo.getRow(14).height = 24;
  ['B', 'C', 'D', 'E'].forEach((col, idx) => {
    const c = wsResumo.getCell(`${col}14`);
    c.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B5A0' } }; // Teal Mindflow
    c.alignment = { vertical: 'middle', horizontal: idx === 0 ? 'left' : 'center' };
    c.border = { bottom: { style: 'medium', color: { argb: 'FF0D9488' } } };
  });

  let curRow = 15;
  const listaMotivos = Object.values(motivosMap).sort((a, b) => b.quantidade - a.quantidade);

  listaMotivos.forEach((m, idx) => {
    const pct = totalRegistros > 0 ? (m.quantidade / totalRegistros) : 0;
    const r = wsResumo.getRow(curRow);
    r.values = ['', m.motivo, m.categoria, m.quantidade, pct];
    r.height = 21;

    const bg = idx % 2 === 0 ? 'FFF8FAFC' : 'FFFFFFFF';

    ['B', 'C', 'D', 'E'].forEach((col, colIdx) => {
      const cell = wsResumo.getCell(`${col}${curRow}`);
      cell.font = { name: 'Segoe UI', size: 9, color: { argb: 'FF334155' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      cell.alignment = { vertical: 'middle', horizontal: colIdx === 0 ? 'left' : 'center' };
      
      if (colIdx === 1) {
        cell.font = { 
          name: 'Segoe UI', 
          size: 9, 
          bold: true, 
          color: { argb: m.categoria === 'Atendida' ? 'FF10B981' : 'FFEF4444' } 
        };
      }
      if (colIdx === 2) {
        cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FF0F172A' } };
      }
      if (colIdx === 3) {
        cell.numFmt = '0.0%';
      }
    });

    curRow++;
  });

  // Linha de Totalização da Tabela 1
  const totalRowT1 = wsResumo.getRow(curRow);
  totalRowT1.values = ['', 'TOTAL DE CHAMADAS NO PERÍODO', '-', totalRegistros, 1.0];
  totalRowT1.height = 22;
  ['B', 'C', 'D', 'E'].forEach((col, colIdx) => {
    const cell = wsResumo.getCell(`${col}${curRow}`);
    cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FF0F172A' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    cell.border = { 
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'medium', color: { argb: 'FF0F172A' } }
    };
    cell.alignment = { vertical: 'middle', horizontal: colIdx === 0 ? 'left' : 'center' };
    if (colIdx === 3) cell.numFmt = '0.0%';
  });

  // 6. TABELA 2: INTELIGÊNCIA DE HORÁRIOS (MELHOR TURNO DE CONTATO)
  curRow += 3;
  wsResumo.mergeCells(`B${curRow}:E${curRow}`);
  const tTurnoTitle = wsResumo.getCell(`B${curRow}`);
  tTurnoTitle.value = 'EFICIÊNCIA DE CONTATO POR TURNO DO DIA (MELHOR HORÁRIO PARA DISPARO)';
  tTurnoTitle.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FF0F172A' } };
  tTurnoTitle.alignment = { vertical: 'middle', horizontal: 'left' };
  wsResumo.getRow(curRow).height = 26;

  curRow++;
  const headersTurno = ['Turno do Dia', 'Disparos', 'Atendidas', 'Taxa de Atendimento'];
  wsResumo.getRow(curRow).values = ['', ...headersTurno];
  wsResumo.getRow(curRow).height = 24;
  ['B', 'C', 'D', 'E'].forEach((col, idx) => {
    const c = wsResumo.getCell(`${col}${curRow}`);
    c.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; // Slate escuro
    c.alignment = { vertical: 'middle', horizontal: idx === 0 ? 'left' : 'center' };
  });

  curRow++;
  const turnosAtivos = Object.entries(turnosMap).filter(([_, data]) => data.total > 0);
  turnosAtivos.forEach(([nomeTurno, data], idx) => {
    const rate = data.total > 0 ? (data.atendidas / data.total) : 0;
    const r = wsResumo.getRow(curRow);
    r.values = ['', nomeTurno, data.total, data.atendidas, rate];
    r.height = 20;

    const bg = idx % 2 === 0 ? 'FFF8FAFC' : 'FFFFFFFF';
    ['B', 'C', 'D', 'E'].forEach((col, colIdx) => {
      const cell = wsResumo.getCell(`${col}${curRow}`);
      cell.font = { name: 'Segoe UI', size: 9, color: { argb: 'FF334155' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      cell.alignment = { vertical: 'middle', horizontal: colIdx === 0 ? 'left' : 'center' };
      if (colIdx === 3) {
        cell.numFmt = '0.0%';
        cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FF10B981' } };
      }
    });
    curRow++;
  });

  // 7. TABELA 3: PERFORMANCE POR AGENTE SDR IA (ISOLADO PARA O CLIENTE)
  curRow += 2;
  wsResumo.mergeCells(`B${curRow}:E${curRow}`);
  const t2Title = wsResumo.getCell(`B${curRow}`);
  t2Title.value = `PERFORMANCE DOS AGENTES SDR IA — ${clientName.toUpperCase()}`;
  t2Title.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FF0F172A' } };
  t2Title.alignment = { vertical: 'middle', horizontal: 'left' };
  wsResumo.getRow(curRow).height = 26;

  curRow++;
  const headersT2 = ['Agente SDR de IA', 'Disparos', 'Atendidas', 'Taxa de Contato'];
  wsResumo.getRow(curRow).values = ['', ...headersT2];
  wsResumo.getRow(curRow).height = 24;
  ['B', 'C', 'D', 'E'].forEach((col, idx) => {
    const c = wsResumo.getCell(`${col}${curRow}`);
    c.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B5A0' } }; // Teal Mindflow
    c.alignment = { vertical: 'middle', horizontal: idx === 0 ? 'left' : 'center' };
  });

  curRow++;
  const listaAgentes = Object.values(agentesMap).sort((a, b) => b.total - a.total);
  listaAgentes.forEach((ag, idx) => {
    const contactRate = ag.total > 0 ? (ag.atendidas / ag.total) : 0;
    const r = wsResumo.getRow(curRow);
    r.values = ['', ag.nome, ag.total, ag.atendidas, contactRate];
    r.height = 20;

    const bg = idx % 2 === 0 ? 'FFF8FAFC' : 'FFFFFFFF';
    ['B', 'C', 'D', 'E'].forEach((col, colIdx) => {
      const cell = wsResumo.getCell(`${col}${curRow}`);
      cell.font = { name: 'Segoe UI', size: 9, color: { argb: 'FF334155' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      cell.alignment = { vertical: 'middle', horizontal: colIdx === 0 ? 'left' : 'center' };
      if (colIdx === 3) cell.numFmt = '0.0%';
    });
    curRow++;
  });

  // 8. QUADRO DE INSIGHTS & RECOMENDAÇÕES DA MINDFLOW
  curRow += 2;
  wsResumo.mergeCells(`B${curRow}:E${curRow}`);
  const insTitle = wsResumo.getCell(`B${curRow}`);
  insTitle.value = `💡 INSIGHTS ESTRATÉGICOS & RECOMENDAÇÕES — ${clientName.toUpperCase()}`;
  insTitle.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF0D9488' } };
  insTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDFA' } };
  insTitle.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  insTitle.border = {
    top: { style: 'thin', color: { argb: 'FF99F6E4' } },
    left: { style: 'medium', color: { argb: 'FF0D9488' } },
    right: { style: 'thin', color: { argb: 'FF99F6E4' } }
  };
  wsResumo.getRow(curRow).height = 25;

  const topMotivoPerda = listaMotivos.find(m => m.categoria === 'Não Atendida') || { motivo: 'Tentativas sem resposta', quantidade: 0 };
  const pctPerda = totalRegistros > 0 ? ((topMotivoPerda.quantidade / totalRegistros) * 100).toFixed(1) : 0;

  curRow++;
  wsResumo.mergeCells(`B${curRow}:E${curRow}`);
  const insText = wsResumo.getCell(`B${curRow}`);
  insText.value = `• Principal ponto de atenção no período (${periodText}): "${topMotivoPerda.motivo}" representou ${pctPerda}% das discagens.`;
  insText.font = { name: 'Segoe UI', size: 9, color: { argb: 'FF334155' } };
  insText.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDFA' } };
  insText.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  insText.border = { left: { style: 'medium', color: { argb: 'FF0D9488' } }, right: { style: 'thin', color: { argb: 'FF99F6E4' } } };
  wsResumo.getRow(curRow).height = 20;

  curRow++;
  wsResumo.mergeCells(`B${curRow}:E${curRow}`);
  const insText2 = wsResumo.getCell(`B${curRow}`);
  insText2.value = `• Ação Recomendada: Ativar follow-up automático via WhatsApp para contatos não atendidos para recuperar leads sem custo adicional de discagem.`;
  insText2.font = { name: 'Segoe UI', size: 9, color: { argb: 'FF334155' } };
  insText2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDFA' } };
  insText2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  insText2.border = {
    bottom: { style: 'thin', color: { argb: 'FF99F6E4' } },
    left: { style: 'medium', color: { argb: 'FF0D9488' } },
    right: { style: 'thin', color: { argb: 'FF99F6E4' } }
  };
  wsResumo.getRow(curRow).height = 20;

  // -------------------------------------------------------------------------
  // ABA 2: BASE COMPLETA DE LIGAÇÕES (DETALHADA COM RESUMO & ÁUDIO)
  // -------------------------------------------------------------------------
  const wsBase = wb.addWorksheet('📋 Base de Ligações', {
    views: [
      { state: 'frozen', ySplit: 3, showGridLines: true } // Congela cabeçalho
    ]
  });

  wsBase.columns = [
    { header: 'Data/Hora', key: 'data_hora', width: 17 },
    { header: 'Lead / Contato', key: 'lead_nome', width: 24 },
    { header: 'Telefone', key: 'telefone', width: 19 },
    { header: 'E-mail', key: 'email', width: 26 },
    { header: 'Status Comercial', key: 'status_comercial', width: 32 },
    { header: 'Interesse / Temperatura', key: 'temperatura', width: 22 },
    { header: 'Duração', key: 'duracao', width: 11 },
    { header: 'Agente SDR IA', key: 'agente', width: 22 },
    { header: 'Resumo da IA / Próximo Passo', key: 'resumo_ia', width: 50 },
    { header: 'Reunião Marcada?', key: 'reuniao', width: 17 },
    { header: 'Gravação (Áudio)', key: 'gravacao', width: 18 }
  ];

  // Banner Aba 2
  wsBase.spliceRows(1, 0, []);
  wsBase.spliceRows(1, 0, []);
  wsBase.mergeCells('A1:K1');
  const bTitle = wsBase.getCell('A1');
  bTitle.value = `REGISTRO DETALHADO — ${clientName.toUpperCase()} | PERÍODO: ${periodText.toUpperCase()} (${items.length} REGISTROS)`;
  bTitle.font = { name: 'Segoe UI', size: 11.5, bold: true, color: { argb: 'FFFFFFFF' } };
  bTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  bTitle.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  wsBase.getRow(1).height = 32;

  // Header Linha 3
  const headerRow = wsBase.getRow(3);
  headerRow.height = 25;
  headerRow.eachCell(cell => {
    cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B5A0' } }; // Teal Mindflow
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF0D9488' } } };
  });

  // Linhas de dados
  items.forEach((c, idx) => {
    const rowIdx = 4 + idx;
    const rawDur = Number(c.Duracao || c.duracao || c.duration || c.duration_seconds || 0);
    const durSec = rawDur > 1000 ? Math.round(rawDur / 1000) : Math.round(rawDur);

    const trad = traduzirMotivo(c.disconnection_reason || c.motivo, durSec);
    const tel = formatarTelefoneExport(c.Numero || c.numero || c.lead_phone || c.from_number || c.to_number);
    const emailStr = c.Email || c.email || '-';
    const isReuniao = c.Marcada === true || c.marcada === true || (c.status && String(c.status).toLowerCase().includes('agendad'));

    const temp = calcularTemperaturaLead(isReuniao, durSec, c.disconnection_reason || c.motivo, c.call_summary, c.transcript);

    let dtStr = '-';
    if (c.created_at || c.start_timestamp) {
      const d = new Date(c.created_at || c.start_timestamp);
      if (!isNaN(d.getTime())) {
        dtStr = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR').slice(0, 5);
      }
    }

    const recUrl = c.recording_url || '';
    
    // Resumo
    let resumoDisplay = c.call_summary || '';
    if (!resumoDisplay && c.transcript) {
      resumoDisplay = String(c.transcript).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250);
    }
    if (!resumoDisplay) {
      resumoDisplay = trad.categoria === 'Não Atendida' ? 'Sem conversa registrada (Não atendeu)' : '-';
    }

    const agentDisplay = formatarNomeAgenteExport(c, clientName);

    const r = wsBase.getRow(rowIdx);
    r.values = [
      dtStr,
      c.Nome || c.nome || c.lead_name || 'Contato',
      tel,
      emailStr,
      trad.motivo,
      temp.label,
      formatarDuracaoExport(durSec),
      agentDisplay,
      resumoDisplay,
      isReuniao ? 'SIM' : 'NÃO',
      recUrl ? { text: 'Ouvir Áudio 🎧', hyperlink: recUrl } : '-'
    ];
    r.height = 21;

    const bg = idx % 2 === 0 ? 'FFF8FAFC' : 'FFFFFFFF';
    r.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.font = { name: 'Segoe UI', size: 9, color: { argb: 'FF334155' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };

      // Alinhamento
      if ([1, 3, 7, 10, 11].includes(colNum)) {
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      } else {
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
      }

      // Temperatura / Interesse (Coluna 6)
      if (colNum === 6) {
        cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: temp.corArgb } };
      }

      // Reunião Marcada (Coluna 10)
      if (colNum === 10 && isReuniao) {
        cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FF10B981' } };
      }

      // Link de gravação (Coluna 11)
      if (colNum === 11 && recUrl) {
        cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: 'FF2563EB' }, underline: true };
      }
    });
  });

  // AutoFilter nas 11 colunas
  wsBase.autoFilter = {
    from: { row: 3, column: 1 },
    to: { row: 3 + items.length, column: 11 }
  };

  return await wb.xlsx.writeBuffer();
}

/**
 * Gera arquivo CSV compatível com Excel pt-BR (UTF-8 com BOM e separador ;)
 */
function generateMindFlowCsvBuffer(items, isWhatsApp = false, clientName = 'MINDFLOW', periodText = 'Período Completo', isLimited = false, agentFilter = 'Todos os Agentes') {
  const headers = [
    'Data/Hora',
    'Lead / Contato',
    'Telefone',
    'E-mail',
    'Status Comercial',
    'Interesse / Temperatura',
    'Duração',
    'Agente SDR IA',
    'Resumo da IA / Próximo Passo',
    'Reunião Marcada?',
    'Gravação (Áudio)'
  ];

  const headerRow = headers.map(h => `"${h}"`).join(';');
  const rows = items.map(c => {
    const rawDur = Number(c.Duracao || c.duracao || c.duration || c.duration_seconds || 0);
    const durSec = rawDur > 1000 ? Math.round(rawDur / 1000) : Math.round(rawDur);
    const trad = traduzirMotivo(c.disconnection_reason || c.motivo, durSec);
    const tel = formatarTelefoneExport(c.Numero || c.numero || c.lead_phone || c.from_number || c.to_number);
    const emailStr = c.Email || c.email || '-';
    const isReuniao = c.Marcada === true || c.marcada === true || (c.status && String(c.status).toLowerCase().includes('agendad'));
    const temp = calcularTemperaturaLead(isReuniao, durSec, c.disconnection_reason || c.motivo, c.call_summary, c.transcript);

    let dtStr = '-';
    if (c.created_at || c.start_timestamp) {
      const d = new Date(c.created_at || c.start_timestamp);
      if (!isNaN(d.getTime())) {
        dtStr = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR').slice(0, 5);
      }
    }

    let resumoDisplay = c.call_summary || '';
    if (!resumoDisplay && c.transcript) {
      resumoDisplay = String(c.transcript).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250);
    }
    if (!resumoDisplay) {
      resumoDisplay = trad.categoria === 'Não Atendida' ? 'Sem conversa registrada (Não atendeu)' : '-';
    }

    const agentDisplay = formatarNomeAgenteExport(c, clientName);
    const recUrl = c.recording_url || '-';

    const cols = [
      dtStr,
      c.Nome || c.nome || c.lead_name || 'Contato',
      tel,
      emailStr,
      trad.motivo,
      temp.label,
      formatarDuracaoExport(durSec),
      agentDisplay,
      resumoDisplay,
      isReuniao ? 'SIM' : 'NÃO',
      recUrl
    ];

    return cols.map(v => `"${String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`).join(';');
  });

  const bom = '\uFEFF';
  return Buffer.from(bom + headerRow + '\n' + rows.join('\n'), 'utf8');
}

module.exports = {
  traduzirMotivo,
  calcularTemperaturaLead,
  formatarTelefoneExport,
  formatarDuracaoExport,
  extrairTurnoExport,
  formatarNomeAgenteExport,
  generateMindFlowExcelBuffer,
  generateMindFlowCsvBuffer
};
