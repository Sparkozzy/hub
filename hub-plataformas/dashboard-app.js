// State Management
const state = {
    filters: {
        agent: '',
        startDate: '',
        endDate: '',
        detailedDisconnections: false
    },
    auditFilters: {
        minDuration: '',
        maxDuration: ''
    },
    pagination: {
        page: 1,
        limit: 15,
        totalPages: 1
    },
    charts: {
        funnel: null,
        disconnections: null,
        hourly: null,
        fatigue: null,
        waFunnel: null,
        waHours: null
    },
    selectedCall: null
};

// Colors Config (HSL matches style.css theme)
const colors = {
    primary: '#6366f1',
    primaryGlow: 'rgba(99, 102, 241, 0.25)',
    purple: '#a855f7',
    purpleGlow: 'rgba(168, 85, 247, 0.25)',
    success: '#10b981',
    successGlow: 'rgba(16, 185, 129, 0.25)',
    warning: '#f59e0b',
    warningGlow: 'rgba(245, 158, 11, 0.25)',
    error: '#ef4444',
    errorGlow: 'rgba(239, 68, 68, 0.25)',
    info: '#0ea5e9',
    infoGlow: 'rgba(14, 165, 233, 0.25)',
    muted: '#6b7280',
    cardBorder: 'rgba(255, 255, 255, 0.06)'
};

// Global Initialization
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initFilters();
    loadAgents();
    refreshDashboard();
    initETLTrigger();
    initAuditPanel();
    initExportCsv();
    // Auto-refresh a cada 30 segundos
    setInterval(refreshDashboard, 30000);
});

// 1. Tab Navigation Routing
function updateHeaderTitle(tabName) {
    const titleEl = document.getElementById('dashHeaderTitle');
    const descEl = document.getElementById('dashHeaderDesc');
    if (!titleEl || !descEl) return;

    const isClientMode = window.location.pathname === '/cliente' || sessionStorage.getItem('isClient') === '1';

    const tabConfig = {
        overview: {
            title: isClientMode ? 'Dashboard' : 'Dashboard de Ligações',
            desc: 'Mapeamento de funil, produtividade dos agentes e auditoria em tempo real.'
        },
        fatigue: {
            title: 'Fadiga & Pressão',
            desc: 'Análise da densidade de contatos e pressão de rediscagem sobre a base de leads.'
        },
        audit: {
            title: 'Auditoria de Ligações',
            desc: 'Player de áudio, transcrição e diagnóstico detalhado de chamadas dos SDRs.'
        },
        whatsapp: {
            title: 'Dashboard de WhatsApp',
            desc: 'Métricas de engajamento, funil de conversas e auditoria de mensagens do WhatsApp.'
        }
    };

    const cfg = tabConfig[tabName] || tabConfig.overview;
    titleEl.textContent = cfg.title;
    descEl.textContent = cfg.desc;
}

function initTabs() {
    const tabs = document.querySelectorAll('.dash-tab');
    const sections = document.querySelectorAll('.tab-content');

    function activateTab(targetTab) {
        tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === targetTab));
        sections.forEach(s => s.classList.toggle('active', s.id === `tab-${targetTab}`));

        updateHeaderTitle(targetTab);

        if (targetTab === 'audit') {
            loadAuditCalls();
        } else if (targetTab === 'whatsapp') {
            setTimeout(() => {
                loadWhatsApp();
                window._waNeedsReload = false;
            }, 60);
        }

        setTimeout(() => {
            Object.values(state.charts).forEach(chart => {
                if (chart) chart.resize();
            });
        }, 100);
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            const targetTab = tab.getAttribute('data-tab');
            window.location.hash = targetTab;
            activateTab(targetTab);
        });
    });

    const initialHash = (window.location.hash || '').replace('#', '');
    if (['overview', 'fatigue', 'audit', 'whatsapp'].includes(initialHash)) {
        activateTab(initialHash);
    }

    window.addEventListener('hashchange', () => {
        const hash = (window.location.hash || '').replace('#', '');
        if (['overview', 'fatigue', 'audit', 'whatsapp'].includes(hash)) {
            activateTab(hash);
        }
    });
}

// 2. Dynamic Filter Dropdowns & Observers

