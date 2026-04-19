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
  'request_user', 'new_tab', 'new_tab_group', 'close_tab', 'switch_tab', 'list_tabs',
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

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'conflict';

export interface BridgeCallbacks {
  onMessage: (message: AgentMessage) => void | Promise<void>;
  onStatusChange: (status: ConnectionStatus, reason?: string) => void;
}

export interface BridgeIdentity {
  browser: 'chrome' | 'firefox';
  instanceId: string;
}

const DEFAULT_PORT = 9334;

// Retry every 2 seconds. A failed WebSocket to localhost is essentially free.
// This means worst case the agent waits <2s after starting its server.
const POLL_INTERVAL = 2000;

// MV3 backgrounds (Chrome SW, Firefox event page) idle-stop after ~30s,
// which kills setInterval. We ride chrome.alarms as a backup.
//
// Firefox MV3 has a hard 1-minute minimum for alarm periods — a single
// 1-min alarm fires too late to prevent the very first idle-stop, which
// means the bg keeps flapping. The documented workaround is three alarms
// staggered 20s apart (see Mozilla Discourse #128327): together they
// produce an alarm event every 20s, well under Firefox's idle threshold,
// which resets the idle timer and keeps the bg alive between reconnects.
const POLL_ALARM_NAMES = ['obc-bridge-poll-0', 'obc-bridge-poll-1', 'obc-bridge-poll-2'];
const POLL_ALARM_PERIOD_MINUTES = 1;
const POLL_ALARM_STAGGER_MS = 20_000;

// Bridge rejects us because another extension (different instanceId) owns
// this port. Retrying won't help — the user must change the port or stop
// the other browser.
const CLOSE_CODE_CONFLICT = 4002;

