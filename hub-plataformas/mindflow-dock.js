/**
 * MindFlow Global Floating Call Dock System
 * Maintains active/recent call widgets persistent across all hub pages (disparo, dashboard, index, etc.).
 * Stackable up to 5 items + Overflow Counter for > 5 calls.
 */

(function () {
  const DOCK_STORAGE_KEY = 'mindflow_dock_calls';

  // Inject CSS styles into document head
  function injectStyles() {
    if (document.getElementById('mindflowDockStyles')) return;
    const style = document.createElement('style');
    style.id = 'mindflowDockStyles';
    style.textContent = `
      .mindflow-call-dock-container {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        display: flex;
        flex-direction: column-reverse;
        gap: 8px;
        width: 320px;
        max-width: calc(100vw - 32px);
        font-family: 'Space Grotesk', sans-serif;
        pointer-events: auto;
      }

      .mindflow-dock-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: rgba(8, 14, 26, 0.94);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 14px;
        padding: 10px 14px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 16px rgba(0, 181, 160, 0.15);
        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        position: relative;
        overflow: hidden;
      }
      .mindflow-dock-card:hover {
        border-color: rgba(0, 181, 160, 0.45);
        transform: translateY(-2px);
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.6), 0 0 24px rgba(0, 181, 160, 0.25);
      }

      .mindflow-dock-card.status-ended {
        border-color: rgba(239, 68, 68, 0.25);
      }
      .mindflow-dock-card.status-ended:hover {
        border-color: rgba(239, 68, 68, 0.5);
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.6), 0 0 20px rgba(239, 68, 68, 0.2);
      }

      .mindflow-dock-card.status-warning {
        border-color: rgba(245, 158, 11, 0.25);
      }

      .dock-card-left {
        display: flex;
        align-items: center;
        gap: 10px;
        cursor: pointer;
        flex: 1;
        min-width: 0;
      }

      .dock-status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
        transition: all 0.3s ease;
      }
      .dock-status-dot.dot-ongoing {
        background: #00B5A0;
        box-shadow: 0 0 10px #00B5A0;
        animation: dockPulse 1.4s infinite ease-in-out;
      }
      .dock-status-dot.dot-ended {
        background: #EF4444;
        box-shadow: 0 0 8px #EF4444;
      }
      .dock-status-dot.dot-warning {
        background: #F59E0B;
        box-shadow: 0 0 8px #F59E0B;
      }

      @keyframes dockPulse {
        0% { transform: scale(0.95); opacity: 0.8; }
        50% { transform: scale(1.25); opacity: 1; }
        100% { transform: scale(0.95); opacity: 0.8; }
      }

      .dock-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
      }

      .dock-name {
        font-size: 13px;
        font-weight: 700;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        letter-spacing: -0.01em;
      }

      .dock-sub-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        font-size: 11px;
      }
      .dock-status-lbl {
        color: rgba(255, 255, 255, 0.55);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dock-timer {
        color: #00B5A0;
        font-weight: 600;
        font-family: 'Space Grotesk', monospace;
      }
      .status-ended .dock-timer { color: #EF4444; }
      .status-warning .dock-timer { color: #F59E0B; }

      .dock-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: 6px;
      }
      .dock-btn-icon {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.7);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        margin: 0;
        line-height: 1;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        box-sizing: border-box;
      }
      .dock-btn-icon:hover {
        background: rgba(0, 181, 160, 0.2);
        color: #00B5A0;
        border-color: rgba(0, 181, 160, 0.4);
      }
      .dock-btn-icon.close:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #EF4444;
        border-color: rgba(239, 68, 68, 0.4);
      }
      .dock-btn-icon span {
        font-size: 15px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 15px;
        height: 15px;
      }

      .mindflow-dock-overflow-pill {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: rgba(14, 22, 38, 0.95);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        padding: 8px 12px;
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      }
      .overflow-text {
        display: flex;
        align-items: center;
        gap: 6px;
        color: #00B5A0;
      }
      .overflow-text span.material-symbols-outlined { font-size: 16px; }

      .mindflow-dock-overflow-box {
        background: rgba(6, 10, 20, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 180px;
        overflow-y: auto;
      }
      .overflow-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.03);
        font-size: 11px;
      }
      .overflow-item-name { color: #fff; font-weight: 600; }
      .overflow-item-timer { color: #8E8FA2; font-family: monospace; }
    `;
    document.head.appendChild(style);
  }

  // Get active dock calls
  function getDockCalls() {
    try {
      const data = localStorage.getItem(DOCK_STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  // Save dock calls
  function saveDockCalls(calls) {
    try {
      localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(calls));
      window.dispatchEvent(new Event('mindflow_dock_updated'));
    } catch (e) {}
  }

  // Global helper to add or update call in dock
  window.mindflowDockAddCall = function (callObj) {
    if (!callObj || (!callObj.id && !callObj.executionId)) return;
    let calls = getDockCalls();
    const targetId = callObj.id || callObj.executionId;
    const idx = calls.findIndex(c => c.id === targetId || (c.executionId && c.executionId === callObj.executionId));

    const updatedItem = {
      id: targetId,
      executionId: callObj.executionId || '',
      leadName: callObj.leadName || 'Pedro Ernesto',
      phone: callObj.phone || '',
      agentName: callObj.agentName || 'Agente',
      status: callObj.status || 'ringing', // ringing, in_progress, ended, error
      statusLabel: callObj.statusLabel || 'Discando...',
      disconnectionReason: callObj.disconnectionReason || '',
      timer: callObj.timer || '00:00',
      timestamp: Date.now()
    };

    if (idx >= 0) {
      calls[idx] = { ...calls[idx], ...updatedItem };
    } else {
      calls.unshift(updatedItem);
    }

    saveDockCalls(calls);
    renderDock();
  };

  // Remove call from dock
  window.mindflowDockRemoveCall = function (id) {
    let calls = getDockCalls();
    calls = calls.filter(c => c.id !== id && c.executionId !== id);
    saveDockCalls(calls);
    renderDock();
  };

  let overflowExpanded = false;

  function renderDock() {
    injectStyles();
    let container = document.getElementById('mindflowGlobalCallDock');
    const calls = getDockCalls();

    if (!calls || calls.length === 0) {
      if (container) container.style.display = 'none';
      return;
    }

    if (!container) {
      container = document.createElement('div');
      container.id = 'mindflowGlobalCallDock';
      container.className = 'mindflow-call-dock-container';
      document.body.appendChild(container);
    }

    container.style.display = 'flex';
    container.innerHTML = '';

    const MAX_VISIBLE = 5;
    const visibleCalls = calls.slice(0, MAX_VISIBLE);
    const overflowCalls = calls.slice(MAX_VISIBLE);

    // Overflow pill if > 5 calls
    if (overflowCalls.length > 0) {
      const overflowPill = document.createElement('div');
      overflowPill.className = 'mindflow-dock-overflow-pill';
      overflowPill.innerHTML = `
        <div class="overflow-text">
          <span class="material-symbols-outlined">layers</span>
          <span>+${overflowCalls.length} chamadas no histórico</span>
        </div>
        <button type="button" class="dock-btn-icon" onclick="mindflowToggleDockOverflow()" title="Alternar Lista">
          <span class="material-symbols-outlined">${overflowExpanded ? 'expand_more' : 'expand_less'}</span>
        </button>
      `;
      container.appendChild(overflowPill);

      if (overflowExpanded) {
        const overflowBox = document.createElement('div');
        overflowBox.className = 'mindflow-dock-overflow-box';
        overflowCalls.forEach(call => {
          const item = document.createElement('div');
          item.className = 'overflow-item';
          item.innerHTML = `
            <span class="overflow-item-name">${escapeHtml(call.leadName)}</span>
            <span class="overflow-item-timer">${escapeHtml(call.timer)}</span>
            <button type="button" class="dock-btn-icon close" onclick="mindflowDockRemoveCall('${call.id}')"><span class="material-symbols-outlined">close</span></button>
          `;
          overflowBox.appendChild(item);
        });
        container.appendChild(overflowBox);
      }
    }

    // Visible cards (up to 5)
    visibleCalls.forEach(call => {
      const card = document.createElement('div');
      card.className = `mindflow-dock-card status-${call.status || 'ringing'}`;

      let dotClass = 'dot-warning';
      if (call.status === 'in_progress') dotClass = 'dot-ongoing';
      else if (call.status === 'ended') dotClass = 'dot-ended';

      card.innerHTML = `
        <div class="dock-card-left" onclick="mindflowDockExpandCall('${call.id}')">
          <div class="dock-status-dot ${dotClass}"></div>
          <div class="dock-info">
            <span class="dock-name" title="${escapeHtml(call.leadName)} (${escapeHtml(call.phone)})">${escapeHtml(call.leadName)}</span>
            <div class="dock-sub-row">
              <span class="dock-status-lbl">${escapeHtml(call.statusLabel || 'Discando...')}</span>
              <span class="dock-timer">${escapeHtml(call.timer || '00:00')}</span>
            </div>
          </div>
        </div>
        <div class="dock-actions">
          <button type="button" class="dock-btn-icon" onclick="mindflowDockExpandCall('${call.id}')" title="Expandir Chamada">
            <span class="material-symbols-outlined">open_in_full</span>
          </button>
          <button type="button" class="dock-btn-icon close" onclick="mindflowDockRemoveCall('${call.id}')" title="Fechar Item">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      `;
      container.appendChild(card);
    });
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.mindflowToggleDockOverflow = function () {
    overflowExpanded = !overflowExpanded;
    renderDock();
  };

  window.mindflowDockExpandCall = function (id) {
    if (window.location.pathname.includes('disparo')) {
      if (typeof expandLiveModal === 'function') expandLiveModal();
    } else {
      window.location.href = `/disparo.html?call_id=${encodeURIComponent(id)}`;
    }
  };

  window.addEventListener('storage', (e) => {
    if (e.key === DOCK_STORAGE_KEY) renderDock();
  });
  window.addEventListener('mindflow_dock_updated', renderDock);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderDock);
  } else {
    renderDock();
  }
})();
