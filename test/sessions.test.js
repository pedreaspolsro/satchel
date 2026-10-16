// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager, withSessionName } = require('../src/main/sessions');

/** In-memory backend/terminal/store/screen so the core can be tested on any OS. */
function harness({ windows = [], parents = new Map(), foreground = null, ownWindows = [], persisted = {} } = {}) {
  const state = { windows, parents, foreground, launched: [], bounds: [], focused: [], placements: new Map(), placed: [], maximized: [], minimized: [] };
  const backend = {
    name: 'fake',
    capabilities: { list: true, focus: true, move: true },
    listWindows: () => state.windows.map((w) => ({ ...w })),
    windowTitle: (id) => { const w = state.windows.find((x) => x.id === id); return w ? w.title : null; },
    shellCwds: (pids) => { const m = new Map(); for (const p of pids) if (state.cwds && state.cwds.has(p)) m.set(p, state.cwds.get(p)); return m; },
    processImage: (pid) => (state.windows.some((w) => w.pid === pid) ? 'C:/Git/usr/bin/mintty.exe' : null),
    processParents: () => state.parents,
    foreground: () => state.foreground,
    focus: (id) => state.focused.push(id),
    setBounds: (id, r) => state.bounds.push({ id, ...r }),
    isMinimized: () => false,
    placement: (id) => state.placements.get(id) || null,
    setBoundsPhysical: (id, r) => state.placed.push({ id, ...r }),
    maximize: (id) => state.maximized.push(id),
    minimize: (id) => state.minimized.push(id),
    restore() {}, close() {},
  };
  const terminal = { name: 'fake', launch: (req) => { const pid = 5000 + state.launched.length; state.launched.push({ ...req, pid }); return { pid }; } };
  const saved = { sessions: persisted.sessions || [], names: {}, closed: persisted.closed || [] };
  const store = {
    loadSessions: () => saved.sessions, saveSessions: (l) => { saved.sessions = l; }, loadState: () => ({}), saveState() {},
    loadNames: () => saved.names, saveNames: (n) => { saved.names = JSON.parse(JSON.stringify(n)); },
    sessionsSavedAt: () => persisted.savedAt || null,
    loadClosed: () => JSON.parse(JSON.stringify(saved.closed)), saveClosed: (l) => { saved.closed = JSON.parse(JSON.stringify(l)); },
  };
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
  const mgr = new SessionManager({ config, backend, terminal, store, screen, isOwnWindow: (h) => ownWindows.includes(h) });
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
  assert.equal(mgr.snapshot()[0].profile, 'Claude company'); // ...but the account it runs under is still tracked
  assert.equal(mgr.applyHookEvent({ event: 'Stop', ppid: 777 }), false);
});

test('launch passes env + SATCHEL_ID and attaches the window by pid', () => {
  const { mgr, state } = harness();
  const s = mgr.launch({ profileName: 'Claude personal', label: 'work' });
  assert.equal(state.launched.length, 1);
  assert.equal(state.launched[0].env.CLAUDE_CONFIG_DIR, 'C:/Users/me/.claude');
  assert.equal(state.launched[0].env.SATCHEL_ID, s.id);
  assert.equal(state.launched[0].command, "claude --name 'work'"); // the label becomes Claude's session name
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

test('refreshCwds applies the live shell cwd; a running Claude keeps the hook-reported dir', () => {
  const { mgr, state } = harness({
    windows: [{ id: 10, pid: 100, title: 'MINGW64:/p' }, { id: 11, pid: 101, title: '✳ x' }],
    parents: new Map([[555, 444], [444, 333], [333, 222], [222, 101]]),
    foreground: 999,
  });
  state.cwds = new Map([[100, 'P:\\live'], [101, 'P:\\shell-of-claude-window']]);
  mgr.poll();
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 444, sessionId: 'abc', cwd: 'P:/claude-project' });
  mgr.refreshCwds();
  const [a, b] = mgr.snapshot();
  assert.equal(a.cwd, 'P:\\live');           // plain shell: live cwd fills in
  assert.equal(b.cwd, 'P:/claude-project');  // Claude session: hook dir wins
  // after Claude exits, the live shell cwd takes over
  mgr.applyHookEvent({ event: 'SessionEnd', sessionId: 'abc', reason: 'prompt_input_exit' });
  mgr.refreshCwds();
  assert.equal(mgr.snapshot()[1].cwd, 'P:\\shell-of-claude-window');
});