function initFilters() {
    const clearBtn = document.getElementById('btn-clear-filters');

    // ── Período ──
    const toggle = document.getElementById('periodToggle');
    const panel = document.getElementById('periodPanel');
    const text = document.getElementById('periodText');
    const calTitle = document.getElementById('periodCalTitle');
    const calGrid = document.getElementById('periodCalGrid');
    const startDisplay = document.getElementById('periodStartDisplay');
    const endDisplay = document.getElementById('periodEndDisplay');
    const applyBtn = document.getElementById('periodApply');
    const clearPeriodBtn = document.getElementById('periodClear');
    let calDate = new Date();
    let selStart = null, selEnd = null;

    function pad(n) { return String(n).padStart(2, '0'); }
    function toStr(d) { return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) : ''; }
    function sameDay(a, b) { return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

    function fmtBr(d) { return d ? d.toLocaleDateString('pt-BR') : '—'; }

    function updateToggle() {
        if (state.filters.startDate && state.filters.endDate) {
            const s = state.filters.startDate.split('-').reverse().join('/');
            const e = state.filters.endDate.split('-').reverse().join('/');
            text.textContent = s + ' — ' + e;
            text.classList.add('active');
        } else { text.textContent = 'Período'; text.classList.remove('active'); }
    }

    function updateFields() {
        startDisplay.textContent = fmtBr(selStart);
        startDisplay.classList.toggle('hint', !selStart);
        endDisplay.textContent = fmtBr(selEnd);
        endDisplay.classList.toggle('hint', !selEnd);
        startDisplay.closest('.period-field').classList.toggle('highlight', !!selStart && !selEnd);
        endDisplay.closest('.period-field').classList.toggle('highlight', !!selEnd);
        applyBtn.disabled = !selStart || !selEnd;
    }

    function renderCalendar() {
        const year = calDate.getFullYear(), month = calDate.getMonth();
        calTitle.textContent = new Date(year, month).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const today = new Date();
        const todayNorm = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        let html = '<div class="period-cal-weekday">Dom</div><div class="period-cal-weekday">Seg</div><div class="period-cal-weekday">Ter</div><div class="period-cal-weekday">Qua</div><div class="period-cal-weekday">Qui</div><div class="period-cal-weekday">Sex</div><div class="period-cal-weekday">Sáb</div>';
        for (let i = 0; i < firstDay; i++) html += '<div class="period-cal-day empty"></div>';

        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(year, month, d);
            const isPast = date < todayNorm;
            const isToday = sameDay(date, today);
            const isStart = sameDay(date, selStart);
            const isEnd = sameDay(date, selEnd);
            const inRange = selStart && selEnd && date >= selStart && date <= selEnd;
            let cls = 'period-cal-day';
            if (isPast) cls += ' past';
            if (isToday) cls += ' today';
            if (isStart && isEnd && sameDay(selStart, selEnd)) cls += ' selected';
            else if (isStart) cls += ' range-start';
            else if (isEnd) cls += ' range-end';
            else if (inRange) cls += ' in-range';
            html += `<div class="${cls}" data-date="${year}-${pad(month + 1)}-${pad(d)}">${d}</div>`;
        }
        calGrid.innerHTML = html;

        calGrid.querySelectorAll('.period-cal-day:not(.empty):not(.past)').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const [y, m, day] = el.dataset.date.split('-').map(Number);
                const clicked = new Date(y, m - 1, day);

                // Se clicou no mesmo que já tá selecionado como início, desmarca
                if (sameDay(clicked, selStart) && !selEnd) { selStart = null; updateFields(); renderCalendar(); return; }

                if (!selStart || (selStart && selEnd)) {
                    selStart = clicked; selEnd = null;
                } else {
                    if (clicked < selStart) { selEnd = selStart; selStart = clicked; }
                    else { selEnd = clicked; }
                }
                updateFields();
                renderCalendar();
            });
        });
    }

    // Apply
    applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!selStart || !selEnd) return;
        state.filters.startDate = toStr(selStart);
        state.filters.endDate = toStr(selEnd);
        updateToggle();
        panel.classList.remove('open'); toggle.classList.remove('open');
        refreshDashboard();
    });

    // Clear (dentro do painel)
    clearPeriodBtn.addEventListener('click', (e) => { e.stopPropagation(); selStart = null; selEnd = null; updateFields(); renderCalendar(); });

    document.getElementById('periodCalPrev').addEventListener('click', (e) => { e.stopPropagation(); calDate.setMonth(calDate.getMonth() - 1); renderCalendar(); });
    document.getElementById('periodCalNext').addEventListener('click', (e) => { e.stopPropagation(); calDate.setMonth(calDate.getMonth() + 1); renderCalendar(); });

    toggle.addEventListener('click', () => {
        console.log('[Period] toggle click');
        if (!panel) { console.error('[Period] panel is null'); return; }
        const willOpen = !panel.classList.contains('open');
        panel.classList.toggle('open');
        toggle.classList.toggle('open');
        if (willOpen) {
            console.log('[Period] opening panel');
            const sd = state.filters.startDate ? new Date(state.filters.startDate + 'T12:00:00') : null;
            const ed = state.filters.endDate ? new Date(state.filters.endDate + 'T12:00:00') : null;
            selStart = sd; selEnd = ed;
            try { updateFields(); renderCalendar(); } catch (e) { console.error('[Period] render error:', e); }
        }
    });
    document.addEventListener('click', (e) => {
        if (!toggle.contains(e.target) && !panel.contains(e.target)) { panel.classList.remove('open'); toggle.classList.remove('open'); }
    });

    // Presets
    document.querySelectorAll('.period-preset').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const now = new Date();
            let d1, d2;
            if (btn.dataset.range === 'today') { d1 = now; d2 = now; }
            else if (btn.dataset.range === '7d') { d1 = new Date(); d1.setDate(now.getDate() - 6); d2 = now; }
            else if (btn.dataset.range === '30d') { d1 = new Date(); d1.setDate(now.getDate() - 29); d2 = now; }
            else if (btn.dataset.range === 'all') {
                state.filters.startDate = ''; state.filters.endDate = '';
                selStart = null; selEnd = null; updateToggle();
                panel.classList.remove('open'); toggle.classList.remove('open');
                refreshDashboard(); return;
            }
            selStart = d1; selEnd = d2;
            state.filters.startDate = toStr(d1); state.filters.endDate = toStr(d2);
            updateToggle();
            panel.classList.remove('open'); toggle.classList.remove('open');
            refreshDashboard();
        });
    });

    clearBtn.addEventListener('click', () => {
        state.filters.agent = ''; state.filters.startDate = ''; state.filters.endDate = '';
        selStart = null; selEnd = null; updateToggle();
        panel.classList.remove('open'); toggle.classList.remove('open');
        refreshDashboard();
    });
    updateToggle();

    // Disconnection reasons breakdown view toggler
    const toggleBtn = document.getElementById('btn-toggle-disconnections');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            state.filters.detailedDisconnections = !state.filters.detailedDisconnections;
            toggleBtn.classList.toggle('active', state.filters.detailedDisconnections);

            const consolidatedView = document.getElementById('disconnections-consolidated-view');
            const detailedView = document.getElementById('disconnections-detailed-view');

            if (state.filters.detailedDisconnections) {
                consolidatedView.classList.add('hidden');
                detailedView.classList.remove('hidden');
                toggleBtn.title = "Ver Gráfico Consolidado";
            } else {
                consolidatedView.classList.remove('hidden');
                detailedView.classList.add('hidden');
                toggleBtn.title = "Ver Índice Detalhado";
            }

            // Re-fetch only the disconnections panel
            const qParams = new URLSearchParams();
            if (state.filters.agent) qParams.append('agent', state.filters.agent);
            if (state.filters.startDate) qParams.append('start_date', state.filters.startDate);
            if (state.filters.endDate) qParams.append('end_date', state.filters.endDate);
            loadDisconnections(qParams.toString());
        });
    }
}

async function loadAgents() {
    try {
        const res = await fetch('/api/agents');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();

        // Normaliza: hub_backend pode retornar strings ou objetos {id, name}
        const agentNames = raw.map(a => (typeof a === 'string' ? a : (a.name || a.agent_name || a.id || String(a))));

        const opts = [{ value: '', label: 'Todos os Agentes' }];
        agentNames.forEach(name => {
            opts.push({ value: name, label: name });
        });

        if (window.dashAgentSelect) {
            window.dashAgentSelect.setOptions(opts);
            window.dashAgentSelect.setValue('', 'Todos os Agentes');
        }
    } catch (err) {
        console.error('[Agents] Erro ao buscar agentes:', err);
    }
}

