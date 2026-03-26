/**
 * Background service worker for the Kiro Browser Use extension.
 *
 * Manages multiple agent sessions, each with its own Chrome tab group.
 * Actions from agent A only affect tabs in agent A's tab group.
 */

import { WebSocketBridge } from '../bridge/websocket-bridge';
import { executeAction, getToolSchema, markDetached } from '../actions/browser-actions';
import type {
  AgentMessage,
  ExtensionMessage,
  AgentSession,
  ExtensionState,
  ActionLogEntry,
  ControlMode,
} from '../types/protocol';

// ─── State ───────────────────────────────────────────────────────────────────

const sessions = new Map<string, AgentSession>();
const actionLog: ActionLogEntry[] = [];

function getState(): ExtensionState {
  return {
    connected: bridge.status === 'connected',
    sessions: Array.from(sessions.values()),
    actionLog,
  };
}

function addLog(entry: Omit<ActionLogEntry, 'timestamp'>): void {
  actionLog.push({ ...entry, timestamp: Date.now() });
  if (actionLog.length > 200) {
    actionLog.splice(0, actionLog.length - 100);
  }
  broadcastState();
}

// ─── WebSocket Bridge ────────────────────────────────────────────────────────

const bridge = new WebSocketBridge({
  onMessage: handleBridgeMessage,
  onStatusChange: (status) => {
    const wasConnected = getState().connected;
    const isConnected = status === 'connected';

    if (isConnected && !wasConnected) {
      addLog({ source: 'system', action: 'Connected to bridge', status: 'success' });
    } else if (!isConnected && wasConnected) {
      // Bridge went down — clear all sessions
      for (const [sessionId, session] of sessions) {
        cleanupSession(sessionId, session);
      }
      sessions.clear();
      addLog({ source: 'system', action: 'Disconnected from bridge', status: 'pending' });
    }
    broadcastState();
  },
});

// ─── Session Management ──────────────────────────────────────────────────────

async function createSession(sessionId: string, name: string): Promise<void> {
  if (sessions.has(sessionId)) return;

  // Create a tab group for this session
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  let tabGroupId: number | null = null;

  if (tab.id) {
    try {
      tabGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(tabGroupId, {
        title: name,
        color: pickColor(sessions.size),
        collapsed: false,
      });
    } catch {
      // Tab groups may not be supported
    }
  }

  const session: AgentSession = {
    id: sessionId,
    name,
    tabGroupId,
    activeTabId: tab.id ?? null,
    controlMode: 'collaborative',
    pendingUserAction: null,
    pendingUserActionId: null,
  };

  sessions.set(sessionId, session);
  addLog({ source: 'system', session: sessionId, action: `Agent "${name}" connected`, status: 'success' });
}

function cleanupSession(sessionId: string, session: AgentSession): void {
  // Don't close tabs — user might want to keep them.
  // Just ungroup them and remove the group.
  if (session.tabGroupId !== null) {
    chrome.tabs.query({}, (tabs) => {
      const groupTabs = tabs.filter((t) => t.groupId === session.tabGroupId);
      if (groupTabs.length > 0) {
        const ids = groupTabs.map((t) => t.id!).filter(Boolean) as [number, ...number[]];
        if (ids.length > 0) chrome.tabs.ungroup(ids).catch(() => {});
      }
    });
  }
  addLog({ source: 'system', session: sessionId, action: `Agent "${session.name}" disconnected`, status: 'pending' });
}

const TAB_GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;

function pickColor(index: number): typeof TAB_GROUP_COLORS[number] {
  return TAB_GROUP_COLORS[index % TAB_GROUP_COLORS.length];
}

/** Get the active tab for a session (must be in the session's tab group) */
async function getSessionTab(session: AgentSession): Promise<number | null> {
  if (session.activeTabId) {
    try {
      const tab = await chrome.tabs.get(session.activeTabId);
      // Tab still exists and is in the right group (or no group tracking)
      if (session.tabGroupId === null || tab.groupId === session.tabGroupId) {
        return session.activeTabId;
      }
    } catch {
      // Tab was closed
    }
  }

  // Find any tab in this session's group
  if (session.tabGroupId !== null) {
    const tabs = await chrome.tabs.query({});
    const groupTab = tabs.find((t) => t.groupId === session.tabGroupId);
    if (groupTab?.id) {
      session.activeTabId = groupTab.id;
      return groupTab.id;
    }
  }

  return null;
}

// ─── Message Handling ────────────────────────────────────────────────────────