test('spinner-only title changes do not re-emit updates; real transitions do', () => {
  const { mgr, state } = harness({ windows: [{ id: 10, pid: 100, title: '◐ Build' }], foreground: 999 });
  let updates = 0;
  mgr.on('update', () => updates++);
  mgr.poll();
  const base = updates;
  state.windows[0].title = '◓ Build'; mgr.poll(); // cheap tick: same status, same topic
  state.windows[0].title = '◑ Build'; mgr.poll();
  assert.equal(updates, base);
  state.windows[0].title = '✳ Build'; mgr.poll(); // working -> idle is a real change
  assert.ok(updates > base);
});

test('withSessionName passes the label to plain `claude` commands only', () => {
  assert.equal(withSessionName('claude', 'fix tests'), "claude --name 'fix tests'");
  assert.equal(withSessionName('claude --dangerously-skip-permissions', 'x'), "claude --name 'x' --dangerously-skip-permissions");
  assert.equal(withSessionName('claude', "it's"), "claude --name 'it'\\''s'"); // shell-quoted for bash -c
  assert.equal(withSessionName('claude --resume', 'x'), 'claude --resume');    // a resumed session keeps its name
  assert.equal(withSessionName('claude -c', 'x'), 'claude -c');
  assert.equal(withSessionName('claude --name given', 'x'), 'claude --name given');
  assert.equal(withSessionName('claude', ''), 'claude');
  assert.equal(withSessionName('', 'x'), '');
  assert.equal(withSessionName('claude-code-router', 'x'), 'claude-code-router');
});

test('resume launches `claude --resume` against the remembered session', () => {
  const { mgr, state } = harness();
  mgr.names.abc = { label: 'My Task', group: 'Company', groupLocked: true, sessionTitle: 'Fix tests', cwd: process.cwd(), updatedAt: 2 };
  mgr.names.old = { label: 'my task', group: 'Other', groupLocked: false, sessionTitle: null, cwd: null, updatedAt: 1 };
  const s = mgr.launch({ profileName: 'Claude personal', label: 'my task', resume: true });
  assert.equal(state.launched[0].command, "claude --resume 'abc'"); // newest label match wins, no --name added
  assert.equal(s.claudeSessionId, 'abc');    // pre-seeded so hooks/grouping attach immediately
  assert.equal(s.sessionTitle, 'Fix tests');
  assert.equal(s.group, 'Company');          // remembered user-chosen group applies right away
  // Claude's own title also resolves
  mgr.names.xyz = { label: '', group: 'Other', groupLocked: false, sessionTitle: 'Refactor', cwd: null, updatedAt: 3 };
  mgr.launch({ profileName: 'Claude personal', label: 'Refactor', resume: true });
  assert.equal(state.launched[1].command, "claude --resume 'xyz'");
  // unknown name -> Claude matches its own session titles; empty -> interactive picker
  mgr.launch({ profileName: 'Claude personal', label: 'never seen', resume: true });
  assert.equal(state.launched[2].command, "claude --resume 'never seen'");
  mgr.launch({ profileName: 'Claude personal', resume: true });
  assert.equal(state.launched[3].command, 'claude --resume');
});

