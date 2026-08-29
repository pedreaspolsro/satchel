#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Claude Code hook -> Satchel bridge.
 * Reads the hook payload from stdin and appends one JSON line to ~/.satchel/events.jsonl.
 * Satchel tails that file and marks the matching session (via the SATCHEL_ID env var that
 * Satchel injects at launch) as "needs you" / "finished" / "working".
 *
 * Always exits 0 and never prints, so it can never block or alter Claude's behaviour.
 * Wire it into ~/.claude/settings.json — see README.md.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = process.env.SATCHEL_EVENTS || path.join(os.homedir(), '.satchel', 'events.jsonl');
let data = '';

function finish() {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch { /* not JSON — still record the event */ }
  const ev = {
    ts: Date.now(),
    event: input.hook_event_name || process.argv[2] || 'unknown',
    satchelId: process.env.SATCHEL_ID || null,
    profile: process.env.SATCHEL_PROFILE || null,
    sessionId: input.session_id || null,
    cwd: input.cwd || process.cwd(),
    message: input.message || input.title || null,
    notificationType: input.notification_type || null,
    // Lets Satchel find the terminal window of sessions it did not launch: it walks the
    // process tree upwards from our parent (shell <- claude <- bash <- mintty).
    pid: process.pid,
    ppid: process.ppid,
    // Which account this session runs under -> Satchel sorts the window into the matching group.
    configDir: process.env.CLAUDE_CONFIG_DIR || null,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(ev)}\n`);
  } catch { /* ignore */ }
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 2000).unref(); // never hang Claude if stdin stays open
