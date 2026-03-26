/**
 * Side panel UI controller.
 * The extension auto-connects to the bridge on startup. This panel just
 * shows what's happening and lets the user adjust control modes.
 */

import type { SessionState, ControlMode, ActionLogEntry } from '../types/protocol';

// ─── DOM Elements ────────────────────────────────────────────────────────────

const statusBadge = document.getElementById('status-badge')!;
const statusDot = document.querySelector('.status-dot')!;
const statusMessage = document.getElementById('status-message')!;
const statusHint = document.getElementById('status-hint')!;
const portDisplay = document.getElementById('port-display')!;
const portInput = document.getElementById('port-input') as HTMLInputElement;
const savePortBtn = document.getElementById('save-port-btn')!;
const reconnectBtn = document.getElementById('reconnect-btn')!;
const disconnectBtn = document.getElementById('disconnect-btn')!;
const modeButtons = document.querySelectorAll<HTMLButtonElement>('.mode-btn');
const userActionPanel = document.getElementById('user-action-panel')!;
const userActionMessage = document.getElementById('user-action-message')!;
const userDoneMessage = document.getElementById('user-done-message') as HTMLTextAreaElement;
const userDoneBtn = document.getElementById('user-done-btn')!;
const activeTabInfo = document.getElementById('active-tab-info')!;
const actionLog = document.getElementById('action-log')!;
const clearLogBtn = document.getElementById('clear-log-btn')!;

// ─── State ───────────────────────────────────────────────────────────────────

let currentState: SessionState | null = null;

// ─── Background Communication ────────────────────────────────────────────────

function sendToBackground(type: string, data?: Record<string, unknown>): Promise<unknown> {
  return chrome.runtime.sendMessage({ source: 'sidepanel', type, ...data });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.source === 'background' && message.type === 'state_update') {
    currentState = message.data as SessionState;
    render();
  }
});

// ─── Event Handlers ──────────────────────────────────────────────────────────

savePortBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  if (port >= 1024 && port <= 65535) {
    await chrome.storage.local.set({ bridgePort: port });
    portDisplay.textContent = String(port);
    // Reconnect with new port
    await sendToBackground('disconnect');
    await sendToBackground('connect', { port });
  }
});

reconnectBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  await sendToBackground('disconnect');
  await sendToBackground('connect', { port });
});

disconnectBtn.addEventListener('click', async () => {
  await sendToBackground('disconnect');
});

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode as ControlMode;
    sendToBackground('set_control_mode', { data: mode });
  });
});

userDoneBtn.addEventListener('click', async () => {
  const message = userDoneMessage.value.trim();
  await sendToBackground('set_control_mode', {
    data: 'collaborative' as ControlMode,
    userMessage: message || undefined,
  });
  userDoneMessage.value = '';
});

clearLogBtn.addEventListener('click', () => {
  actionLog.innerHTML = '<div class="log-empty">Log cleared.</div>';
});

// ─── Render ──────────────────────────────────────────────────────────────────

function render(): void {
  if (!currentState) return;

  // Connection status
  if (currentState.connected) {
    statusBadge.textContent = 'Connected';
    statusBadge.className = 'badge connected';
    statusDot.className = 'status-dot connected';
    statusMessage.innerHTML = 'Agent connected';
    statusHint.textContent = '';
    disconnectBtn.classList.remove('hidden');
  } else {
    statusBadge.textContent = 'Waiting for agent...';
    statusBadge.className = 'badge disconnected';
    statusDot.className = 'status-dot disconnected';
    statusMessage.innerHTML = `Waiting for agent on port <strong>${portDisplay.textContent}</strong>`;
    statusHint.textContent = 'Auto-connects when an agent starts. Run: npm run bridge';
    disconnectBtn.classList.add('hidden');
  }

  // Control modes
  modeButtons.forEach((btn) => {
    const mode = btn.dataset.mode as ControlMode;
    btn.classList.toggle('active', mode === currentState!.controlMode);
  });

  // User action panel
  if (currentState.pendingUserAction) {
    userActionPanel.classList.remove('hidden');
    userActionMessage.textContent = currentState.pendingUserAction;
  } else {
    userActionPanel.classList.add('hidden');
  }

  // Active tab
  if (currentState.activeTabId) {
    chrome.tabs.get(currentState.activeTabId).then((tab) => {
      activeTabInfo.innerHTML = `
        <span class="tab-title">${escapeHtml(tab.title ?? 'Untitled')}</span>
        <span class="tab-url">${escapeHtml(tab.url ?? '')}</span>
      `;
    }).catch(() => {
      activeTabInfo.innerHTML = '<span class="tab-title">Tab not found</span>';
    });
  }

  // Action log
  renderLog(currentState.actionLog);
}

function renderLog(entries: ActionLogEntry[]): void {
  if (entries.length === 0) {
    actionLog.innerHTML = '<div class="log-empty">Waiting for agent to connect...</div>';
    return;
  }

  const recent = entries.slice(-50);
  actionLog.innerHTML = recent.map((entry) => {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    return `
      <div class="log-entry">
        <div class="log-status ${entry.status}"></div>
        <span class="log-source ${entry.source}">${entry.source}</span>
        <div class="log-content">
          <div class="log-action">${escapeHtml(entry.action)}</div>
          ${entry.details ? `<div class="log-details" title="${escapeHtml(entry.details)}">${escapeHtml(entry.details)}</div>` : ''}
        </div>
        <span class="log-time">${time}</span>
      </div>
    `;
  }).join('');

  actionLog.scrollTop = actionLog.scrollHeight;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Load saved port
  const stored = await chrome.storage.local.get(['bridgePort']);
  if (stored.bridgePort) {
    portInput.value = String(stored.bridgePort);
    portDisplay.textContent = String(stored.bridgePort);
  }

  // Get initial state from background
  try {
    const state = await sendToBackground('get_state');
    if (state) {
      currentState = state as SessionState;
      render();
    }
  } catch {
    // Background may not be ready yet
  }
}

init();