test('resume refuses a session that is already open in a window', () => {
  const { mgr } = harness({
    windows: [{ id: 10, pid: 100, title: '✳ x' }],
    parents: new Map([[555, 444], [444, 333], [333, 222], [222, 100]]),
  });
  mgr.poll();
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 444, sessionId: 'abc' });
  mgr.applyHookEvent({ event: 'UserPromptSubmit', sessionId: 'abc' }); // content -> worth remembering
  mgr.rename(mgr.snapshot()[0].id, 'My Task'); // persists names.abc with the label
  assert.throws(() => mgr.launch({ profileName: 'Claude personal', label: 'my task', resume: true }), /already open/);
  // candidates list also hides the live one
  assert.deepEqual(mgr.resumeCandidates(), []);
});

test('prompt-less fresh sessions are not remembered; titled records win resume ties', () => {
  const { mgr, saved } = harness({
    windows: [{ id: 10, pid: 100, title: 'MINGW64:/p' }],
    parents: new Map([[555, 444], [444, 333], [333, 222], [222, 100]]),
    foreground: 999,
  });
  mgr.poll();
  const row = mgr.snapshot()[0].id;
  mgr.rename(row, 'new dispo');
  // A `claude` that starts and dies without a single prompt never writes a transcript — its id
  // must not be remembered, or resume-by-name later resolves to an unresumable ghost.
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 444, sessionId: 'ghost', source: 'startup' });
  mgr.applyHookEvent({ event: 'SessionEnd', sessionId: 'ghost', reason: 'prompt_input_exit' });
  assert.ok(!('ghost' in saved.names), 'ghost session must not be remembered');
  // The real conversation in the same row gets remembered once something is said.
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 444, sessionId: 'real', source: 'startup' });
  mgr.applyHookEvent({ event: 'UserPromptSubmit', sessionId: 'real', sessionTitle: 'new dispo' });
  mgr.applyHookEvent({ event: 'SessionEnd', sessionId: 'real', reason: 'prompt_input_exit' });
  assert.equal(saved.names.real.label, 'new dispo');
  // A resumed session counts as content even before the next prompt.
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 444, sessionId: 'resumed', source: 'resume' });
  assert.ok('resumed' in saved.names);
  // While that same-name session is OPEN, resume-by-name refuses rather than resurrecting an
  // older conversation with the same name (a /clear leaves those behind).
  assert.throws(() => mgr._resumeTarget('new dispo'), /already open/);
  mgr.applyHookEvent({ event: 'SessionEnd', sessionId: 'resumed', reason: 'prompt_input_exit' });
  // Tiebreak: an untitled leftover record must lose to the titled real one, even when newer.
  mgr.names.leftover = { label: 'new dispo', group: 'Company', groupLocked: false, sessionTitle: null, cwd: null, updatedAt: Date.now() + 9999 };
  assert.equal(mgr._resumeTarget('new dispo').sessionId, 'real');
  // Suggestions collapse to one entry per name — the same record the resolver would pick.
  const dispo = mgr.resumeCandidates().filter((c) => c.name === 'new dispo');
  assert.equal(dispo.length, 1);
  assert.equal(dispo[0].sessionId, 'real');
});

test('resume keeps profile flags, respects an already-resuming profile, rejects non-claude commands', () => {
  const { mgr, state, config } = harness();
  config.profiles.push({ name: 'Skippy', group: 'Other', cwd: '.', command: 'claude --dangerously-skip-permissions' });
  config.profiles.push({ name: 'Resumer', group: 'Other', cwd: '.', command: 'claude --resume' });
  config.profiles.push({ name: 'NotClaude', group: 'Other', cwd: '.', command: 'npm start' });
  mgr.launch({ profileName: 'Skippy', label: 'x', resume: true });
  assert.equal(state.launched[0].command, "claude --resume 'x' --dangerously-skip-permissions");
  mgr.launch({ profileName: 'Resumer', label: 'x', resume: true });
  assert.equal(state.launched[1].command, 'claude --resume');
  assert.throws(() => mgr.launch({ profileName: 'NotClaude', label: 'x', resume: true }), /only with profiles that run "claude"/);
});

