# Kiro Browser Use

Give AI agents control of your Chrome browser. Works with [Kiro CLI](https://kiro.dev), [Claude Desktop](https://claude.ai/download), and any MCP client.

The AI uses **your real browser** — your cookies, sessions, and logins. When it hits something it can't handle (sign-in, CAPTCHA, MFA), it asks you to step in, then continues where it left off.

## Setup

### 1. Add MCP config

**Kiro CLI** — add to `~/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "kiro-browser-use"]
    }
  }
}
```

**Claude Desktop** — add the same to your MCP settings.

### 2. Load the Chrome extension

The extension is auto-installed to `~/.kiro-browser-use/extension/` on first run. Load it in Chrome:

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `~/.kiro-browser-use/extension/`

That's it. The extension auto-connects when your agent starts. No servers to run, no buttons to click.

---

## How It Works

```
┌──────────────┐   MCP (stdio)   ┌──────────────────────┐   WebSocket   ┌──────────────────┐
│  AI Agent    │◄───────────────►│  npx kiro-browser-use │◄────────────►│ Chrome Extension │
│  (Kiro CLI,  │  JSON-RPC 2.0  │  (MCP + bridge)       │  auto-connect │  (side panel +   │
│  Claude, ..) │                 │  ws://localhost:9334  │               │   CDP control)   │
└──────────────┘                 └──────────────────────┘               └──────────────────┘
```

1. Your agent starts the MCP server automatically (from the config above)
2. MCP server starts a WebSocket bridge on `localhost:9334`
3. Chrome extension auto-connects (polls every 2s until it finds the bridge)
4. Agent sends tool calls → extension executes via Chrome DevTools Protocol → results flow back

---

## User/AI Handoff

| Mode | What happens |
|------|-------------|
| **Collaborative** (default) | Both user and AI interact with the page |
| **AI Control** | AI drives, user watches |
| **User Control** | AI paused, user takes over |

```
AI browsing → hits login page → calls browser_request_user("Please sign in")
  → user signs in → clicks "Done" in side panel → AI continues, now authenticated
```

---

## Browser Tools

17 tools available to the AI:

| Tool | What it does |
|------|-------------|
| `browser_screenshot` | Capture page as PNG (saves to temp file, returns path) |
| `browser_click` | Click by selector, text, or coordinates |
| `browser_type` | Type text, optionally clear first or press Enter |
| `browser_navigate` | Go to a URL |
| `browser_scroll` | Scroll up/down/left/right |
| `browser_get_dom` | Get interactive elements with positions and text |
| `browser_get_page_info` | URL, title, dimensions, scroll position |
| `browser_wait` | Wait for element, text, or fixed time |
| `browser_keypress` | Press any key with modifiers |
| `browser_execute_js` | Run JavaScript in page context |
| `browser_hover` | Hover over an element |
| `browser_select_option` | Pick from a dropdown |
| `browser_request_user` | Ask user to take over (sign in, CAPTCHA, etc.) |
| `browser_new_tab` | Open a new tab |
| `browser_close_tab` | Close current tab |
| `browser_switch_tab` | Switch to a tab by ID |
| `browser_list_tabs` | List all open tabs |

---

## Kiro Custom Agent

For a dedicated browsing agent:

```bash
mkdir -p .kiro/agents
npx kiro-browser-use --extension  # ensure extension is installed
cp node_modules/kiro-browser-use/kiro-agent/browser-agent.json .kiro/agents/browser.json
```

```bash
kiro-cli agent browser "Find the pricing page on example.com"
```

---

## Standalone Use (no MCP)

If you're not using an MCP client:

```bash
npx kiro-browser-use --bridge    # starts WebSocket bridge only
```

Connect your agent to `ws://localhost:9334` and send JSON messages:

```json
{"type": "action", "action": "screenshot", "id": "1"}
{"type": "action", "action": "click", "id": "2", "params": {"text": "Sign In"}}
{"type": "action", "action": "navigate", "id": "3", "params": {"url": "https://example.com"}}
```

---

## CLI

```bash
npx kiro-browser-use                 # Start MCP server (default)
npx kiro-browser-use --bridge        # Standalone WebSocket bridge
npx kiro-browser-use --extension     # Print extension install path
npx kiro-browser-use --port 9000     # Custom port
npx kiro-browser-use --help          # Help
```

---

## Development

```bash
git clone https://github.com/smankoo/kiro-browser-use
cd kiro-browser-use
npm install
npm run build    # builds extension to dist/ and packages to extension/
npm run dev      # watch mode
npm start        # run MCP server locally
```

## Requirements

- Chrome 116+
- Node.js 18+
