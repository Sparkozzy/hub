const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

async function buildExecutiveExcel(calls, clientName = 'MINDFLOW') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'MindFlow Platform';
    wb.lastModifiedBy = 'MindFlow Platform';
    wb.created = new Date();

    // ---------------------------------------------------------
    // SHEET 1: RESUMO EXECUTIVO
    // ---------------------------------------------------------
    const ws1 = wb.addWorksheet('Resumo Executivo', {
        views: [{ showGridLines: true }]
    });

    // Setup columns for Sheet 1
    ws1.columns = [
        { width: 32 },
        { width: 16 },
        { width: 32 },
        { width: 16 },
        { width: 32 },
        { width: 16 }
    ];

    // Row 1: Title
    ws1.mergeCells('A1:F1');
    const titleCell1 = ws1.getCell('A1');
    titleCell1.value = `DASHBOARD EXECUTIVO - OPERAÇÃO ${clientName.toUpperCase()}`;
    titleCell1.font = { name: 'Century Gothic', size: 14, bold: true, color: { argb: 'FF00B5A0' } };
    titleCell1.alignment = { vertical: 'middle', horizontal: 'left' };
    ws1.getRow(1).height = 30;

    // Metrics calculation
    const totalCalls = calls.length;
    const uniquePhones = new Set(calls.map(c => c.lead_phone || c.from_number || c.to_number || c.numero)).size;
    
    let highCalls = 0;
    let medCalls = 0;
    let lowCalls = 0;
    const reasonCounts = {};

    calls.forEach(c => {
        const dur = c.duration || c.duration_seconds || c.call_length_seconds || 0;
        const reason = c.disconnection_reason || 'Concluída';
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;

        if (dur >= 45) highCalls++;
        else if (dur >= 15) medCalls++;
        else lowCalls++;
    });

    const conversionRate = totalCalls > 0 ? (highCalls + medCalls) / totalCalls : 0;
    const estimatedValue = (highCalls * 2500) + (medCalls * 500);

    // KPI Cards Block 1
    ws1.getRow(3).values = ['TOTAL DE LIGAÇÕES', '', 'LEADS ÚNICOS', '', 'VOLUME COMERCIAL ESTIMADO', ''];
    ws1.getRow(4).values = [totalCalls, '', uniquePhones, '', estimatedValue, ''];

    // KPI Cards Block 2
    ws1.getRow(5).values = ['LIGAÇÕES ALTAS (SUCESSO)', '', 'LIGAÇÕES MÉDIAS', '', 'TAXA DE CONVERSÃO ÚTIL', ''];
    ws1.getRow(6).values = [highCalls, '', medCalls, '', conversionRate, ''];

    // Style KPI Cards
    const kpiTitleRows = [3, 5];
    kpiTitleRows.forEach(r => {
        const row = ws1.getRow(r);
        row.height = 20;
        ['A', 'C', 'E'].forEach(col => {
            const cell = ws1.getCell(`${col}${r}`);
            cell.font = { name: 'Century Gothic', size: 9, bold: true, color: { argb: 'FF64748B' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
    });

    const kpiValRows = [4, 6];
    kpiValRows.forEach(r => {
        const row = ws1.getRow(r);
        row.height = 26;
        ['A', 'C', 'E'].forEach(col => {
            const cell = ws1.getCell(`${col}${r}`);
            cell.font = { name: 'Century Gothic', size: 14, bold: true, color: { argb: 'FF0F172A' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = {
                bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
            };
        });
    });

    ws1.getCell('E4').numFmt = '"R$ "#,##0';
    ws1.getCell('E6').numFmt = '0.0%';

    // Breakdown Title
    ws1.getRow(8).values = ['Detalhamento do Status das Chamadas (Motivos)'];
    ws1.getCell('A8').font = { name: 'Century Gothic', size: 11, bold: true, color: { argb: 'FF1E293B' } };

    // Breakdown Header
    ws1.getRow(9).values = ['Motivo de Desconexão', 'Quantidade', 'Percentual'];
    const bHeaderRow = ws1.getRow(9);
    bHeaderRow.height = 22;
    ['A', 'B', 'C'].forEach(col => {
        const cell = ws1.getCell(`${col}9`);
        cell.font = { name: 'Century Gothic', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B5A0' } };
        cell.alignment = { vertical: 'middle', horizontal: col === 'A' ? 'left' : 'center' };
    });

    // Breakdown Rows
    let currentRow = 10;
    Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).forEach(([reason, count]) => {
        const pct = totalCalls > 0 ? count / totalCalls : 0;
        const row = ws1.getRow(currentRow);
        row.values = [reason, count, pct];
        row.height = 20;

        const isEven = currentRow % 2 === 0;
        const bg = isEven ? 'FFF8FAFC' : 'FFFFFFFF';

        ws1.getCell(`A${currentRow}`).alignment = { vertical: 'middle', horizontal: 'left' };
        ws1.getCell(`B${currentRow}`).alignment = { vertical: 'middle', horizontal: 'center' };
        ws1.getCell(`C${currentRow}`).alignment = { vertical: 'middle', horizontal: 'center' };
        ws1.getCell(`C${currentRow}`).numFmt = '0.0%';

        ['A', 'B', 'C'].forEach(col => {
            const cell = ws1.getCell(`${col}${currentRow}`);
            cell.font = { name: 'Century Gothic', size: 9 };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        });

        currentRow++;
    });

    // ---------------------------------------------------------
    // SHEET 2: BASE DE LIGAÇÕES
    // ---------------------------------------------------------
    const ws2 = wb.addWorksheet('Base de Ligações', {
        views: [{ showGridLines: true }]
    });

    ws2.columns = [
        { header: 'ID Ligação', key: 'id', width: 12 },
        { header: 'Cliente', key: 'lead_name', width: 22 },
        { header: 'Telefone', key: 'phone', width: 20 },
        { header: 'Data/Hora', key: 'date', width: 18 },
        { header: 'Duração', key: 'duration', width: 12 },
        { header: 'Nome Agente', key: 'agent', width: 24 },
        { header: 'Motivo Desconexão', key: 'reason', width: 22 },
        { header: 'Nível Interesse', key: 'interest', width: 16 },
        { header: 'Valor Estimado', key: 'value', width: 16 },
        { header: 'Prioridade', key: 'priority', width: 16 },
        { header: 'Transcrição da Ligação', key: 'transcript', width: 50 },
        { header: 'Link Gravação', key: 'recording', width: 40 }
    ];

    // Title Row 1
    ws2.spliceRows(1, 0, []);
    ws2.spliceRows(1, 0, []);
    ws2.spliceRows(1, 0, []);

    ws2.mergeCells('A1:L1');
    const titleCell2 = ws2.getCell('A1');
    titleCell2.value = `RELATÓRIO DE PERFORMANCE DE LIGAÇÕES - ${clientName.toUpperCase()}`;
    titleCell2.font = { name: 'Century Gothic', size: 13, bold: true, color: { argb: 'FF00B5A0' } };
    titleCell2.alignment = { vertical: 'middle', horizontal: 'left' };
    ws2.getRow(1).height = 28;

    // Legend Row 2
    ws2.getRow(2).values = [
        'Legenda de Cores:',
        'Interesse ALTO (Conversa/Interesse +45s)',
        'Interesse MÉDIO (Hook +15s)',
        'Sem Retorno / Baixo (<15s)'
    ];
    ws2.getCell('A2').font = { name: 'Century Gothic', size: 9, bold: true, color: { argb: 'FF64748B' } };
    ws2.getCell('B2').font = { name: 'Century Gothic', size: 9, bold: true, color: { argb: 'FF10B981' } }; // Green
    ws2.getCell('C2').font = { name: 'Century Gothic', size: 9, bold: true, color: { argb: 'FFF59E0B' } }; // Orange
    ws2.getCell('D2').font = { name: 'Century Gothic', size: 9, color: { argb: 'FF94A3B8' } }; // Gray

    // Table Header Row 4
    const headerRow2 = ws2.getRow(4);
    headerRow2.values = [
        'ID Ligação', 'Cliente', 'Telefone', 'Data/Hora', 'Duração',
        'Nome Agente', 'Motivo Desconexão', 'Nível Interesse',
        'Valor Estimado', 'Prioridade', 'Transcrição da Ligação', 'Link Gravação'
    ];
    headerRow2.height = 24;

    ws2.getRow(4).eachCell((cell) => {
        cell.font = { name: 'Century Gothic', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B5A0' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Populate Data Rows
    calls.forEach((c, idx) => {
        const rowIdx = 5 + idx;
        const row = ws2.getRow(rowIdx);
        row.height = 22;

        const dur = c.duration || c.duration_seconds || c.call_length_seconds || 0;
        const durStr = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`;
        
        let interest = 'BAIXO';
        let valEst = 0;
        let priority = 'SEM RETORNO';

        if (dur >= 45) {
            interest = 'ALTO';
            valEst = 2500;
            priority = 'ALTA';
        } else if (dur >= 15) {
            interest = 'MEDIO';
            valEst = 500;
            priority = 'NORMAL';
        }

        const phoneRaw = c.lead_phone || c.from_number || c.to_number || c.numero || '';
        const phoneFmt = phoneRaw ? `+55 ${phoneRaw.replace(/^\+?55/, '').trim()}` : '-';

        let dateFormatted = '-';
        if (c.created_at || c.start_timestamp) {
            const d = new Date(c.created_at || c.start_timestamp);
            if (!isNaN(d.getTime())) {
                dateFormatted = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR').slice(0, 5);
            }
        }

        row.values = [
            c.call_id || (totalCalls - idx),
            c.lead_name || c.nome || 'Cliente',
            phoneFmt,
            dateFormatted,
            durStr,
            c.agent_name || c.agent_id || 'Agente MindFlow',
            c.disconnection_reason || 'Concluída',
            interest,
            valEst,
            priority,
            c.transcript || '',
            c.recording_url || ''
        ];

        const isEven = idx % 2 === 0;
        const bg = isEven ? 'FFF8FAFC' : 'FFFFFFFF';

        row.eachCell({ includeEmpty: true }, (cell, colNum) => {
            cell.font = { name: 'Century Gothic', size: 9 };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
            
            // Alignments
            if ([1, 4, 5, 8, 10].includes(colNum)) {
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
            } else if (colNum === 9) {
                cell.alignment = { vertical: 'middle', horizontal: 'right' };
                cell.numFmt = '"R$ "#,##0';
            } else if (colNum === 11) {
                cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
            } else {
                cell.alignment = { vertical: 'middle', horizontal: 'left' };
            }

            // Interest badge color
            if (colNum === 8) {
                if (interest === 'ALTO') {
                    cell.font = { name: 'Century Gothic', size: 9, bold: true, color: { argb: 'FF10B981' } };
                } else if (interest === 'MEDIO') {
                    cell.font = { name: 'Century Gothic', size: 9, bold: true, color: { argb: 'FFF59E0B' } };
                } else {
                    cell.font = { name: 'Century Gothic', size: 9, color: { argb: 'FF94A3B8' } };
                }
            }
        });
    });

    return await wb.xlsx.writeBuffer();
}

// Quick Test Execution
const sampleCalls = Array.from({ length: 25 }, (_, i) => ({
    call_id: `CALL-${1000 + i}`,
    created_at: new Date().toISOString(),
    lead_name: `Cliente Modelo ${i + 1}`,
    lead_phone: '47991089099',
    agent_name: 'Kaique MindFlow',
    duration_seconds: [5, 18, 55, 120, 8, 42][i % 6],
    disconnection_reason: ['Cliente desligou', 'Não atendeu', 'Caixa Postal', 'Agente finalizou'][i % 4],
    transcript: 'Cliente: Alô? | Agente: Fala PEDRO ERNESTO! Tudo certo? Aqui é o Kaique da MindFlow...| Lead: Tudo certo!',
    recording_url: 'https://dxc03zgurdly9.cloudfront.net/sample/recording.wav'
}));

buildExecutiveExcel(sampleCalls, 'MindFlow')
    .then(buf => {
        fs.writeFileSync('C:/Users/pedro/Downloads/test_mindflow_export.xlsx', buf);
        console.log('SUCCESS! MindFlow Executive Excel written to C:/Users/pedro/Downloads/test_mindflow_export.xlsx');
    })
    .catch(console.error);