test('launch honours nameClaudeSession: false', () => {
  const { mgr, state, config } = harness();
  config.nameClaudeSession = false;
  mgr.launch({ profileName: 'Claude personal', label: 'work' });
  assert.equal(state.launched[0].command, 'claude');
});

test('hook session_title names the row; a new Claude session in the same window drops it', () => {
  const { mgr } = harness({
    windows: [{ id: 10, pid: 100, title: 'MINGW64:/p/x' }],
    parents: new Map([[555, 444], [444, 333], [333, 222], [222, 100]]),
    foreground: 999,
  });
  mgr.poll();
  assert.equal(mgr.snapshot()[0].sessionTitle, null);
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 444, sessionId: 'abc', source: 'startup' });
  mgr.applyHookEvent({ event: 'UserPromptSubmit', sessionId: 'abc', sessionTitle: '  Fix the flaky test  ' });
  assert.equal(mgr.snapshot()[0].sessionTitle, 'Fix the flaky test');
  // /rename inside Claude arrives with the next event
  mgr.applyHookEvent({ event: 'UserPromptSubmit', sessionId: 'abc', sessionTitle: 'Flaky test' });
  assert.equal(mgr.snapshot()[0].sessionTitle, 'Flaky test');
  // events without a title leave it alone; Claude exiting keeps the name but forgets the id
  mgr.applyHookEvent({ event: 'Stop', sessionId: 'abc' });
  mgr.applyHookEvent({ event: 'SessionEnd', sessionId: 'abc', reason: 'prompt_input_exit' });
  assert.equal(mgr.snapshot()[0].sessionTitle, 'Flaky test');
  assert.equal(mgr.snapshot()[0].claudeSessionId, null);
  // /clear (or a fresh `claude`) = a different session id in the same window -> automatic name reset
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 444, sessionId: 'def', source: 'clear' });
  assert.equal(mgr.snapshot()[0].sessionTitle, null);
  assert.equal(mgr.snapshot()[0].claudeSessionId, 'def');
});

test('label and group stick to the Claude session id and come back with --resume in a new window', () => {
  const { mgr, state, saved } = harness({
    windows: [{ id: 10, pid: 100, title: '✳ Fix tests' }],
    parents: new Map([[555, 444], [444, 333], [333, 222], [222, 100], [666, 665], [665, 664], [664, 663], [663, 200]]),
    foreground: 999,
  });
  mgr.poll();
  const a = mgr.snapshot()[0];
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 444, sessionId: 'abc', sessionTitle: 'Fix tests' });
  mgr.rename(a.id, 'my task');
  mgr.setGroup(a.id, 'Company');
  assert.equal(saved.names.abc.label, 'my task');
  assert.equal(saved.names.abc.group, 'Company');
  assert.equal(saved.names.abc.groupLocked, true);
  // window closed; later `claude --resume` in a brand-new window (different pid, no SATCHEL_ID)
  mgr.applyHookEvent({ event: 'SessionEnd', sessionId: 'abc', reason: 'prompt_input_exit' });
  state.windows.length = 0;
  mgr.poll(); // fake pid 100 is not alive -> the old session is dropped
  assert.equal(mgr.snapshot().length, 0);
  state.windows.push({ id: 20, pid: 200, title: 'MINGW64:/p/x' });
  mgr.poll();
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 665, sessionId: 'abc', source: 'resume' });
  const b = mgr.snapshot()[0];
  assert.equal(b.pid, 200);
  assert.equal(b.label, 'my task');
  assert.equal(b.group, 'Company');
  assert.equal(b.sessionTitle, 'Fix tests');
  // the user clearing the label is remembered too (not resurrected on the next event)
  mgr.rename(b.id, '');
  mgr.applyHookEvent({ event: 'Stop', sessionId: 'abc' });
  assert.equal(mgr.snapshot()[0].label, '');
  assert.equal(saved.names.abc.label, '');
});

