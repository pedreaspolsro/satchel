// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * SessionManager — platform-independent core.
 * Owns the list of sessions (terminal windows we launched or adopted), polls the window backend
 * for titles/foreground state, derives status, and performs group actions (tile, cascade, ...).
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isAlive, expandHome, statusFromTitle, cleanTitle, gridLayout, cascadeLayout } = require('./util');
const { EVENTS_FILE } = require('./config');

const PENDING_TIMEOUT_MS = 20000;
const PERSIST_FIELDS = ['id', 'pid', 'hwnd', 'profile', 'group', 'groupLocked', 'label', 'cwd', 'createdAt', 'launched', 'claudeSessionId'];

/** Compare directories loosely (slashes, trailing separators, case on Windows). */
function sameDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => { let s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); if (process.platform === 'win32') s = s.toLowerCase(); return s; };
  return norm(a) === norm(b);
}

class SessionManager extends EventEmitter {
  constructor({ config, backend, terminal, store, screen }) {
    super();
    this.config = config;
    this.backend = backend;
    this.terminal = terminal;
    this.store = store;
    this.screen = screen;
    this.sessions = new Map();   // id -> session
    this.exeCache = new Map();   // pid -> lowercase exe basename
    this.ignored = new Set();    // "pid:hwnd" the user asked us to forget
    this.timer = null;
    this.lastEmitted = '';
    this.lastPersisted = '';
    this._restore();
  }

  setConfig(config) { this.config = config; this._changed(true); }
  setTerminal(terminal) { this.terminal = terminal; }

  _blank(over) {
    const now = Date.now();
    return {
      id: null, label: '', profile: null, group: this.config.defaultGroup, cwd: null, createdAt: now,
      launched: false, pid: null, hwnd: null, exe: null, title: '', status: 'unknown', statusSince: now,
      attention: false, note: null, lastFocusedAt: 0, minimized: false, pending: false, pendingSince: 0,
      claudeSessionId: null, groupLocked: false, ...over,
    };
  }

  _restore() {
    for (const s of this.store.loadSessions()) {
      if (!s.id || !s.pid || !isAlive(s.pid)) continue;
      this.sessions.set(s.id, this._blank({ ...s, hwnd: s.hwnd ?? null, pending: true, pendingSince: Date.now() }));
    }
  }