export class WebSocketBridge {
  private ws: WebSocket | null = null;
  private callbacks: BridgeCallbacks;
  private port: number;
  private identity: BridgeIdentity;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private _status: ConnectionStatus = 'disconnected';
  private conflictReason: string | null = null;
  private pendingRejectionReason: string | null = null;
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(callbacks: BridgeCallbacks, identity: BridgeIdentity, port?: number) {
    this.callbacks = callbacks;
    this.identity = identity;
    this.port = port ?? DEFAULT_PORT;

    // Register the alarm listener synchronously at construction so it survives
    // service-worker suspension. Each wake of the SW re-runs the module and
    // re-registers the listener in time to receive any already-queued alarms.
    if (typeof chrome !== 'undefined' && chrome.alarms?.onAlarm) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (POLL_ALARM_NAMES.includes(alarm.name)) this.tryConnect();
      });
    }
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  private setStatus(status: ConnectionStatus, reason?: string) {
    if (this._status === status && this.conflictReason === (reason ?? null)) return;
    this._status = status;
    this.conflictReason = reason ?? null;
    this.callbacks.onStatusChange(status, reason);
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
    // Explicit disconnect clears the alarms too — caller is opting out of
    // auto-reconnect entirely (e.g. user pressed a "disconnect" button).
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      for (const name of POLL_ALARM_NAMES) {
        chrome.alarms.clear(name).catch(() => {});
      }
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
    }
  }

  setPort(port: number): void {
    const changed = this.port !== port;
    this.port = port;
    if (changed) {
      // Port changed — clear any conflict state (user is telling us to try elsewhere)
      // and force a fresh connection attempt.
      this.intentionalClose = false;
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.tryConnect();
      this.startPolling();
    }
  }

  /** Update the extension's identity (used after async instance-id resolves). */
  setIdentity(identity: BridgeIdentity): void {
    this.identity = identity;
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
        data: {
          version: '0.1.0',
          browser: this.identity.browser,
          instanceId: this.identity.instanceId,
        },
      } as ExtensionMessage);
      this.startKeepalive();
      // Stop polling while connected — we'll restart on close
      this.stopPolling();
    };

    this.ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string);
        // Bridge-originated event signalling we're being rejected. Stash the
        // reason — onclose will flip us to the 'conflict' state with it.
        if (parsed?.type === 'event' && parsed?.event === 'rejected') {
          this.pendingRejectionReason = typeof parsed.data?.reason === 'string' ? parsed.data.reason : null;
          return;
        }
        if (!isValidAgentMessage(parsed)) {
          console.warn('[OBCBridge] Rejected invalid message:', parsed?.type);
          return;
        }
        // Process messages serially so async handlers (e.g. createSession)
        // finish before the next message is handled.
        this.messageQueue = this.messageQueue.then(
          () => this.callbacks.onMessage(parsed),
          () => this.callbacks.onMessage(parsed),
        );
      } catch (err) {
        console.error('[OBCBridge] Failed to parse message:', err);
      }
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.ws = null;
      this.stopKeepalive();
      if (this.intentionalClose) return;
      if (event.code === CLOSE_CODE_CONFLICT) {
        // Another extension already owns the bridge. Don't spam reconnects at
        // 2s — but keep the 30s chrome.alarm going so we quietly take over
        // when the other browser closes.
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        // Keep the staggered alarms running — we want to wake and re-check
        // whenever the other browser lets go. The fast 2s setInterval stays
        // off to avoid spamming rejections.
        if (typeof chrome !== 'undefined' && chrome.alarms) {
          chrome.alarms.create(POLL_ALARM_NAMES[0], { periodInMinutes: POLL_ALARM_PERIOD_MINUTES });
          setTimeout(() => {
            try { chrome.alarms.create(POLL_ALARM_NAMES[1], { periodInMinutes: POLL_ALARM_PERIOD_MINUTES }); } catch {}
          }, POLL_ALARM_STAGGER_MS);
          setTimeout(() => {
            try { chrome.alarms.create(POLL_ALARM_NAMES[2], { periodInMinutes: POLL_ALARM_PERIOD_MINUTES }); } catch {}
          }, POLL_ALARM_STAGGER_MS * 2);
        }
        const reason =
          this.pendingRejectionReason ||
          event.reason ||
          'Another browser extension is already connected to this bridge.';
        this.pendingRejectionReason = null;
        this.setStatus('conflict', reason);
        return;
      }
      this.pendingRejectionReason = null;
      this.setStatus('disconnected');
      // Agent went away. Start polling again so we reconnect fast when it's back.
      this.startPolling();
    };

    this.ws.onerror = () => {
      // onclose fires after this — no need to do anything here
    };
  }

  private startPolling(): void {
    // Schedule three alarms staggered 20s apart. Each has the minimum
    // 1-minute period Firefox MV3 allows, but because they're offset they
    // collectively fire every 20s — frequent enough to reset Firefox's
    // idle timer and also serve as a reconnect poke after the bg dies.
    // Overwrites any existing alarms with the same names on re-invocation
    // (e.g. after the bg wakes from suspension).
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      chrome.alarms.create(POLL_ALARM_NAMES[0], { periodInMinutes: POLL_ALARM_PERIOD_MINUTES });
      setTimeout(() => {
        try { chrome.alarms.create(POLL_ALARM_NAMES[1], { periodInMinutes: POLL_ALARM_PERIOD_MINUTES }); } catch {}
      }, POLL_ALARM_STAGGER_MS);
      setTimeout(() => {
        try { chrome.alarms.create(POLL_ALARM_NAMES[2], { periodInMinutes: POLL_ALARM_PERIOD_MINUTES }); } catch {}
      }, POLL_ALARM_STAGGER_MS * 2);
    }
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.tryConnect();
    }, POLL_INTERVAL);
  }

  private stopPolling(): void {
    // Only stop the setInterval here — leave the alarm running so the bg
    // can be woken back up if the process dies while we're "connected".
    // The alarm is torn down explicitly in disconnect().
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