test('SessionStart prefers the process tree over a stale session id in another window', () => {
  const { mgr } = harness({
    windows: [{ id: 10, pid: 100, title: '✳ A' }, { id: 20, pid: 200, title: 'MINGW64:/p' }],
    parents: new Map([[555, 444], [444, 333], [333, 222], [222, 100], [666, 665], [665, 664], [664, 663], [663, 200]]),
    foreground: 999,
  });
  mgr.poll();
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 444, sessionId: 'abc' });
  assert.equal(mgr.snapshot()[0].claudeSessionId, 'abc');
  // no SessionEnd arrived (older hook install); the same conversation is resumed in window 20
  mgr.applyHookEvent({ event: 'SessionStart', ppid: 665, sessionId: 'abc', source: 'resume' });
  assert.equal(mgr.snapshot()[1].claudeSessionId, 'abc');
  // subsequent events (no ppid) go to the window that started it last
  mgr.applyHookEvent({ event: 'Notification', sessionId: 'abc', message: 'Permission' });
  assert.equal(mgr.snapshot()[1].attention, true);
  assert.equal(mgr.snapshot()[0].attention, false);
});

test('marks the session whose window is in the foreground; while Satchel is focused, the last one', () => {
  const { mgr, state } = harness({
    windows: [{ id: 10, pid: 100, title: 'a' }, { id: 11, pid: 101, title: 'b' }],
    foreground: 11,
    ownWindows: [500],
  });
  mgr.poll();
  assert.deepEqual(mgr.snapshot().map((s) => s.focused), [false, true]);
  state.foreground = 10; mgr.poll();
  assert.deepEqual(mgr.snapshot().map((s) => s.focused), [true, false]);
  state.foreground = 500; mgr.poll(); // Satchel's own window: keep pointing at the terminal we came from
  assert.deepEqual(mgr.snapshot().map((s) => s.focused), [true, false]);
  state.foreground = 999; mgr.poll(); // some other app: nothing is current
  assert.deepEqual(mgr.snapshot().map((s) => s.focused), [false, false]);
  state.foreground = null; mgr.poll();
  assert.deepEqual(mgr.snapshot().map((s) => s.focused), [false, false]);
});

test('"+ New" preselects the profile of the active terminal, also once focus has moved on', () => {
  const { mgr, state } = harness({ ownWindows: [500] });
  assert.equal(mgr.activeProfile(), null); // nothing tracked yet
  mgr.launch({ profileName: 'Claude personal' });
  mgr.launch({ profileName: 'Claude company' });
  state.windows.push({ id: 20, pid: 5000, title: '✳ a' }, { id: 21, pid: 5001, title: '✳ b' });
  state.foreground = 21; mgr.poll();
  assert.equal(mgr.activeProfile(), 'Claude company');
  state.foreground = 20; mgr.poll();
  assert.equal(mgr.activeProfile(), 'Claude personal');
  state.foreground = 500; mgr.poll(); // Satchel's panel / the New dialog: the terminal we came from
  assert.equal(mgr.activeProfile(), 'Claude personal');
  state.foreground = 999; mgr.poll(); // the docked strip never takes focus — another app may still be in front
  assert.equal(mgr.activeProfile(), 'Claude personal');
});

/** Take a window off screen and let the manager notice (fake pids may happen to be alive here). */
function closeWindows(mgr, state, ids) {
  state.windows = state.windows.filter((w) => !ids.includes(w.id));
  mgr.poll();
  for (const x of mgr.sessions.values()) if (x.hwnd == null) x.pendingSince = 0; // as if the pid had died
  mgr.poll();
}

