// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Tails ~/.satchel/events.jsonl — one JSON object per line, appended by hooks/claude-code-hook.js
 * from inside Claude Code's hook system. Only lines written after start() are delivered.
 */
const fs = require('fs');
const path = require('path');

class HookWatcher {
  constructor(file, onEvent) {
    this.file = file;
    this.onEvent = onEvent;
    this.offset = 0;
    this.buf = '';
  }

  start() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // History is never replayed, so start from an empty file (keeps it from growing forever).
    // A hook may be appending right now (rare, ~ms) — then just skip what is there instead.
    try { fs.writeFileSync(this.file, ''); this.offset = 0; }
    catch { this.offset = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0; }
    fs.watchFile(this.file, { interval: 500 }, () => this._read());
  }

  stop() { fs.unwatchFile(this.file); }

  _read() {
    let st;
    try { st = fs.statSync(this.file); } catch { return; }
    if (st.size < this.offset) { this.offset = 0; this.buf = ''; } // truncated
    if (st.size === this.offset) return;
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = st.size - this.offset;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, this.offset);
      this.offset = st.size;
      this.buf += b.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.onEvent(JSON.parse(line)); }
      catch (e) { console.warn('[satchel] bad hook event line:', e.message); }
    }
  }
}

// ---- installing the hook into Claude Code settings --------------------------------------

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop'];

function hookCommand(scriptPath) {
  return `node "${scriptPath.replace(/\\/g, '/')}"`;
}

function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Is our hook wired for every event in this settings file? */
function isInstalled(settings, scriptPath) {
  if (!settings || !settings.hooks) return false;
  const needle = scriptPath.replace(/\\/g, '/').toLowerCase();
  return HOOK_EVENTS.every((ev) => Array.isArray(settings.hooks[ev]) && settings.hooks[ev].some((grp) =>
    Array.isArray(grp.hooks) && grp.hooks.some((h) => h.type === 'command' && String(h.command).replace(/\\/g, '/').toLowerCase().includes(needle))));
}

/** Status per Claude config dir: { dir, settingsFile, installed }. */
function hookStatus(configDirs, scriptPath) {
  return configDirs.map((dir) => {
    const settingsFile = path.join(dir, 'settings.json');
    return { dir, settingsFile, exists: fs.existsSync(dir), installed: isInstalled(readSettings(settingsFile), scriptPath) };
  });
}

/**
 * Merge our hook into each <configDir>/settings.json (creating the file if needed). Existing hooks
 * are kept; a backup copy "settings.json.satchel-backup" is written the first time we touch a file.
 */
function installClaudeHooks(configDirs, scriptPath) {
  const command = hookCommand(scriptPath);
  const results = [];
  for (const dir of configDirs) {
    const settingsFile = path.join(dir, 'settings.json');
    if (!fs.existsSync(dir)) { results.push({ dir, skipped: 'config dir does not exist' }); continue; }
    let settings = {};
    if (fs.existsSync(settingsFile)) {
      settings = readSettings(settingsFile);
      if (!settings || typeof settings !== 'object') { results.push({ dir, skipped: 'settings.json is not valid JSON — fix it by hand' }); continue; }
    }
    if (isInstalled(settings, scriptPath)) { results.push({ dir, installed: true, changed: false }); continue; }
    const backup = `${settingsFile}.satchel-backup`;
    if (fs.existsSync(settingsFile) && !fs.existsSync(backup)) fs.copyFileSync(settingsFile, backup);
    settings.hooks = settings.hooks || {};
    for (const ev of HOOK_EVENTS) {
      const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
      const present = groups.some((grp) => Array.isArray(grp.hooks) && grp.hooks.some((h) => h.type === 'command' && String(h.command).includes(scriptPath.replace(/\\/g, '/'))));
      if (!present) groups.push({ hooks: [{ type: 'command', command }] });
      settings.hooks[ev] = groups;
    }
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    results.push({ dir, installed: true, changed: true });
  }
  return results;
}

