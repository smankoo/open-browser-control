/**
 * Firefox implementation of the Open Browser Control protocol.
 *
 * Speaks the same WebSocket protocol as any other OBC extension
 * (src/types/protocol.ts): manage agent sessions, route actions to the
 * correct tab, and relay results and events to the bridge.
 *
 * Firefox-specific choices this implementation makes:
 *   - Actions are driven via browser.scripting and the tabs/webNavigation
 *     APIs, since Firefox does not expose the Chrome DevTools Protocol.
 *   - Session isolation uses named, colored tab groups (Firefox 139+)
 *     when available, and falls back to tracked tab IDs on older versions.
 *   - The toolbar icon toggles a sidebar (sidebar_action) rather than a
 *     Chrome-only side panel.
 *   - The background is a persistent event page (background.scripts).
 */

import { WebSocketBridge } from '../bridge/websocket-bridge';
import { executeAction, getToolSchema } from './actions/browser-actions';
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

// Firefox exposes both `browser` (promise-based) and `chrome` (compat).
// The @types/chrome typings don't declare `browser`, so we alias chrome
// everywhere — Firefox implements the chrome.* namespace for MV3.

// ─── tabGroups (Firefox 139+) ────────────────────────────────────────────────
// Firefox exposes the tabGroups API on `browser.*` but not always on the
// `chrome.*` compat shim, so we bind it at runtime from whichever namespace
// carries it. Older Firefox versions leave `tabGroupsApi` undefined and we
// fall back to tracking sessions by owned tab IDs.

type TabGroupsApi = {
  update: (groupId: number, props: { title?: string; color?: string; collapsed?: boolean }) => Promise<unknown>;
  get: (groupId: number) => Promise<unknown>;
};
type TabsGroupFn = (options: { tabIds: number[]; groupId?: number }) => Promise<number>;
type TabsUngroupFn = (tabIds: number[]) => Promise<void>;

const ffBrowser = (globalThis as unknown as {
  browser?: {
    tabGroups?: TabGroupsApi;
    tabs?: { group?: TabsGroupFn; ungroup?: TabsUngroupFn };
  };
}).browser;

const tabGroupsApi: TabGroupsApi | undefined =
  ffBrowser?.tabGroups ??
  (chrome as unknown as { tabGroups?: TabGroupsApi }).tabGroups;
const tabsGroupFn: TabsGroupFn | undefined =
  ffBrowser?.tabs?.group ??
  (chrome.tabs as unknown as { group?: TabsGroupFn }).group;
const tabsUngroupFn: TabsUngroupFn | undefined =
  ffBrowser?.tabs?.ungroup ??
  (chrome.tabs as unknown as { ungroup?: TabsUngroupFn }).ungroup;

const TAB_GROUPS_SUPPORTED = !!(tabGroupsApi && tabsGroupFn);

const TAB_GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;

function pickColor(index: number): typeof TAB_GROUP_COLORS[number] {
  return TAB_GROUP_COLORS[index % TAB_GROUP_COLORS.length];
}

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
  { browser: 'firefox', instanceId: 'pending' },
);

// ─── Session Management ──────────────────────────────────────────────────────

const pendingCreateSession = new Map<string, Promise<void>>();

async function createSession(sessionId: string, name: string): Promise<void> {
  if (sessions.has(sessionId)) return;
  // Prevent duplicate reclaim work if session_start arrives twice before the
  // first call has finished awaiting storage/tabs.query.
  const existing = pendingCreateSession.get(sessionId);
  if (existing) return existing;

  const promise = doCreateSession(sessionId, name).finally(() => {
    pendingCreateSession.delete(sessionId);
  });
  pendingCreateSession.set(sessionId, promise);
  return promise;
}

