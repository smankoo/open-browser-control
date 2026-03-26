# Kiro Browser Use

A Chrome extension that gives AI agents real browser control. Built for [Kiro CLI](https://kiro.dev) and compatible with any AI agent that speaks MCP, WebSocket, or stdio.

The key idea: **user and AI share the browser**. The AI drives automation while the user steps in for things AI can't do (sign in, solve CAPTCHAs, handle MFA). Then they hand control back. No separate browser instance, no headless Chrome, no simulated environments. The AI uses *your* real browser, with *your* cookies and sessions.

---

## How It Works

```
                                                    ┌──────────────────────────────┐
┌──────────────┐             ┌───────────────┐      │       Chrome Extension       │
│              │  MCP/stdio  │               │  WS  │  ┌──────────┐ ┌───────────┐ │
│   AI Agent   │◄───────────►│ Bridge Server │◄────►│  │Side Panel│ │Background │ │
│  (Kiro CLI,  │  or  WS     │  (Node.js)    │      │  │   (UI)   │ │  SW + CDP │ │
│ Claude, any) │             │               │      │  └──────────┘ └───────────┘ │
│              │             └───────────────┘      │  ┌──────────┐ ┌───────────┐ │
└──────────────┘                                    │  │ Content  │ │  Browser  │ │
                                                    │  │  Script  │ │  Actions  │ │
                                                    │  └──────────┘ └───────────┘ │
                                                    └──────────────────────────────┘
```

The extension uses Chrome DevTools Protocol (CDP) via the `chrome.debugger` API to control tabs -- the same protocol that powers Chrome DevTools. This gives it full access to screenshots, mouse/keyboard input, DOM inspection, JavaScript execution, and navigation.

The bridge server relays messages between the extension and your AI agent. It supports two modes:
- **WebSocket**: agent connects as a second WebSocket client
- **stdio**: agent pipes JSON lines over stdin/stdout (for CLI tools like Kiro)

---

## Quick Start

### 1. Install and build

```bash
git clone <repo-url>
cd kiro-browser-use
npm install
npm run build
```

### 2. Load the extension in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `dist/` folder
4. Pin the extension to your toolbar

### 3. Start the bridge server

```bash
npm run bridge
```

This starts the WebSocket relay on `ws://localhost:9334`.

### 4. Connect

1. Click the extension icon to open the **side panel**
2. Port should default to `9334` -- click **Connect**
3. The status badge turns green when connected

### 5. Run an AI agent

```bash
# Try the example agent to see the protocol in action
node bridge-server/example-agent.js
```

---

## Kiro CLI Integration

### Option A: MCP Server (recommended)

The MCP server exposes all browser tools via the [Model Context Protocol](https://modelcontextprotocol.io/), so Kiro CLI can discover and call them natively.

Add to `~/.kiro/settings/mcp.json` (global) or `.kiro/mcp.json` (workspace):

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/kiro-browser-use/bridge-server/mcp-server.js"],
      "env": { "BRIDGE_PORT": "9334" }
    }
  }
}
```

Now Kiro can use `@browser` tools:
```
> Navigate to example.com and screenshot the page
  (Kiro calls @browser browser_navigate, then @browser browser_screenshot)
```

### Option B: Custom Agent

Drop the pre-built agent config into your workspace:

```bash
mkdir -p .kiro/agents
cp kiro-agent/browser-agent.json .kiro/agents/browser.json
```

Run it:
```bash
kiro-cli agent browser "Go to example.com and find the pricing page"
```

The agent config includes a prompt that teaches the AI to use screenshots + DOM inspection for decision-making and to call `browser_request_user` when it hits login pages or CAPTCHAs.

### Option C: Claude Desktop / Any MCP Client

The same MCP server works with Claude Desktop, Cursor, Windsurf, or any MCP-compatible client. Add the `mcpServers` config to that tool's settings file.

---

## User/AI Handoff

This is the core feature. Three control modes:

| Mode | Who acts | When to use |
|------|----------|-------------|
| **Collaborative** | Both user and AI | Default. AI automates while you watch, you can interact freely |
| **AI Control** | AI only | AI is running a task, user observes |
| **User Control** | User only | AI is paused, waiting for user to finish something |

### Handoff flow

```
AI browsing...
  -> AI hits a login page
  -> AI calls request_user: "Please sign in to your account"
  -> Extension shows notification, switches to User Control
  -> User signs in manually
  -> User clicks "Done - Hand back to AI" in the side panel
  -> Extension sends user_done event
  -> AI resumes where it left off, now authenticated