// 3. Global Dashboard Refresher
async function refreshDashboard() {
    // Build query params
    const qParams = new URLSearchParams();
    if (state.filters.agent) qParams.append('agent', state.filters.agent);
    if (state.filters.startDate) qParams.append('start_date', state.filters.startDate);
    if (state.filters.endDate) qParams.append('end_date', state.filters.endDate);

    const queryStr = qParams.toString();

    // Trigger parallel data requests
    loadKPIs(queryStr);
    loadFunnel(queryStr);
    loadDisconnections(queryStr);
    loadHourly(queryStr);
    loadFatigue(queryStr);

    // Audit table respects current global filters
    state.pagination.page = 1;
    loadAuditCalls();

    // Recarrega WhatsApp se a aba estiver ativa ou se houve troca de cliente
    const waTab = document.getElementById('tab-whatsapp');
    if (waTab && (waTab.classList.contains('active') || window._waNeedsReload)) {
        loadWhatsApp();
        window._waNeedsReload = false;
    }
}

// 4. KPI Card Inserter
async function loadKPIs(queryStr) {
    try {
        const res = await fetch(`/metrics?${queryStr}`);
        const data = await res.json();

        document.getElementById('kpi-total-calls').textContent = data.total_calls.toLocaleString();
        document.getElementById('kpi-avg-calls-lead').textContent = data.avg_ligacoes_por_lead.toFixed(1);
        document.getElementById('kpi-unique-leads').textContent = data.unique_leads.toLocaleString();
        document.getElementById('kpi-total-interest').textContent = data.total_interesse.toLocaleString();
        document.getElementById('kpi-interest-rate').textContent = data.taxa_interesse_por_lead.toFixed(1);
        document.getElementById('kpi-total-cost').textContent = `${data.minutagem_total.toFixed(2)} min`;
        document.getElementById('kpi-cost-lead').textContent = `${data.minutagem_por_lead.toFixed(2)} min`;
        document.getElementById('kpi-cost-interest').textContent = `${data.minutagem_media.toFixed(2)} min`;

        // Gauge statistics under Fatigue tab
        document.getElementById('val-avg-density').textContent = data.avg_density.toFixed(2);
        document.getElementById('val-avg-pressure').textContent = data.avg_pressure.toFixed(2);
    } catch (err) {
        console.error('Erro ao buscar métricas:', err);
        document.getElementById('kpi-total-calls').textContent = 'Erro';
    }
}

// 5. Funnel Chart Builder (Chart.js Horizontal Bar Chart)
async function loadFunnel(queryStr) {
    try {
        const res = await fetch(`/funnel?${queryStr}`);
        const data = await res.json();

        const stages = [
            'Leads Únicos',
            'Leads Hook (+15s)',
            'Leads Conversa (+45s)',
            'Leads Interesse (+90s)'
        ];

        const values = [
            data.leads_totais,
            data.hook_15s,
            data.conversa_45s,
            data.interesse_90s
        ];

        const funnelTotal = values[0];

        // Custom plugin for labels and percentages on the right side of bars
        const funnelValueLabels = {
            id: 'funnelValueLabels',
            afterDatasetsDraw(chart) {
                const { ctx } = chart;
                const meta = chart.getDatasetMeta(0);
                meta.data.forEach((bar, i) => {
                    const val = chart.data.datasets[0].data[i];
                    const pct = funnelTotal > 0 ? ((val / funnelTotal) * 100).toFixed(0) : '0';
                    const x = bar.x + 12;
                    const y = bar.y;
                    ctx.save();
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.font = "600 14px 'Space Grotesk', sans-serif";
                    ctx.fillStyle = '#F5F6FA';
                    ctx.fillText(val.toLocaleString(), x, y - 8);
                    ctx.font = "500 11px 'Inter', sans-serif";
                    ctx.fillStyle = '#8A8FA3';
                    ctx.fillText(pct + '%', x, y + 10);
                    ctx.restore();
                });
            }
        };

        const ctx = document.getElementById('chart-funnel').getContext('2d');

        if (state.charts.funnel) {
            state.charts.funnel.destroy();
        }

        state.charts.funnel = new Chart(ctx, {
            type: 'bar',
            plugins: [funnelValueLabels],
            data: {
                labels: stages,
                datasets: [{
                    data: values,
                    backgroundColor: [
                        '#7B9AFF',
                        '#6366F1',
                        '#00B5A0',
                        '#10B981'
                    ],
                    borderRadius: 8,
                    borderSkipped: false,
                    barThickness: 28
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { right: 56 } },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(8, 12, 24, 0.95)',
                        titleColor: '#fff',
                        titleFont: { family: 'Space Grotesk', size: 13, weight: 600 },
                        bodyColor: '#8E8FA2',
                        bodyFont: { family: 'Inter', size: 12 },
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 8,
                        displayColors: false,
                        callbacks: {
                            label: (c) => {
                                const pct = funnelTotal > 0 ? ((c.raw / funnelTotal) * 100).toFixed(1) : '0';
                                return ` ${c.raw.toLocaleString()} leads · ${pct}% do funil`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.04)', drawBorder: false },
                        ticks: { color: '#8E8FA2', font: { family: 'Inter', size: 11 } },
                        border: { display: false }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { color: '#f3f4f6', font: { family: 'Space Grotesk', size: 12, weight: 500 } },
                        border: { display: false }
                    }
                }
            }
        });
    } catch (err) {
        console.error('Erro ao construir gráfico de funil:', err);
    }
}

