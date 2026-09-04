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
const PERSIST_FIELDS = ['id', 'pid', 'hwnd', 'profile', 'group', 'groupLocked', 'label', 'cwd', 'createdAt', 'launched', 'claudeSessionId', 'sessionTitle'];
const MAX_NAMES = 300; // remembered Claude sessions (label/group/title keyed by Claude session id)

/** Compare directories loosely (slashes, trailing separators, case on Windows). */
function sameDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => { let s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); if (process.platform === 'win32') s = s.toLowerCase(); return s; };
  return norm(a) === norm(b);
}

/** Quote for the POSIX shell the profile command runs in (bash -c / bash -lic). */
function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/**
 * Pass the Satchel label to Claude Code as the session name (`claude --name <label>`), so Claude's
 * own terminal title and its --resume picker show the same name as the Satchel row. Only for plain
 * `claude` commands: a resumed/continued session already has a name, and an explicit --name wins.
 */
function withSessionName(command, label) {
  const cmd = String(command || '').trim();
  const name = String(label || '').trim();
  if (!name || !/^claude(\s|$)/.test(cmd)) return command;
  if (/(^|\s)(--name|-n|--resume|-r|--continue|-c)(\s|=|$)/.test(cmd)) return command;
  return `claude --name ${shellQuote(name)}${cmd.slice('claude'.length)}`;
}

/**
 * Turn the profile command into a resuming one: `claude --resume <ref>` (ref = session id or
 * Claude session title; without a ref Claude opens its interactive session picker). Keeps the
 * profile's extra flags; a profile that already resumes/continues is left alone. Only claude
 * profiles can resume — anything else would silently replace the user's command.
 */
function withResume(command, ref) {
  const cmd = String(command || '').trim();
  if (cmd && !/^claude(\s|$)/.test(cmd)) throw new Error('Resume works only with profiles that run "claude"');
  const base = cmd || 'claude';
  if (/(^|\s)(--resume|-r|--continue|-c)(\s|=|$)/.test(base)) return base;
  return `claude --resume${ref ? ` ${shellQuote(ref)}` : ''}${base.slice('claude'.length)}`;
}