```

The user can also take control at any time by switching modes in the side panel, and hand back when ready.

---

## Browser Actions

17 high-level actions available to the AI. These are abstractions over CDP -- the AI never needs to think in raw protocol commands.

### Navigation & Pages
| Action | Description | Key Params |
|--------|-------------|------------|
| `navigate` | Go to a URL | `url` |
| `get_page_info` | Get URL, title, scroll position, viewport size | -- |
| `wait` | Wait for element, text, navigation, or fixed time | `selector`, `text`, `ms`, `timeout` |

### Interaction
| Action | Description | Key Params |
|--------|-------------|------------|
| `click` | Click element by selector, text, or coordinates | `selector`, `text`, `x`, `y`, `button` |
| `type` | Type text (optionally clear first, press Enter after) | `text`, `selector`, `clear`, `pressEnter` |
| `keypress` | Press any key with modifiers | `key`, `modifiers` |
| `scroll` | Scroll page or element | `direction`, `amount`, `selector` |
| `hover` | Move mouse over element | `selector`, `text`, `x`, `y` |
| `select_option` | Pick dropdown option | `selector`, `value`, `text` |

### Observation
| Action | Description | Key Params |
|--------|-------------|------------|
| `screenshot` | Capture page as base64 PNG | `fullPage`, `selector` |
| `get_dom` | Get interactive elements with positions and text | `simplified`, `selector` |
| `execute_js` | Run JavaScript in page context | `expression` |

### Tab Management
| Action | Description | Key Params |
|--------|-------------|------------|
| `new_tab` | Open new tab | `url` |
| `close_tab` | Close current tab | -- |
| `switch_tab` | Switch to tab by ID | `tabId` |
| `list_tabs` | List all open tabs | -- |

### Collaboration
| Action | Description | Key Params |
|--------|-------------|------------|
| `request_user` | Ask user to do something, AI pauses | `message`, `timeout` |

---

## Protocol Reference

All messages are JSON over WebSocket with a `type` field and unique `id` for request/response correlation.

### Sending an action

```json
{
  "type": "action",
  "action": "click",
  "id": "req-1",
  "params": {
    "text": "Sign In"
  }
}
```

### Receiving a result

```json
{
  "type": "result",
  "id": "req-1",
  "success": true,
  "data": {
    "clicked": { "x": 450, "y": 320 },
    "button": "left",
    "clickCount": 1
  },
  "pageState": {
    "url": "https://example.com/login",
    "title": "Sign In - Example",
    "tabId": 123
  }
}
```

### Events (extension -> agent, no request needed)

```json
{ "type": "event", "event": "page_navigated", "data": { "url": "...", "title": "...", "tabId": 123 } }
{ "type": "event", "event": "user_handoff", "data": { "message": "User took control" } }
{ "type": "event", "event": "user_done", "data": { "message": "Signed in successfully" } }
{ "type": "event", "event": "connected", "data": { "version": "0.1.0" } }
```

### Discovering available tools

```json
{ "type": "get_tool_schema", "id": "schema-1" }
```

Returns full JSON Schema definitions for all 17 actions.

---

## Integration Examples

### Python

```python
import asyncio, websockets, json

