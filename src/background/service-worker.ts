/**
 * Background service worker for the Kiro Browser Use extension.
 *
 * Responsibilities:
 * - Manages WebSocket connection to bridge server
 * - Routes agent actions to browser-actions module
 * - Manages user/AI control handoff
 * - Maintains session state
 * - Communicates with side panel and content scripts
 */

import { WebSocketBridge, type ConnectionStatus } from '../bridge/websocket-bridge';
import { executeAction, getToolSchema, markDetached } from '../actions/browser-actions';
import type {
  AgentMessage,
  ExtensionMessage,
  SessionState,
  ActionLogEntry,
  ControlMode,
} from '../types/protocol';

// ─── State ───────────────────────────────────────────────────────────────────

const state: SessionState = {
  connected: false,
  controlMode: 'collaborative',
  activeTabId: null,
  debuggerAttached: false,
  actionLog: [],
  pendingUserAction: null,
};

function addLog(entry: Omit<ActionLogEntry, 'timestamp'>): void {
  state.actionLog.push({ ...entry, timestamp: Date.now() });
  // Keep log bounded
  if (state.actionLog.length > 200) {
    state.actionLog = state.actionLog.slice(-100);
  }
  broadcastState();
}

// ─── WebSocket Bridge ────────────────────────────────────────────────────────

const bridge = new WebSocketBridge({
  onMessage: handleAgentMessage,
  onStatusChange: handleStatusChange,
});

function handleStatusChange(status: ConnectionStatus): void {
  const wasConnected = state.connected;
  state.connected = status === 'connected';

  // Only log transitions, not every poll attempt
  if (status === 'connected' && !wasConnected) {
    addLog({ source: 'system', action: 'Agent connected', status: 'success' });
  } else if (status === 'disconnected' && wasConnected) {
    addLog({ source: 'system', action: 'Agent disconnected', status: 'pending' });
  }

  broadcastState();
}

async function handleAgentMessage(message: AgentMessage): Promise<void> {
  if (message.type === 'ping') {
    bridge.send({ type: 'pong' } as ExtensionMessage);
    return;
  }

  if (message.type === 'get_tool_schema') {
    bridge.send({
      type: 'tool_schema',
      id: message.id,
      tools: getToolSchema(),
    } as ExtensionMessage);
    return;
  }

  if (message.type !== 'action') return;

  // Check if user has control
  if (state.controlMode === 'user') {
    bridge.send({
      type: 'result',
      id: message.id,
      success: false,
      error: 'User currently has control. Wait for user to hand back control.',
    } as ExtensionMessage);
    return;
  }

  // Handle request_user specially
  if (message.action === 'request_user') {
    state.pendingUserAction = message.params.message;
    state.controlMode = 'user';
    addLog({
      source: 'ai',
      action: 'request_user',
      details: message.params.message,
      status: 'pending',
    });

    // Notify side panel
    broadcastState();

    // Show notification
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Kiro needs your help',
        message: message.params.message,
      });
    } catch {
      // Notifications may not be available
    }

    // Set up timeout if specified
    if (message.params.timeout) {
      setTimeout(() => {
        if (state.controlMode === 'user' && state.pendingUserAction === message.params.message) {
          state.controlMode = 'collaborative';
          state.pendingUserAction = null;
          bridge.send({
            type: 'result',
            id: message.id,
            success: true,
            data: { userAction: 'timeout', message: 'User did not respond in time, auto-resuming' },
          } as ExtensionMessage);
          broadcastState();
        }
      }, message.params.timeout);
    }

    // Store the action id so we can respond when user is done
    pendingUserActionId = message.id;
    return;
  }

  // Get active tab
  const tabId = state.activeTabId ?? (await getActiveTabId());
  if (!tabId) {
    bridge.send({
      type: 'result',
      id: message.id,
      success: false,
      error: 'No active tab found',
    } as ExtensionMessage);
    return;
  }

  state.activeTabId = tabId;

  addLog({
    source: 'ai',
    action: message.action,
    details: JSON.stringify((message as { params?: unknown }).params ?? {}).slice(0, 200),
    status: 'pending',
  });

  // Execute the action
  const result = await executeAction(message, tabId);

  // Update log
  const lastLog = state.actionLog[state.actionLog.length - 1];
  if (lastLog) {
    lastLog.status = result.success ? 'success' : 'error';
  }

  bridge.send(result);
  broadcastState();
}