/** Remove our hook (and only ours) from each <configDir>/settings.json; other hooks are untouched. */
function uninstallClaudeHooks(configDirs, scriptPath) {
  const needle = scriptPath.replace(/\\/g, '/').toLowerCase();
  const ours = (h) => h && h.type === 'command' && String(h.command).replace(/\\/g, '/').toLowerCase().includes(needle);
  const results = [];
  for (const dir of configDirs) {
    const settingsFile = path.join(dir, 'settings.json');
    const settings = readSettings(settingsFile);
    if (!settings || !settings.hooks) { results.push({ dir, removed: false }); continue; }
    let changed = false;
    for (const ev of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[ev])) continue;
      const groups = settings.hooks[ev].map((grp) => {
        if (!Array.isArray(grp.hooks) || !grp.hooks.some(ours)) return grp;
        changed = true;
        return { ...grp, hooks: grp.hooks.filter((h) => !ours(h)) };
      }).filter((grp) => !Array.isArray(grp.hooks) || grp.hooks.length);
      if (groups.length) settings.hooks[ev] = groups; else delete settings.hooks[ev];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    if (changed) fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    results.push({ dir, removed: changed });
  }
  return results;
}

/**
 * Upgrade: where our hook is already installed for some events, wire the events that were added in
 * later Satchel versions (e.g. SessionEnd) without the user having to click "Hooks" again. Config
 * dirs without any Satchel hook are left alone (the user opted out or never opted in).
 */
function upgradeClaudeHooks(configDirs, scriptPath) {
  const needle = scriptPath.replace(/\\/g, '/').toLowerCase();
  const ours = (h) => h && h.type === 'command' && String(h.command).replace(/\\/g, '/').toLowerCase().includes(needle);
  const results = [];
  for (const dir of configDirs) {
    const settingsFile = path.join(dir, 'settings.json');
    const settings = readSettings(settingsFile);
    if (!settings || !settings.hooks) { results.push({ dir, upgraded: false }); continue; }
    const wired = (ev) => Array.isArray(settings.hooks[ev]) && settings.hooks[ev].some((grp) => Array.isArray(grp.hooks) && grp.hooks.some(ours));
    if (!HOOK_EVENTS.some(wired) || HOOK_EVENTS.every(wired)) { results.push({ dir, upgraded: false }); continue; }
    for (const ev of HOOK_EVENTS) {
      if (wired(ev)) continue;
      const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
      groups.push({ hooks: [{ type: 'command', command: hookCommand(scriptPath) }] });
      settings.hooks[ev] = groups;
    }
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    results.push({ dir, upgraded: true });
  }
  return results;
}

/**
 * Rename migration: rewrite any installed hook command pointing at the OLD script path to the NEW
 * one, in place, so hooks keep working after the ShellMan -> Satchel rename (no duplicates, no
 * re-install needed). Matches loosely on the old script's directory+filename.
 */
function migrateHookPath(configDirs, oldScript, newScript) {
  const oldNeedle = oldScript.replace(/\\/g, '/').toLowerCase();
  const newCmd = hookCommand(newScript);
  const results = [];
  for (const dir of configDirs) {
    const settingsFile = path.join(dir, 'settings.json');
    const settings = readSettings(settingsFile);
    if (!settings || !settings.hooks) { results.push({ dir, migrated: false }); continue; }
    let changed = false;
    for (const ev of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[ev])) continue;
      for (const grp of settings.hooks[ev]) {
        if (!Array.isArray(grp.hooks)) continue;
        for (const h of grp.hooks) {
          if (h && h.type === 'command' && String(h.command).replace(/\\/g, '/').toLowerCase().includes(oldNeedle)) { h.command = newCmd; changed = true; }
        }
      }
    }
    if (changed) fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    results.push({ dir, migrated: changed });
  }
  return results;
}

module.exports = { HookWatcher, hookStatus, installClaudeHooks, uninstallClaudeHooks, upgradeClaudeHooks, migrateHookPath, HOOK_EVENTS, hookCommand };
