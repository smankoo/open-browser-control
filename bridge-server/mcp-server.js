#!/usr/bin/env node

/**
 * MCP Server for Kiro Browser Use
 *
 * Implements the Model Context Protocol (MCP) over stdio, making the browser
 * extension's capabilities available as MCP tools that Kiro CLI (and other
 * MCP-compatible agents like Claude Desktop) can discover and call.
 *
 * Usage:
 *   # As a Kiro MCP server (add to ~/.kiro/settings/mcp.json):
 *   {
 *     "mcpServers": {
 *       "browser": {
 *         "command": "node",
 *         "args": ["/path/to/kiro-browser-use/bridge-server/mcp-server.js"],
 *         "env": { "BRIDGE_PORT": "9334" }
 *       }
 *     }
 *   }
 *
 * This server connects to the bridge server as a WebSocket client and
 * translates MCP JSON-RPC requests into the extension's action protocol.
 */

const WebSocket = require('ws');
const readline = require('readline');

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '9334', 10);
const SERVER_NAME = 'kiro-browser-use';
const SERVER_VERSION = '0.1.0';

// ─── WebSocket Connection to Bridge ──────────────────────────────────────────

let ws = null;
let wsConnected = false;
let actionId = 0;
const pendingActions = new Map();

function connectBridge() {
  ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}`);

  ws.on('open', () => {
    wsConnected = true;
    log('Connected to bridge server');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Route results back to pending MCP requests
      if (msg.type === 'result' && pendingActions.has(msg.id)) {
        const { resolve } = pendingActions.get(msg.id);
        pendingActions.delete(msg.id);
        resolve(msg);
      }

      // Route tool schema responses
      if (msg.type === 'tool_schema' && pendingActions.has(msg.id)) {
        const { resolve } = pendingActions.get(msg.id);
        pendingActions.delete(msg.id);
        resolve(msg);
      }
    } catch (err) {
      log(`Parse error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    wsConnected = false;
    log('Disconnected from bridge, reconnecting in 3s...');
    setTimeout(connectBridge, 3000);
  });

  ws.on('error', (err) => {
    log(`Bridge error: ${err.message}`);
  });
}

function sendAction(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!wsConnected || !ws) {
      reject(new Error('Not connected to bridge server. Make sure the bridge is running and the Chrome extension is connected.'));
      return;
    }

    const id = `mcp-${++actionId}`;
    const message = { type: 'action', action, id, params };

    pendingActions.set(id, { resolve, reject });
    ws.send(JSON.stringify(message));

    setTimeout(() => {
      if (pendingActions.has(id)) {
        pendingActions.delete(id);
        reject(new Error(`Timeout waiting for ${action} result`));
      }
    }, 30000);
  });
}

