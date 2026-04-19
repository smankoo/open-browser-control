#!/usr/bin/env node

/**
 * Bridge Server — multiplexes N agent connections to 1 browser extension
 * (Chrome or Firefox — both speak the same protocol).
 *
 * Each agent gets a session ID. The bridge tags all messages with the
 * session so the extension can route actions to the correct tab group.
 *
 * Usage:
 *   node server.js [--port 9334]
 *
 * Connection protocol:
 *   1. Browser extension connects (identified by first message being an event)
 *   2. Agents connect and send: {"type": "session_start", "session": "...", "name": "..."}
 *   3. Bridge relays messages, adding/preserving session tags
 *   4. On agent disconnect, bridge sends session_end to extension
 */

const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const PORT = parseInt(getArg('port', '9334'), 10);

// ─── Message Validation ─────────────────────────────────────────────────────

const VALID_AGENT_ACTIONS = new Set([
  'screenshot', 'click', 'type', 'keypress', 'scroll', 'navigate', 'wait',
  'get_dom', 'get_page_info', 'execute_js', 'select_option', 'hover',
  'request_user', 'new_tab', 'new_tab_group', 'close_tab', 'switch_tab', 'list_tabs',
]);

const VALID_MESSAGE_TYPES = new Set([
  'action', 'ping', 'pong', 'get_tool_schema', 'tool_schema',
  'session_start', 'session_end', 'session_update',
  'result', 'event',
]);

function isValidMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return false;
  if (!VALID_MESSAGE_TYPES.has(msg.type)) return false;
  if (msg.type === 'action') {
    if (typeof msg.id !== 'string' || !msg.id) return false;
    if (!VALID_AGENT_ACTIONS.has(msg.action)) return false;
  }
  if (msg.type === 'session_start' && typeof msg.name !== 'string') return false;
  return true;
}

// ─── State ───────────────────────────────────────────────────────────────────

let extensionSocket = null;
let extensionInstanceId = null; // UUID of the currently-connected extension install
let extensionBrowser = null;    // 'chrome' | 'firefox'

// Map<sessionId, { ws, name }>
const agentSessions = new Map();

// Map<WebSocket, sessionId> — reverse lookup
const socketToSession = new Map();

// Actions and get_tool_schema requests buffered while the extension is
// disconnected. MV3 backgrounds (especially Firefox event pages) can
// idle-stop even with keepalive ports open; when they do, alarms wake
// them back up within ~30s. Holding requests here during that gap turns
// a hard failure into a brief latency blip.
//
// Each entry: { msg, agentWs, deadline (ms epoch) }
const pendingForExtension = [];
const PENDING_TIMEOUT_MS = 25_000; // leave margin under the agent's 30s timeout

function flushPendingToExtension() {
  while (pendingForExtension.length) {
    const { msg } = pendingForExtension.shift();
    sendToExtension(msg);
  }
}

function reapExpiredPending() {
  if (!pendingForExtension.length) return;
  const now = Date.now();
  for (let i = pendingForExtension.length - 1; i >= 0; i--) {
    const p = pendingForExtension[i];
    if (p.deadline > now) continue;
    pendingForExtension.splice(i, 1);
    if (p.agentWs.readyState === WebSocket.OPEN && p.msg.id) {
      p.agentWs.send(JSON.stringify({
        type: 'result',
        id: p.msg.id,
        session: p.msg.session,
        success: false,
        error: 'Browser extension did not come back in time. The browser may be closed or the extension disabled.',
      }));
    }
  }
}
setInterval(reapExpiredPending, 1000);

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

