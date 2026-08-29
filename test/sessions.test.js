// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../src/main/sessions');

/** In-memory backend/terminal/store/screen so the core can be tested on any OS. */
function harness({ windows = [], parents = new Map(), foreground = null } = {}) {
  const state = { windows, parents, foreground, launched: [], bounds: [], focused: [] };
  const backend = {
    name: 'fake',
    capabilities: { list: true, focus: true, move: true },
    listWindows: () => state.windows.map((w) => ({ ...w })),
    processImage: (pid) => (state.windows.some((w) => w.pid === pid) ? 'C:/Git/usr/bin/mintty.exe' : null),
    processParents: () => state.parents,
    foreground: () => state.foreground,
    focus: (id) => state.focused.push(id),
    setBounds: (id, r) => state.bounds.push({ id, ...r }),
    isMinimized: () => false,
    minimize() {}, restore() {}, close() {},
  };
  const terminal = { name: 'fake', launch: (req) => { const pid = 5000 + state.launched.length; state.launched.push({ ...req, pid }); return { pid }; } };
  const saved = { sessions: [] };
  const store = { loadSessions: () => saved.sessions, saveSessions: (l) => { saved.sessions = l; }, loadState: () => ({}), saveState() {} };
  const screen = {
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1000, height: 600 }, bounds: { x: 0, y: 0, width: 1000, height: 600 } }),
    getAllDisplays: () => [screen.getPrimaryDisplay()],
  };
  const config = {
    pollIntervalMs: 1000, adoptForeign: true, adoptExecutables: ['mintty.exe'], defaultGroup: 'Other',
    groups: [{ name: 'Personal', color: '#111' }, { name: 'Company', color: '#222' }, { name: 'Other', color: '#333' }],
    profiles: [
      { name: 'Claude personal', group: 'Personal', cwd: '.', command: 'claude', env: { CLAUDE_CONFIG_DIR: 'C:/Users/me/.claude' } },
      { name: 'Claude company', group: 'Company', cwd: '.', command: 'claude', env: { CLAUDE_CONFIG_DIR: 'C:/Users/me/.claude-co' } },
    ],
    statusGlyphs: { idle: ['✳'], working: ['◐', '◓', '◑', '◒'] },
    attention: { onIdle: true, onHook: true },
  };
  // isAlive() uses process.kill(pid, 0); fake pids don't exist, so stub it for pending sessions.
  const mgr = new SessionManager({ config, backend, terminal, store, screen });
  return { mgr, state, saved, config };
}

test('adopts foreign terminal windows and derives status from the title', () => {
  const { mgr } = harness({ windows: [{ id: 10, pid: 100, title: '✳ Fix tests' }, { id: 11, pid: 101, title: '◑ Refactor' }] });
  mgr.poll();
  const snap = mgr.snapshot();
  assert.equal(snap.length, 2);
  assert.deepEqual(snap.map((s) => s.status), ['idle', 'working']);
  assert.equal(snap[0].group, 'Other');
  assert.equal(snap[0].cleanTitle, 'Fix tests');
});

test('flags attention when a session goes working -> idle while not in the foreground', () => {
  const { mgr, state } = harness({ windows: [{ id: 10, pid: 100, title: '◑ Refactor' }], foreground: 999 });
  const events = [];
  mgr.on('attention', (s) => events.push(s));
  mgr.poll();
  state.windows[0].title = '✳ Refactor';
  mgr.poll();
  assert.equal(mgr.snapshot()[0].attention, true);
  assert.equal(events.length, 1);
  // focusing clears it
  mgr.focus(mgr.snapshot()[0].id);
  assert.equal(mgr.snapshot()[0].attention, false);
  // no second notification while already flagged
  state.windows[0].title = '◑ Refactor'; mgr.poll();
  state.windows[0].title = '✳ Refactor'; mgr.poll();
  assert.equal(events.length, 2);
});

