# Kiro Browser Use

Chrome extension that gives AI agents real browser control. Built for [Kiro CLI](https://kiro.dev), works with any MCP-compatible agent.

The AI uses **your real browser** — your cookies, sessions, and logins. When it hits something it can't handle (sign-in, CAPTCHA, MFA), it asks you to step in. You do your thing, hand back control, and the AI continues.

---

## Setup (one time)

### 1. Build and load the extension

```bash
git clone <repo-url> && cd kiro-browser-use
npm install && npm run build
```

Open `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select `dist/`

### 2. Configure your AI agent

**Kiro CLI** — add to `~/.kiro/settings/mcp.json`:
```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/kiro-browser-use/bridge-server/mcp-server.js"]
    }
  }
}
```

**Claude Desktop** — same config in Claude's MCP settings.

**Any MCP client** — same config. The MCP server is standard JSON-RPC over stdio.

That's it. No servers to start. No buttons to click. The MCP server starts the bridge, the extension auto-connects.

---

## How It Works

```
┌──────────────┐   MCP (stdio)   ┌──────────────────────┐   WebSocket   ┌──────────────────┐
│  AI Agent    │◄───────────────►│  MCP Server          │◄────────────►│ Chrome Extension │
│  (Kiro CLI,  │  JSON-RPC 2.0  │  (embeds bridge)     │  auto-connect │  (side panel +   │
│  Claude, ..) │                 │  ws://localhost:9334  │               │   CDP control)   │
└──────────────┘                 └──────────────────────┘               └──────────────────┘
```

1. Your AI agent starts the MCP server (Kiro does this automatically from the config)
2. The MCP server starts a WebSocket bridge on `localhost:9334`
3. The Chrome extension auto-connects to the bridge (retries with backoff if not up yet)
4. Agent sends tool calls → MCP server relays to extension → extension executes via CDP → results flow back

No manual "connect" step. The extension shows a pulsing dot while waiting and turns green when connected.

### Standalone use (without MCP)

If you're not using an MCP client, start the bridge directly:

```bash
npm start                           # or: node bridge-server/index.js
```

Then connect your agent via WebSocket to `ws://localhost:9334`. See [Integration Examples](#integration-examples) below.

---

## User/AI Handoff

Three control modes, switchable in the side panel:

| Mode | What happens |
|------|-------------|
| **Collaborative** (default) | Both user and AI can interact with the page |
| **AI Control** | AI drives, user watches |
| **User Control** | AI paused, user takes over |

### Typical handoff flow

```
AI: navigating, clicking, filling forms...
AI: hits a login page it can't handle
AI: calls browser_request_user("Please sign in")
    → Extension shows notification, switches to User Control
User: signs in manually
User: clicks "Done - Hand back to AI" in the side panel
    → Extension sends user_done event
AI: resumes, now authenticated
```

---

## Browser Actions

17 high-level actions. The AI never writes raw CDP — it uses verbs like "click the Sign In button."

### Interaction
| Action | Params |
|--------|--------|
| `browser_click` | `selector`, `text`, `x`, `y`, `button` |
| `browser_type` | `text`, `selector`, `clear`, `pressEnter` |
| `browser_keypress` | `key`, `modifiers` |
| `browser_scroll` | `direction`, `amount`, `selector` |
| `browser_hover` | `selector`, `text`, `x`, `y` |
| `browser_select_option` | `selector`, `value`, `text` |

### Observation
| Action | Params |
|--------|--------|
| `browser_screenshot` | `fullPage`, `selector` |
| `browser_get_dom` | `simplified`, `selector` |
| `browser_get_page_info` | — |
| `browser_execute_js` | `expression` |

### Navigation
| Action | Params |
|--------|--------|
| `browser_navigate` | `url` |
| `browser_wait` | `selector`, `text`, `ms`, `timeout` |
| `browser_new_tab` | `url` |
| `browser_close_tab` | — |
| `browser_switch_tab` | `tabId` |
| `browser_list_tabs` | — |

### Collaboration
| Action | Params |
|--------|--------|
| `browser_request_user` | `message`, `timeout` |

---

## Kiro Custom Agent

For a dedicated browsing agent, drop the config into your workspace:

```bash
mkdir -p .kiro/agents
cp kiro-agent/browser-agent.json .kiro/agents/browser.json
```

Then:
```bash
kiro-cli agent browser "Find the pricing page on example.com"
```

The agent config includes a system prompt that teaches the AI the plan→act→observe→adjust loop and when to call `browser_request_user`.

---

## Integration Examples

### Python (WebSocket)

```python
import asyncio, websockets, json

async def browse():
    async with websockets.connect("ws://localhost:9334") as ws:
        # Screenshot
        await ws.send(json.dumps({"type": "action", "action": "screenshot", "id": "1"}))
        result = json.loads(await ws.recv())

        # Click by text
        await ws.send(json.dumps({
            "type": "action", "action": "click", "id": "2",
            "params": {"text": "Sign In"}
        }))
        result = json.loads(await ws.recv())

        # Hand off to user
        await ws.send(json.dumps({
            "type": "action", "action": "request_user", "id": "3",
            "params": {"message": "Please sign in"}
        }))
        result = json.loads(await ws.recv())  # blocks until user clicks Done

asyncio.run(browse())
```

### Node.js

```bash
node bridge-server/example-agent.js
```

### stdin/stdout (pipe JSON lines)

```bash
node bridge-server/kiro-adapter.js --port 9334
# Then type:
{"tool": "screenshot"}
{"tool": "navigate", "params": {"url": "https://example.com"}}
```

---

## Protocol

JSON messages over WebSocket. Every action has a unique `id`.

**Request:**
```json
{"type": "action", "action": "click", "id": "1", "params": {"text": "Submit"}}
```

**Response:**
```json
{"type": "result", "id": "1", "success": true, "data": {"clicked": {"x": 450, "y": 320}}, "pageState": {"url": "...", "title": "...", "tabId": 123}}
```

**Events (no request needed):**
```json
{"type": "event", "event": "page_navigated", "data": {"url": "...", "title": "..."}}
{"type": "event", "event": "user_done", "data": {"message": "Signed in"}}
```

**Tool discovery:**
```json
{"type": "get_tool_schema", "id": "s1"}
```

---

## Project Structure

```
kiro-browser-use/
├── src/                              # Chrome extension (TypeScript)
│   ├── manifest.json                 # Manifest V3
│   ├── background/service-worker.ts  # Auto-connect, action routing, state
│   ├── actions/browser-actions.ts    # 17 CDP actions + tool schema
│   ├── bridge/websocket-bridge.ts    # WS client, reconnect, keepalive
│   ├── content/content-script.ts     # DOM annotation, element finding
│   ├── sidepanel/                    # Control panel UI
│   └── types/protocol.ts            # TypeScript protocol types
├── bridge-server/
│   ├── mcp-server.js                 # MCP server + embedded bridge (one process)
│   ├── server.js                     # Standalone WS bridge (for non-MCP use)
│   ├── index.js                      # CLI entry point
│   ├── example-agent.js              # Demo agent
│   └── kiro-adapter.js               # stdin/stdout adapter
├── kiro-agent/
│   └── browser-agent.json            # Drop-in Kiro agent config
└── dist/                             # Built extension → load in Chrome
```

## Development

```bash
npm run dev      # Watch mode
npm run build    # Production build
npm start        # Start bridge server
```

## Requirements

- Chrome 116+
- Node.js 18+