// 6. Disconnections Donut Chart
async function loadDisconnections(queryStr) {
    try {
        const isDetailed = state.filters.detailedDisconnections;
        const url = isDetailed ? `/disconnections?${queryStr}&detailed=true` : `/disconnections?${queryStr}`;
        const res = await fetch(url);
        const data = await res.json();

        const detailedView = document.getElementById('disconnections-detailed-view');

        const categoryColors = {
            'Conversa Normal': '#00B5A0',
            'Não Atendeu': '#FBBF24',
            'Erro Técnico': '#C084FC',
            'Bloqueado': '#FB7185',
            'Ocupado': '#38BDF8'
        };

        const categoryMap = {
            'Conversa Normal': 'normal',
            'Não Atendeu': 'no-answer',
            'Bloqueado': 'blocked',
            'Erro Técnico': 'technical',
            'Ocupado': 'busy'
        };

        if (isDetailed) {
            detailedView.innerHTML = '';

            if (data.length === 0) {
                detailedView.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px;">Nenhum dado encontrado</div>';
                return;
            }

            data.forEach(item => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'detailed-item';

                const classCategory = categoryMap[item.category] || 'normal';
                const color = categoryColors[item.category] || '#6b7280';

                itemDiv.innerHTML = `
                    <div class="detailed-item-header" style="display: flex; justify-content: space-between; align-items: center;">
                        <span class="detailed-reason-name" style="font-family: monospace; font-size: 11px; font-weight: 600; color: #fff; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 170px;" title="${item.reason}">${item.reason}</span>
                        <span class="disconnection-badge ${classCategory}" style="padding: 1px 6px; font-size: 9px; line-height: 1; border-radius: 4px; font-weight: 500;">${item.category}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 10px; color: var(--text-secondary);">
                        <span>${item.count.toLocaleString()} chamadas</span>
                        <span style="font-weight: 600; color: #fff;">${item.percentage.toFixed(1)}%</span>
                    </div>
                    <div class="detailed-bar-container" style="width: 100%; height: 5px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; margin-top: 6px;">
                        <div class="detailed-bar" style="width: ${item.percentage}%; height: 100%; border-radius: 3px; background-color: ${color}; transition: width 0.4s ease;"></div>
                    </div>
                `;
                detailedView.appendChild(itemDiv);
            });
        } else {
            const categories = data.map(c => c.category);
            const counts = data.map(c => c.count);
            const labels = categories;
            const bgColors = categories.map(cat => categoryColors[cat] || '#6b7280');

            const ctx = document.getElementById('chart-disconnections').getContext('2d');

            if (state.charts.disconnections) {
                state.charts.disconnections.destroy();
            }

            state.charts.disconnections = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: counts,
                        backgroundColor: bgColors,
                        borderColor: '#0b0f19',
                        borderWidth: 2,
                        cutout: '75%',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: '#8E8FA2',
                                usePointStyle: true,
                                pointStyle: 'circle',
                                boxWidth: 8,
                                boxHeight: 8,
                                padding: 14,
                                font: { family: 'Space Grotesk', size: 11, weight: 500 }
                            }
                        },
                        tooltip: {
                            backgroundColor: 'rgba(8, 12, 24, 0.95)',
                            titleColor: '#fff',
                            titleFont: { family: 'Space Grotesk', size: 13, weight: 600 },
                            bodyColor: '#8E8FA2',
                            bodyFont: { family: 'Inter', size: 12 },
                            borderColor: 'rgba(255, 255, 255, 0.1)',
                            borderWidth: 1,
                            padding: 12,
                            cornerRadius: 8,
                            boxPadding: 4,
                            callbacks: {
                                label: (c) => {
                                    const total = c.dataset.data.reduce((a, b) => a + b, 0);
                                    const pct = total > 0 ? ((c.raw / total) * 100).toFixed(1) : '0';
                                    return ` ${c.label}: ${c.raw.toLocaleString()} (${pct}%)`;
                                }
                            }
                        }
                    }
                }
            });
        }
    } catch (err) {
        console.error('Erro ao construir desconexões:', err);
    }
}