// ─── MCP Tool Definitions ────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current browser page. Returns base64-encoded PNG image.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture full scrollable page instead of just viewport' },
        selector: { type: 'string', description: 'CSS selector to screenshot a specific element' },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click on a page element. Specify by CSS selector, visible text, or x/y coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to click' },
        text: { type: 'string', description: 'Visible text of element to click' },
        x: { type: 'number', description: 'X coordinate to click' },
        y: { type: 'number', description: 'Y coordinate to click' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
      },
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the focused element or a specific element.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        selector: { type: 'string', description: 'CSS selector to focus before typing' },
        clear: { type: 'boolean', description: 'Clear existing text before typing' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in the current tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page in a direction.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
        selector: { type: 'string', description: 'Scroll within a specific element' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'browser_get_dom',
    description: 'Get the page DOM structure. Returns interactive elements with their text, roles, and positions.',
    inputSchema: {
      type: 'object',
      properties: {
        simplified: { type: 'boolean', description: 'Return simplified interactive elements (default: true)' },
        selector: { type: 'string', description: 'Scope to a CSS selector' },
      },
    },
  },
  {
    name: 'browser_get_page_info',
    description: 'Get current page metadata: URL, title, dimensions, scroll position.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a condition: element to appear, text to show, or fixed time.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Wait for element matching selector' },
        text: { type: 'string', description: 'Wait for text to appear on page' },
        ms: { type: 'number', description: 'Wait fixed milliseconds' },
        timeout: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
      },
    },
  },
  {
    name: 'browser_keypress',
    description: 'Press a keyboard key, optionally with modifiers.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name (Enter, Tab, Escape, ArrowDown, etc.)' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] },
          description: 'Modifier keys to hold',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_execute_js',
    description: 'Execute JavaScript in the page context and return the result.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_request_user',
    description: 'Ask the user to perform an action (e.g., sign in, solve CAPTCHA). The AI pauses until the user signals they are done.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message explaining what the user needs to do' },
        timeout: { type: 'number', description: 'Auto-resume after this many ms (optional)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'browser_new_tab',
    description: 'Open a new browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (default: about:blank)' },
      },
    },
  },
  {
    name: 'browser_list_tabs',
    description: 'List all open browser tabs with their IDs, URLs, and titles.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_switch_tab',
    description: 'Switch to a specific browser tab by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to switch to (get IDs from browser_list_tabs)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_hover',
    description: 'Move mouse over an element to trigger hover effects.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select an option from a dropdown <select> element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the select element' },
        value: { type: 'string', description: 'Option value to select' },
        text: { type: 'string', description: 'Option text to match' },
      },
      required: ['selector'],
    },
  },
];

// Map MCP tool names to extension action names
const TOOL_TO_ACTION = {
  browser_screenshot: 'screenshot',
  browser_click: 'click',
  browser_type: 'type',
  browser_navigate: 'navigate',
  browser_scroll: 'scroll',
  browser_get_dom: 'get_dom',
  browser_get_page_info: 'get_page_info',
  browser_wait: 'wait',
  browser_keypress: 'keypress',
  browser_execute_js: 'execute_js',
  browser_request_user: 'request_user',
  browser_new_tab: 'new_tab',
  browser_list_tabs: 'list_tabs',
  browser_switch_tab: 'switch_tab',
  browser_hover: 'hover',
  browser_select_option: 'select_option',
};

// ─── MCP JSON-RPC Handler ────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[${SERVER_NAME}] ${msg}\n`);
}

function sendJsonRpc(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(json + '\n');
}

function sendResult(id, result) {
  sendJsonRpc({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendJsonRpc({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
      break;

    case 'notifications/initialized':
      // Client acknowledged initialization
      break;

    case 'tools/list':
      sendResult(id, { tools: MCP_TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      const actionName = TOOL_TO_ACTION[toolName];
      if (!actionName) {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      try {
        const result = await sendAction(actionName, args);

        if (result.success) {
          // Format response based on action type
          const content = [];

          if (result.data?.screenshot) {
            content.push({
              type: 'image',
              data: result.data.screenshot,
              mimeType: 'image/png',
            });
          }

          // Always include a text summary
          const summary = { ...result.data };
          delete summary.screenshot; // Don't duplicate screenshot in text
          if (result.pageState) {
            summary.pageState = result.pageState;
          }
          content.push({
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          });

          sendResult(id, { content });
        } else {
          sendResult(id, {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
            isError: true,
          });
        }
      } catch (err) {
        sendResult(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      break;
    }

    case 'ping':
      sendResult(id, {});
      break;

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ─── Stdio JSON-RPC Transport ────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    handleRequest(request).catch((err) => {
      log(`Handler error: ${err.message}`);
      if (request.id !== undefined) {
        sendError(request.id, -32603, err.message);
      }
    });
  } catch (err) {
    log(`Parse error: ${err.message}`);
  }
});

rl.on('close', () => {
  log('stdin closed, shutting down');
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────────────────────────

connectBridge();
log(`MCP server started (bridge port: ${BRIDGE_PORT})`);