async function doCreateSession(sessionId: string, name: string): Promise<void> {
  // Reclaim any previously-owned tab group or tab IDs from a prior run.
  let tabGroupId: number | null = null;
  let activeTabId: number | null = null;
  const ownedTabIds = new Set<number>();

  try {
    const stored = await chrome.storage.local.get(['obc_sessions']);
    const sessionMap = stored.obc_sessions as
      | Record<string, { tabGroupId?: number | null; ownedTabIds?: number[] }>
      | undefined;
    const saved = sessionMap?.[sessionId];

    if (TAB_GROUPS_SUPPORTED && tabGroupsApi && saved?.tabGroupId != null) {
      try {
        await tabGroupsApi.get(saved.tabGroupId);
        tabGroupId = saved.tabGroupId;
        const groupTabs = await chrome.tabs.query({});
        for (const t of groupTabs) {
          if (t.groupId === tabGroupId && t.id !== undefined) {
            ownedTabIds.add(t.id);
            if (activeTabId === null) activeTabId = t.id;
          }
        }
      } catch {
        // Group no longer exists — drop it
      }
    }

    const savedIds = saved?.ownedTabIds ?? [];
    for (const tabId of savedIds) {
      try {
        await chrome.tabs.get(tabId);
        ownedTabIds.add(tabId);
        if (activeTabId === null) activeTabId = tabId;
      } catch {
        // Tab closed — skip
      }
    }
  } catch {}

  // A session_end for this ID may have arrived while we were awaiting storage.
  if (sessions.has(sessionId)) return;

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

// Coalesce bursts of persistSessions() calls (e.g. during session creation +
// first tab + ensureTabInGroup) into a single storage write on the next
// microtask. Storage writes from a background script get expensive under
// load; we only care that the latest snapshot eventually lands.
let persistScheduled = false;
function persistSessions(): void {
  if (persistScheduled) return;
  persistScheduled = true;
  queueMicrotask(() => {
    persistScheduled = false;
    const data: Record<string, { tabGroupId: number | null; ownedTabIds: number[] }> = {};
    for (const [id, session] of sessions) {
      data[id] = {
        tabGroupId: session.tabGroupId,
        ownedTabIds: Array.from(session.ownedTabIds),
      };
    }
    chrome.storage.local.set({ obc_sessions: data }).catch(() => {});
  });
}

function cleanupSession(sessionId: string, session: AgentSession): void {
  // Don't close tabs — user might want to keep them. Ungroup them so the
  // user isn't left with a dangling AI-labeled group.
  if (TAB_GROUPS_SUPPORTED && tabsUngroupFn && session.tabGroupId !== null) {
    const ids = Array.from(session.ownedTabIds);
    if (ids.length > 0) {
      tabsUngroupFn(ids).catch(() => {});
    }
  }
  addLog({ source: 'system', session: sessionId, action: `Agent "${session.name}" disconnected`, status: 'pending' });
}

/** Ensure the given tab is in the session's tab group, creating the group if needed. */
async function ensureTabInGroup(session: AgentSession, tabId: number): Promise<void> {
  if (!TAB_GROUPS_SUPPORTED || !tabsGroupFn || !tabGroupsApi) return;
  try {
    if (session.tabGroupId !== null) {
      await tabsGroupFn({ tabIds: [tabId], groupId: session.tabGroupId });
      return;
    }
    const newGroupId = await tabsGroupFn({ tabIds: [tabId] });
    await tabGroupsApi.update(newGroupId, {
      title: session.name,
      color: pickColor(sessions.size),
      collapsed: false,
    });
    session.tabGroupId = newGroupId;
    persistSessions();
  } catch {
    // Group assignment can fail if the tab is pinned or the API is unavailable.
  }
}

/** Get the active tab for a session, creating one on demand if needed. */
async function getSessionTab(session: AgentSession): Promise<number | null> {
  if (session.activeTabId) {
    try {
      const tab = await chrome.tabs.get(session.activeTabId);
      const belongs = session.tabGroupId !== null && TAB_GROUPS_SUPPORTED
        ? tab.groupId === session.tabGroupId
        : session.ownedTabIds.has(session.activeTabId);
      if (belongs) return session.activeTabId;
    } catch {
      session.ownedTabIds.delete(session.activeTabId);
    }
  }

  if (TAB_GROUPS_SUPPORTED && session.tabGroupId !== null) {
    const tabs = await chrome.tabs.query({});
    const groupTab = tabs.find((t) => t.groupId === session.tabGroupId);
    if (groupTab?.id) {
      session.activeTabId = groupTab.id;
      session.ownedTabIds.add(groupTab.id);
      return groupTab.id;
    }
  }

  for (const tabId of session.ownedTabIds) {
    try {
      await chrome.tabs.get(tabId);
      session.activeTabId = tabId;
      return tabId;
    } catch {
      session.ownedTabIds.delete(tabId);
    }
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (tab.id) {
    session.ownedTabIds.add(tab.id);
    session.activeTabId = tab.id;
    await ensureTabInGroup(session, tab.id);
    persistSessions();
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
      persistSessions();
      broadcastState();
    }
    return;
  }

  if (message.type === 'session_update') {
    const session = sessions.get(message.session);
    if (session) {
      session.name = message.name;
      if (TAB_GROUPS_SUPPORTED && tabGroupsApi && session.tabGroupId !== null) {
        try {
          await tabGroupsApi.update(session.tabGroupId, { title: message.name });
        } catch {
          // Group may have been closed by the user
        }
      }
      addLog({ source: 'system', session: message.session, action: `Session renamed to "${message.name}"`, status: 'success' });
      broadcastState();
    }
    return;
  }

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
      session.activeTabId = tab.id;

      if (TAB_GROUPS_SUPPORTED && tabsGroupFn && tabGroupsApi) {
        try {
          const newGroupId = await tabsGroupFn({ tabIds: [tab.id] });
          await tabGroupsApi.update(newGroupId, {
            title: groupName,
            color: pickColor(sessions.size + (session.tabGroupId ?? 0)),
            collapsed: false,
          });
          session.tabGroupId = newGroupId;
        } catch (err) {
          console.error('[OBC] Failed to create tab group:', err);
        }
      }
    }
    session.name = groupName;
    persistSessions();

    addLog({ source: 'ai', session: sessionId, action: 'new_tab_group', details: groupName, status: 'success' });

    const responseData: Record<string, unknown> = {
      tabId: tab.id,
      groupName,
      url: tab.url ?? '',
      tabGroupId: session.tabGroupId,
    };
    if (!TAB_GROUPS_SUPPORTED) {
      responseData.note = 'This Firefox version lacks browser.tabGroups; tabs are tracked per-session instead.';
    }

    bridge.send({
      type: 'result',
      id: message.id,
      session: sessionId,
      success: true,
      data: responseData,
    } as ExtensionMessage);
    broadcastState();
    return;
  }

  if (message.action === 'new_tab') {
    const requestedUrl = message.params?.url ?? 'about:blank';
    if (requestedUrl !== 'about:blank' && !isSafeUrl(requestedUrl)) {
      bridge.send({ type: 'result', id: message.id, session: sessionId, success: false, error: 'Blocked: only http and https URLs are allowed' });
      return;
    }
    const tab = await chrome.tabs.create({ url: requestedUrl });
    if (tab.id) {
      session.ownedTabIds.add(tab.id);
      session.activeTabId = tab.id;
      await ensureTabInGroup(session, tab.id);
      persistSessions();
    }

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

  if (message.action === 'list_tabs') {
    const allTabs = await chrome.tabs.query({});
    const sessionTabs = TAB_GROUPS_SUPPORTED && session.tabGroupId !== null
      ? allTabs.filter((t) => t.groupId === session.tabGroupId)
      : allTabs.filter((t) => t.id !== undefined && session.ownedTabIds.has(t.id));

    // `active` here means "the tab this session is currently acting on",
    // not the browser window's focused tab. Firefox's t.active is false
    // for every tab in a non-focused tab group, which is useless for an
    // agent asking "where am I?".
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

  if (message.action === 'switch_tab') {
    try {
      const tab = await chrome.tabs.get(message.params.tabId);
      const belongs = TAB_GROUPS_SUPPORTED && session.tabGroupId !== null
        ? tab.groupId === session.tabGroupId
        : session.ownedTabIds.has(message.params.tabId);
      if (!belongs) {
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
  const taggedResult = { ...result, session: sessionId } as ExtensionMessage;

  const lastLog = actionLog[actionLog.length - 1];
  if (lastLog) lastLog.status = result.success ? 'success' : 'error';

  bridge.send(taggedResult);
  broadcastState();
}

// ─── Tab Tracking ────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    for (const session of sessions.values()) {
      const belongs = TAB_GROUPS_SUPPORTED && session.tabGroupId !== null
        ? tab.groupId === session.tabGroupId
        : session.ownedTabIds.has(activeInfo.tabId);
      if (belongs) {
        session.activeTabId = activeInfo.tabId;
        session.ownedTabIds.add(activeInfo.tabId);
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

// Holding a port open keeps the event page (Firefox) or service worker
// (Chrome) alive. The side panel and every open tab's content script
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

// ─── Toolbar Icon → Toggle Sidebar ───────────────────────────────────────────

// On Firefox, clicking the toolbar icon toggles the sidebar (sidebar_action).
const firefoxBrowser = (globalThis as unknown as { browser?: { sidebarAction?: { toggle: () => Promise<void> } } }).browser;
if (firefoxBrowser?.sidebarAction) {
  chrome.action.onClicked.addListener(() => {
    firefoxBrowser.sidebarAction!.toggle().catch(() => {});
  });
}

// ─── Startup ─────────────────────────────────────────────────────────────────

Promise.all([
  chrome.storage.local.get(['bridgePort']),
  getInstanceId(),
]).then(([storage, instanceId]) => {
  if (storage.bridgePort) {
    bridge.setPort(storage.bridgePort as number);
  }
  bridge.setIdentity({ browser: 'firefox', instanceId });
  bridge.connect();
});