// 7. Hourly Contact Heatmap / Line Chart
async function loadHourly(queryStr) {
    try {
        const res = await fetch(`/hours?${queryStr}`);
        const data = await res.json();

        // Formata as labels de horas para incluir o sufixo "h"
        const hours = data.map(d => {
            const h = parseInt(d.hour, 10);
            return isNaN(h) ? d.hour : `${String(h).padStart(2, '0')}h`;
        });
        const calls = data.map(d => d.call_count);
        const conversion = data.map(d => d.conversion_rate);
        const peakIndex = calls.indexOf(Math.max(...calls));

        const ctx = document.getElementById('chart-hourly').getContext('2d');

        if (state.charts.hourly) {
            state.charts.hourly.destroy();
        }

        // Canvas Gradients
        const gradBarPeak = ctx.createLinearGradient(0, 0, 0, 260);
        gradBarPeak.addColorStop(0, 'rgba(123, 154, 255, 0.7)');
        gradBarPeak.addColorStop(1, 'rgba(123, 154, 255, 0.15)');

        const gradBarNorm = ctx.createLinearGradient(0, 0, 0, 260);
        gradBarNorm.addColorStop(0, 'rgba(123, 154, 255, 0.35)');
        gradBarNorm.addColorStop(1, 'rgba(123, 154, 255, 0.04)');

        const gradLine = ctx.createLinearGradient(0, 0, 0, 260);
        gradLine.addColorStop(0, 'rgba(0, 181, 160, 0.3)');
        gradLine.addColorStop(1, 'rgba(0, 181, 160, 0.0)');

        state.charts.hourly = new Chart(ctx, {
            data: {
                labels: hours,
                datasets: [
                    {
                        type: 'bar',
                        label: 'Volume de Ligações',
                        data: calls,
                        backgroundColor: calls.map((_, i) => i === peakIndex ? gradBarPeak : gradBarNorm),
                        hoverBackgroundColor: 'rgba(123, 154, 255, 0.8)',
                        borderRadius: { topLeft: 6, topRight: 6 },
                        borderSkipped: false,
                        barThickness: 16,
                        yAxisID: 'y'
                    },
                    {
                        type: 'line',
                        label: 'Taxa de Interesse (%)',
                        data: conversion,
                        borderColor: '#00B5A0',
                        backgroundColor: gradLine,
                        borderWidth: 2.5,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 0,
                        pointHoverRadius: 6,
                        pointHoverBackgroundColor: '#00B5A0',
                        pointHoverBorderColor: '#fff',
                        pointHoverBorderWidth: 2,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(8, 12, 24, 0.95)',
                        titleColor: '#fff',
                        titleFont: { family: 'Space Grotesk', size: 13, weight: 600 },
                        bodyColor: '#8E8FA2',
                        bodyFont: { family: 'Inter', size: 12 },
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 8,
                        boxPadding: 4,
                        usePointStyle: true,
                        callbacks: {
                            label: (context) => {
                                const val = context.raw;
                                if (context.dataset.type === 'line') {
                                    return ` Taxa de Interesse: ${typeof val === 'number' ? val.toFixed(1) : val}%`;
                                }
                                return ` Volume de Ligações: ${val.toLocaleString()}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: '#8E8FA2',
                            font: { family: 'Inter', size: 11 },
                            maxRotation: 0,
                            minRotation: 0,
                            maxTicksLimit: 12
                        },
                        border: { display: false }
                    },
                    y: {
                        position: 'left',
                        grid: { color: 'rgba(255, 255, 255, 0.04)', drawBorder: false },
                        ticks: { color: '#8E8FA2', font: { family: 'Inter', size: 11 }, precision: 0 },
                        border: { display: false },
                        title: { display: false }
                    },
                    y1: {
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: {
                            color: '#00B5A0',
                            font: { family: 'Inter', size: 11 },
                            callback: (v) => `${v}%`
                        },
                        border: { display: false },
                        title: { display: false }
                    }
                }
            }
        });
    } catch (err) {
        console.error('Erro ao construir gráfico horário:', err);
    }
}

// 8. Fatigue Combo Impact Chart (Attempts bucket vs Interest conversion rate)
async function loadFatigue(queryStr) {
    try {
        const res = await fetch(`/fatigue?${queryStr}`);
        const data = await res.json();

        const buckets = data.map(d => d.attempt_bucket);
        const calls = data.map(d => d.call_count);
        const conversions = data.map(d => d.conversion_rate);

        const ctx = document.getElementById('chart-fatigue-impact').getContext('2d');

        if (state.charts.fatigue) {
            state.charts.fatigue.destroy();
        }

        const gradBarNorm = ctx.createLinearGradient(0, 0, 0, 260);
        gradBarNorm.addColorStop(0, 'rgba(123, 154, 255, 0.35)');
        gradBarNorm.addColorStop(1, 'rgba(123, 154, 255, 0.04)');

        const gradLine = ctx.createLinearGradient(0, 0, 0, 260);
        gradLine.addColorStop(0, 'rgba(0, 181, 160, 0.3)');
        gradLine.addColorStop(1, 'rgba(0, 181, 160, 0.0)');

        state.charts.fatigue = new Chart(ctx, {
            data: {
                labels: buckets,
                datasets: [
                    {
                        type: 'bar',
                        label: 'Volume de Ligações',
                        data: calls,
                        backgroundColor: gradBarNorm,
                        hoverBackgroundColor: 'rgba(123, 154, 255, 0.8)',
                        borderRadius: { topLeft: 6, topRight: 6 },
                        borderSkipped: false,
                        barThickness: 24,
                        yAxisID: 'y'
                    },
                    {
                        type: 'line',
                        label: 'Taxa de Interesse (%)',
                        data: conversions,
                        borderColor: '#00B5A0',
                        backgroundColor: gradLine,
                        borderWidth: 2.5,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 0,
                        pointHoverRadius: 6,
                        pointHoverBackgroundColor: '#00B5A0',
                        pointHoverBorderColor: '#fff',
                        pointHoverBorderWidth: 2,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(8, 12, 24, 0.95)',
                        titleColor: '#fff',
                        titleFont: { family: 'Space Grotesk', size: 13, weight: 600 },
                        bodyColor: '#8E8FA2',
                        bodyFont: { family: 'Inter', size: 12 },
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 8,
                        boxPadding: 4,
                        usePointStyle: true,
                        callbacks: {
                            label: (context) => {
                                const idx = context.dataIndex;
                                if (context.dataset.type === 'line') {
                                    return ` Taxa de Conversão: ${conversions[idx]}%`;
                                }
                                return ` Ligações no Estágio: ${calls[idx].toLocaleString()}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#8E8FA2', font: { family: 'Inter', size: 11 } },
                        border: { display: false }
                    },
                    y: {
                        position: 'left',
                        grid: { color: 'rgba(255, 255, 255, 0.04)', drawBorder: false },
                        ticks: { color: '#8E8FA2', font: { family: 'Inter', size: 11 }, precision: 0 },
                        border: { display: false },
                        title: { display: false }
                    },
                    y1: {
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: {
                            color: '#00B5A0',
                            font: { family: 'Inter', size: 11 },
                            callback: (v) => `${v}%`
                        },
                        border: { display: false },
                        title: { display: false }
                    }
                }
            }
        });
    } catch (err) {
        console.error('Erro ao carregar gráfico de fadiga:', err);
    }
}

// 9. Manual ETL Trigger Client Trigger
function initETLTrigger() {
    const btn = document.getElementById('btn-trigger-etl');
    if (!btn) return; // Botão removido no modo nativo
    const toast = document.getElementById('etl-status-toast');

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        toast.classList.remove('hidden');
        toast.querySelector('.text').textContent = 'ETL Inicializado...';

        try {
            const res = await fetch('/etl/trigger', { method: 'POST' });
            const data = await res.json();

            toast.querySelector('.text').textContent = 'Processando ETL em background...';

            // Wait 10 seconds and auto-refresh the metrics
            setTimeout(() => {
                toast.querySelector('.text').textContent = 'Dados Recarregados!';
                refreshDashboard();
                loadAgents();

                setTimeout(() => {
                    toast.classList.add('hidden');
                    btn.disabled = false;
                }, 3000);
            }, 10000);

        } catch (err) {
            console.error('Erro ao rodar ETL:', err);
            toast.querySelector('.text').textContent = 'Erro ao disparar ETL';
            setTimeout(() => {
                toast.classList.add('hidden');
                btn.disabled = false;
            }, 3000);
        }
    });
}

// 10. Audit Panel & Player controls
function initAuditPanel() {
    const btnApply = document.getElementById('btn-apply-audit-filters');
    const minInput = document.getElementById('audit-duration-min');
    const maxInput = document.getElementById('audit-duration-max');

    const btnPrev = document.getElementById('btn-prev-page');
    const btnNext = document.getElementById('btn-next-page');

    btnApply.addEventListener('click', () => {
        state.auditFilters.minDuration = minInput.value;
        state.auditFilters.maxDuration = maxInput.value;
        state.pagination.page = 1;
        loadAuditCalls();
    });

    btnPrev.addEventListener('click', () => {
        if (state.pagination.page > 1) {
            state.pagination.page--;
            loadAuditCalls();
        }
    });

    btnNext.addEventListener('click', () => {
        if (state.pagination.page < state.pagination.totalPages) {
            state.pagination.page++;
            loadAuditCalls();
        }
    });
}

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

