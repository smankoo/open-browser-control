/**
 * Side panel UI controller.
 * Communicates with the background service worker to display state
 * and handle user interactions.
 */

import type { SessionState, ControlMode, ActionLogEntry } from '../types/protocol';

// ─── DOM Elements ────────────────────────────────────────────────────────────

const statusBadge = document.getElementById('status-badge')!;
const portInput = document.getElementById('port-input') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn')!;
const autoConnectCheckbox = document.getElementById('auto-connect-checkbox') as HTMLInputElement;
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

// Listen for state updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.source === 'background' && message.type === 'state_update') {
    currentState = message.data as SessionState;
    render();
  }
});

// ─── Event Handlers ──────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  if (currentState?.connected) {
    await sendToBackground('disconnect');
  } else {
    const port = parseInt(portInput.value, 10);
    await sendToBackground('connect', { port });
    // Save port
    chrome.storage.local.set({ bridgePort: port });
  }
});

autoConnectCheckbox.addEventListener('change', () => {
  chrome.storage.local.set({ autoConnect: autoConnectCheckbox.checked });
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

  // Status badge
  if (currentState.connected) {
    statusBadge.textContent = 'Connected';
    statusBadge.className = 'badge connected';
    connectBtn.textContent = 'Disconnect';
    connectBtn.classList.add('btn-danger');
    connectBtn.classList.remove('btn-primary');
  } else {
    statusBadge.textContent = 'Disconnected';
    statusBadge.className = 'badge disconnected';
    connectBtn.textContent = 'Connect';
    connectBtn.classList.remove('btn-danger');
    connectBtn.classList.add('btn-primary');
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
    actionLog.innerHTML = '<div class="log-empty">No activity yet. Connect to a bridge server to start.</div>';
    return;
  }

  // Only render the last 50 entries
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

  // Scroll to bottom
  actionLog.scrollTop = actionLog.scrollHeight;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Load saved settings
  const stored = await chrome.storage.local.get(['bridgePort', 'autoConnect']);
  if (stored.bridgePort) portInput.value = String(stored.bridgePort);
  if (stored.autoConnect) autoConnectCheckbox.checked = true;

  // Get initial state
  try {
    const state = await sendToBackground('get_state');
    if (state) {
      currentState = state as SessionState;
      render();
    }
  } catch {
    // Background may not be ready
  }
}

init();