async function handleBridgeMessage(message: AgentMessage): Promise<void> {
  if (message.type === 'ping') {
    bridge.send({ type: 'pong' } as ExtensionMessage);
    return;
  }

  // Session lifecycle
  if (message.type === 'session_start') {
    await createSession(message.session, message.name);
    broadcastState();
    return;
  }

  if (message.type === 'session_end') {
    const session = sessions.get(message.session);
    if (session) {
      cleanupSession(message.session, session);
      sessions.delete(message.session);
      broadcastState();
    }
    return;
  }

  if (message.type === 'session_update') {
    const session = sessions.get(message.session);
    if (session) {
      session.name = message.name;
      // Update the Chrome tab group title
      if (session.tabGroupId !== null) {
        try {
          await chrome.tabGroups.update(session.tabGroupId, { title: message.name });
        } catch {
          // Tab group may have been closed
        }
      }
      addLog({ source: 'system', session: message.session, action: `Session renamed to "${message.name}"`, status: 'success' });
      broadcastState();
    }
    return;
  }

  // Tool schema (session-scoped)
  if (message.type === 'get_tool_schema') {
    bridge.send({
      type: 'tool_schema',
      id: message.id,
      session: message.session,
      tools: getToolSchema(),
    } as ExtensionMessage);
    return;
  }

  if (message.type !== 'action') return;

  const sessionId = message.session;
  const session = sessions.get(sessionId);

  if (!session) {
    bridge.send({
      type: 'result',
      id: message.id,
      session: sessionId,
      success: false,
      error: `Unknown session: ${sessionId}`,
    } as ExtensionMessage);
    return;
  }

  // Check control mode
  if (session.controlMode === 'user') {
    bridge.send({
      type: 'result',
      id: message.id,
      session: sessionId,
      success: false,
      error: 'User currently has control. Wait for user to hand back control.',
    } as ExtensionMessage);
    return;
  }

  // Handle request_user
  if (message.action === 'request_user') {
    session.pendingUserAction = message.params.message;
    session.pendingUserActionId = message.id;
    session.controlMode = 'user';

    addLog({
      source: 'ai',
      session: sessionId,
      action: 'request_user',
      details: message.params.message,
      status: 'pending',
    });

    try {
      chrome.notifications.create(`user-action-${sessionId}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `${session.name} needs your help`,
        message: message.params.message,
      });
    } catch {}

    if (message.params.timeout) {
      setTimeout(() => {
        if (session.controlMode === 'user' && session.pendingUserActionId === message.id) {
          session.controlMode = 'collaborative';
          session.pendingUserAction = null;
          session.pendingUserActionId = null;
          bridge.send({
            type: 'result',
            id: message.id,
            session: sessionId,
            success: true,
            data: { userAction: 'timeout', message: 'Auto-resumed after timeout' },
          } as ExtensionMessage);
          broadcastState();
        }
      }, message.params.timeout);
    }

    broadcastState();
    return;
  }

  // Handle new_tab — add to session's tab group
  if (message.action === 'new_tab') {
    const tab = await chrome.tabs.create({ url: message.params?.url ?? 'about:blank' });
    if (tab.id && session.tabGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: session.tabGroupId });
      } catch {}
    }
    session.activeTabId = tab.id ?? null;

    addLog({ source: 'ai', session: sessionId, action: 'new_tab', details: message.params?.url, status: 'success' });

    bridge.send({
      type: 'result',
      id: message.id,
      session: sessionId,
      success: true,
      data: { tabId: tab.id, url: tab.url ?? '' },
    } as ExtensionMessage);
    broadcastState();
    return;
  }

  // Handle list_tabs — only list tabs in this session's group
  if (message.action === 'list_tabs') {
    const allTabs = await chrome.tabs.query({});
    const sessionTabs = session.tabGroupId !== null
      ? allTabs.filter((t) => t.groupId === session.tabGroupId)
      : allTabs;

    bridge.send({
      type: 'result',
      id: message.id,
      session: sessionId,
      success: true,
      data: {
        tabs: sessionTabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
        })),
      },
    } as ExtensionMessage);
    return;
  }

  // Handle switch_tab — verify tab is in session's group
  if (message.action === 'switch_tab') {
    try {
      const tab = await chrome.tabs.get(message.params.tabId);
      if (session.tabGroupId !== null && tab.groupId !== session.tabGroupId) {
        bridge.send({
          type: 'result',
          id: message.id,
          session: sessionId,
          success: false,
          error: 'Tab does not belong to this session',
        } as ExtensionMessage);
        return;
      }
      await chrome.tabs.update(message.params.tabId, { active: true });
      session.activeTabId = message.params.tabId;
      bridge.send({
        type: 'result',
        id: message.id,
        session: sessionId,
        success: true,
        data: { switchedTo: message.params.tabId },
        pageState: { url: tab.url ?? '', title: tab.title ?? '', tabId: message.params.tabId },
      } as ExtensionMessage);
    } catch (err) {
      bridge.send({
        type: 'result',
        id: message.id,
        session: sessionId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as ExtensionMessage);
    }
    return;
  }

  // All other actions — get tab from session
  const tabId = await getSessionTab(session);
  if (!tabId) {
    bridge.send({
      type: 'result',
      id: message.id,
      session: sessionId,
      success: false,
      error: 'No active tab for this session',
    } as ExtensionMessage);
    return;
  }

  addLog({
    source: 'ai',
    session: sessionId,
    action: message.action,
    details: JSON.stringify((message as { params?: unknown }).params ?? {}).slice(0, 200),
    status: 'pending',
  });

  const result = await executeAction(message, tabId);

  // Tag result with session
  const taggedResult = { ...result, session: sessionId } as ExtensionMessage;

  // Update log
  const lastLog = actionLog[actionLog.length - 1];
  if (lastLog) lastLog.status = result.success ? 'success' : 'error';

  bridge.send(taggedResult);
  broadcastState();
}

// ─── Tab Tracking ────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Update the session whose tab group owns this tab
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    for (const session of sessions.values()) {
      if (session.tabGroupId !== null && tab.groupId === session.tabGroupId) {
        session.activeTabId = activeInfo.tabId;
        if (bridge.status === 'connected') {
          bridge.send({
            type: 'event',
            event: 'page_navigated',
            session: session.id,
            data: { url: tab.url ?? '', title: tab.title ?? '', tabId: activeInfo.tabId },
          } as ExtensionMessage);
        }
        break;
      }
    }
  } catch {}
  broadcastState();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  chrome.tabs.get(tabId).then((tab) => {
    for (const session of sessions.values()) {
      if (session.activeTabId === tabId && bridge.status === 'connected') {
        bridge.send({
          type: 'event',
          event: 'page_navigated',
          session: session.id,
          data: { url: tab.url ?? '', title: tab.title ?? '', tabId },
        } as ExtensionMessage);
        break;
      }
    }
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  markDetached(tabId);
  for (const session of sessions.values()) {
    if (session.activeTabId === tabId) {
      session.activeTabId = null;
    }
  }
});

// ─── Side Panel Communication ────────────────────────────────────────────────

function broadcastState(): void {
  chrome.runtime.sendMessage({
    source: 'background',
    type: 'state_update',
    data: getState(),
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.source === 'content') return true;
  if (message.source !== 'sidepanel') return true;

  switch (message.type) {
    case 'get_state':
      sendResponse(getState());
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
      const sessionId = message.sessionId as string;
      const newMode = message.data as ControlMode;
      const session = sessions.get(sessionId);
      if (!session) break;

      const oldMode = session.controlMode;
      session.controlMode = newMode;

      // User handing back control
      if (oldMode === 'user' && newMode !== 'user' && session.pendingUserActionId) {
        bridge.send({
          type: 'result',
          id: session.pendingUserActionId,
          session: sessionId,
          success: true,
          data: {
            userAction: 'completed',
            message: message.userMessage ?? 'User finished the requested action',
          },
        } as ExtensionMessage);

        bridge.send({
          type: 'event',
          event: 'user_done',
          session: sessionId,
          data: { message: message.userMessage ?? '' },
        } as ExtensionMessage);

        session.pendingUserActionId = null;
        session.pendingUserAction = null;
      }

      // User taking control
      if (newMode === 'user' && oldMode !== 'user') {
        bridge.send({
          type: 'event',
          event: 'user_handoff',
          session: sessionId,
          data: { message: 'User took control' },
        } as ExtensionMessage);
      }

      addLog({ source: 'user', session: sessionId, action: `Control: ${newMode}`, status: 'success' });
      broadcastState();
      sendResponse({ ok: true });
      break;
    }
  }

  return true;
});

// ─── Extension Icon → Open Side Panel ────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Startup ─────────────────────────────────────────────────────────────────

chrome.storage.local.get(['bridgePort'], (result) => {
  if (result.bridgePort) {
    bridge.setPort(result.bridgePort as number);
  }
  bridge.connect();
});

console.log('[KiroBrowserUse] Background service worker started');
