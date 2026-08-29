// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// SATCHEL_HOME overrides the data dir (useful for testing and portable setups).
const DIR = process.env.SATCHEL_HOME || path.join(os.homedir(), '.satchel');
const FILE = path.join(DIR, 'config.json');
const EVENTS_FILE = path.join(DIR, 'events.jsonl');
const PALETTE = ['#4f9cff', '#ff9f43', '#2ecc71', '#e056fd', '#ff6b6b', '#f9ca24', '#00d2d3'];

function detectMintty() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'usr', 'bin', 'mintty.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'mintty.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

/** ~/.claude -> "personal", ~/.claude-acme -> "acme": one Claude Code account per config dir. */
function detectClaudeDirs() {
  const home = os.homedir();
  let names = [];
  try {
    names = fs.readdirSync(home, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\.claude(-.+)?$/.test(d.name))
      .map((d) => d.name);
  } catch { /* ignore */ }
  return names.sort().map((n) => ({ dir: path.join(home, n), key: n === '.claude' ? 'personal' : n.slice('.claude-'.length) }));
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function defaultTerminal() {
  if (process.platform === 'win32') return { type: 'mintty', path: detectMintty() };
  if (process.platform === 'darwin') {
    return { type: 'custom', argv: ['osascript', '-e', 'tell application "Terminal" to do script "cd {cwd} && {command}"'] };
  }
  return { type: 'custom', argv: ['x-terminal-emulator', '-T', '{title}', '-e', 'bash', '-lic', '{command}'] };
}

function defaults() {
  const claude = detectClaudeDirs();
  const groups = claude.map((c, i) => ({ name: cap(c.key), color: PALETTE[i % PALETTE.length] }));
  groups.push({ name: 'Other', color: '#8b95a5' });
  const profiles = claude.map((c) => ({
    name: `Claude ${c.key}`,
    group: cap(c.key),
    cwd: '~',
    command: 'claude',
    env: { CLAUDE_CONFIG_DIR: c.dir.split(path.sep).join('/') },
  }));
  profiles.push({ name: 'Shell', group: 'Other', cwd: '~', command: '' });

  return {
    version: 1,
    pollIntervalMs: 1000,
    alwaysOnTop: true,
    hotkey: 'CommandOrControl+Alt+S',
    notifications: true,
    closeToTray: true,      // closing the panel hides it to the tray; quit via the tray menu or --quit
    startMinimized: false,  // start hidden in the tray (for autostart)
    dock: { edge: 'top', height: 40 }, // where the toolbar's dock button puts the strip, and how thick it is
    raiseGroupOnSelect: true, // docked: clicking a group tab also brings that group's non-minimized windows to the front
    adoptForeign: true,
    adoptExecutables: ['mintty.exe', 'WindowsTerminal.exe', 'wezterm-gui.exe', 'alacritty.exe'],
    defaultGroup: 'Other',
    terminal: defaultTerminal(),
    groups,
    profiles,
    statusGlyphs: { idle: ['✳'], working: ['◐', '◓', '◑', '◒'] },
    attention: { onIdle: true, onHook: true },
  };
}

// Renamed from "ShellMan": bring the user's settings over from ~/.shellman on first run of Satchel.
const OLD_DIR = path.join(os.homedir(), '.shellman');
function migrateFromOld() {
  if (process.env.SATCHEL_HOME || fs.existsSync(DIR) || !fs.existsSync(OLD_DIR)) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    for (const f of ['config.json', 'state.json', 'sessions.json']) {
      const src = path.join(OLD_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIR, f));
    }
    console.log('[satchel] migrated settings from ~/.shellman');
  } catch (e) { console.error('[satchel] migration from ~/.shellman failed:', e.message); }
}

function load() {
  migrateFromOld();
  fs.mkdirSync(DIR, { recursive: true });
  const base = defaults();
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(base, null, 2));
    return base;
  }
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { throw new Error(`Cannot parse ${FILE}: ${e.message}`); }
  return {
    ...base,
    ...parsed,
    statusGlyphs: { ...base.statusGlyphs, ...(parsed.statusGlyphs || {}) },
    attention: { ...base.attention, ...(parsed.attention || {}) },
    dock: { ...base.dock, ...(parsed.dock || {}) },
  };
}

function save(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
}

module.exports = { DIR, OLD_DIR, FILE, EVENTS_FILE, load, save, defaults };
