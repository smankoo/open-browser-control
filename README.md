# Kiro Browser Use

A Chrome extension that connects AI agents (like Kiro CLI) to Chrome for collaborative browsing. The AI can control the browser while the user can seamlessly take over for tasks like signing in, solving CAPTCHAs, or handling complex interactions — then hand control back.

## Architecture

```
┌──────────────┐      stdio/WS      ┌───────────────┐    WebSocket     ┌──────────────────┐
│  AI Agent    │◄───────────────────►│ Bridge Server │◄────────────────►│ Chrome Extension │
│ (kiro-cli,   │   JSON protocol    │ (Node.js)     │  ws://localhost  │  ┌─────────────┐ │
│  any agent)  │                    └───────────────┘                  │  │ Side Panel  │ │
└──────────────┘                                                       │  │ (control UI)│ │
                                                                       │  └─────────────┘ │
                                                                       │  ┌─────────────┐ │
                                                                       │  │ Background  │ │
                                                                       │  │ SW + CDP    │ │
                                                                       │  └─────────────┘ │
                                                                       └──────────────────┘
```

### Components

1. **Chrome Extension** (Manifest V3)
   - **Side Panel**: Control UI showing connection status, control mode, action log
   - **Background Service Worker**: WebSocket client, routes actions, manages state
   - **Content Script**: DOM annotation, element finding, visual overlays
   - **Browser Actions**: High-level CDP abstractions (click, type, scroll, screenshot, etc.)

2. **Bridge Server** (Node.js)
   - WebSocket relay between extension and AI agent
   - Supports both WebSocket and stdin/stdout modes
   - Kiro adapter for CLI integration

## Quick Start

### 1. Build the extension

```bash
npm install
npm run build
```

### 2. Load in Chrome

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `dist/` folder

### 3. Start the bridge server

```bash
# WebSocket mode (agent connects as another WS client)
npm run bridge

# Or stdio mode (agent communicates via stdin/stdout)
node bridge-server/server.js --mode stdio
```

### 4. Connect the extension

1. Click the Kiro Browser Use icon in Chrome to open the side panel
2. Enter the bridge port (default: 9334)
3. Click "Connect"

### 5. Run an AI agent

```bash
# Example agent (demonstrates the protocol)
node bridge-server/example-agent.js

# Or use the Kiro adapter for stdin/stdout integration
node bridge-server/kiro-adapter.js --port 9334
```

## Protocol

Messages are JSON objects sent over WebSocket. Each action has a unique `id` for request/response correlation.

### Agent → Extension (Actions)

| Action | Description | Key Params |
|--------|-------------|------------|
| `screenshot` | Capture page screenshot | `fullPage`, `selector` |
| `click` | Click element | `x`, `y`, `selector`, `text` |
| `type` | Type text | `text`, `selector`, `clear`, `pressEnter` |
| `keypress` | Press key | `key`, `modifiers` |
| `scroll` | Scroll page | `direction`, `amount` |
| `navigate` | Go to URL | `url` |
| `wait` | Wait for condition | `selector`, `text`, `ms` |
| `get_dom` | Get page structure | `simplified` |
| `get_page_info` | Get page metadata | — |
| `execute_js` | Run JavaScript | `expression` |
| `hover` | Hover element | `x`, `y`, `selector`, `text` |
| `select_option` | Select dropdown option | `selector`, `value`, `text` |
| `request_user` | Ask user to take action | `message`, `timeout` |
| `new_tab` | Open new tab | `url` |
| `close_tab` | Close current tab | — |
| `switch_tab` | Switch to tab | `tabId` |
| `list_tabs` | List all tabs | — |

### Extension → Agent (Results)

```json
{
  "type": "result",
  "id": "action-123",
  "success": true,
  "data": { ... },
  "pageState": { "url": "...", "title": "...", "tabId": 123 }
}
```

### Extension → Agent (Events)

| Event | Description |
|-------|-------------|
| `connected` | Extension connected to bridge |
| `disconnected` | Extension disconnected |
| `page_navigated` | Active tab URL changed |
| `user_handoff` | User took control |
| `user_done` | User finished, AI can resume |

## Control Modes

- **Collaborative**: Both user and AI can interact with the page
- **AI Control**: AI has full control, user observes
- **User Control**: AI is paused, user interacts (used during `request_user`)

## User/AI Handoff Flow

1. AI encounters something it can't do (e.g., sign-in page)
2. AI sends `request_user` action with a message
3. Extension shows notification and switches to User Control
4. User performs the action (signs in, solves CAPTCHA, etc.)
5. User clicks "Done - Hand back to AI" in the side panel
6. Extension sends `user_done` event, AI resumes

## Kiro CLI Integration

### As an MCP Server

Add to your Kiro MCP config (`~/.kiro/settings/mcp.json` or workspace `.kiro/mcp.json`):

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/kiro-browser-use/bridge-server/mcp-server.js"],
      "env": { "BRIDGE_PORT": "9334" }
    }
  }
}
```

Then in Kiro CLI, the browser tools are available as `@browser` tools:
```
> @browser browser_screenshot
> @browser browser_click --text "Sign In"
> @browser browser_navigate --url "https://example.com"
```

### As a Custom Agent

Copy the agent config to your Kiro workspace:
```bash
cp kiro-agent/browser-agent.json .kiro/agents/browser.json
```

Then run it:
```bash
kiro-cli agent browser "Go to example.com and find the pricing page"
```

### Works with Claude Desktop Too

Add the same MCP server config to Claude Desktop's settings to give Claude browser control through this extension.

## Integrating with Your AI Agent

### Python Example

```python
import asyncio
import websockets
import json

async def browse():
    async with websockets.connect("ws://localhost:9334") as ws:
        # Take screenshot
        await ws.send(json.dumps({
            "type": "action",
            "action": "screenshot",
            "id": "1"
        }))
        result = json.loads(await ws.recv())
        screenshot_b64 = result["data"]["screenshot"]

        # Click a button
        await ws.send(json.dumps({
            "type": "action",
            "action": "click",
            "id": "2",
            "params": {"text": "Sign In"}
        }))
        result = json.loads(await ws.recv())

        # Ask user to sign in
        await ws.send(json.dumps({
            "type": "action",
            "action": "request_user",
            "id": "3",
            "params": {"message": "Please sign in with your credentials"}
        }))
        # This will block until user clicks "Done"
        result = json.loads(await ws.recv())

asyncio.run(browse())
```

### Node.js Example

See `bridge-server/example-agent.js` for a complete example.

## Development

```bash
npm run dev    # Build with watch mode
npm run build  # Production build
npm run bridge # Start bridge server
```
