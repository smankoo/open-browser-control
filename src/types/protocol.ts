/**
 * Protocol types for communication between AI agent and Chrome extension.
 *
 * Message flow:
 *   AI Agent <-> Bridge Server <-> Chrome Extension (Background SW)
 *
 * The protocol uses JSON messages with a type field and optional id for
 * request/response correlation.
 */

// ─── Agent → Extension Actions ───────────────────────────────────────────────

export interface ScreenshotAction {
  type: 'action';
  action: 'screenshot';
  id: string;
  params?: {
    /** If true, capture full page (not just viewport) */
    fullPage?: boolean;
    /** CSS selector to screenshot a specific element */
    selector?: string;
  };
}

export interface ClickAction {
  type: 'action';
  action: 'click';
  id: string;
  params: {
    /** Click at specific coordinates */
    x?: number;
    y?: number;
    /** Click element matching CSS selector */
    selector?: string;
    /** Click element containing this text */
    text?: string;
    /** Click type */
    button?: 'left' | 'right' | 'middle';
    /** Number of clicks (1=single, 2=double) */
    clickCount?: number;
  };
}

export interface TypeAction {
  type: 'action';
  action: 'type';
  id: string;
  params: {
    /** Text to type */
    text: string;
    /** Optional selector to focus first */
    selector?: string;
    /** If true, clear field before typing */
    clear?: boolean;
    /** If true, press Enter after typing */
    pressEnter?: boolean;
  };
}

export interface KeyPressAction {
  type: 'action';
  action: 'keypress';
  id: string;
  params: {
    /** Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown') */
    key: string;
    /** Modifier keys */
    modifiers?: ('ctrl' | 'alt' | 'shift' | 'meta')[];
  };
}

export interface ScrollAction {
  type: 'action';
  action: 'scroll';
  id: string;
  params: {
    /** Direction to scroll */
    direction: 'up' | 'down' | 'left' | 'right';
    /** Amount in pixels (default: 500) */
    amount?: number;
    /** Scroll within a specific element */
    selector?: string;
  };
}

export interface NavigateAction {
  type: 'action';
  action: 'navigate';
  id: string;
  params: {
    url: string;
  };
}

export interface WaitAction {
  type: 'action';
  action: 'wait';
  id: string;
  params: {
    /** Wait for element matching selector */
    selector?: string;
    /** Wait for specific text to appear */
    text?: string;
    /** Wait fixed milliseconds */
    ms?: number;
    /** Wait for navigation to complete */
    navigation?: boolean;
    /** Timeout in ms (default: 10000) */
    timeout?: number;
  };
}

export interface GetDomAction {
  type: 'action';
  action: 'get_dom';
  id: string;
  params?: {
    /** Return simplified accessibility tree instead of full DOM */
    simplified?: boolean;
    /** CSS selector to scope the DOM extraction */
    selector?: string;
  };
}

export interface GetPageInfoAction {
  type: 'action';
  action: 'get_page_info';
  id: string;
}

export interface ExecuteJsAction {
  type: 'action';
  action: 'execute_js';
  id: string;
  params: {
    /** JavaScript expression to evaluate */
    expression: string;
  };
}

export interface SelectOptionAction {
  type: 'action';
  action: 'select_option';
  id: string;
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
  params: {
    /** Message to show the user explaining what they need to do */
    message: string;
    /** Optional timeout in ms before AI resumes automatically */
    timeout?: number;
  };
}

export interface NewTabAction {
  type: 'action';
  action: 'new_tab';
  id: string;
  params: {
    url?: string;
  };
}

export interface CloseTabAction {
  type: 'action';
  action: 'close_tab';
  id: string;
}

export interface SwitchTabAction {
  type: 'action';
  action: 'switch_tab';
  id: string;
  params: {
    tabId: number;
  };
}

export interface ListTabsAction {
  type: 'action';
  action: 'list_tabs';
  id: string;
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
  success: true;
  data: Record<string, unknown>;
  /** Page state after the action (URL, title, etc.) */
  pageState?: PageState;
}

export interface ActionError {
  type: 'result';
  id: string;
  success: false;
  error: string;
}

export type ActionResult = ActionSuccess | ActionError;

// ─── Extension → Agent Events ────────────────────────────────────────────────

export interface PageState {
  url: string;
  title: string;
  tabId: number;
}

export interface UserHandoffEvent {
  type: 'event';
  event: 'user_handoff';
  /** User took control */
  data: { message: string };
}

export interface UserDoneEvent {
  type: 'event';
  event: 'user_done';
  /** User finished and handed back to AI */
  data: { message?: string };
}

export interface PageNavigatedEvent {
  type: 'event';
  event: 'page_navigated';
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
}

export interface ToolSchemaResponse {
  type: 'tool_schema';
  id: string;
  tools: ToolDefinition[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ─── Union Types ─────────────────────────────────────────────────────────────

export type AgentMessage = AgentAction | PingMessage | GetToolSchemaMessage;
export type ExtensionMessage = ActionResult | ExtensionEvent | PongMessage | ToolSchemaResponse;
export type AnyMessage = AgentMessage | ExtensionMessage;

// ─── Internal Extension Messages (between background/sidepanel/content) ──────

export interface InternalMessage {
  source: 'background' | 'sidepanel' | 'content';
  type: string;
  data?: unknown;
}

// ─── Session State ───────────────────────────────────────────────────────────

export type ControlMode = 'ai' | 'user' | 'collaborative';

export interface SessionState {
  connected: boolean;
  controlMode: ControlMode;
  activeTabId: number | null;
  debuggerAttached: boolean;
  actionLog: ActionLogEntry[];
  pendingUserAction: string | null;
}

export interface ActionLogEntry {
  timestamp: number;
  source: 'ai' | 'user' | 'system';
  action: string;
  details?: string;
  status: 'pending' | 'success' | 'error';
}
