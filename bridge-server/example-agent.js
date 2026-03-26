#!/usr/bin/env node

/**
 * Example AI Agent Client
 *
 * Demonstrates how an AI agent connects to the bridge server
 * and interacts with the Chrome extension.
 *
 * Usage:
 *   # Start the bridge server first:
 *   node server.js --mode ws
 *
 *   # Then load the Chrome extension and click Connect.
 *
 *   # Then run this example agent:
 *   node example-agent.js
 *
 * This shows the basic action→observe loop that a real agent would use.
 */

const WebSocket = require('ws');

const PORT = process.argv[2] || 9334;
const ws = new WebSocket(`ws://localhost:${PORT}`);

let messageId = 0;
const pendingRequests = new Map();

function generateId() {
  return `agent-${++messageId}`;
}

// Send an action and wait for the result
function sendAction(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = generateId();
    const message = { type: 'action', action, id, params };

    pendingRequests.set(id, { resolve, reject });
    ws.send(JSON.stringify(message));
    console.log(`→ ${action}`, params);

    // Timeout after 30s
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Timeout waiting for action result'));
      }
    }, 30000);
  });
}

ws.on('open', async () => {
  console.log('Connected to bridge server');

  try {
    // 1. Get tool schema
    const schemaId = generateId();
    ws.send(JSON.stringify({ type: 'get_tool_schema', id: schemaId }));

    // 2. Example workflow: navigate, screenshot, interact
    console.log('\n=== Starting example browsing session ===\n');

    // Get page info
    const pageInfo = await sendAction('get_page_info');
    console.log('← Page info:', JSON.stringify(pageInfo.data?.pageInfo, null, 2));

    // Take a screenshot
    const screenshot = await sendAction('screenshot');
    console.log(`← Screenshot taken (${screenshot.data?.screenshot?.length} chars base64)`);

    // Get DOM structure
    const dom = await sendAction('get_dom', { simplified: true });
    const elements = dom.data?.dom?.elements || [];
    console.log(`← Found ${elements.length} interactive elements`);
    elements.slice(0, 10).forEach((el) => {
      console.log(`   [${el.index}] <${el.tag}> "${el.text?.slice(0, 40)}" at (${el.bounds.x}, ${el.bounds.y})`);
    });

    console.log('\n=== Example session complete ===');
    console.log('The agent would now use the DOM info + screenshot to decide next actions.');
    console.log('Press Ctrl+C to exit.\n');
  } catch (err) {
    console.error('Error:', err.message);
  }
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());

    // Handle results (responses to our actions)
    if (message.type === 'result' && pendingRequests.has(message.id)) {
      const { resolve } = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      resolve(message);
      return;
    }

    // Handle tool schema
    if (message.type === 'tool_schema') {
      console.log(`← Received ${message.tools?.length} tool definitions`);
      return;
    }

    // Handle events
    if (message.type === 'event') {
      console.log(`← Event: ${message.event}`, message.data);

      if (message.event === 'user_done') {
        console.log('User finished their task, AI can continue...');
      }
      return;
    }

    // Handle pong
    if (message.type === 'pong') return;

    console.log('← Unknown message:', message);
  } catch (err) {
    console.error('Failed to parse message:', err);
  }
});

ws.on('close', () => {
  console.log('Disconnected from bridge server');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});