// 11. CSV Export Handler (Gera CSV a partir da API /calls)
function initExportCsv() {
    const btn = document.getElementById('btn-export-csv');
    if (!btn) return;

    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const originalHtml = btn.innerHTML;
        btn.style.pointerEvents = 'none';
        btn.innerHTML = '<span class="material-symbols-outlined spin" style="animation: spin 1s linear infinite;">progress_activity</span> Exportando...';

        try {
            const params = new URLSearchParams({ page: 1, limit: 5000, _t: Date.now() });
            if (state?.filters?.agent) params.append('agent', state.filters.agent);
            if (state?.filters?.startDate) params.append('start_date', state.filters.startDate);
            if (state?.filters?.endDate) params.append('end_date', state.filters.endDate);

            const res = await fetch(`/calls?${params.toString()}`);
            if (!res.ok) {
                alert('Erro ao consultar servidor de ligações.');
                return;
            }

            const result = await res.json();
            const calls = result.data || result.calls || (Array.isArray(result) ? result : []);

            if (!calls || calls.length === 0) {
                alert('Nenhuma ligação encontrada para os filtros selecionados.');
                return;
            }

            // Colunas amigáveis do CSV
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

            const bom = '\uFEFF';
            const csvContent = bom + headerRow + '\n' + bodyRows;
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `ligacoes_mindflow_${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        } catch (err) {
            console.error('[Export CSV] Erro:', err);
            alert('Erro ao gerar arquivo CSV.');
        } finally {
            btn.style.pointerEvents = 'auto';
            btn.innerHTML = originalHtml;
        }
    });
}

async function loadAuditCalls() {
    const tbody = document.querySelector('.audit-table tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading-td"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;display:inline-block;">pending</span> Buscando ligações...</td></tr>';

    const params = new URLSearchParams({
        page: state.pagination.page,
        limit: state.pagination.limit
    });

    // Add global filters
    if (state.filters.agent) params.append('agent', state.filters.agent);
    if (state.filters.startDate) params.append('start_date', state.filters.startDate);
    if (state.filters.endDate) params.append('end_date', state.filters.endDate);

    // Add audit specific duration filters
    if (state.auditFilters.minDuration) params.append('min_duration', state.auditFilters.minDuration);
    if (state.auditFilters.maxDuration) params.append('max_duration', state.auditFilters.maxDuration);

    try {
        const res = await fetch(`/calls?${params.toString()}`);
        const result = await res.json();

        tbody.innerHTML = '';

        if (result.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="loading-td">Nenhuma ligação encontrada para os filtros selecionados.</td></tr>';
            document.getElementById('current-page').textContent = '1';
            document.getElementById('total-pages').textContent = '1';
            document.getElementById('btn-prev-page').disabled = true;
            document.getElementById('btn-next-page').disabled = true;
            return;
        }

        // Paginate info
        state.pagination.totalPages = result.pages;
        document.getElementById('current-page').textContent = result.page;
        document.getElementById('total-pages').textContent = result.pages;

        document.getElementById('btn-prev-page').disabled = result.page === 1;
        document.getElementById('btn-next-page').disabled = result.page === result.pages;

        const categoryMap = {
            'Conversa Normal': 'normal',
            'Não Atendeu': 'no-answer',
            'Bloqueado': 'blocked',
            'Erro Técnico': 'technical',
            'Ocupado': 'busy'
        };

        result.data.forEach(call => {
            const tr = document.createElement('tr');

            // Highlight if active
            if (state.selectedCall && state.selectedCall.call_id === call.call_id) {
                tr.classList.add('active-row');
            }

            const formatDuration = (s) => {
                const min = Math.floor(s / 60);
                const sec = Math.floor(s % 60);
                return `${min}:${sec.toString().padStart(2, '0')}`;
            };

            const dateParsed = new Date(call.created_at.replace(' ', 'T')).toLocaleString('pt-BR');
            const classCategory = categoryMap[call.disconnection_category] || 'normal';

            tr.innerHTML = `
                <td>
                    <span class="cell-phone">${call.to_number}</span>
                    <span class="cell-lead-name">${call.Nome || 'Sem Nome'}</span>
                </td>
                <td style="font-weight: 500;">${call.agent_name || '-'}</td>
                <td style="color: var(--text-secondary);">${dateParsed}</td>
                <td><span class="badge-duration">${formatDuration(call.Duracao)}</span></td>
                <td><span class="disconnection-badge ${classCategory}">${call.disconnection_category}</span></td>
                <td>
                    <button class="btn-audit" title="Ouvir gravação"><span class="material-symbols-outlined" style="font-size:16px;">play_arrow</span></button>
                </td>
            `;

            // Add click row to open player
            tr.addEventListener('click', () => {
                // Remove styling on previous active
                const active = tbody.querySelector('.active-row');
                if (active) active.classList.remove('active-row');
                tr.classList.add('active-row');

                openAudioPlayer(call);
            });

            tbody.appendChild(tr);
        });

    } catch (err) {
        console.error('Erro ao carregar ligações da auditoria:', err);
        tbody.innerHTML = '<tr><td colspan="6" class="loading-td" style="color: var(--error);">Erro ao carregar ligações do servidor.</td></tr>';
    }
}

// 11. Open Custom Player and load parameters
function openAudioPlayer(call) {
    state.selectedCall = call;

    const emptyState = document.getElementById('player-empty-state');
    const activeState = document.getElementById('player-active-state');

    emptyState.classList.add('hidden');
    activeState.classList.remove('hidden');

    // Fill lead profiling Info
    document.getElementById('player-lead-name').textContent = call.Nome || 'Contato Sem Nome';
    document.getElementById('player-lead-phone').textContent = call.to_number;
    document.getElementById('player-lead-email').textContent = call.Email || 'Sem e-mail cadastrado';

    // Call metadata
    const dateParsed = new Date(call.created_at.replace(' ', 'T')).toLocaleString('pt-BR');
    document.getElementById('player-meta-agent').textContent = call.agent_name || '-';
    document.getElementById('player-meta-date').textContent = dateParsed;

    const formatDuration = (s) => {
        const min = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${min}m e ${sec}s`;
    };
    document.getElementById('player-meta-duration').textContent = formatDuration(call.Duracao);
    document.getElementById('player-meta-disconnection').textContent = call.disconnection_category;

    // Fatigue elements badge colorizer
    const densityVal = call.densidade_tentativas.toFixed(3);
    const pressureVal = call.pressao_recente.toFixed(3);

    const densityEl = document.getElementById('player-meta-density');
    densityEl.textContent = `${densityVal} (Tentativa/Hora)`;
    if (call.densidade_tentativas > 0.5) {
        densityEl.style.color = colors.error;
    } else if (call.densidade_tentativas > 0.2) {
        densityEl.style.color = colors.warning;
    } else {
        densityEl.style.color = colors.success;
    }

    const pressureEl = document.getElementById('player-meta-pressure');
    pressureEl.textContent = `${pressureVal} (Tentativa/Hora)`;
    if (call.pressao_recente > 1.0) {
        pressureEl.style.color = colors.error;
    } else if (call.pressao_recente > 0.5) {
        pressureEl.style.color = colors.warning;
    } else {
        pressureEl.style.color = colors.success;
    }

    // Audio source loader
    const audio = document.getElementById('audio-element');

    if (call.recording_url) {
        audio.src = call.recording_url;
        audio.classList.remove('hidden');
        audio.play().catch(err => {
            console.log('Auto-play blocked by browser. User action required to start audio playback.');
        });

        // Remove lgpd warning hidden state
        document.querySelector('.audio-player-wrapper').classList.remove('hidden');
    } else {
        audio.src = '';
        audio.classList.add('hidden');
        document.querySelector('.audio-player-wrapper').classList.add('hidden');
        alert('Esta ligação não contém gravação disponível no Retell.');
    }
}

