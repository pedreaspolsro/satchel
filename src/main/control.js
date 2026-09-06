// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Control socket: lets the CLI talk to the RUNNING GUI instead of spinning up its own instance,
 * so `--list` shows the GUI's live sessions (labels, attention, Claude ids) and `--launch`ed
 * windows belong to the GUI. Named pipe on Windows, unix socket in ~/.satchel elsewhere.
 *
 * Protocol: one JSON request per connection — `{"cmd":"...",...}\n` -> `{"ok":true,"result":...}\n`
 * or `{"ok":false,"error":"..."}\n`.
 */
const net = require('net');
const fs = require('fs');

function dispatch(manager, msg) {
  switch (msg.cmd) {
    case 'ping': return { pong: true, pid: process.pid };
    case 'list': return { backend: manager.backend.name, capabilities: manager.backend.capabilities, pid: process.pid, sessions: manager.snapshot() };
    case 'launch': return manager.launch(msg);
    case 'focus': manager.focus(manager.findId(msg.ref)); return { ok: true };
    case 'close': manager.close(manager.findId(msg.ref)); return { ok: true };
    case 'tile': return { tiled: manager.tile(msg.group, msg.displayId) };
    case 'cascade': return { cascaded: manager.cascade(msg.group, msg.displayId) };
    case 'minimizeGroup': return { minimized: manager.minimizeGroup(msg.group) };
    case 'displays': return manager.displays();
    default: throw new Error(`unknown command "${msg.cmd}"`);
  }
}

function startControlServer(manager, sock) {
  if (process.platform !== 'win32') { try { fs.unlinkSync(sock); } catch { /* stale socket file */ } }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setTimeout(10000, () => conn.destroy());
    conn.on('error', () => {});
    conn.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) { if (buf.length > 65536) conn.destroy(); return; }
      let reply;
      try { reply = { ok: true, result: dispatch(manager, JSON.parse(buf.slice(0, i))) }; }
      catch (e) { reply = { ok: false, error: e.message }; }
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.on('error', (e) => console.error('[satchel] control socket:', e.message));
  server.listen(sock);
  return server;
}

/** CLI side: one request to a running GUI. Resolves null when no GUI is listening. */
function controlRequest(sock, msg, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let conn;
    try { conn = net.connect(sock); } catch { return done(null); }
    const timer = setTimeout(() => { conn.destroy(); done(null); }, timeoutMs);
    let buf = '';
    conn.on('connect', () => conn.write(`${JSON.stringify(msg)}\n`));
    conn.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      conn.destroy();
      try { done(JSON.parse(buf.slice(0, i))); } catch { done(null); }
    });
    conn.on('error', () => { clearTimeout(timer); done(null); });
  });
}

module.exports = { startControlServer, controlRequest, dispatch };
