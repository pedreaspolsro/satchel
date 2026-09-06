// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrubEnv, baseEnv, isSessionMarker } = require('../src/main/terminals/spawn');

test('scrubEnv removes agent-session markers but keeps real config', () => {
  const env = {
    PATH: '/usr/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_PID: '1234',
    CLAUDE_EFFORT: 'high',
    AI_AGENT: '1',
    CLAUDE_CONFIG_DIR: 'C:/Users/me/.claude-finshape',
    ANTHROPIC_API_KEY: 'keep-me',
    SATCHEL_ID: 'x',
    NO_COLOR: '1',              // leaks from Claude Code's shell -> launched terminals go black & white
    GIT_TERMINAL_PROMPT: '0',   // leaks too -> git stops asking for credentials
  };
  const out = scrubEnv(env);
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.CLAUDE_CONFIG_DIR, 'C:/Users/me/.claude-finshape'); // profiles rely on this
  assert.equal(out.ANTHROPIC_API_KEY, 'keep-me');
  assert.equal(out.SATCHEL_ID, 'x');
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT', 'NO_COLOR', 'GIT_TERMINAL_PROMPT']) {
    assert.ok(!(k in out), `${k} should be scrubbed`);
  }
  // adapters merge the profile env AFTER scrubbing, so an explicit profile value still wins
  assert.equal({ ...scrubEnv(env), NO_COLOR: '1' }.NO_COLOR, '1');
});

test('baseEnv prefers the backend clean environment and falls back to the scrubbed process env', () => {
  const clean = { Path: 'C:/reg', USERPROFILE: 'C:/u', SystemRoot: 'C:/Windows' };
  assert.deepEqual(baseEnv({ cleanEnv: () => clean }), clean);
  const saved = process.env.CLAUDECODE;
  process.env.CLAUDECODE = '1';
  try {
    // Anything not a plausible user block -> scrubbed inherited env instead.
    for (const bad of [null, {}, { Path: 'x' }, { USERPROFILE: 'y' }]) {
      const out = baseEnv({ cleanEnv: () => bad });
      assert.ok(!('CLAUDECODE' in out), `fallback must scrub (got clean=${JSON.stringify(bad)})`);
    }
    assert.ok(!('CLAUDECODE' in baseEnv({ cleanEnv: () => { throw new Error('boom'); } })));
    assert.ok(!('CLAUDECODE' in baseEnv(null)));
  } finally {
    if (saved === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved;
  }
});

test('mintty adapter builds a scrubbed env (regression: scrubEnv must be imported there)', () => {
  const saved = { NO_COLOR: process.env.NO_COLOR, CLAUDECODE: process.env.CLAUDECODE };
  process.env.NO_COLOR = '1';
  process.env.CLAUDECODE = '1';
  try {
    const mintty = require('../src/main/terminals/mintty');
    let got = null;
    const backend = { spawnDetached: (req) => { got = req; return { pid: 4242 }; } };
    // cfg.path just has to exist; the adapter never runs it because the fake backend intercepts
    const t = mintty({ path: process.execPath, icon: 'nope' }, backend);
    const { pid } = t.launch({ cwd: process.cwd(), env: { CLAUDE_CONFIG_DIR: 'C:/x/.claude', NO_COLOR: 'profile-set' }, title: 'T', command: '' });
    assert.equal(pid, 4242);
    assert.equal(got.env.MSYSTEM, process.env.MSYSTEM || 'MINGW64');
    assert.ok(!('CLAUDECODE' in got.env), 'CLAUDECODE should be scrubbed');
    assert.equal(got.env.NO_COLOR, 'profile-set'); // scrubbed from inherited env, but profile env wins
    assert.equal(got.env.CLAUDE_CONFIG_DIR, 'C:/x/.claude');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('isSessionMarker classifies vars', () => {
  assert.ok(isSessionMarker('CLAUDE_CODE_ENTRYPOINT'));
  assert.ok(isSessionMarker('CLAUDECODE'));
  assert.ok(isSessionMarker('NO_COLOR'));
  assert.ok(isSessionMarker('FORCE_COLOR'));
  assert.ok(isSessionMarker('CLICOLOR'));
  assert.ok(isSessionMarker('CLICOLOR_FORCE'));
  assert.ok(isSessionMarker('GIT_TERMINAL_PROMPT'));
  assert.ok(!isSessionMarker('CLAUDE_CONFIG_DIR'));
  assert.ok(!isSessionMarker('PATH'));
  assert.ok(!isSessionMarker('ANTHROPIC_API_KEY'));
  assert.ok(!isSessionMarker('COLORTERM')); // describes the terminal, doesn't tame output
});
