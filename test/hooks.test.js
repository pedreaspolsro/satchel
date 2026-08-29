// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installClaudeHooks, uninstallClaudeHooks, hookStatus, HOOK_EVENTS } = require('../src/main/hooks');

const SCRIPT = 'C:\\Users\\me\\.satchel\\claude-code-hook.js';

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satchel-hooks-'));
  const a = path.join(root, '.claude'), b = path.join(root, '.claude-co'), missing = path.join(root, '.claude-missing');
  fs.mkdirSync(a); fs.mkdirSync(b);
  // dir A already has a foreign Stop hook and some unrelated settings; dir B has no settings.json
  fs.writeFileSync(path.join(a, 'settings.json'), JSON.stringify({
    model: 'opus',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
  }));
  return { root, a, b, missing };
}

test('install merges into existing settings, creates missing files, skips missing dirs, is idempotent', () => {
  const { a, b, missing } = tmpDirs();
  const r1 = installClaudeHooks([a, b, missing], SCRIPT);
  assert.deepEqual(r1.map((x) => x.changed ?? null), [true, true, null]);
  assert.match(r1[2].skipped, /does not exist/);

  const sa = JSON.parse(fs.readFileSync(path.join(a, 'settings.json'), 'utf8'));
  assert.equal(sa.model, 'opus'); // untouched
  assert.equal(sa.hooks.Stop[0].hooks[0].command, 'echo done'); // foreign hook kept
  for (const ev of HOOK_EVENTS) {
    assert.ok(sa.hooks[ev].some((g) => g.hooks.some((h) => h.command.includes('claude-code-hook.js'))), ev);
  }
  assert.ok(fs.existsSync(path.join(a, 'settings.json.satchel-backup')));
  assert.ok(fs.existsSync(path.join(b, 'settings.json')));
  assert.ok(!fs.existsSync(path.join(b, 'settings.json.satchel-backup'))); // nothing to back up

  const st = hookStatus([a, b, missing], SCRIPT);
  assert.deepEqual(st.map((x) => x.installed), [true, true, false]);

  const r2 = installClaudeHooks([a, b], SCRIPT);
  assert.deepEqual(r2.map((x) => x.changed), [false, false]);
  const again = JSON.parse(fs.readFileSync(path.join(a, 'settings.json'), 'utf8'));
  assert.equal(again.hooks.Stop.length, 2); // not duplicated
});

test('uninstall removes only our entries and cleans up empty structures', () => {
  const { a, b } = tmpDirs();
  installClaudeHooks([a, b], SCRIPT);
  const r = uninstallClaudeHooks([a, b], SCRIPT);
  assert.deepEqual(r.map((x) => x.removed), [true, true]);

  const sa = JSON.parse(fs.readFileSync(path.join(a, 'settings.json'), 'utf8'));
  assert.deepEqual(sa.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] });
  assert.equal(sa.model, 'opus');
  const sb = JSON.parse(fs.readFileSync(path.join(b, 'settings.json'), 'utf8'));
  assert.equal(sb.hooks, undefined);
  assert.deepEqual(hookStatus([a, b], SCRIPT).map((x) => x.installed), [false, false]);
  assert.deepEqual(uninstallClaudeHooks([a, b], SCRIPT).map((x) => x.removed), [false, false]);
});
