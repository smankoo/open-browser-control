#!/usr/bin/env node

/**
 * Bridge Server for Kiro Browser Use
 *
 * This server acts as a relay between the Chrome extension (WebSocket client)
 * and an AI agent. The agent can connect via:
 *   1. WebSocket (another client connecting to this server)
 *   2. stdin/stdout (for CLI-based agents like kiro-cli)
 *
 * Usage:
 *   node server.js [--port 9334] [--mode ws|stdio]
 *
 * In "stdio" mode, the server reads JSON messages from stdin (one per line)
 * and writes JSON responses to stdout. This lets any CLI agent pipe through it.
 *
 * In "ws" mode (default), it accepts two WebSocket connections:
 *   - The Chrome extension connects first
 *   - The AI agent connects second
 *   Messages are relayed between them.
 */

const { WebSocketServer, WebSocket } = require('ws');
const readline = require('readline');

// ─── Configuration ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const PORT = parseInt(getArg('port', '9334'), 10);
const MODE = getArg('mode', 'ws');

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

let extensionSocket = null;
let agentSocket = null;

console.error(`[KiroBridge] Starting bridge server on ws://localhost:${PORT} (mode: ${MODE})`);

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || 'unknown';
  console.error(`[KiroBridge] New connection from: ${origin}`);

  // First connection is the extension, second is the agent (in ws mode)
  if (!extensionSocket) {
    extensionSocket = ws;
    console.error('[KiroBridge] Extension connected');

    ws.on('message', (data) => {
      const msg = data.toString();
      if (MODE === 'stdio') {
        // Forward extension messages to stdout for the agent
        process.stdout.write(msg + '\n');
      } else if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
        agentSocket.send(msg);
      }
    });

    ws.on('close', () => {
      console.error('[KiroBridge] Extension disconnected');
      extensionSocket = null;
    });
  } else if (MODE === 'ws' && !agentSocket) {
    agentSocket = ws;
    console.error('[KiroBridge] Agent connected');

    ws.on('message', (data) => {
      const msg = data.toString();
      if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        extensionSocket.send(msg);
      }
    });

    ws.on('close', () => {
      console.error('[KiroBridge] Agent disconnected');
      agentSocket = null;
    });
  } else {
    console.error('[KiroBridge] Extra connection rejected (max 2 in ws mode)');
    ws.close(4000, 'Too many connections');
  }
});

// ─── Stdio Mode ──────────────────────────────────────────────────────────────

if (MODE === 'stdio') {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Forward agent messages from stdin to the extension
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
      extensionSocket.send(trimmed);
    } else {
      console.error('[KiroBridge] Extension not connected, buffering message');
    }
  });

  rl.on('close', () => {
    console.error('[KiroBridge] stdin closed, shutting down');
    process.exit(0);
  });
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.error('[KiroBridge] Shutting down...');
  wss.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('[KiroBridge] Shutting down...');
  wss.close();
  process.exit(0);
});

console.error(`[KiroBridge] Ready. Waiting for connections...`);
console.error(`[KiroBridge] Extension should connect to ws://localhost:${PORT}`);
if (MODE === 'ws') {
  console.error(`[KiroBridge] Agent should also connect to ws://localhost:${PORT}`);
} else {
  console.error(`[KiroBridge] Agent should pipe JSON messages via stdin/stdout`);
}
