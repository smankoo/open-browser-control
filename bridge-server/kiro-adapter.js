#!/usr/bin/env node

/**
 * Kiro CLI Adapter
 *
 * This adapter translates between the kiro-browser-use protocol
 * and a generic AI agent's tool-calling interface.
 *
 * It connects to the bridge server and exposes a simple interface
 * that can be consumed by AI agents via:
 *   - Stdin/stdout (JSON lines)
 *   - Imported as a module
 *
 * For kiro-cli integration, this serves as a "browser tool provider"
 * that kiro can call when it needs to interact with a web page.
 *
 * Usage as MCP-like tool provider (stdin/stdout):
 *   node kiro-adapter.js --port 9334
 *
 *   # Then send tool calls as JSON lines:
 *   {"tool": "screenshot"}
 *   {"tool": "click", "params": {"text": "Sign In"}}
 *   {"tool": "type", "params": {"text": "hello", "selector": "#search"}}
 */

const WebSocket = require('ws');
const readline = require('readline');

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '9334', 10);

let ws = null;
let connected = false;
let messageId = 0;
const pendingRequests = new Map();

function connect() {
  ws = new WebSocket(`ws://localhost:${PORT}`);

  ws.on('open', () => {
    connected = true;
    output({ type: 'status', connected: true, message: 'Connected to bridge server' });
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'result' && pendingRequests.has(message.id)) {
        const { resolve } = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        resolve(message);
        return;
      }

      if (message.type === 'tool_schema') {
        output({ type: 'tool_schema', tools: message.tools });
        return;
      }

      if (message.type === 'event') {
        output({ type: 'event', event: message.event, data: message.data });
        return;
      }
    } catch (err) {
      output({ type: 'error', message: `Parse error: ${err.message}` });
    }
  });

  ws.on('close', () => {
    connected = false;
    output({ type: 'status', connected: false, message: 'Disconnected' });
    // Reconnect after 3s
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    output({ type: 'error', message: err.message });
  });
}

function output(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function callTool(tool, params = {}) {
  if (!connected || !ws) {
    return { success: false, error: 'Not connected to bridge server' };
  }

  const id = `kiro-${++messageId}`;
  const message = { type: 'action', action: tool, id, params };

  return new Promise((resolve) => {
    pendingRequests.set(id, { resolve });
    ws.send(JSON.stringify(message));

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        resolve({ success: false, error: 'Timeout' });
      }
    }, 30000);
  });
}

// ─── Stdin Interface ─────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);

    // Handle special commands
    if (request.tool === 'list_tools' || request.type === 'get_tool_schema') {
      const id = `kiro-${++messageId}`;
      ws.send(JSON.stringify({ type: 'get_tool_schema', id }));
      return;
    }

    if (request.tool === 'status') {
      output({ type: 'status', connected });
      return;
    }

    // Execute tool call
    const result = await callTool(request.tool, request.params || {});
    output(result);
  } catch (err) {
    output({ type: 'error', message: `Invalid JSON: ${err.message}` });
  }
});

rl.on('close', () => {
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────────────────────────

connect();
