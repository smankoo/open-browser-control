#!/usr/bin/env node

/**
 * Open Browser Control — entry point.
 *
 * When used as an MCP server (the primary use case), this starts the MCP
 * server (which embeds the WebSocket bridge). A browser extension
 * (Chrome or Firefox) is installed separately; pass --extension or
 * --extension firefox to print the path to the bundled copy for
 * load-unpacked installs.
 *
 * MCP config (Claude Desktop, etc.):
 *   {
 *     "mcpServers": {
 *       "browser": {
 *         "command": "npx",
 *         "args": ["-y", "open-browser-control"]
 *       }
 *     }
 *   }
 *
 * Standalone:
 *   npx open-browser-control                       # MCP mode (default)
 *   npx open-browser-control --bridge              # standalone WebSocket bridge
 *   npx open-browser-control --extension           # print Chrome extension path
 *   npx open-browser-control --extension firefox   # print Firefox extension path
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);

// ─── Browser Selection ───────────────────────────────────────────────────────

function parseBrowser() {
  // Accept --browser chrome|firefox, and --extension [chrome|firefox]
  const browserIdx = args.indexOf('--browser');
  if (browserIdx !== -1 && args[browserIdx + 1]) {
    return args[browserIdx + 1].toLowerCase();
  }
  const extIdx = args.indexOf('--extension');
  if (extIdx !== -1 && args[extIdx + 1] && !args[extIdx + 1].startsWith('-')) {
    return args[extIdx + 1].toLowerCase();
  }
  return 'chrome';
}

const BROWSER = parseBrowser();
if (!['chrome', 'firefox'].includes(BROWSER)) {
  console.error(`[open-browser-control] Unknown browser: ${BROWSER}. Use "chrome" or "firefox".`);
  process.exit(1);
}

const EXTENSION_DIR = BROWSER === 'firefox' ? 'extension-firefox' : 'extension';
const EXTENSION_HOME = path.join(os.homedir(), BROWSER === 'firefox'
  ? 'open-browser-control-extension-firefox'
  : 'open-browser-control-extension');

// ─── Install Extension ──────────────────────────────────────────────────────

function installExtension() {
  const bundledExtension = path.join(__dirname, '..', EXTENSION_DIR);

  if (!fs.existsSync(bundledExtension) || !fs.existsSync(path.join(bundledExtension, 'manifest.json'))) {
    // Dev mode — try dist/<browser>/ instead
    const devDist = path.join(__dirname, '..', 'dist', BROWSER);
    if (fs.existsSync(devDist) && fs.existsSync(path.join(devDist, 'manifest.json'))) {
      copyDir(devDist, EXTENSION_HOME);
      return;
    }
    log(`Warning: Pre-built ${BROWSER} extension not found. Run "npm run build" first.`);
    return;
  }

  const bundledManifest = JSON.parse(fs.readFileSync(path.join(bundledExtension, 'manifest.json'), 'utf-8'));
  const installedManifestPath = path.join(EXTENSION_HOME, 'manifest.json');

  if (fs.existsSync(installedManifestPath)) {
    const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, 'utf-8'));
    if (installedManifest.version === bundledManifest.version) {
      return; // Up to date
    }
    log(`Updating ${BROWSER} extension: ${installedManifest.version} → ${bundledManifest.version}`);
  } else {
    log(`Installing ${BROWSER} extension...`);
  }

  copyDir(bundledExtension, EXTENSION_HOME);
  log(`Extension installed to: ${EXTENSION_HOME}`);
  log('');
  if (BROWSER === 'firefox') {
    log('To load in Firefox:');
    log('  1. Open about:debugging#/runtime/this-firefox');
    log('  2. Click "Load Temporary Add-on…"');
    log(`  3. Select: ${path.join(EXTENSION_HOME, 'manifest.json')}`);
    log('');
    log('Note: Firefox unsigned extensions are cleared on restart. For a');
    log('permanent install, use Firefox Developer Edition or a signed XPI.');
  } else {
    log('To load in Chrome:');
    log('  1. Open chrome://extensions');
    log('  2. Enable "Developer mode"');
    log('  3. Click "Load unpacked"');
    log(`  4. Select: ${EXTENSION_HOME}`);
  }
  log('');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function log(msg) {
  process.stderr.write(msg ? `[open-browser-control] ${msg}\n` : '\n');
}

// ─── CLI Flags ───────────────────────────────────────────────────────────────

if (args.includes('--extension') || args.includes('--extension-path')) {
  installExtension();
  console.log(EXTENSION_HOME);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
open-browser-control — Give AI agents control of your browser.

Usage:
  npx open-browser-control                       Start MCP server (default)
  npx open-browser-control --bridge              Start standalone WebSocket bridge
  npx open-browser-control --extension           Print Chrome extension path and exit
  npx open-browser-control --extension firefox   Print Firefox extension path and exit
  npx open-browser-control --port 9000           Use a custom port

Both Chrome and Firefox extensions speak the same WebSocket protocol to
the same bridge on port 9334 — install whichever browser's extension you
prefer and the MCP server controls it.

MCP config (add to your MCP client):
  {
    "mcpServers": {
      "browser": {
        "command": "npx",
        "args": ["-y", "open-browser-control"]
      }
    }
  }

Extension paths:
  Chrome:  ${path.join(os.homedir(), 'open-browser-control-extension')}
  Firefox: ${path.join(os.homedir(), 'open-browser-control-extension-firefox')}
  `.trim());
  process.exit(0);
}

// ─── Start ───────────────────────────────────────────────────────────────────

if (args.includes('--bridge')) {
  require('./server.js');
} else {
  require('./mcp-server.js');
}
