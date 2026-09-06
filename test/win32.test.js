// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const onWindows = process.platform === 'win32';

test('quoteArg follows MS command-line rules', { skip: !onWindows }, () => {
  const { quoteArg } = require('../src/main/backends/win32')._internal;
  assert.equal(quoteArg('plain'), 'plain');
  assert.equal(quoteArg(''), '""');
  assert.equal(quoteArg('has space'), '"has space"');
  assert.equal(quoteArg('C:\\Program Files\\Git\\usr\\bin\\mintty.exe'), '"C:\\Program Files\\Git\\usr\\bin\\mintty.exe"');
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteArg('trailing\\'), 'trailing\\');
  assert.equal(quoteArg('dir with space\\'), '"dir with space\\\\"');
  assert.equal(quoteArg('claude; exec /usr/bin/bash --login -i'), '"claude; exec /usr/bin/bash --login -i"');
});

test('envBlock is sorted, double-NUL terminated UTF-16', { skip: !onWindows }, () => {
  const { envBlock } = require('../src/main/backends/win32')._internal;
  const buf = envBlock({ b: '2', A: '1', '=C:': 'x', skipped: null });
  const s = buf.toString('utf16le');
  assert.equal(s, 'A=1\0b=2\0\0');
});

test('cleanEnv builds the canonical user environment, independent of process env', { skip: !onWindows }, () => {
  const b = require('../src/main/backends/win32');
  process.env.SATCHEL_TEST_LEAK = '1';
  try {
    const env = b.cleanEnv();
    assert.ok(env && Object.keys(env).length > 10, 'expected a populated environment block');
    const key = (n) => Object.keys(env).find((k) => k.toLowerCase() === n);
    assert.ok(env[key('path')], 'Path missing');
    assert.ok(env[key('userprofile')], 'USERPROFILE missing');
    assert.ok(env[key('systemroot')], 'SystemRoot missing');
    assert.ok(!('SATCHEL_TEST_LEAK' in env), 'process env leaked into the clean block');
  } finally {
    delete process.env.SATCHEL_TEST_LEAK;
  }
});

test('listWindows returns titled top-level windows', { skip: !onWindows }, () => {
  const b = require('../src/main/backends/win32');
  const wins = b.listWindows();
  assert.ok(Array.isArray(wins));
  for (const w of wins) {
    assert.equal(typeof w.id, 'number');
    assert.equal(typeof w.pid, 'number');
    assert.ok(w.title.length > 0);
  }
});
