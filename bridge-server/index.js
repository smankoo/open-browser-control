#!/usr/bin/env node

/**
 * Kiro Browser Use — single entry point.
 *
 * Starts the WebSocket bridge that the Chrome extension auto-connects to.
 * AI agents then connect to this same server.
 *
 * Usage:
 *   npx kiro-browser-use            # start on default port 9334
 *   npx kiro-browser-use --port 9000
 *   npx kiro-browser-use --mode stdio   # for CLI agents (stdin/stdout)
 *
 * That's it. The Chrome extension auto-connects. No manual steps.
 */

require('./server.js');
