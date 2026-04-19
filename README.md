# Open Browser Control

Give AI agents control of **your browser** — Chrome or Firefox. Works with [Kiro](https://kiro.dev), [Claude Code](https://claude.ai/claude-code), [Claude Desktop](https://claude.ai/download), [Cursor](https://cursor.com), and any MCP client.

The AI uses **your real browser** — your cookies, sessions, and logins. When it hits something it can't handle (sign-in, CAPTCHA, MFA), it asks you to step in, then continues where it left off.

Install either the Chrome **or** the Firefox extension — the MCP server speaks the same protocol to both.

## Quick Start

### Step 1: Add MCP config

Add to your MCP client's config:

**Kiro** — add to `.kiro/settings/mcp.json` (workspace) or `~/.kiro/settings/mcp.json` (global):
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "open-browser-control"]
    }
  }
}
```

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add browser -- npx -y open-browser-control
```
</details>

<details>
<summary><strong>Claude Desktop / Cursor / other MCP clients</strong></summary>

Add to your MCP config file:
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "open-browser-control"]
    }
  }
}
```
</details>

### Step 2: Install the browser extension

Pick whichever browser you'd like the AI to drive.

**Chrome** — install from the Chrome Web Store:

**[Open Browser Control on the Chrome Web Store](https://chromewebstore.google.com/detail/open-browser-control/icicfjcgocaakibmmaejmoipckofnnpl)**

<details>
<summary><strong>Firefox</strong></summary>

Unpack the extension and load it in Firefox:

```bash
npx -y open-browser-control --extension firefox
```

This prints a path like `~/open-browser-control-extension-firefox`. Then:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Pick the `manifest.json` inside that folder

> Firefox clears unsigned temporary add-ons on restart. For a permanent install, use Firefox Developer Edition (`xpinstall.signatures.required=false`) or sign the extension via AMO.
</details>

<details>
<summary><strong>Chrome — load unpacked</strong></summary>

The extension is auto-installed to `~/open-browser-control-extension/` on first run. Load it in Chrome:

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the folder: `~/open-browser-control-extension/`
</details>

Done. The extension auto-connects when your agent starts. No servers to run, no buttons to click.

---

## How It Works

```
AI Agent          MCP Server              Browser Extension
(Kiro,       ◄──► (npx open-browser-  ◄──► (Chrome: CDP, or
 Claude, ..)      control)                  Firefox: scripting API)
              stdio    ws://localhost:9334    auto-connect
```

1. Your agent starts the MCP server automatically (from the config above)
2. MCP server starts a WebSocket bridge on `localhost:9334`
3. The browser extension (Chrome or Firefox) auto-connects (polls every 2s until it finds the bridge)
4. Agent sends tool calls → extension executes (via Chrome DevTools Protocol on Chrome, or the WebExtensions `scripting` API on Firefox) → results flow back

Both extensions implement the same JSON protocol over WebSocket, so the MCP server, bridge, and agents never need to know which browser is on the other end.

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

19 tools available to the AI:

| Tool | What it does |
|------|-------------|
| `browser_navigate` | Go to a URL |
| `browser_get_dom` | Get interactive elements with positions and text (primary way to read pages) |
| `browser_get_page_info` | URL, title, dimensions, scroll position |
| `browser_execute_js` | Run JavaScript in page context |
| `browser_click` | Click by selector, text, or coordinates |
| `browser_type` | Type text, optionally clear first or press Enter |
| `browser_scroll` | Scroll up/down/left/right |
| `browser_keypress` | Press any key with modifiers |
| `browser_hover` | Hover over an element |
| `browser_select_option` | Pick from a dropdown |
| `browser_wait` | Wait for element, text, or fixed time |
| `browser_screenshot` | Capture page as PNG (use sparingly — DOM tools are faster) |
| `browser_request_user` | Ask user to take over (sign in, CAPTCHA, etc.) |
| `browser_new_tab_group` | Create a named tab group for a task |
| `browser_new_tab` | Open a new tab in the current group |
| `browser_close_tab` | Close a tab |
| `browser_switch_tab` | Switch to a tab by ID |
| `browser_list_tabs` | List all open tabs in this session |
| `browser_set_session_name` | Set the session name (shown on tab group) |

---

## Standalone Use (no MCP)

If you're not using an MCP client:

```bash
npx -y open-browser-control --bridge    # starts WebSocket bridge only
```

Connect your agent to `ws://localhost:9334` and send JSON messages:

```json
{"type": "action", "action": "navigate", "id": "1", "params": {"url": "https://example.com"}}
{"type": "action", "action": "click", "id": "2", "params": {"text": "Sign In"}}
{"type": "action", "action": "get_dom", "id": "3"}
```

---

## CLI

```bash
npx -y open-browser-control                 # Start MCP server (default)
npx -y open-browser-control --bridge        # Standalone WebSocket bridge
npx -y open-browser-control --extension     # Print extension install path
npx -y open-browser-control --port 9000     # Custom port
npx -y open-browser-control --help          # Help
```

---

## Development

```bash
git clone https://github.com/smankoo/open-browser-control
cd open-browser-control
npm install
npm run build    # builds both browsers → dist/chrome, dist/firefox
                 # and packages to extension/ and extension-firefox/
npm run dev      # watch mode
npm start        # run MCP server locally
```

## Requirements

- Chrome 116+ **or** Firefox 128+
- Node.js 18+
