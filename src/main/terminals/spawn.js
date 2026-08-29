// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const { spawn } = require('child_process');

// Environment markers Claude Code (and similar agent CLIs) inject to signal "you are running INSIDE
// an agent session". If Satchel was itself started from such a session, these leak into every
// terminal it launches, and a `claude` started there is treated as a nested child session
// (transcript saving off, no history, can't --resume). Scrub them so each launched terminal is a
// clean top-level session. CLAUDE_CONFIG_DIR is intentionally kept (profiles set it per account).
const KEEP = new Set(['CLAUDE_CONFIG_DIR']);
function isSessionMarker(k) {
  if (KEEP.has(k)) return false;
  return k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'AI_AGENT' || k.startsWith('CLAUDE_CODE_');
}

/** Return a copy of `env` with agent-session markers removed. */
function scrubEnv(env) {
  const out = {};
  for (const k of Object.keys(env)) if (!isSessionMarker(k)) out[k] = env[k];
  return out;
}

/**
 * Start a detached process and return { pid }.
 * Prefers the backend's native spawner (Windows: CreateProcessW without handle inheritance);
 * falls back to Node's spawn elsewhere.
 */
function spawnProcess(backend, { exe, args, cwd, env }) {
  const clean = scrubEnv(env);
  if (backend && typeof backend.spawnDetached === 'function') {
    return backend.spawnDetached({ exe, args, cwd, env: clean });
  }
  const child = spawn(exe, args, { cwd, env: clean, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { pid: child.pid };
}

module.exports = { spawnProcess, scrubEnv, isSessionMarker };