let pendingUserActionId: string | null = null;

// ─── Tab Management ──────────────────────────────────────────────────────────

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

// Track active tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  state.activeTabId = activeInfo.tabId;
  broadcastState();

  if (state.connected) {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    bridge.send({
      type: 'event',
      event: 'page_navigated',
      data: { url: tab.url ?? '', title: tab.title ?? '', tabId: activeInfo.tabId },
    } as ExtensionMessage);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === state.activeTabId && changeInfo.status === 'complete' && state.connected) {
    chrome.tabs.get(tabId).then((tab) => {
      bridge.send({
        type: 'event',
        event: 'page_navigated',
        data: { url: tab.url ?? '', title: tab.title ?? '', tabId },
      } as ExtensionMessage);
    });
  }
});

// Clean up debugger on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  markDetached(tabId);
  if (tabId === state.activeTabId) {
    state.activeTabId = null;
  }
});

// ─── Side Panel Communication ────────────────────────────────────────────────

function broadcastState(): void {
  chrome.runtime.sendMessage({
    source: 'background',
    type: 'state_update',
    data: state,
  }).catch(() => {
    // Side panel may not be open
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.source === 'content' && message.type === 'content_loaded') {
    // Content script loaded in a tab
    return;
  }

  if (message.source !== 'sidepanel') return true;

  switch (message.type) {
    case 'get_state':
      sendResponse(state);
      break;

    case 'connect':
      if (message.port) bridge.setPort(message.port);
      bridge.connect();
      sendResponse({ ok: true });
      break;

    case 'disconnect':
      bridge.disconnect();
      sendResponse({ ok: true });
      break;

    case 'set_control_mode': {
      const newMode = message.data as ControlMode;
      const oldMode = state.controlMode;
      state.controlMode = newMode;

      // If user was in control and hands back
      if (oldMode === 'user' && newMode !== 'user' && pendingUserActionId) {
        bridge.send({
          type: 'result',
          id: pendingUserActionId,
          success: true,
          data: {
            userAction: 'completed',
            message: message.userMessage ?? 'User finished the requested action',
          },
        } as ExtensionMessage);
        pendingUserActionId = null;
        state.pendingUserAction = null;

        bridge.send({
          type: 'event',
          event: 'user_done',
          data: { message: message.userMessage ?? '' },
        } as ExtensionMessage);
      }

      // If user takes control
      if (newMode === 'user' && oldMode !== 'user') {
        bridge.send({
          type: 'event',
          event: 'user_handoff',
          data: { message: 'User took control' },
        } as ExtensionMessage);
      }

      addLog({
        source: 'user',
        action: `Control mode: ${newMode}`,
        status: 'success',
      });
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'set_active_tab':
      state.activeTabId = message.tabId;
      broadcastState();
      sendResponse({ ok: true });
      break;
  }

  return true;
});

// ─── Extension Icon Click → Open Side Panel ──────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// Enable side panel to open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Startup ─────────────────────────────────────────────────────────────────

// Auto-connect on startup. The extension always tries to reach the bridge.
// If the bridge isn't running yet, the reconnect logic retries with backoff
// until it comes up. No manual "Connect" click needed.
chrome.storage.local.get(['bridgePort'], (result) => {
  if (result.bridgePort) {
    bridge.setPort(result.bridgePort as number);
  }
  bridge.connect();
});

console.log('[KiroBrowserUse] Background service worker started');
