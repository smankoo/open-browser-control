/**
 * WebSocket bridge that connects the Chrome extension to an external AI agent.
 *
 * The extension is always running (browser is always on). The agent comes and
 * goes. So we poll at a steady interval — fast enough that the agent never
 * waits, cheap enough that it doesn't matter when nothing is there.
 *
 * No exponential backoff. A failed connection to localhost is ~0 cost.
 * The user should never notice a delay when they start their agent.
 */

import type { AgentMessage, ExtensionMessage } from '../types/protocol';

const VALID_AGENT_ACTIONS = new Set([
  'screenshot', 'click', 'type', 'keypress', 'scroll', 'navigate', 'wait',
  'get_dom', 'get_page_info', 'execute_js', 'select_option', 'hover',
  'request_user', 'new_tab', 'close_tab', 'switch_tab', 'list_tabs',
]);

const VALID_INBOUND_TYPES = new Set([
  'action', 'ping', 'session_start', 'session_end', 'session_update', 'get_tool_schema',
]);

function isValidAgentMessage(msg: unknown): msg is AgentMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== 'string' || !VALID_INBOUND_TYPES.has(m.type)) return false;
  if (m.type === 'action') {
    if (typeof m.id !== 'string' || !m.id) return false;
    if (typeof m.action !== 'string' || !VALID_AGENT_ACTIONS.has(m.action)) return false;
  }
  return true;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface BridgeCallbacks {
  onMessage: (message: AgentMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

const DEFAULT_PORT = 9334;

// Retry every 2 seconds. A failed WebSocket to localhost is essentially free.
// This means worst case the agent waits <2s after starting its server.
const POLL_INTERVAL = 2000;

export class WebSocketBridge {
  private ws: WebSocket | null = null;
  private callbacks: BridgeCallbacks;
  private port: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private _status: ConnectionStatus = 'disconnected';

  constructor(callbacks: BridgeCallbacks, port?: number) {
    this.callbacks = callbacks;
    this.port = port ?? DEFAULT_PORT;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  private setStatus(status: ConnectionStatus) {
    if (this._status === status) return;
    this._status = status;
    this.callbacks.onStatusChange(status);
  }

  /** Start polling for the bridge. Call once on startup. */
  connect(): void {
    this.intentionalClose = false;
    this.tryConnect();
    this.startPolling();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPolling();
    this.stopKeepalive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  send(message: ExtensionMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  setPort(port: number): void {
    const changed = this.port !== port;
    this.port = port;
    if (changed && !this.intentionalClose) {
      // Reconnect on new port immediately
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.tryConnect();
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private tryConnect(): void {
    // Already connected or mid-handshake — nothing to do
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    try {
      this.ws = new WebSocket(`ws://localhost:${this.port}`);
    } catch {
      // Constructor can throw on invalid URL — shouldn't happen but be safe
      return;
    }

    this.ws.onopen = () => {
      this.setStatus('connected');
      this.send({
        type: 'event',
        event: 'connected',
        data: { version: '0.1.0' },
      } as ExtensionMessage);
      this.startKeepalive();
      // Stop polling while connected — we'll restart on close
      this.stopPolling();
    };

    this.ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string);
        if (!isValidAgentMessage(parsed)) {
          console.warn('[OBCBridge] Rejected invalid message:', parsed?.type);
          return;
        }
        this.callbacks.onMessage(parsed);
      } catch (err) {
        console.error('[OBCBridge] Failed to parse message:', err);
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.stopKeepalive();
      if (!this.intentionalClose) {
        this.setStatus('disconnected');
        // Agent went away. Start polling again so we reconnect fast when it's back.
        this.startPolling();
      }
    };

    this.ws.onerror = () => {
      // onclose fires after this — no need to do anything here
    };
  }

  private startPolling(): void {
    if (this.pollTimer) return; // Already polling
    this.pollTimer = setInterval(() => {
      this.tryConnect();
    }, POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