// ============================================================
// WHATSAPP TAB (dados via hub_backend proxy)
// ============================================================
const waState = {
    page: 1,
    limit: 20,
    totalPages: 1
};

// Hook: carrega dados do WhatsApp ao entrar na aba (via initTabs)

function loadWhatsApp() {
    loadWaMetrics();
    loadWaFunnel();
    loadWaHours();
    loadWaChats();
}

function formatTma(val) {
    if (val == null || isNaN(val) || val === 0) return '0 min';
    const num = Number(val);
    if (num > 10000) {
        // Valor recebido em milissegundos (ex: 93817.36 ms -> 1.56 min)
        const mins = num / 60000;
        return mins < 1 ? `${Math.round(num / 1000)}s` : `${mins.toFixed(1)} min`;
    }
    if (num > 500) {
        // Valor recebido em segundos (ex: 600s -> 10 min)
        return `${(num / 60).toFixed(1)} min`;
    }
    return `${num.toFixed(1)} min`;
}

async function loadWaMetrics() {
    try {
        const res = await fetch(`/whatsapp/metrics?_t=${Date.now()}`);
        const d = await res.json();
        const set = (id, v) => { document.getElementById(id).textContent = v; };
        set('wa-kpi-total-leads', (d.total_leads ?? 0).toLocaleString());
        set('wa-kpi-new-leads', (d.leads_novos_24h ?? 0).toLocaleString());
        set('wa-kpi-active-leads', (d.leads_ativos_24h ?? 0).toLocaleString());
        set('wa-kpi-resp-rate', `${d.taxa_resposta ?? 0}%`);
        set('wa-kpi-total-msgs', (d.total_mensagens ?? 0).toLocaleString());
        set('wa-kpi-avg-msgs', (d.avg_mensagens_por_lead ?? 0).toFixed(1));
        set('wa-kpi-tma', formatTma(d.tempo_medio_atendimento_minutos));
    } catch (err) {
        console.error('Erro ao carregar métricas WhatsApp:', err);
    }
}

async function loadWaFunnel() {
    try {
        const res = await fetch(`/whatsapp/funnel?_t=${Date.now()}`);
        const d = await res.json();
        const stages = ['Leads Totais', 'Com Resposta', 'Engajadas (>5 msgs)'];
        const values = [d.total_leads ?? 0, d.leads_com_resposta ?? 0, d.conversas_engajadas_gt5_msgs ?? 0];
        const funnelTotal = values[0];

        const waFunnelValueLabels = {
            id: 'waFunnelValueLabels',
            afterDatasetsDraw(chart) {
                const { ctx } = chart;
                const meta = chart.getDatasetMeta(0);
                meta.data.forEach((bar, i) => {
                    const val = chart.data.datasets[0].data[i];
                    const pct = funnelTotal > 0 ? ((val / funnelTotal) * 100).toFixed(0) : '0';
                    const x = bar.x + 12;
                    const y = bar.y;
                    ctx.save();
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.font = "600 14px 'Space Grotesk', sans-serif";
                    ctx.fillStyle = '#F5F6FA';
                    ctx.fillText(val.toLocaleString(), x, y - 8);
                    ctx.font = "500 11px 'Inter', sans-serif";
                    ctx.fillStyle = '#8A8FA3';
                    ctx.fillText(pct + '%', x, y + 10);
                    ctx.restore();
                });
            }
        };

        const ctx = document.getElementById('chart-wa-funnel').getContext('2d');
        if (state.charts.waFunnel) state.charts.waFunnel.destroy();
        state.charts.waFunnel = new Chart(ctx, {
            type: 'bar',
            plugins: [waFunnelValueLabels],
            data: {
                labels: stages,
                datasets: [{
                    label: 'Volume',
                    data: values,
                    backgroundColor: ['#7B9AFF', '#00B5A0', '#10B981'],
                    borderRadius: 8,
                    borderSkipped: false,
                    barThickness: 28
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { right: 56 } },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(8, 12, 24, 0.95)',
                        titleColor: '#fff',
                        titleFont: { family: 'Space Grotesk', size: 13, weight: 600 },
                        bodyColor: '#8E8FA2',
                        bodyFont: { family: 'Inter', size: 12 },
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 8,
                        displayColors: false,
                        callbacks: {
                            label: (context) => ` ${context.raw.toLocaleString()} conversas`
                        }
                    }
                },
                scales: {
                    x: { grid: { color: 'rgba(255, 255, 255, 0.04)', drawBorder: false }, ticks: { color: '#8E8FA2', font: { family: 'Inter', size: 11 } } },
                    y: { grid: { display: false }, ticks: { color: '#f3f4f6', font: { family: 'Space Grotesk', size: 12, weight: 500 } } }
                }
            }
        });
    } catch (err) {
        console.error('Erro ao construir funil WhatsApp:', err);
    }
}

