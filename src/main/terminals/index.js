// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Terminal adapters know how to open ONE new terminal window running a shell.
 *
 *   launch({ cwd, env, title, command, shell }) -> { pid }
 *
 * `pid` must be the process that owns the window, because the session manager matches the
 * window to the session by pid (mintty with Daemonize=no: yes; terminal servers like
 * gnome-terminal: no — TODO title-token matching for those).
 *
 * `backend` is the window backend; adapters use its native spawner when it has one.
 */
function createTerminal(cfg = {}, backend = null) {
  const type = cfg.type || (process.platform === 'win32' ? 'mintty' : 'custom');
  switch (type) {
    case 'mintty': return require('./mintty')(cfg, backend);
    case 'custom': return require('./custom')(cfg, backend);
    default: throw new Error(`Unknown terminal type "${type}" (use "mintty" or "custom")`);
  }
}

module.exports = { createTerminal };