test('hook events match adopted windows through the process tree and auto-group by account', () => {
  const { mgr, state } = harness({
    windows: [{ id: 10, pid: 100, title: '✳ Fix tests' }],
    // hook(555) <- sh(444) <- claude(333) <- bash(222) <- mintty(100)
    parents: new Map([[555, 444], [444, 333], [333, 222], [222, 100], [100, 1]]),
    foreground: 999,
  });
  mgr.poll();
  const matched = mgr.applyHookEvent({ event: 'Notification', ppid: 444, sessionId: 'abc', cwd: 'P:/x', configDir: 'c:\\users\\me\\.claude-co\\', message: 'Permission needed' });
  assert.equal(matched, true);
  const s = mgr.snapshot()[0];
  assert.equal(s.group, 'Company');
  assert.equal(s.profile, 'Claude company');
  assert.equal(s.claudeSessionId, 'abc');
  assert.equal(s.cwd, 'P:/x');
  assert.equal(s.attention, true);
  assert.equal(s.note, 'Permission needed');
  // later events match by claude session id even without ppid
  assert.equal(mgr.applyHookEvent({ event: 'UserPromptSubmit', sessionId: 'abc' }), true);
  assert.equal(mgr.snapshot()[0].attention, false);
  // a different account (e.g. after `claude` was restarted in the same window) re-groups it
  mgr.applyHookEvent({ event: 'SessionStart', sessionId: 'abc', configDir: 'C:/Users/me/.claude' });
  assert.equal(mgr.snapshot()[0].group, 'Personal');
  assert.equal(mgr.snapshot()[0].profile, 'Claude personal');
  // a user-chosen group is never overridden by hooks
  mgr.setGroup(s.id, 'Personal');
  mgr.applyHookEvent({ event: 'Stop', sessionId: 'abc', configDir: 'C:/Users/me/.claude-co' });
  assert.equal(mgr.snapshot()[0].group, 'Personal');
  assert.equal(mgr.applyHookEvent({ event: 'Stop', ppid: 777 }), false);
});

test('launch passes env + SATCHEL_ID and attaches the window by pid', () => {
  const { mgr, state } = harness();
  const s = mgr.launch({ profileName: 'Claude personal', label: 'work' });
  assert.equal(state.launched.length, 1);
  assert.equal(state.launched[0].env.CLAUDE_CONFIG_DIR, 'C:/Users/me/.claude');
  assert.equal(state.launched[0].env.SATCHEL_ID, s.id);
  assert.equal(state.launched[0].command, 'claude');
  assert.equal(s.pending, true);
  state.windows.push({ id: 77, pid: 5000, title: '✳ Claude' });
  mgr.poll();
  const after = mgr.snapshot().find((x) => x.id === s.id);
  assert.equal(after.hwnd, 77);
  assert.equal(after.pending, false);
  assert.equal(after.group, 'Personal');
  assert.equal(after.label, 'work');
  assert.throws(() => mgr.launch({ profileName: 'nope' }), /Unknown profile/);
});

test('tile lays out the windows of a group on the work area', () => {
  const { mgr, state } = harness({ windows: [
    { id: 1, pid: 100, title: 'a' }, { id: 2, pid: 101, title: 'b' }, { id: 3, pid: 102, title: 'c' },
  ] });
  mgr.poll();
  const ids = mgr.snapshot().map((s) => s.id);
  mgr.setGroup(ids[0], 'Personal');
  mgr.setGroup(ids[1], 'Personal');
  assert.equal(mgr.tile('Personal', 1), 2);
  assert.equal(state.bounds.length, 2);
  assert.deepEqual(state.bounds[0], { id: 1, x: 0, y: 0, width: 500, height: 600 });
  assert.deepEqual(state.bounds[1], { id: 2, x: 500, y: 0, width: 500, height: 600 });
  assert.equal(mgr.tile('All', 1), 3);
});

test('forget stops tracking a window and it is not re-adopted', () => {
  const { mgr } = harness({ windows: [{ id: 10, pid: 100, title: 'x' }] });
  mgr.poll();
  mgr.forget(mgr.snapshot()[0].id);
  mgr.poll();
  assert.equal(mgr.snapshot().length, 0);
});