  start() {
    this.stop();
    const tick = () => { try { this.poll(); } catch (e) { this.emit('error', e); } };
    tick();
    this.timer = setInterval(tick, this.config.pollIntervalMs || 1000);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One reconciliation pass between OS windows and our session list. */
  poll() {
    const now = Date.now();
    const adopt = new Set((this.config.adoptExecutables || []).map((s) => s.toLowerCase()));
    const windows = [];
    for (const w of this.backend.listWindows()) {
      let exe = this.exeCache.get(w.pid);
      if (exe === undefined) {
        const img = this.backend.processImage(w.pid);
        exe = img ? path.basename(img).toLowerCase() : '';
        this.exeCache.set(w.pid, exe);
      }
      if (adopt.has(exe)) windows.push({ ...w, exe });
    }
    if (this.exeCache.size > 4000) this.exeCache.clear();

    const fg = this.backend.foreground();
    const byId = new Map(windows.map((w) => [w.id, w]));
    const claimed = new Set();

    // 1) sessions that already own a window
    for (const s of this.sessions.values()) {
      if (s.hwnd == null) continue;
      const w = byId.get(s.hwnd);
      if (w && w.pid === s.pid) { claimed.add(w.id); this._sync(s, w, now, fg); }
      else { s.hwnd = null; s.pending = true; s.pendingSince = now; }
    }
    // 2) pending sessions (just launched, or restored from disk): match by pid
    for (const s of this.sessions.values()) {
      if (s.hwnd != null) continue;
      const w = windows.find((x) => x.pid === s.pid && !claimed.has(x.id));
      if (w) { s.hwnd = w.id; claimed.add(w.id); this._sync(s, w, now, fg, true); }
      else if (!isAlive(s.pid) || now - s.pendingSince > PENDING_TIMEOUT_MS) this.sessions.delete(s.id);
    }
    // 3) adopt windows nobody owns
    if (this.config.adoptForeign !== false) {
      for (const w of windows) {
        if (claimed.has(w.id) || this.ignored.has(`${w.pid}:${w.id}`)) continue;
        this._adopt(w, now);
      }
    }
    this._changed();
  }

  _sync(s, w, now, fg, first = false) {
    s.pending = false;
    s.title = w.title;
    s.pid = w.pid;
    s.exe = w.exe;
    s.minimized = this.backend.isMinimized(w.id);
    const st = statusFromTitle(w.title, this.config.statusGlyphs);
    if (st !== s.status) {
      const prev = s.status;
      s.status = st;
      s.statusSince = now;
      const wantIdle = (this.config.attention || {}).onIdle !== false;
      if (!first && prev === 'working' && st === 'idle' && wantIdle && w.id !== fg) this._flag(s, null);
    }
    if (w.id === fg) {
      s.lastFocusedAt = now;
      if (s.attention) { s.attention = false; s.note = null; }
    }
  }

  _flag(s, note) {
    if (s.attention) { if (note) s.note = note; return; }
    s.attention = true;
    s.note = note;
    this.emit('attention', this._view(s));
  }

  _adopt(w, now) {
    const s = this._blank({
      id: crypto.randomUUID(), pid: w.pid, hwnd: w.id, exe: w.exe, title: w.title, createdAt: now,
      status: statusFromTitle(w.title, this.config.statusGlyphs), statusSince: now,
    });
    this.sessions.set(s.id, s);
  }

  // ---- commands -------------------------------------------------------------------------

  launch({ profileName, cwd, label } = {}) {
    const p = (this.config.profiles || []).find((x) => x.name === profileName);
    if (!p) throw new Error(`Unknown profile "${profileName}"`);
    const dir = expandHome(cwd || p.cwd || '~');
    if (!fs.existsSync(dir)) throw new Error(`Folder does not exist: ${dir}`);
    const id = crypto.randomUUID();
    const env = { ...(p.env || {}), SATCHEL_ID: id, SATCHEL_PROFILE: p.name, SATCHEL_EVENTS: EVENTS_FILE };
    const { pid } = this.terminal.launch({ cwd: dir, env, title: label || p.name, command: p.command || '', shell: p.shell });
    const s = this._blank({
      id, label: (label || '').trim(), profile: p.name, group: p.group || this.config.defaultGroup, cwd: dir,
      launched: true, pid, pending: true, pendingSince: Date.now(),
    });
    this.sessions.set(id, s);
    this._changed(true);
    return this._view(s);
  }

  get(id) { return this.sessions.get(id) || null; }

  /** Resolve a session by full id, id prefix, or pid (for the CLI). */
  findId(ref) {
    if (this.sessions.has(ref)) return ref;
    for (const s of this.sessions.values()) {
      if (String(s.pid) === String(ref) || s.id.startsWith(String(ref))) return s.id;
    }
    throw new Error(`No session matches "${ref}"`);
  }

  _need(id) { const s = this.sessions.get(id); if (!s) throw new Error('Unknown session'); return s; }
  _needWin(id) { const s = this._need(id); if (s.hwnd == null) throw new Error('Session has no window (yet)'); return s; }

  focus(id) {
    const s = this._needWin(id);
    this.backend.focus(s.hwnd);
    s.lastFocusedAt = Date.now();
    s.attention = false;
    s.note = null;
    this._changed(true);
  }
  rename(id, label) { this._need(id).label = (label || '').trim(); this._changed(true); }
  setGroup(id, group) {
    const s = this._need(id);
    s.group = group || this.config.defaultGroup;
    s.groupLocked = true; // a user choice beats hook-based auto-grouping
    this._changed(true);
  }
  close(id) { this.backend.close(this._needWin(id).hwnd); }
  minimize(id) { this.backend.minimize(this._needWin(id).hwnd); this._changed(); }
  restore(id) { this.backend.restore(this._needWin(id).hwnd); this._changed(); }
  forget(id) {
    const s = this._need(id);
    if (s.hwnd != null) this.ignored.add(`${s.pid}:${s.hwnd}`);
    this.sessions.delete(id);
    this._changed(true);
  }

  groupNames() {
    const names = (this.config.groups || []).map((g) => g.name);
    for (const s of this.sessions.values()) if (s.group && !names.includes(s.group)) names.push(s.group);
    if (this.config.defaultGroup && !names.includes(this.config.defaultGroup)) names.push(this.config.defaultGroup);
    return names;
  }

  _ordered() { return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt); }
  _inGroup(group) {
    return this._ordered().filter((s) => s.hwnd != null && (!group || group === 'All' || s.group === group));
  }
  _area(displayId) {
    const displays = this.screen.getAllDisplays();
    const d = displays.find((x) => x.id === displayId) || this.screen.getPrimaryDisplay();
    return d.workArea;
  }

  tile(group, displayId) {
    const list = this._inGroup(group);
    const rects = gridLayout(list.length, this._area(displayId));
    list.forEach((s, i) => this.backend.setBounds(s.hwnd, rects[i]));
    return list.length;
  }
  cascade(group, displayId) {
    const list = this._inGroup(group);
    const rects = cascadeLayout(list.length, this._area(displayId));
    list.forEach((s, i) => this.backend.setBounds(s.hwnd, rects[i]));
    return list.length;
  }
  minimizeGroup(group) {
    const list = this._inGroup(group);
    list.forEach((s) => this.backend.minimize(s.hwnd));
    this._changed();
    return list.length;
  }