async function loadWaHours() {
    try {
        const res = await fetch(`/whatsapp/hours?_t=${Date.now()}`);
        const d = await res.json();
        const rows = d.hours_distribution || [];

        const labels = rows.map(r => `${String(r.hora).padStart(2, '0')}:00`);
        const leadMsgs = rows.map(r => r.mensagens_lead ?? 0);
        const aiMsgs = rows.map(r => r.mensagens_ia ?? 0);

        const ctx = document.getElementById('chart-wa-hours').getContext('2d');
        if (state.charts.waHours) state.charts.waHours.destroy();

        // Canvas Gradients para barras elegantes
        const gradLead = ctx.createLinearGradient(0, 0, 0, 260);
        gradLead.addColorStop(0, 'rgba(123, 154, 255, 0.95)');
        gradLead.addColorStop(1, 'rgba(123, 154, 255, 0.35)');

        const gradAi = ctx.createLinearGradient(0, 0, 0, 260);
        gradAi.addColorStop(0, 'rgba(0, 181, 160, 0.95)');
        gradAi.addColorStop(1, 'rgba(0, 181, 160, 0.35)');

        state.charts.waHours = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Mensagens Lead',
                        data: leadMsgs,
                        backgroundColor: gradLead,
                        hoverBackgroundColor: '#7B9AFF',
                        borderRadius: { topLeft: 4, topRight: 4 },
                        borderSkipped: false,
                        barThickness: 7,
                        categoryPercentage: 0.65,
                        barPercentage: 0.85
                    },
                    {
                        label: 'Mensagens IA',
                        data: aiMsgs,
                        backgroundColor: gradAi,
                        hoverBackgroundColor: '#00B5A0',
                        borderRadius: { topLeft: 4, topRight: 4 },
                        borderSkipped: false,
                        barThickness: 7,
                        categoryPercentage: 0.65,
                        barPercentage: 0.85
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(8, 12, 24, 0.95)',
                        titleColor: '#fff',
                        titleFont: { family: 'Space Grotesk', size: 13, weight: 600 },
                        bodyColor: '#8E8FA2',
                        bodyFont: { family: 'Inter', size: 12 },
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12,
                        cornerRadius: 8,
                        boxPadding: 4,
                        usePointStyle: true,
                        callbacks: {
                            label: (context) => ` ${context.dataset.label}: ${context.raw.toLocaleString()}`
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: '#8E8FA2',
                            font: { family: 'Inter', size: 11 },
                            maxRotation: 0,
                            minRotation: 0,
                            maxTicksLimit: 12
                        }
                    },
                    y: {
                        grid: { color: 'rgba(255, 255, 255, 0.04)', drawBorder: false },
                        ticks: {
                            color: '#8E8FA2',
                            font: { family: 'Inter', size: 11 },
                            precision: 0
                        }
                    }
                }
            }
        });
    } catch (err) {
        console.error('Erro ao construir gráfico de horas WhatsApp:', err);
    }
}

async function loadWaChats() {
    const tbody = document.getElementById('wa-chats-body');
    tbody.innerHTML = '<tr><td colspan="6" class="loading-td">Carregando conversas...</td></tr>';

    const params = new URLSearchParams({ page: waState.page, limit: waState.limit, _t: Date.now() });

    try {
        const res = await fetch(`/whatsapp/chats?${params.toString()}`);
        const result = await res.json();
        tbody.innerHTML = '';

        if (!result.data || result.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="loading-td">Nenhuma conversa encontrada.</td></tr>';
            document.getElementById('wa-current-page').textContent = '1';
            document.getElementById('wa-total-pages').textContent = '1';
            document.getElementById('wa-btn-prev').disabled = true;
            document.getElementById('wa-btn-next').disabled = true;
            return;
        }

        waState.totalPages = result.pages;
        document.getElementById('wa-current-page').textContent = result.page;
        document.getElementById('wa-total-pages').textContent = result.pages;
        document.getElementById('wa-btn-prev').disabled = result.page === 1;
        document.getElementById('wa-btn-next').disabled = result.page === result.pages;

        result.data.forEach(chat => {
            const tr = document.createElement('tr');
            const nome = chat.nome || 'Sem Nome';
            const numero = chat.numero || '';
            const ultima = chat.ultima_msgm_texto || '';
            const etapa = chat.etapa_crm || '-';
            const reuniao = chat.reuniao_marcada ? 'Sim' : 'Não';
            const tma = chat.duracao_atendimento_minutos != null ? formatTma(chat.duracao_atendimento_minutos) : '-';
            const sessionId = chat.numero || chat.id || '';

            tr.innerHTML = `
                <td>
                    <span class="cell-phone">${numero}</span>
                    <span class="cell-lead-name">${nome}</span>
                </td>
                <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);">${ultima}</td>
                <td>${etapa}</td>
                <td>${reuniao}</td>
                <td>${tma}</td>
                <td>
                    <button class="btn-audit" title="Ver histórico"><span class="material-symbols-outlined" style="font-size:16px;">chat</span></button>
                </td>
            `;

            tr.addEventListener('click', () => {
                const active = tbody.querySelector('.active-row');
                if (active) active.classList.remove('active-row');
                tr.classList.add('active-row');
                openWaChat(sessionId, nome);
            });

            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error('Erro ao carregar conversas WhatsApp:', err);
        tbody.innerHTML = '<tr><td colspan="6" class="loading-td" style="color:var(--error);">Erro ao carregar conversas.</td></tr>';
    }
}

async function openWaChat(sessionId, nome) {
    const modal = document.getElementById('wa-modal');
    const body = document.getElementById('wa-modal-body');
    modal.style.display = 'flex';
    body.innerHTML = '<p style="color:rgba(255,255,255,.4);font-size:13px;text-align:center;">Carregando mensagens...</p>';

    try {
        const res = await fetch(`/whatsapp/chats/${encodeURIComponent(sessionId)}/messages`);
        const d = await res.json();
        const msgs = d.messages || [];

        if (msgs.length === 0) {
            body.innerHTML = '<p style="color:rgba(255,255,255,.4);font-size:13px;text-align:center;">Nenhuma mensagem encontrada.</p>';
            return;
        }

        body.innerHTML = msgs.map(m => {
            const isHuman = (m.message_type === 'human');
            const align = isHuman ? 'flex-end' : 'flex-start';
            const bg = isHuman ? 'rgba(46,79,255,0.25)' : 'rgba(0,181,160,0.15)';
            const border = isHuman ? 'rgba(46,79,255,0.4)' : 'rgba(0,181,160,0.3)';
            return `
                <div style="display:flex;flex-direction:column;align-items:${align};">
                    <div style="max-width:75%;padding:8px 12px;border-radius:12px;background:${bg};border:1px solid ${border};font-size:13px;line-height:1.5;color:#fff;word-break:break-word;">
                        ${m.message_content || ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Erro ao carregar histórico:', err);
        body.innerHTML = '<p style="color:var(--error);font-size:13px;text-align:center;">Erro ao carregar mensagens.</p>';
    }
}

function closeWaModal() {
    document.getElementById('wa-modal').style.display = 'none';
}

// Fecha modal ao clicar fora
document.getElementById('wa-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeWaModal();
});

// Paginação do WhatsApp
document.getElementById('wa-btn-prev')?.addEventListener('click', () => {
    if (waState.page > 1) { waState.page--; loadWaChats(); }
});
document.getElementById('wa-btn-next')?.addEventListener('click', () => {
    if (waState.page < waState.totalPages) { waState.page++; loadWaChats(); }
});
