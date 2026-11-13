#!/usr/bin/env node
/**
 * Checks who can reach the bridge: it starts bridge-server/server.js on a
 * spare port and tries to connect as an agent on this machine (no Origin), as
 * the browser extension (moz-extension:// origin), as a web page (an https
 * origin) and over the machine's network address.
 *
 * Usage: node bridge-server/test-access.js [path/to/server.js] [port]
 * Exit status: 0 when local agents and the extension are let in and web pages
 * and other machines are kept out, 1 otherwise.
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');

const serverPath = path.resolve(process.argv[2] || path.join(__dirname, 'server.js'));
const port = parseInt(process.argv[3] || '19334', 10);

// The first non-loopback IPv4 address of this machine, if it has one
const lanAddress = Object.values(os.networkInterfaces()).flat()
  .find(a => a && a.family === 'IPv4' && !a.internal)?.address;

function attempt(url, origin) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const done = result => { try { ws.terminate(); } catch {} resolve(result); };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session_start', session: 'test', name: 'access-test' }));
    });
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'session_started') done('accepted');
    });
    ws.on('unexpected-response', (req, res) => done(`refused (HTTP ${res.statusCode})`));
    ws.on('error', err => done(`refused (${err.code || err.message})`));
    setTimeout(() => done('no answer'), 3000);
  });
}

(async () => {
  const bridge = spawn(process.execPath, [serverPath, '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  // DEBUG_BRIDGE=1 shows the bridge's own log
  bridge.stderr.on('data', d => { if (process.env.DEBUG_BRIDGE) process.stderr.write(d); });
  bridge.on('exit', code => { if (process.env.DEBUG_BRIDGE) console.error('bridge exited', code); });
  await new Promise(r => setTimeout(r, 800));

  const checks = [
    ['agent on this machine (no Origin)', `ws://127.0.0.1:${port}`, null, true],
    ['browser extension (moz-extension://)', `ws://127.0.0.1:${port}`, 'moz-extension://0d2c9a1e-test', true],
    ['web page (https://example.com)', `ws://127.0.0.1:${port}`, 'https://example.com', false],
    ['web page opened from a file (null)', `ws://127.0.0.1:${port}`, 'null', false],
  ];
  if (lanAddress) checks.push([`another machine (${lanAddress})`, `ws://${lanAddress}:${port}`, null, false]);

  let failed = 0;
  for (const [label, url, origin, shouldConnect] of checks) {
    const result = await attempt(url, origin);
    const ok = (result === 'accepted') === shouldConnect;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${result}`);
  }
  bridge.kill();
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exitCode = failed ? 1 : 0;
})();
