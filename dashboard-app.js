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
        fatigue: null
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
});

// 1. Tab Navigation Routing
function initTabs() {
    const tabs = document.querySelectorAll('.dash-tab');
    const sections = document.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            const targetTab = tab.getAttribute('data-tab');
            
            // Toggle active classes
            tabs.forEach(t => t.classList.remove('active'));
            sections.forEach(s => s.classList.remove('active'));
            
            tab.classList.add('active');
            const targetSection = document.getElementById(`tab-${targetTab}`);
            if (targetSection) targetSection.classList.add('active');
            
            // Adjust chart sizes inside the new visible tab
            setTimeout(() => {
                Object.values(state.charts).forEach(chart => {
                    if (chart) chart.resize();
                });
            }, 100);
        });
    });
}

// 2. Dynamic Filter Dropdowns & Observers
let datePickerInstance;

function initFilters() {
    const agentSelect = document.getElementById('filter-agent');
    const clearBtn = document.getElementById('btn-clear-filters');
    
    agentSelect.addEventListener('change', (e) => {
        state.filters.agent = e.target.value;
        refreshDashboard();
    });
    
    // Initialize premium Flatpickr date range picker with dual calendar & sidebar presets
    try {
        datePickerInstance = flatpickr("#filter-date-range", {
            mode: "range",
            dateFormat: "Y-m-d",
            altInput: true,
            altFormat: "d/m/Y",
            locale: (typeof flatpickr !== 'undefined' && flatpickr.l10ns && flatpickr.l10ns.pt) ? "pt" : "default",
            theme: "dark",
            showMonths: 2,
            onReady: function(selectedDates, dateStr, instance) {
                const container = instance.calendarContainer;
                if (!container) return;
                
                // Add layout modifier class
                container.classList.add("has-presets");
                
                const presetsDiv = document.createElement("div");
                presetsDiv.className = "flatpickr-presets";
                
                const presets = [
                    { text: "Hoje", special: 'today' },
                    { text: "Últimos 7 dias", special: '7days' },
                    { text: "Últimas 4 semanas", special: '28days' },
                    { text: "Últimos 3 meses", special: '90days' },
                    { text: "Este Mês", special: 'this_month' },
                    { text: "Histórico Completo", special: 'all' }
                ];
                
                presets.forEach(p => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "preset-btn";
                    btn.textContent = p.text;
                    
                    btn.addEventListener("click", () => {
                        const now = new Date();
                        let start, end;
                        
                        if (p.special === 'all') {
                            instance.clear();
                            state.filters.startDate = '';
                            state.filters.endDate = '';
                            instance.close();
                            refreshDashboard();
                            return;
                        }
                        
                        end = now;
                        if (p.special === 'today') {
                            start = now;
                        } else if (p.special === '7days') {
                            start = new Date();
                            start.setDate(now.getDate() - 6);
                        } else if (p.special === '28days') {
                            start = new Date();
                            start.setDate(now.getDate() - 27);
                        } else if (p.special === '90days') {
                            start = new Date();
                            start.setDate(now.getDate() - 89);
                        } else if (p.special === 'this_month') {
                            start = new Date(now.getFullYear(), now.getMonth(), 1);
                        }
                        
                        instance.setDate([start, end], true);
                        instance.close();
                    });
                    
                    presetsDiv.appendChild(btn);
                });
                
                container.insertBefore(presetsDiv, container.firstChild);
            },
            onChange: function(selectedDates, dateStr, instance) {
                if (selectedDates.length === 2) {
                    const formatDate = (d) => {
                        const yyyy = d.getFullYear();
                        const mm = String(d.getMonth() + 1).padStart(2, '0');
                        const dd = String(d.getDate()).padStart(2, '0');
                        return `${yyyy}-${mm}-${dd}`;
                    };
                    state.filters.startDate = formatDate(selectedDates[0]);
                    state.filters.endDate = formatDate(selectedDates[1]);
                    refreshDashboard();
                }
            }
        });
    } catch (flatpickrErr) {
        console.warn("Falha ao carregar componente Flatpickr de data:", flatpickrErr);
    }
    
    clearBtn.addEventListener('click', () => {
        agentSelect.value = '';
        if (datePickerInstance) datePickerInstance.clear();
        state.filters.agent = '';
        state.filters.startDate = '';
        state.filters.endDate = '';
        refreshDashboard();
    });
    
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
        const res = await fetch('/agents');
        const agents = await res.json();
        const select = document.getElementById('filter-agent');
        
        // Remove existing items except "Todos"
        select.innerHTML = '<option value="">Todos os Agentes</option>';
        agents.forEach(agent => {
            const opt = document.createElement('option');
            opt.value = agent;
            opt.textContent = agent;
            select.appendChild(opt);
        });
    } catch (err) {
        console.error('Erro ao buscar agentes:', err);
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
        document.getElementById('kpi-total-cost').textContent = `U$ ${data.total_cost.toFixed(2)}`;
        document.getElementById('kpi-cost-lead').textContent = `U$ ${data.custo_por_lead.toFixed(2)}`;
        
        const costInterest = document.getElementById('kpi-cost-interest');
        if (data.total_interesse > 0) {
            costInterest.textContent = `U$ ${data.custo_por_interesse.toFixed(2)}`;
        } else {
            costInterest.textContent = 'U$ 0.00';
        }
        
        // Gauge statistics under Fatigue tab
        document.getElementById('val-avg-density').textContent = data.avg_density.toFixed(2);
        document.getElementById('val-avg-pressure').textContent = data.avg_pressure.toFixed(2);
    } catch (err) {
        console.error('Erro ao buscar métricas:', err);
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

        // Update total calls volume outside the funnel (using the subtitle of the first KPI or a dedicated area if needed)
        // For now, let's update the KPI subtitle for total calls to show the volume
        const totalCallsKpi = document.getElementById('kpi-total-calls');
        if (totalCallsKpi && data.total_calls_volume !== undefined) {
            totalCallsKpi.textContent = data.total_calls_volume.toLocaleString();
        }
        
        // Calculate conversions relative to initial Leads
        const percentages = values.map(val => {
            return data.leads_totais > 0 ? ((val / data.leads_totais) * 100).toFixed(1) + '%' : '0.0%';
        });
        
        const ctx = document.getElementById('chart-funnel').getContext('2d');
        
        if (state.charts.funnel) {
            state.charts.funnel.destroy();
        }
        
        state.charts.funnel = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: stages,
                datasets: [{
                    label: 'Volume de Conversão',
                    data: values,
                    backgroundColor: [
                        '#818cf8', // Indigo
                        '#0ea5e9', // Sky Blue
                        '#a855f7', // Purple
                        '#10b981'  // Green
                    ],
                    borderRadius: 8,
                    borderWidth: 0,
                    barThickness: 28
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const val = context.raw;
                                const idx = context.dataIndex;
                                return ` Leads: ${val.toLocaleString()} (${percentages[idx]} do Funil)`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#9ca3af' }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { color: '#f3f4f6', font: { weight: 600 } }
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
        
        if (isDetailed) {
            // Render Granular List
            detailedView.innerHTML = '';
            
            if (data.length === 0) {
                detailedView.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px;">Nenhum dado encontrado</div>';
                return;
            }
            
            const categoryColors = {
                'Conversa Normal': '#10b981',
                'Não Atendeu': '#f59e0b',
                'Bloqueado': '#ef4444',
                'Erro Técnico': '#a855f7',
                'Ocupado': '#0ea5e9'
            };
            
            const categoryMap = {
                'Conversa Normal': 'normal',
                'Não Atendeu': 'no-answer',
                'Bloqueado': 'blocked',
                'Erro Técnico': 'technical',
                'Ocupado': 'busy'
            };
            
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
            const percentages = data.map(c => c.percentage);
            
            const categoryLabels = {
                'Conversa Normal': 'Conversa Normal 🟢',
                'Não Atendeu': 'Não Atendeu 🟡',
                'Bloqueado': 'Bloqueado 🔴',
                'Erro Técnico': 'Erro Técnico ⚙️',
                'Ocupado': 'Ocupado 🔵'
            };
            
            // The backend now returns clean labels, we map them to labels with emojis for the chart legend
            const labels = categories.map(cat => categoryLabels[cat] || cat);
            
            // Match color scheme
            const categoryColors = {
                'Conversa Normal': '#10b981',
                'Não Atendeu': '#f59e0b',
                'Bloqueado': '#ef4444',
                'Erro Técnico': '#a855f7',
                'Ocupado': '#0ea5e9'
            };
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
                        borderColor: '#0d0f22',
                        borderWidth: 2,
                        cutout: '72%'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: '#9ca3af',
                                boxWidth: 10,
                                padding: 12,
                                font: { size: 11 }
                            }
                        },
                        tooltip: {
                            callbacks: {
                                label: (context) => {
                                    const val = context.raw;
                                    const idx = context.dataIndex;
                                    return ` Ligações: ${val.toLocaleString()} (${percentages[idx]}%)`;
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
        
        const hours = data.map(d => d.hour);
        const calls = data.map(d => d.call_count);
        const conversion = data.map(d => d.conversion_rate);
        
        const ctx = document.getElementById('chart-hourly').getContext('2d');
        
        if (state.charts.hourly) {
            state.charts.hourly.destroy();
        }
        
        state.charts.hourly = new Chart(ctx, {
            type: 'line',
            data: {
                labels: hours,
                datasets: [
                    {
                        label: 'Taxa de Interesse (%)',
                        data: conversion,
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.05)',
                        borderWidth: 3,
                        yAxisID: 'y1',
                        tension: 0.3,
                        fill: true,
                        pointBackgroundColor: '#10b981',
                        pointHoverRadius: 6
                    },
                    {
                        label: 'Volume de Ligações',
                        data: calls,
                        backgroundColor: 'rgba(99, 102, 241, 0.25)',
                        borderColor: '#6366f1',
                        borderWidth: 1.5,
                        yAxisID: 'y',
                        type: 'bar',
                        borderRadius: 4,
                        barThickness: 16
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { color: '#9ca3af', boxWidth: 12 }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.03)' },
                        ticks: { color: '#9ca3af' }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#9ca3af' },
                        title: { display: true, text: 'Volume de Tentativas', color: '#9ca3af' }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: { 
                            color: '#10b981',
                            callback: (val) => `${val}%`
                        },
                        title: { display: true, text: 'Taxa de Conversão', color: '#10b981' }
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
        
        state.charts.fatigue = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: buckets,
                datasets: [
                    {
                        label: 'Taxa de Interesse do Lead (%)',
                        data: conversions,
                        borderColor: '#a855f7',
                        borderWidth: 3,
                        yAxisID: 'y1',
                        type: 'line',
                        tension: 0.3,
                        pointBackgroundColor: '#a855f7',
                        pointHoverRadius: 7,
                        pointHoverBorderColor: '#fff'
                    },
                    {
                        label: 'Volume de Contatos Feitos',
                        data: calls,
                        backgroundColor: 'rgba(99, 102, 241, 0.2)',
                        borderColor: '#6366f1',
                        borderWidth: 1.5,
                        yAxisID: 'y',
                        borderRadius: 6,
                        barThickness: 36
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { color: '#9ca3af', boxWidth: 12 }
                    },
                    tooltip: {
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
                        grid: { color: 'rgba(255, 255, 255, 0.03)' },
                        ticks: { color: '#f3f4f6', font: { weight: 500 } }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#9ca3af' },
                        title: { display: true, text: 'Volume de Tentativas', color: '#9ca3af' }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: { 
                            color: '#a855f7',
                            callback: (val) => `${val}%`
                        },
                        title: { display: true, text: 'Taxa de Interesse (%)', color: '#a855f7' }
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

async function loadAuditCalls() {
    const tbody = document.querySelector('.audit-table tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="loading-td"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;display:inline-block;">pending</span> Buscando ligações...</td></tr>';
    
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
            tbody.innerHTML = '<tr><td colspan="7" class="loading-td">Nenhuma ligação encontrada para os filtros selecionados.</td></tr>';
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
                <td style="font-family: monospace;">U$ ${call.combined_cost.toFixed(3)}</td>
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
        tbody.innerHTML = '<tr><td colspan="7" class="loading-td" style="color: var(--error);">Erro ao carregar ligações do servidor.</td></tr>';
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
    document.getElementById('player-meta-cost').textContent = `U$ ${call.combined_cost.toFixed(3)}`;
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
