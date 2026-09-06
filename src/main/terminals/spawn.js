// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const { spawn } = require('child_process');

// Environment Claude Code (and similar agent CLIs) sets up for the shells it runs. If Satchel was
// itself started from such a session, these leak into every terminal it launches:
//  - session markers (CLAUDECODE, CLAUDE_CODE_*, ...): a `claude` started there is treated as a
//    nested child session (transcript saving off, no history, can't --resume);
//  - output tamers (NO_COLOR, GIT_TERMINAL_PROMPT, ...): every launched terminal renders
//    black-and-white and git stops asking for credentials.
// Scrub them from the INHERITED environment so each launched terminal looks like one the user
// opened by hand. Terminal adapters must apply scrubEnv() to process.env only, and merge the
// profile's own env on top of the result — an explicit profile value always wins.
// CLAUDE_CONFIG_DIR is intentionally kept (profiles set it per account).
const KEEP = new Set(['CLAUDE_CONFIG_DIR']);
const TAMERS = new Set(['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'GIT_TERMINAL_PROMPT']);
function isSessionMarker(k) {
  if (KEEP.has(k)) return false;
  return k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'AI_AGENT'
    || k.startsWith('CLAUDE_CODE_') || TAMERS.has(k);
}

/** Return a copy of `env` with agent-session leftovers removed. */
function scrubEnv(env) {
  const out = {};
  for (const k of Object.keys(env)) if (!isSessionMarker(k)) out[k] = env[k];
  return out;
}

/**
 * Base environment for a launched terminal. Preferred: the OS's canonical user environment from
 * the backend (Windows: CreateEnvironmentBlock — immune to ANY junk Satchel itself inherited,
 * and picks up setx/registry changes without a restart). Fallback: the scrubbed inherited env.
 * Adapters merge the profile's own env on top either way, so explicit profile values always win.
 */
function baseEnv(backend) {
  if (backend && typeof backend.cleanEnv === 'function') {
    try {
      const env = backend.cleanEnv();
      // Sanity: a real user block has a path + profile (Windows spells it "Path" — match any case).
      const has = (name) => env && Object.keys(env).some((k) => k.toLowerCase() === name && env[k]);
      if (has('path') && has('userprofile')) return env;
    } catch { /* fall through */ }
  }
  return scrubEnv(process.env);
}

/**
 * Start a detached process and return { pid }. The env is passed through as given — build it as
 * { ...scrubEnv(process.env), ...profileEnv } in the adapter (see above).
 * Prefers the backend's native spawner (Windows: CreateProcessW without handle inheritance);
 * falls back to Node's spawn elsewhere.
 */
function spawnProcess(backend, { exe, args, cwd, env }) {
  if (backend && typeof backend.spawnDetached === 'function') {
    return backend.spawnDetached({ exe, args, cwd, env });
  }
  const child = spawn(exe, args, { cwd, env, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { pid: child.pid };
}

module.exports = { spawnProcess, scrubEnv, baseEnv, isSessionMarker };