class SessionManager extends EventEmitter {
  constructor({ config, backend, terminal, store, screen, isOwnWindow }) {
    super();
    this.config = config;
    this.backend = backend;
    this.terminal = terminal;
    this.store = store;
    this.screen = screen;
    this.isOwnWindow = typeof isOwnWindow === 'function' ? isOwnWindow : () => false; // is this hwnd one of Satchel's own windows?
    this.sessions = new Map();   // id -> session
    this.exeCache = new Map();   // pid -> lowercase exe basename
    this.ignored = new Set();    // "pid:hwnd" the user asked us to forget
    this.names = typeof store.loadNames === 'function' ? (store.loadNames() || {}) : {}; // claudeSessionId -> { label, group, groupLocked, sessionTitle, updatedAt }
    this.fg = null;              // foreground hwnd as of the last poll
    this.slow = false;           // hidden in the tray -> poll 5x slower
    this._tick = 0;
    this.timer = null;
    this.lastEmitted = '';
    this.lastPersisted = '';
    this.lastNames = '';
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
      claudeSessionId: null, groupLocked: false, sessionTitle: null, ...over,
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
    this.timer = setInterval(tick, (this.config.pollIntervalMs || 1000) * (this.slow ? 5 : 1));
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Nothing is on screen while Satchel sits in the tray: poll 5x slower (hooks stay instant). */
  setSlow(on) {
    if (this.slow === !!on) return;
    this.slow = !!on;
    if (this.timer) this.start();
  }

  /** One pass: usually a cheap refresh of the windows we track; a full reconcile when needed. */
  poll() {
    const now = Date.now();
    this._tick++;
    if (this._pollCheap(now)) { this._changed(); return; }
    this._pollFull(now);
  }

  /**
   * Refresh only tracked windows (title / minimized / foreground) — no EnumWindows sweep, no
   * process lookups. Returns false when the full reconcile must run instead: every 5th tick
   * (adoption of foreign windows), any pending or vanished window, or a backend without
   * windowTitle().
   */
  _pollCheap(now) {
    if (typeof this.backend.windowTitle !== 'function') return false;
    if (this._tick % 5 === 1) return false; // tick 1 and every 5th: adoption sweep
    const list = [...this.sessions.values()];
    if (!list.length || list.some((s) => s.hwnd == null)) return false;
    const updates = [];
    for (const s of list) {
      const title = this.backend.windowTitle(s.hwnd);
      if (title == null) return false; // a window disappeared -> reconcile now
      updates.push([s, title]);
    }
    const fg = this.backend.foreground();
    this.fg = fg;
    for (const [s, title] of updates) this._sync(s, { id: s.hwnd, pid: s.pid, exe: s.exe, title }, now, fg);
    return true;
  }

  /** Full reconciliation between OS windows and our session list. */
  _pollFull(now) {
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
    this.fg = fg;
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

  launch({ profileName, cwd, label, resume } = {}) {
    const p = (this.config.profiles || []).find((x) => x.name === profileName);
    if (!p) throw new Error(`Unknown profile "${profileName}"`);
    let command = p.command || '';
    let target = null;
    if (resume) {
      target = this._resumeTarget(label);
      // Remembered session -> precise resume by id; unknown name -> Claude matches its own
      // session titles; no name -> Claude's interactive session picker opens in the window.
      command = withResume(command, target ? target.sessionId : ((label || '').trim() || null));
    } else if (this.config.nameClaudeSession !== false) {
      command = withSessionName(command, label);
    }
    const dir = expandHome(cwd || (target && target.cwd) || p.cwd || '~');
    if (!fs.existsSync(dir)) throw new Error(`Folder does not exist: ${dir}`);
    const id = crypto.randomUUID();
    const env = { ...(p.env || {}), SATCHEL_ID: id, SATCHEL_PROFILE: p.name, SATCHEL_EVENTS: EVENTS_FILE };
    const { pid } = this.terminal.launch({ cwd: dir, env, title: label || p.name, command, shell: p.shell });
    const s = this._blank({
      id, label: (label || '').trim(), profile: p.name, group: p.group || this.config.defaultGroup, cwd: dir,
      launched: true, pid, pending: true, pendingSince: Date.now(),
      // Pre-seed identity from the remembered session so grouping/naming apply immediately.
      claudeSessionId: target ? target.sessionId : null, sessionTitle: target ? target.sessionTitle || null : null,
    });
    if (target) this._applyRemembered(s, target.sessionId);
    this.sessions.set(id, s);
    this._changed(true);
    return this._view(s);
  }

  /**
   * Resolve "resume by name" against the remembered sessions (label first, then Claude's own
   * session title; newest wins). A name that only matches sessions already open in a window is an
   * error — resuming those would attach the same conversation twice.
   */
  _resumeTarget(label) {
    const name = String(label || '').trim().toLowerCase();
    if (!name) return null;
    const live = new Set([...this.sessions.values()].map((s) => s.claudeSessionId).filter(Boolean));
    let best = null;
    let liveHit = null;
    for (const [sessionId, r] of Object.entries(this.names)) {
      const rank = (r.label || '').trim().toLowerCase() === name ? 2
        : (r.sessionTitle || '').trim().toLowerCase() === name ? 1 : 0;
      if (!rank) continue;
      if (live.has(sessionId)) { liveHit = r; continue; }
      if (!best || rank > best.rank || (rank === best.rank && (r.updatedAt || 0) > (best.updatedAt || 0))) {
        best = { sessionId, rank, ...r };
      }
    }
    if (!best && liveHit) throw new Error(`"${(liveHit.label || liveHit.sessionTitle || '').trim()}" is already open — focus that window instead`);
    return best;
  }

  /** Closed-but-remembered Claude sessions, newest first — the "Resume" suggestions in the dialog. */
  resumeCandidates() {
    const live = new Set([...this.sessions.values()].map((s) => s.claudeSessionId).filter(Boolean));
    return Object.entries(this.names)
      .filter(([id, r]) => !live.has(id) && ((r.label || '').trim() || (r.sessionTitle || '').trim()))
      .map(([sessionId, r]) => ({
        sessionId, name: (r.label || '').trim() || (r.sessionTitle || '').trim(),
        group: r.group || null, cwd: r.cwd || null, updatedAt: r.updatedAt || 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
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
   * SessionStart tries the process tree before the session id: a `claude --resume` may bring a known
   * session id into a *different* window than the one that ran it last.
   */
  _sessionForHook(ev) {
    if (ev.satchelId && this.sessions.has(ev.satchelId)) return this.sessions.get(ev.satchelId);
    const all = [...this.sessions.values()];
    const bySessionId = () => (ev.sessionId ? all.find((x) => x.claudeSessionId === ev.sessionId) : null) || null;
    const byTree = () => {
      const getParents = this.backend.processParentsDeep || this.backend.processParents;
      if (!ev.ppid || typeof getParents !== 'function') return null;
      const byPid = new Map(all.filter((x) => x.pid).map((x) => [x.pid, x]));
      const parents = getParents.call(this.backend);
      let p = ev.ppid;
      for (let depth = 0; depth < 16 && p; depth++) {
        if (byPid.has(p)) return byPid.get(p);
        p = parents.get(p);
      }
      return null;
    };
    return ev.event === 'SessionStart' ? (byTree() || bySessionId()) : (bySessionId() || byTree());
  }

  /** Bring back what the user gave this Claude session last time it was in a window (label, group). */
  _applyRemembered(s, sessionId) {
    const rec = sessionId ? this.names[sessionId] : null;
    if (!rec) return;
    if (!s.label && rec.label) s.label = rec.label;
    if (!s.groupLocked && rec.groupLocked && rec.group) { s.group = rec.group; s.groupLocked = true; }
    if (!s.sessionTitle && rec.sessionTitle) s.sessionTitle = rec.sessionTitle;
  }

  /** Event shape: see hooks/claude-code-hook.js. Returns true if a session matched. */
  applyHookEvent(ev) {
    if (!ev || typeof ev !== 'object') return false;
    const s = this._sessionForHook(ev);
    if (!s) return false;
    if (ev.event === 'SessionStart' && ev.sessionId && ev.sessionId !== s.claudeSessionId) {
      // Another Claude session took over this window (`/clear`, a fresh `claude`, `--resume` of a
      // different conversation): drop the previous conversation's automatic name.
      s.sessionTitle = null;
      // The conversation now lives here — no other window may still answer to its id.
      for (const o of this.sessions.values()) if (o !== s && o.claudeSessionId === ev.sessionId) o.claudeSessionId = null;
    }
    if (ev.sessionId) s.claudeSessionId = ev.sessionId;
    if (ev.cwd) s.cwd = ev.cwd;
    // Sort adopted windows into the group of the account they run under.
    if (ev.configDir && !s.groupLocked) {
      const prof = (this.config.profiles || []).find((p) => p.env && sameDir(p.env.CLAUDE_CONFIG_DIR, ev.configDir));
      if (prof) { s.group = prof.group || s.group; s.profile = prof.name; }
    }
    this._applyRemembered(s, ev.sessionId);
    // Claude's own session name (/rename, --name, or the generated topic) — the row's automatic name.
    if (typeof ev.sessionTitle === 'string' && ev.sessionTitle.trim()) s.sessionTitle = ev.sessionTitle.trim();
    const fg = this.backend.foreground();
    const onHook = (this.config.attention || {}).onHook !== false;
    const away = s.hwnd == null || s.hwnd !== fg;
    switch (ev.event) {
      case 'UserPromptSubmit': s.attention = false; s.note = null; break;
      case 'Stop': if (onHook && away) this._flag(s, 'Finished'); break;
      case 'Notification': if (onHook && away) this._flag(s, ev.message || 'Needs your attention'); break;
      case 'SessionEnd':
        // Claude exited (or /clear'ed): the id no longer identifies this window, so a later --resume
        // elsewhere is not misattributed to it. The name stays — it is still what ran here last.
        if (!ev.sessionId || ev.sessionId === s.claudeSessionId) s.claudeSessionId = null;
        break;
      default: break;
    }
    this._changed(true);
    return true;
  }

  /** The session whose window is in the foreground; while Satchel itself is focused, the last one. */
  _focusedId() {
    const fg = this.fg;
    if (fg == null) return null;
    for (const s of this.sessions.values()) if (s.hwnd != null && s.hwnd === fg) return s.id;
    if (!this.isOwnWindow(fg)) return null;
    let best = null;
    for (const s of this.sessions.values()) if (s.hwnd != null && s.lastFocusedAt && (!best || s.lastFocusedAt > best.lastFocusedAt)) best = s;
    return best ? best.id : null;
  }

  // ---- snapshots / persistence ----------------------------------------------------------

  _view(s, focusedId = this._focusedId()) {
    const group = (this.config.groups || []).find((g) => g.name === s.group);
    const profile = s.profile ? (this.config.profiles || []).find((p) => p.name === s.profile) : null;
    return {
      id: s.id, label: s.label, profile: s.profile, group: s.group,
      color: (group && group.color) || (profile && profile.color) || '#8b95a5',
      pid: s.pid, hwnd: s.hwnd, exe: s.exe, title: s.title,
      cleanTitle: cleanTitle(s.title, this.config.statusGlyphs),
      sessionTitle: s.sessionTitle,
      status: s.status, statusSince: s.statusSince, attention: s.attention, note: s.note,
      cwd: s.cwd, createdAt: s.createdAt, launched: s.launched, minimized: s.minimized, pending: s.pending,
      claudeSessionId: s.claudeSessionId, focused: s.id === focusedId,
    };
  }

  snapshot() { const f = this._focusedId(); return this._ordered().map((s) => this._view(s, f)); }

  _changed(force = false) {
    const snap = this.snapshot();
    // Compare without the raw title: it carries Claude's spinner glyph, which rotates every tick
    // while a session works — repainting the UI for that would keep the renderer busy for nothing
    // visible (the topic lives in cleanTitle, the animation is CSS).
    const key = JSON.stringify(snap.map(({ title, ...rest }) => rest));
    if (force || key !== this.lastEmitted) {
      this.lastEmitted = key;
      this.emit('update', snap);
    }
    this.persist();
  }

  persist() {
    const list = this._ordered().map((s) => Object.fromEntries(PERSIST_FIELDS.map((k) => [k, s[k]])));
    const json = JSON.stringify(list);
    if (json !== this.lastPersisted) {
      this.lastPersisted = json;
      try { this.store.saveSessions(list); } catch (e) { this.emit('error', e); }
    }
    this._persistNames();
  }

  /** Remember label/group/title per Claude session id, so they come back with `claude --resume`. */
  _persistNames() {
    if (typeof this.store.saveNames !== 'function') return;
    let changed = false;
    for (const s of this.sessions.values()) {
      if (!s.claudeSessionId) continue;
      const prev = this.names[s.claudeSessionId];
      const rec = { label: s.label || '', group: s.group, groupLocked: !!s.groupLocked, sessionTitle: s.sessionTitle || null, cwd: s.cwd || null, updatedAt: prev ? prev.updatedAt : Date.now() };
      const same = prev && prev.label === rec.label && prev.group === rec.group && prev.groupLocked === rec.groupLocked && prev.sessionTitle === rec.sessionTitle && prev.cwd === rec.cwd;
      if (same) continue;
      rec.updatedAt = Date.now();
      this.names[s.claudeSessionId] = rec;
      changed = true;
    }
    if (!changed) return;
    const ids = Object.keys(this.names);
    if (ids.length > MAX_NAMES) {
      ids.sort((a, b) => (this.names[b].updatedAt || 0) - (this.names[a].updatedAt || 0));
      for (const id of ids.slice(MAX_NAMES)) delete this.names[id];
    }
    try { this.store.saveNames(this.names); } catch (e) { this.emit('error', e); }
  }
}

module.exports = { SessionManager, withSessionName, withResume, shellQuote };
