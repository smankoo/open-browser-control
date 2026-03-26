/**
 * Side panel UI — shows connection status, active sessions, and activity log.
 */

import type { ExtensionState, AgentSession, ControlMode, ActionLogEntry } from '../types/protocol';

// ─── DOM Elements ────────────────────────────────────────────────────────────

const statusBadge = document.getElementById('status-badge')!;
const statusDot = document.querySelector('.status-dot')!;
const statusMessage = document.getElementById('status-message')!;
const statusHint = document.getElementById('status-hint')!;
const portDisplay = document.getElementById('port-display')!;
const portInput = document.getElementById('port-input') as HTMLInputElement;
const savePortBtn = document.getElementById('save-port-btn')!;
const reconnectBtn = document.getElementById('reconnect-btn')!;
const sessionsContainer = document.getElementById('sessions-container')!;
const actionLog = document.getElementById('action-log')!;
const clearLogBtn = document.getElementById('clear-log-btn')!;

// ─── State ───────────────────────────────────────────────────────────────────

let currentState: ExtensionState | null = null;

// ─── Background Communication ────────────────────────────────────────────────

function sendToBackground(type: string, data?: Record<string, unknown>): Promise<unknown> {
  return chrome.runtime.sendMessage({ source: 'sidepanel', type, ...data });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.source === 'background' && message.type === 'state_update') {
    currentState = message.data as ExtensionState;
    render();
  }
});

// ─── Event Handlers ──────────────────────────────────────────────────────────

savePortBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  if (port >= 1024 && port <= 65535) {
    await chrome.storage.local.set({ bridgePort: port });
    portDisplay.textContent = String(port);
    await sendToBackground('disconnect');
    await sendToBackground('connect', { port });
  }
});

reconnectBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  await sendToBackground('disconnect');
  await sendToBackground('connect', { port });
});

clearLogBtn.addEventListener('click', () => {
  actionLog.innerHTML = '<div class="log-empty">Log cleared.</div>';
});

// Delegate clicks on session controls
sessionsContainer.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  // Mode buttons
  const modeBtn = target.closest('.mode-btn') as HTMLElement | null;
  if (modeBtn) {
    const sessionId = modeBtn.dataset.session!;
    const mode = modeBtn.dataset.mode as ControlMode;
    sendToBackground('set_control_mode', { sessionId, data: mode });
    return;
  }

  // User done button
  const doneBtn = target.closest('.user-done-btn') as HTMLElement | null;
  if (doneBtn) {
    const sessionId = doneBtn.dataset.session!;
    const textarea = sessionsContainer.querySelector(`textarea[data-session="${sessionId}"]`) as HTMLTextAreaElement | null;
    const message = textarea?.value?.trim() || '';
    sendToBackground('set_control_mode', {
      sessionId,
      data: 'collaborative' as ControlMode,
      userMessage: message || undefined,
    });
    if (textarea) textarea.value = '';
  }
});

// ─── Render ──────────────────────────────────────────────────────────────────

function render(): void {
  if (!currentState) return;

  // Connection status
  if (currentState.connected) {
    const count = currentState.sessions.length;
    statusBadge.textContent = count > 0 ? `${count} agent${count > 1 ? 's' : ''}` : 'Connected';
    statusBadge.className = 'badge connected';
    statusDot.className = 'status-dot connected';
    statusMessage.textContent = count > 0
      ? `${count} agent session${count > 1 ? 's' : ''} active`
      : 'Bridge connected, waiting for agents';
    statusHint.textContent = '';
  } else {
    statusBadge.textContent = 'Waiting for agent...';
    statusBadge.className = 'badge disconnected';
    statusDot.className = 'status-dot disconnected';
    statusMessage.innerHTML = `Waiting for agent on port <strong>${portDisplay.textContent}</strong>`;
    statusHint.textContent = 'Auto-connects when an agent starts.';
  }

  // Sessions
  renderSessions(currentState.sessions);

  // Action log
  renderLog(currentState.actionLog);
}

function renderSessions(sessions: AgentSession[]): void {
  if (sessions.length === 0) {
    if (currentState?.connected) {
      sessionsContainer.innerHTML = '<div class="no-sessions">Bridge connected. Waiting for agent sessions...</div>';
    } else {
      sessionsContainer.innerHTML = '';
    }
    return;
  }

  sessionsContainer.innerHTML = sessions.map((session) => {
    const userActionHtml = session.pendingUserAction ? `
      <div class="user-action-alert">
        <h3>AI needs your help</h3>
        <p>${escapeHtml(session.pendingUserAction)}</p>
        <textarea data-session="${session.id}" placeholder="Optional: describe what you did..." rows="2"></textarea>
        <button class="btn btn-primary btn-block user-done-btn" data-session="${session.id}">Done - Hand back to AI</button>
      </div>
    ` : '';

    return `
      <section class="session-card">
        <div class="session-header">
          <span class="session-name">${escapeHtml(session.name)}</span>
          <span class="session-id">${session.id}</span>
        </div>
        <div class="control-modes">
          <button class="mode-btn ${session.controlMode === 'collaborative' ? 'active' : ''}"
                  data-session="${session.id}" data-mode="collaborative" title="Both user and AI">
            <span class="mode-icon">&#x1f91d;</span><span>Collab</span>
          </button>
          <button class="mode-btn ${session.controlMode === 'ai' ? 'active' : ''}"
                  data-session="${session.id}" data-mode="ai" title="AI has full control">
            <span class="mode-icon">&#x1f916;</span><span>AI</span>
          </button>
          <button class="mode-btn ${session.controlMode === 'user' ? 'active' : ''}"
                  data-session="${session.id}" data-mode="user" title="User has control">
            <span class="mode-icon">&#x1f464;</span><span>User</span>
          </button>
        </div>
        ${userActionHtml}
      </section>
    `;
  }).join('');
}

function renderLog(entries: ActionLogEntry[]): void {
  if (entries.length === 0) {
    actionLog.innerHTML = '<div class="log-empty">Waiting for agent to connect...</div>';
    return;
  }

  const recent = entries.slice(-50);
  actionLog.innerHTML = recent.map((entry) => {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const sessionLabel = entry.session
      ? `<span class="log-session">${entry.session.slice(0, 4)}</span>`
      : '';

    return `
      <div class="log-entry">
        <div class="log-status ${entry.status}"></div>
        <span class="log-source ${entry.source}">${entry.source}</span>
        ${sessionLabel}
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
  const stored = await chrome.storage.local.get(['bridgePort']);
  if (stored.bridgePort) {
    portInput.value = String(stored.bridgePort);
    portDisplay.textContent = String(stored.bridgePort);
  }

  try {
    const state = await sendToBackground('get_state');
    if (state) {
      currentState = state as ExtensionState;
      render();
    }
  } catch {}
}

init();
