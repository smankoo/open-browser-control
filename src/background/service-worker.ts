/**
 * Background service worker for the Open Browser Control extension.
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
import { isSafeUrl } from '../utils/url-utils';
import { getInstanceId } from '../utils/instance-id';

// ─── State ───────────────────────────────────────────────────────────────────

const sessions = new Map<string, AgentSession>();
const actionLog: ActionLogEntry[] = [];

let conflictReason: string | null = null;

function getState(): ExtensionState {
  return {
    connected: bridge.status === 'connected',
    sessions: Array.from(sessions.values()).map(({ ownedTabIds: _, ...rest }) => ({
      ...rest,
      ownedTabIds: new Set<number>(),
    })),
    actionLog,
    conflictReason,
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

const bridge = new WebSocketBridge(
  {
    onMessage: handleBridgeMessage,
    onStatusChange: (status, reason) => {
      const wasConnected = getState().connected;
      const isConnected = status === 'connected';

      conflictReason = status === 'conflict' ? (reason ?? 'Port already claimed by another extension') : null;

      if (isConnected && !wasConnected) {
        addLog({ source: 'system', action: 'Connected to bridge', status: 'success' });
      } else if (!isConnected && wasConnected) {
        // Bridge went down — clear all sessions
        for (const [sessionId, session] of sessions) {
          cleanupSession(sessionId, session);
        }
        sessions.clear();
        chrome.storage.local.remove('obc_sessions').catch(() => {});
        addLog({ source: 'system', action: 'Disconnected from bridge', status: 'pending' });
      }
      if (status === 'conflict') {
        addLog({ source: 'system', action: `Bridge conflict: ${reason ?? 'port in use'}`, status: 'error' });
      }
      broadcastState();
    },
  },
  { browser: 'chrome', instanceId: 'pending' },
);

// ─── Session Management ──────────────────────────────────────────────────────

async function createSession(sessionId: string, name: string): Promise<void> {
  if (sessions.has(sessionId)) return;

  // Try to reclaim an existing tab group from a previous service worker lifecycle
  let tabGroupId: number | null = null;
  let activeTabId: number | null = null;
  const ownedTabIds = new Set<number>();

  try {
    const stored = await chrome.storage.local.get(['obc_sessions']);
    const sessionMap = stored.obc_sessions as Record<string, { tabGroupId: number | null }> | undefined;
    const savedGroupId = sessionMap?.[sessionId]?.tabGroupId;
    if (savedGroupId != null) {
      // Check if this tab group still exists
      const allTabs = await chrome.tabs.query({});
      const groupTabs = allTabs.filter((t) => t.groupId === savedGroupId);
      if (groupTabs.length > 0) {
        tabGroupId = savedGroupId;
        activeTabId = groupTabs[0].id ?? null;
        for (const t of groupTabs) {
          if (t.id) ownedTabIds.add(t.id);
        }
      }
    }
  } catch {
    // Storage read failed — no reclaim
  }

  // Don't create any tabs or groups here — wait until an action actually needs one.
  // Tabs are created on demand by getSessionTab, new_tab, new_tab_group, or navigate.

  const session: AgentSession = {
    id: sessionId,
    name,
    tabGroupId,
    activeTabId,
    controlMode: 'collaborative',
    pendingUserAction: null,
    pendingUserActionId: null,
    ownedTabIds,
  };

  sessions.set(sessionId, session);
  persistSessions();
  addLog({ source: 'system', session: sessionId, action: `Agent "${name}" connected`, status: 'success' });
}

/** Persist session→tabGroup mapping so we can reclaim groups after service worker restart */
function persistSessions(): void {
  const data: Record<string, { tabGroupId: number | null }> = {};
  for (const [id, session] of sessions) {
    data[id] = { tabGroupId: session.tabGroupId };
  }
  chrome.storage.local.set({ obc_sessions: data }).catch(() => {});
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
      // Tab still exists and belongs to this session
      const belongs = session.tabGroupId !== null
        ? tab.groupId === session.tabGroupId
        : session.ownedTabIds.has(session.activeTabId);
      if (belongs) {
        return session.activeTabId;
      }
    } catch {
      // Tab was closed — remove from owned set
      session.ownedTabIds.delete(session.activeTabId);
    }
  }

  // Find any tab in this session's group or owned set
  if (session.tabGroupId !== null) {
    const tabs = await chrome.tabs.query({});
    const groupTab = tabs.find((t) => t.groupId === session.tabGroupId);
    if (groupTab?.id) {
      session.activeTabId = groupTab.id;
      return groupTab.id;
    }
  } else if (session.ownedTabIds.size > 0) {
    for (const tabId of session.ownedTabIds) {
      try {
        await chrome.tabs.get(tabId);
        session.activeTabId = tabId;
        return tabId;
      } catch {
        session.ownedTabIds.delete(tabId);
      }
    }
  }

  // No tab exists — create one on demand
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (tab.id) {
    session.ownedTabIds.add(tab.id);
    if (session.tabGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: session.tabGroupId });
      } catch {}
    } else {
      // No group yet — create one with the session name
      try {
        session.tabGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(session.tabGroupId, {
          title: session.name,
          color: pickColor(sessions.size),
          collapsed: false,
        });
        persistSessions();
      } catch {}
    }
    session.activeTabId = tab.id;
    return tab.id;
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

  // Handle new_tab_group — create a new named tab group for this session
  if (message.action === 'new_tab_group') {
    const groupName = message.params?.name || 'Task';
    const requestedUrl = message.params?.url ?? 'about:blank';
    if (requestedUrl !== 'about:blank' && !isSafeUrl(requestedUrl)) {
      bridge.send({ type: 'result', id: message.id, session: sessionId, success: false, error: 'Blocked: only http and https URLs are allowed' });
      return;
    }

    const tab = await chrome.tabs.create({ url: requestedUrl, active: false });
    if (tab.id) {
      session.ownedTabIds.add(tab.id);
      try {
        const newGroupId = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(newGroupId, {
          title: groupName,
          color: pickColor(sessions.size + (session.tabGroupId ?? 0)),
          collapsed: false,
        });
        session.tabGroupId = newGroupId;
        persistSessions();
      } catch (err) {
        console.error('[OBC] Failed to create tab group:', err);
      }
    }
    session.activeTabId = tab.id ?? null;

    addLog({ source: 'ai', session: sessionId, action: 'new_tab_group', details: groupName, status: 'success' });

    bridge.send({
      type: 'result',
      id: message.id,
      session: sessionId,
      success: true,
      data: { tabId: tab.id, groupName, url: tab.url ?? '' },
    } as ExtensionMessage);
    broadcastState();
    return;
  }

  // Handle new_tab — add to session's tab group
  if (message.action === 'new_tab') {
    const requestedUrl = message.params?.url ?? 'about:blank';
    if (requestedUrl !== 'about:blank' && !isSafeUrl(requestedUrl)) {
      bridge.send({ type: 'result', id: message.id, session: sessionId, success: false, error: 'Blocked: only http and https URLs are allowed' });
      return;
    }
    const tab = await chrome.tabs.create({ url: requestedUrl });
    if (tab.id) {
      session.ownedTabIds.add(tab.id);
      if (session.tabGroupId !== null) {
        try {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: session.tabGroupId });
        } catch {}
      }
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
      : allTabs.filter((t) => t.id !== undefined && session.ownedTabIds.has(t.id));

    // `active` here means "the tab this session is currently acting on",
    // not the browser window's focused tab. chrome.tabs.query's `active`
    // reports the latter, and in Firefox it's false for every tab in a
    // non-focused tab group — useless for an agent asking "where am I?".
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
          active: t.id === session.activeTabId,
        })),
      },
    } as ExtensionMessage);
    return;
  }

  // Handle switch_tab — verify tab is in session's group or owned set
  if (message.action === 'switch_tab') {
    try {
      const tab = await chrome.tabs.get(message.params.tabId);
      const tabBelongsToSession = session.tabGroupId !== null
        ? tab.groupId === session.tabGroupId
        : session.ownedTabIds.has(message.params.tabId);
      if (!tabBelongsToSession) {
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
    session.ownedTabIds.delete(tabId);
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

// Holding a port open keeps the service worker (Chrome) or event page
// (Firefox) alive. The side panel and every open tab's content script
// both open these on load — the union covers the realistic cases (either
// the user is watching the sidebar, or they have at least one web page
// open). No message exchange needed; the open connection itself is the
// keepalive.
const KEEPALIVE_PORTS = new Set(['sidepanel-keepalive', 'content-keepalive']);
chrome.runtime.onConnect.addListener((port) => {
  if (!KEEPALIVE_PORTS.has(port.name)) return;
  port.onDisconnect.addListener(() => {});
});

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

Promise.all([
  chrome.storage.local.get(['bridgePort']),
  getInstanceId(),
]).then(([storage, instanceId]) => {
  if (storage.bridgePort) {
    bridge.setPort(storage.bridgePort as number);
  }
  bridge.setIdentity({ browser: 'chrome', instanceId });
  bridge.connect();
});

console.log('[OpenBrowserControl] Background service worker started');