test('a closed window reopens in its folder, resumes its conversation and goes back to its place', () => {
  const { mgr, state, saved } = harness();
  const s = mgr.launch({ profileName: 'Claude personal', label: 'work', cwd: __dirname });
  state.windows.push({ id: 77, pid: 5000, title: '✳ Claude' });
  state.placements.set(77, { x: 100, y: 50, width: 800, height: 600, maximized: false, minimized: false });
  mgr.poll();
  mgr.applyHookEvent({ event: 'SessionStart', satchelId: s.id, sessionId: 'abc', source: 'startup' });
  mgr.applyHookEvent({ event: 'UserPromptSubmit', sessionId: 'abc' });
  // maximized later, then minimized: the normal rect and "maximized" survive both
  state.placements.set(77, { x: -8, y: -8, width: 1936, height: 1048, maximized: true, minimized: false });
  mgr._tick = 0; mgr.poll();
  state.placements.set(77, { x: -32000, y: -32000, width: 160, height: 28, maximized: false, minimized: true });
  mgr._tick = 0; mgr.poll();
  closeWindows(mgr, state, [77]);
  assert.deepEqual(mgr.closedList().map((e) => [e.count, e.names]), [[1, ['work']]]);
  assert.equal(saved.closed.length, 1, 'the stack is persisted');

  const r = mgr.reopenClosed();
  assert.deepEqual(r.errors, []);
  const again = state.launched[1];
  assert.equal(again.command, "claude --resume 'abc'");
  assert.equal(again.cwd, __dirname);
  assert.equal(again.env.CLAUDE_CONFIG_DIR, 'C:/Users/me/.claude');
  assert.equal(mgr.closedList().length, 0);
  const back = mgr.snapshot().find((x) => x.id === r.opened[0].id);
  assert.equal(back.label, 'work');
  assert.equal(back.claudeSessionId, 'abc');

  state.windows.push({ id: 78, pid: 5001, title: '✳ Claude' });
  mgr.poll();
  assert.deepEqual(state.placed, [{ id: 78, x: 100, y: 50, width: 800, height: 600 }]);
  assert.deepEqual(state.maximized, [78]);
  assert.deepEqual(state.minimized, [78]);
  assert.throws(() => mgr.reopenClosed(), /Nothing to reopen/);
});

test('windows closing together are one entry; Claude without a conversation reopens as a shell, adopted shells via the shell profile', () => {
  const { mgr, state, config } = harness({ windows: [{ id: 10, pid: 100, title: 'MINGW64:/c/work' }] });
  config.profiles.push({ name: 'Shell', group: 'Other', cwd: '.', command: '' });
  mgr.launch({ profileName: 'Claude company', label: 'after claude' });
  state.windows.push({ id: 20, pid: 5000, title: 'MINGW64:/p' }); // Claude exited before anything was said
  mgr.poll();
  closeWindows(mgr, state, [10]);
  mgr.closed[mgr.closed.length - 1].at -= 60000; // a minute later...
  closeWindows(mgr, state, [20]);
  assert.deepEqual(mgr.closedList().map((e) => e.count), [1, 1]);
  // ...but a burst (a PC restart) is one entry
  mgr.reopenClosed();
  mgr.reopenClosed();
  state.windows.push({ id: 21, pid: 5001, title: 'x' }, { id: 22, pid: 5002, title: 'y' });
  mgr.poll();
  closeWindows(mgr, state, [21, 22]);
  assert.deepEqual(mgr.closedList().map((e) => e.count), [2]);
  const [company, shell] = [state.launched[1], state.launched[2]]; // newest entry first
  assert.equal(company.command, ''); // same account, plain shell
  assert.equal(company.env.CLAUDE_CONFIG_DIR, 'C:/Users/me/.claude-co');
  assert.equal(company.env.SATCHEL_PROFILE, 'Claude company');
  assert.equal(shell.command, '');
  assert.equal(shell.env.SATCHEL_PROFILE, 'Shell');
});