log(`Bridge server listening on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  // We don't know yet if this is the extension or an agent.
  // We'll figure it out from the first message.
  let identified = false;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!isValidMessage(msg)) {
      log(`Rejected invalid message: type=${msg?.type}, action=${msg?.action}`);
      return;
    }

    // ── Identify the connection on first meaningful message ──

    if (!identified) {
      // Extension sends {"type":"event","event":"connected"} as its first message
      if (msg.type === 'event' && msg.event === 'connected') {
        const incomingId = msg.data?.instanceId;
        const incomingBrowser = msg.data?.browser;

        if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
          // Decide: reconnect, legacy replace, or conflict?
          //   - Both sides identified with different ids → real conflict
          //     (two different installs want the slot).
          //   - Either side missing an id → fall back to legacy "new replaces
          //     old" so extensions from before the handshake change keep
          //     working when a bridge is upgraded underneath them.
          //   - Same id on both sides → reconnect (reload/crash).
          const bothIdentified = incomingId && extensionInstanceId;
          const differentInstalls = bothIdentified && incomingId !== extensionInstanceId;

          if (differentInstalls) {
            // WebSocket close reason is limited to 123 bytes; send the
            // longer explanation as a JSON message first, then close.
            const short = `extension-already-attached-${extensionBrowser || 'unknown'}`;
            const detail =
              `${extensionBrowser === 'chrome' ? 'Chrome' : extensionBrowser === 'firefox' ? 'Firefox' : 'Another browser'} ` +
              `is already connected to this bridge. Only one browser can attach at a time.`;
            log(`Rejecting extension connection — bridge held by ${extensionBrowser || 'unknown'} (${extensionInstanceId.slice(0, 8)})`);
            try { ws.send(JSON.stringify({ type: 'event', event: 'rejected', data: { reason: detail } })); } catch {}
            ws.close(4002, short);
            return;
          }

          log('Browser extension reconnected (replacing old connection)');
          extensionSocket.close(4001, 'Replaced by new extension connection');
        }

        extensionSocket = ws;
        extensionInstanceId = incomingId || null;
        extensionBrowser = incomingBrowser || null;
        identified = true;
        log(`Browser extension connected (${incomingBrowser || 'unknown'}, ${incomingId ? incomingId.slice(0, 8) : 'no-id'})`);

        // Tell extension about all existing sessions
        for (const [sessionId, session] of agentSessions) {
          sendToExtension({
            type: 'session_start',
            session: sessionId,
            name: session.name,
          });
        }

        // Drain anything that arrived while the extension was asleep.
        flushPendingToExtension();
        return;
      }

      // Agent sends {"type":"session_start","session":"...","name":"..."} as its first message
      if (msg.type === 'session_start') {
        const sessionId = msg.session || crypto.randomUUID().slice(0, 8);
        const name = msg.name || 'Agent';
        identified = true;

        agentSessions.set(sessionId, { ws, name });
        socketToSession.set(ws, sessionId);
        log(`Agent "${name}" connected (session: ${sessionId})`);

        // Tell extension about this session
        sendToExtension({ type: 'session_start', session: sessionId, name });

        // Confirm session to agent
        ws.send(JSON.stringify({
          type: 'session_started',
          session: sessionId,
          name,
        }));
        return;
      }

      // Legacy: agent that doesn't send session_start first.
      // Auto-assign a session.
      const sessionId = crypto.randomUUID().slice(0, 8);
      identified = true;
      agentSessions.set(sessionId, { ws, name: 'Agent' });
      socketToSession.set(ws, sessionId);
      log(`Agent connected without session_start, assigned session: ${sessionId}`);
      sendToExtension({ type: 'session_start', session: sessionId, name: 'Agent' });

      // Fall through to handle this first message as a regular message
    }

    // ── Route messages ──

    if (ws === extensionSocket) {
      // Extension → route to the correct agent by session field
      const sessionId = msg.session;
      if (sessionId && agentSessions.has(sessionId)) {
        const agent = agentSessions.get(sessionId);
        if (agent.ws.readyState === WebSocket.OPEN) {
          agent.ws.send(data.toString());
        }
      }
    } else {
      // Agent → tag with session and forward to extension
      const sessionId = socketToSession.get(ws);
      if (sessionId) {
        // Handle session name updates
        if (msg.type === 'session_update') {
          const session = agentSessions.get(sessionId);
          if (session) {
            session.name = msg.name || session.name;
            log(`Agent "${session.name}" renamed (session: ${sessionId})`);
          }
        }
        msg.session = sessionId;
        // Extension offline? Hold the request briefly instead of failing.
        // The extension's alarm-based reconnect fires within ~30s; flushing
        // on reconnect turns a bg-stop into a small latency bump.
        if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
          if ((msg.type === 'action' || msg.type === 'get_tool_schema') && typeof msg.id === 'string') {
            pendingForExtension.push({ msg, agentWs: ws, deadline: Date.now() + PENDING_TIMEOUT_MS });
            return;
          }
        }
        sendToExtension(msg);
      }
    }
  });

  ws.on('close', () => {
    if (ws === extensionSocket) {
      log('Browser extension disconnected');
      extensionSocket = null;
      extensionInstanceId = null;
      extensionBrowser = null;
    } else {
      const sessionId = socketToSession.get(ws);
      if (sessionId) {
        const session = agentSessions.get(sessionId);
        log(`Agent "${session?.name}" disconnected (session: ${sessionId})`);
        agentSessions.delete(sessionId);
        socketToSession.delete(ws);
        sendToExtension({ type: 'session_end', session: sessionId });
      }
    }
  });

  ws.on('error', () => {});
});

function sendToExtension(msg) {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    extensionSocket.send(JSON.stringify(msg));
  }
}

function log(msg) {
  process.stderr.write(`[obc-bridge] ${msg}\n`);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${PORT} already in use. Another bridge is running — that's fine.`);
    log('MCP servers should connect to the existing bridge as clients.');
    process.exit(0);
  }
  log(`Server error: ${err.message}`);
});

process.on('SIGINT', () => { wss.close(); process.exit(0); });
process.on('SIGTERM', () => { wss.close(); process.exit(0); });

log('Waiting for connections...');

module.exports = { PORT };
