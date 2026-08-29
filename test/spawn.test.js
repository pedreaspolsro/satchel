// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrubEnv, isSessionMarker } = require('../src/main/terminals/spawn');

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
  };
  const out = scrubEnv(env);
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.CLAUDE_CONFIG_DIR, 'C:/Users/me/.claude-finshape'); // profiles rely on this
  assert.equal(out.ANTHROPIC_API_KEY, 'keep-me');
  assert.equal(out.SATCHEL_ID, 'x');
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT']) {
    assert.ok(!(k in out), `${k} should be scrubbed`);
  }
});

test('isSessionMarker classifies vars', () => {
  assert.ok(isSessionMarker('CLAUDE_CODE_ENTRYPOINT'));
  assert.ok(isSessionMarker('CLAUDECODE'));
  assert.ok(!isSessionMarker('CLAUDE_CONFIG_DIR'));
  assert.ok(!isSessionMarker('PATH'));
  assert.ok(!isSessionMarker('ANTHROPIC_API_KEY'));
});
