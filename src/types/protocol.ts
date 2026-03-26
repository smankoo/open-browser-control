/**
 * Protocol types for communication between AI agents and Chrome extension.
 *
 * Message flow:
 *   Agent A ──┐
 *   Agent B ──┼──► Bridge Server ◄──► Chrome Extension
 *   Agent C ──┘
 *
 * Every message carries a `session` field so the extension can route
 * actions to the correct tab group and return results to the correct agent.
 */

// ─── Agent → Extension Actions ───────────────────────────────────────────────
// All actions carry a `session` field added by the bridge.

export interface ScreenshotAction {
  type: 'action';
  action: 'screenshot';
  id: string;
  session: string;
  params?: {
    fullPage?: boolean;
    selector?: string;
  };
}

export interface ClickAction {
  type: 'action';
  action: 'click';
  id: string;
  session: string;
  params: {
    x?: number;
    y?: number;
    selector?: string;
    text?: string;
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
  };
}

export interface TypeAction {
  type: 'action';
  action: 'type';
  id: string;
  session: string;
  params: {
    text: string;
    selector?: string;
    clear?: boolean;
    pressEnter?: boolean;
  };
}

export interface KeyPressAction {
  type: 'action';
  action: 'keypress';
  id: string;
  session: string;
  params: {
    key: string;
    modifiers?: ('ctrl' | 'alt' | 'shift' | 'meta')[];
  };
}

export interface ScrollAction {
  type: 'action';
  action: 'scroll';
  id: string;
  session: string;
  params: {
    direction: 'up' | 'down' | 'left' | 'right';
    amount?: number;
    selector?: string;
  };
}

export interface NavigateAction {
  type: 'action';
  action: 'navigate';
  id: string;
  session: string;
  params: {
    url: string;
  };
}

export interface WaitAction {
  type: 'action';
  action: 'wait';
  id: string;
  session: string;
  params: {
    selector?: string;
    text?: string;
    ms?: number;
    navigation?: boolean;
    timeout?: number;
  };
}

export interface GetDomAction {
  type: 'action';
  action: 'get_dom';
  id: string;
  session: string;
  params?: {
    simplified?: boolean;
    selector?: string;
  };
}

export interface GetPageInfoAction {
  type: 'action';
  action: 'get_page_info';
  id: string;
  session: string;
}

export interface ExecuteJsAction {
  type: 'action';
  action: 'execute_js';
  id: string;
  session: string;
  params: {
    expression: string;
  };
}

export interface SelectOptionAction {
  type: 'action';
  action: 'select_option';
  id: string;
  session: string;
  params: {
    selector: string;
    value?: string;
    text?: string;
  };
}

export interface HoverAction {
  type: 'action';
  action: 'hover';
  id: string;
  session: string;
  params: {
    x?: number;
    y?: number;
    selector?: string;
    text?: string;
  };
}

export interface RequestUserAction {
  type: 'action';
  action: 'request_user';
  id: string;
  session: string;
  params: {
    message: string;
    timeout?: number;
  };
}

export interface NewTabAction {
  type: 'action';
  action: 'new_tab';
  id: string;
  session: string;
  params: {
    url?: string;
  };
}

export interface CloseTabAction {
  type: 'action';
  action: 'close_tab';
  id: string;
  session: string;
}

export interface SwitchTabAction {
  type: 'action';
  action: 'switch_tab';
  id: string;
  session: string;
  params: {
    tabId: number;
  };
}

export interface ListTabsAction {
  type: 'action';
  action: 'list_tabs';
  id: string;
  session: string;
}

export type AgentAction =
  | ScreenshotAction
  | ClickAction
  | TypeAction
  | KeyPressAction
  | ScrollAction
  | NavigateAction
  | WaitAction
  | GetDomAction
  | GetPageInfoAction
  | ExecuteJsAction
  | SelectOptionAction
  | HoverAction
  | RequestUserAction
  | NewTabAction
  | CloseTabAction
  | SwitchTabAction
  | ListTabsAction;

// ─── Extension → Agent Responses ─────────────────────────────────────────────

export interface ActionSuccess {
  type: 'result';
  id: string;
  session?: string;
  success: true;
  data: Record<string, unknown>;
  pageState?: PageState;
}

export interface ActionError {
  type: 'result';
  id: string;
  session?: string;
  success: false;
  error: string;
}

export type ActionResult = ActionSuccess | ActionError;

// ─── Session Lifecycle ───────────────────────────────────────────────────────

export interface SessionStartMessage {
  type: 'session_start';
  session: string;
  name: string;
}

export interface SessionEndMessage {
  type: 'session_end';
  session: string;
}

export interface SessionUpdateMessage {
  type: 'session_update';
  session: string;
  name: string;
}

// ─── Extension → Agent Events ────────────────────────────────────────────────

export interface PageState {
  url: string;
  title: string;
  tabId: number;
}

export interface UserHandoffEvent {
  type: 'event';
  event: 'user_handoff';
  session: string;
  data: { message: string };
}

export interface UserDoneEvent {
  type: 'event';
  event: 'user_done';
  session: string;
  data: { message?: string };
}

export interface PageNavigatedEvent {
  type: 'event';
  event: 'page_navigated';
  session: string;
  data: PageState;
}

export interface ConnectionEvent {
  type: 'event';
  event: 'connected' | 'disconnected';
  data: { version: string };
}

export type ExtensionEvent =
  | UserHandoffEvent
  | UserDoneEvent
  | PageNavigatedEvent
  | ConnectionEvent;

// ─── Control Messages ────────────────────────────────────────────────────────

export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
}

export interface GetToolSchemaMessage {
  type: 'get_tool_schema';
  id: string;
  session: string;
}

export interface ToolSchemaResponse {
  type: 'tool_schema';
  id: string;
  session: string;
  tools: ToolDefinition[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ─── Union Types ─────────────────────────────────────────────────────────────

export type AgentMessage = AgentAction | PingMessage | GetToolSchemaMessage | SessionStartMessage | SessionEndMessage | SessionUpdateMessage;
export type ExtensionMessage = ActionResult | ExtensionEvent | PongMessage | ToolSchemaResponse | SessionStartMessage | SessionEndMessage;
export type AnyMessage = AgentMessage | ExtensionMessage;

// ─── Internal Extension Messages (between background/sidepanel/content) ──────

export interface InternalMessage {
  source: 'background' | 'sidepanel' | 'content';
  type: string;
  data?: unknown;
}

// ─── Session State ───────────────────────────────────────────────────────────

export type ControlMode = 'ai' | 'user' | 'collaborative';

/** Per-session state tracked by the extension */
export interface AgentSession {
  id: string;
  name: string;
  tabGroupId: number | null;
  activeTabId: number | null;
  controlMode: ControlMode;
  pendingUserAction: string | null;
  pendingUserActionId: string | null;
}

/** Overall extension state broadcast to the side panel */
export interface ExtensionState {
  connected: boolean;
  sessions: AgentSession[];
  actionLog: ActionLogEntry[];
}

export interface ActionLogEntry {
  timestamp: number;
  source: 'ai' | 'user' | 'system';
  session?: string;
  action: string;
  details?: string;
  status: 'pending' | 'success' | 'error';
}
