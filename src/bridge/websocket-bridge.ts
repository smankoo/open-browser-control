/**
 * WebSocket bridge that connects the Chrome extension to an external AI agent.
 * The extension acts as a WebSocket CLIENT connecting to a local bridge server.
 *
 * Protocol: JSON messages over WebSocket
 * - Agent sends action messages
 * - Extension sends result/event messages
 */

import type { AgentMessage, ExtensionMessage } from '../types/protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface BridgeCallbacks {
  onMessage: (message: AgentMessage) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

const DEFAULT_PORT = 9334;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]; // Exponential backoff

export class WebSocketBridge {
  private ws: WebSocket | null = null;
  private callbacks: BridgeCallbacks;
  private port: number;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private _status: ConnectionStatus = 'disconnected';
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(callbacks: BridgeCallbacks, port?: number) {
    this.callbacks = callbacks;
    this.port = port ?? DEFAULT_PORT;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  private setStatus(status: ConnectionStatus) {
    this._status = status;
    this.callbacks.onStatusChange(status);
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.intentionalClose = false;
    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(`ws://localhost:${this.port}`);
    } catch {
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus('connected');

      // Send handshake
      this.send({
        type: 'event',
        event: 'connected',
        data: { version: '0.1.0' },
      } as ExtensionMessage);

      // Start keepalive to prevent MV3 service worker from sleeping.
      // Chrome 116+ keeps the SW alive while a WebSocket is open,
      // but we send pings as a safety net for older versions.
      this.startKeepalive();
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as AgentMessage;
        this.callbacks.onMessage(message);
      } catch (err) {
        console.error('[KiroBridge] Failed to parse message:', err);
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (!this.intentionalClose) {
        this.setStatus('disconnected');
        this.scheduleReconnect();
      } else {
        this.setStatus('disconnected');
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this
      this.setStatus('error');
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  send(message: ExtensionMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('[KiroBridge] Cannot send, not connected');
    }
  }

  setPort(port: number): void {
    this.port = port;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000); // Every 20 seconds
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) return;

    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