test('a Claude window reopens its last conversation even after Claude exited or /clear started an empty one', () => {
  const { mgr, state } = harness();
  const a = mgr.launch({ profileName: 'Claude personal', label: 'x' });
  state.windows.push({ id: 77, pid: 5000, title: '✳ Claude' });
  mgr.poll();
  mgr.applyHookEvent({ event: 'SessionStart', satchelId: a.id, sessionId: 'conv1', source: 'startup' });
  mgr.applyHookEvent({ event: 'UserPromptSubmit', sessionId: 'conv1' });
  mgr.applyHookEvent({ event: 'SessionEnd', sessionId: 'conv1', reason: 'prompt_input_exit' }); // `/exit`
  state.windows[0].title = 'MINGW64:/p'; // back at the shell prompt
  mgr.poll();
  closeWindows(mgr, state, [77]);
  const b = mgr.reopenClosed().opened[0];
  assert.equal(state.launched[1].command, "claude --resume 'conv1'");

  // /clear: a new, still empty conversation replaces it — the reopen still brings conv1 back
  state.windows.push({ id: 78, pid: 5001, title: '✳ Claude' });
  mgr.poll();
  mgr.applyHookEvent({ event: 'SessionStart', satchelId: b.id, sessionId: 'conv1', source: 'resume' });
  mgr.applyHookEvent({ event: 'SessionEnd', sessionId: 'conv1', reason: 'clear' });
  mgr.applyHookEvent({ event: 'SessionStart', satchelId: b.id, sessionId: 'conv2', source: 'clear' });
  closeWindows(mgr, state, [78]);
  mgr.reopenClosed();
  assert.equal(state.launched[2].command, "claude --resume 'conv1'");

  // Open in another window by the time of the reopen: no second attach, a plain shell instead
  state.windows.push({ id: 79, pid: 5002, title: '✳ Claude' });
  mgr.poll();
  closeWindows(mgr, state, [79]);
  const other = mgr.launch({ profileName: 'Claude personal', label: 'y' });
  state.windows.push({ id: 80, pid: 5003, title: '✳ Claude' });
  mgr.poll();
  mgr.applyHookEvent({ event: 'SessionStart', satchelId: other.id, sessionId: 'conv1', source: 'resume' });
  mgr.reopenClosed();
  assert.equal(state.launched[4].command, '');
  assert.equal(state.launched[4].env.CLAUDE_CONFIG_DIR, 'C:/Users/me/.claude');
});

test('after a restart the previous session is one reopen entry, joined with what closed during shutdown', () => {
  const savedAt = Date.now() - 3600000;
  const dead = (id, extra) => ({ id, pid: 4194000 + id.length, hwnd: 1000 + id.length, exe: 'mintty.exe', profile: 'Claude personal', group: 'Personal', cwd: __dirname, createdAt: 1, launched: true, ...extra });
  const { mgr } = harness({
    persisted: {
      savedAt,
      sessions: [
        dead('a', { claudeSessionId: 'conv-a', hadPrompt: true, label: 'A' }),
        dead('bb', { label: 'B' }),
        // a recycled pid: alive, but not a terminal any more
        { ...dead('ccc', { label: 'C' }), pid: process.pid },
        // a launch that never got a window is not a window to bring back
        { id: 'dddd', pid: 4194999, hwnd: null, profile: 'Claude personal', createdAt: 1, launched: true },
      ],
      closed: [
        { at: savedAt - 7200000, windows: [{ name: 'old', profile: 'Claude personal', label: 'old' }] },
        { at: savedAt - 3000, windows: [{ name: 'D', profile: 'Claude personal', label: 'D' }] }, // seen closing at shutdown
      ],
    },
  });
  assert.deepEqual(mgr.snapshot(), []);
  const list = mgr.closedList();
  assert.deepEqual(list.map((e) => e.count), [4, 1]);
  assert.deepEqual([...list[0].names].sort(), ['A', 'B', 'C', 'D']);
});
