# Privacy Policy — Open Browser Control

**Last updated:** April 6, 2026

## What this extension does

Open Browser Control connects AI agents to your Chrome browser via the Model Context Protocol (MCP). The AI agent can navigate pages, click, type, read page content, and manage tabs — all on your behalf.

## Data collection

This extension collects the following data **locally** as part of browser automation:

- **Page URLs and titles** — reported to the AI agent so it knows what page it's on
- **Page DOM content** — interactive elements, text, and links are read so the agent can understand the page
- **User activity** — clicks, scroll position, and keyboard input are processed as part of automation actions
- **Screenshots** — captured when explicitly requested by the AI agent, saved to local temp files

## Where data goes

All data stays on your machine. The extension communicates only with a local WebSocket bridge running on `localhost` (default port 9334). **No data is sent to any external server.**

The communication flow is:

```
Chrome Extension ←→ localhost:9334 ←→ MCP Server (local process) ←→ AI Agent
```

## Data storage

The extension stores two values in Chrome's local storage:

- **Bridge port number** — the WebSocket port to connect to (default: 9334)
- **Session-to-tab-group mappings** — so tab groups persist across extension restarts

No browsing data, page content, or user activity is persisted.

## Third parties

This extension does not:

- Send data to any external server
- Sell or transfer user data to third parties
- Use data for advertising, analytics, or creditworthiness
- Include any third-party tracking or analytics code

## Your AI agent

The AI agent you connect (e.g. Kiro, Claude, Cursor) may have its own data handling practices. This privacy policy covers only the Chrome extension itself, not the AI client.

## Open source

This extension is open source under the MIT license. You can inspect the full source code at:

https://github.com/smankoo/open-browser-control

## Contact

For questions about this privacy policy, open an issue at:

https://github.com/smankoo/open-browser-control/issues