async def browse():
    async with websockets.connect("ws://localhost:9334") as ws:
        # Take screenshot
        await ws.send(json.dumps({
            "type": "action", "action": "screenshot", "id": "1"
        }))
        result = json.loads(await ws.recv())
        screenshot_b64 = result["data"]["screenshot"]

        # Find interactive elements
        await ws.send(json.dumps({
            "type": "action", "action": "get_dom", "id": "2",
            "params": {"simplified": True}
        }))
        result = json.loads(await ws.recv())
        elements = result["data"]["dom"]["elements"]

        # Click a button by its text
        await ws.send(json.dumps({
            "type": "action", "action": "click", "id": "3",
            "params": {"text": "Submit"}
        }))
        result = json.loads(await ws.recv())

        # Ask user to handle sign-in
        await ws.send(json.dumps({
            "type": "action", "action": "request_user", "id": "4",
            "params": {"message": "Please sign in with your credentials"}
        }))
        # Blocks until user clicks "Done" in side panel
        result = json.loads(await ws.recv())
        print("User finished:", result["data"])

asyncio.run(browse())
```

### Node.js

See [`bridge-server/example-agent.js`](bridge-server/example-agent.js) for a complete working example.

### Stdin/Stdout (for CLI agents)

```bash
# Start bridge in stdio mode
node bridge-server/server.js --mode stdio

# Or use the Kiro adapter
node bridge-server/kiro-adapter.js --port 9334
```

Then pipe JSON commands:
```json
{"tool": "screenshot"}
{"tool": "click", "params": {"text": "Sign In"}}
{"tool": "navigate", "params": {"url": "https://example.com"}}
```

---

## Project Structure

```
kiro-browser-use/
├── src/                              # Chrome extension source (TypeScript)
│   ├── manifest.json                 # Manifest V3 config
│   ├── background/service-worker.ts  # WebSocket client, action routing, state
│   ├── actions/browser-actions.ts    # 17 CDP-based actions + tool schema
│   ├── bridge/websocket-bridge.ts    # WS client with reconnect + keepalive
│   ├── content/content-script.ts     # DOM annotation, element finding
│   ├── sidepanel/                    # Control panel UI (HTML/CSS/TS)
│   └── types/protocol.ts            # TypeScript protocol definitions
├── bridge-server/
│   ├── server.js                     # WebSocket relay (ws + stdio modes)
│   ├── mcp-server.js                 # MCP server for Kiro/Claude Desktop
│   ├── example-agent.js              # Demo agent
│   └── kiro-adapter.js               # Stdin/stdout adapter
├── kiro-agent/
│   └── browser-agent.json            # Drop-in Kiro custom agent config
├── dist/                             # Built extension (load in Chrome)
├── package.json
├── tsconfig.json
└── webpack.config.js
```

---

## Development

```bash
npm run dev      # Build with watch mode (auto-rebuild on changes)
npm run build    # Production build
npm run bridge   # Start the bridge server on port 9334
npm run clean    # Remove dist/
```

After changing extension source, reload the extension in `chrome://extensions/` (click the refresh icon).

---

## How It Compares

This project is inspired by the [Claude Chrome extension](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn) but designed to be **agent-agnostic**. Key differences:

| | Claude Extension | Kiro Browser Use |
|---|---|---|
| **Agent** | Claude only | Any agent (Kiro, Claude, custom) |
| **Protocol** | Proprietary | Open WebSocket + MCP |
| **Browser** | Embedded in Anthropic stack | Standalone, composable |
| **Handoff** | Claude-specific UX | Generic user/AI handoff |
| **Integration** | Claude Code / Desktop | MCP, WebSocket, stdio |

The design philosophy follows the **plan -> act -> observe -> adjust** loop: the AI takes an action, gets back structured feedback (screenshots, DOM state, page info), reasons about what happened, and decides the next step.

---

## Requirements

- Chrome 116+ (for WebSocket keepalive in Manifest V3 service workers)
- Node.js 18+
- npm 8+

---

## License

MIT