  /** Bring every non-minimized window of a group to the front; activate the most-recently-used one. */
  raiseGroup(group) {
    const list = this._inGroup(group)
      .filter((s) => !this.backend.isMinimized(s.hwnd))
      .sort((a, b) => (a.lastFocusedAt || 0) - (b.lastFocusedAt || 0)); // oldest first -> newest ends on top
    if (!list.length) return 0;
    if (typeof this.backend.raiseAll === 'function') this.backend.raiseAll(list.map((s) => s.hwnd));
    else list.forEach((s) => this.backend.focus(s.hwnd)); // fallback: sequential activation
    const top = list[list.length - 1];
    top.lastFocusedAt = Date.now();
    if (top.attention) { top.attention = false; top.note = null; }
    this._changed(true);
    return list.length;
  }
  displays() {
    const primary = this.screen.getPrimaryDisplay().id;
    return this.screen.getAllDisplays().map((d) => ({
      id: d.id, label: d.label || 'Display', bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, primary: d.id === primary,
    }));
  }

  // ---- Claude Code hook events ----------------------------------------------------------

  /**
   * Find the session a hook event belongs to:
   *   1. SATCHEL_ID env var (sessions we launched)
   *   2. Claude session id seen before
   *   3. process tree: walk up from the hook's parent until we hit a pid that owns a session window
   */
  _sessionForHook(ev) {
    if (ev.satchelId && this.sessions.has(ev.satchelId)) return this.sessions.get(ev.satchelId);
    const all = [...this.sessions.values()];
    if (ev.sessionId) {
      const s = all.find((x) => x.claudeSessionId === ev.sessionId);
      if (s) return s;
    }
    const getParents = this.backend.processParentsDeep || this.backend.processParents;
    if (ev.ppid && typeof getParents === 'function') {
      const byPid = new Map(all.filter((x) => x.pid).map((x) => [x.pid, x]));
      const parents = getParents.call(this.backend);
      let p = ev.ppid;
      for (let depth = 0; depth < 16 && p; depth++) {
        if (byPid.has(p)) return byPid.get(p);
        p = parents.get(p);
      }
    }
    return null;
  }

  /** Event shape: see hooks/claude-code-hook.js. Returns true if a session matched. */
  applyHookEvent(ev) {
    if (!ev || typeof ev !== 'object') return false;
    const s = this._sessionForHook(ev);
    if (!s) return false;
    if (ev.sessionId) s.claudeSessionId = ev.sessionId;
    if (ev.cwd) s.cwd = ev.cwd;
    // Sort adopted windows into the group of the account they run under.
    if (ev.configDir && !s.groupLocked) {
      const prof = (this.config.profiles || []).find((p) => p.env && sameDir(p.env.CLAUDE_CONFIG_DIR, ev.configDir));
      if (prof) { s.group = prof.group || s.group; s.profile = prof.name; }
    }
    const fg = this.backend.foreground();
    const onHook = (this.config.attention || {}).onHook !== false;
    const away = s.hwnd == null || s.hwnd !== fg;
    switch (ev.event) {
      case 'UserPromptSubmit': s.attention = false; s.note = null; break;
      case 'Stop': if (onHook && away) this._flag(s, 'Finished'); break;
      case 'Notification': if (onHook && away) this._flag(s, ev.message || 'Needs your attention'); break;
      default: break;
    }
    this._changed(true);
    return true;
  }

  // ---- snapshots / persistence ----------------------------------------------------------

  _view(s) {
    const group = (this.config.groups || []).find((g) => g.name === s.group);
    const profile = s.profile ? (this.config.profiles || []).find((p) => p.name === s.profile) : null;
    return {
      id: s.id, label: s.label, profile: s.profile, group: s.group,
      color: (group && group.color) || (profile && profile.color) || '#8b95a5',
      pid: s.pid, hwnd: s.hwnd, exe: s.exe, title: s.title,
      cleanTitle: cleanTitle(s.title, this.config.statusGlyphs),
      status: s.status, statusSince: s.statusSince, attention: s.attention, note: s.note,
      cwd: s.cwd, createdAt: s.createdAt, launched: s.launched, minimized: s.minimized, pending: s.pending,
      claudeSessionId: s.claudeSessionId,
    };
  }

  snapshot() { return this._ordered().map((s) => this._view(s)); }

  _changed(force = false) {
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    if (force || json !== this.lastEmitted) {
      this.lastEmitted = json;
      this.emit('update', snap);
    }
    this.persist();
  }

  persist() {
    const list = this._ordered().map((s) => Object.fromEntries(PERSIST_FIELDS.map((k) => [k, s[k]])));
    const json = JSON.stringify(list);
    if (json === this.lastPersisted) return;
    this.lastPersisted = json;
    try { this.store.saveSessions(list); } catch (e) { this.emit('error', e); }
  }
}

module.exports = { SessionManager };
