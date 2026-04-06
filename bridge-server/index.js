#!/usr/bin/env node

/**
 * Open Browser Control — entry point.
 *
 * When used as an MCP server (the primary use case), this is the command
 * that runs. It:
 *   1. Ensures the Chrome extension is installed to ~/open-browser-control-extension/
 *   2. Starts the MCP server (which embeds the WebSocket bridge)
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
 *   npx open-browser-control              # MCP mode (default)
 *   npx open-browser-control --bridge     # standalone WebSocket bridge (no MCP)
 *   npx open-browser-control --extension  # print extension path and exit
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const EXTENSION_HOME = path.join(os.homedir(), 'open-browser-control-extension');
const args = process.argv.slice(2);

// ─── Install Extension ──────────────────────────────────────────────────────

function installExtension() {
  // The pre-built extension ships inside the npm package as ./extension/
  const bundledExtension = path.join(__dirname, '..', 'extension');

  if (!fs.existsSync(bundledExtension) || !fs.existsSync(path.join(bundledExtension, 'manifest.json'))) {
    // Dev mode — try dist/ instead
    const devDist = path.join(__dirname, '..', 'dist');
    if (fs.existsSync(devDist) && fs.existsSync(path.join(devDist, 'manifest.json'))) {
      copyDir(devDist, EXTENSION_HOME);
      return;
    }
    log('Warning: Pre-built extension not found. Run "npm run build" first.');
    return;
  }

  // Check if we need to update (compare manifest versions)
  const bundledManifest = JSON.parse(fs.readFileSync(path.join(bundledExtension, 'manifest.json'), 'utf-8'));
  const installedManifestPath = path.join(EXTENSION_HOME, 'manifest.json');

  if (fs.existsSync(installedManifestPath)) {
    const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, 'utf-8'));
    if (installedManifest.version === bundledManifest.version) {
      return; // Already up to date
    }
    log(`Updating extension: ${installedManifest.version} → ${bundledManifest.version}`);
  } else {
    log('Installing Chrome extension...');
  }

  copyDir(bundledExtension, EXTENSION_HOME);
  log(`Extension installed to: ${EXTENSION_HOME}`);
  log('');
  log('To load in Chrome:');
  log('  1. Open chrome://extensions');
  log('  2. Enable "Developer mode"');
  log('  3. Click "Load unpacked"');
  log(`  4. Select: ${EXTENSION_HOME}`);
  log('');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
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
open-browser-control — Give AI agents control of your Chrome browser.

Usage:
  npx open-browser-control                 Start MCP server (default)
  npx open-browser-control --bridge        Start standalone WebSocket bridge
  npx open-browser-control --extension     Print extension path and exit
  npx open-browser-control --port 9000     Use a custom port

MCP config (add to your MCP client):
  {
    "mcpServers": {
      "browser": {
        "command": "npx",
        "args": ["-y", "open-browser-control"]
      }
    }
  }

Extension location: ${EXTENSION_HOME}
  `.trim());
  process.exit(0);
}

// ─── Start ───────────────────────────────────────────────────────────────────

installExtension();

if (args.includes('--bridge')) {
  require('./server.js');
} else {
  require('./mcp-server.js');
}
