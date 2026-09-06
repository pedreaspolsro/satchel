// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { startControlServer, controlRequest } = require('../src/main/control');

const PIPE = process.platform === 'win32'
  ? `\\\\.\\pipe\\satchel-test-${process.pid}`
  : path.join(os.tmpdir(), `satchel-test-${process.pid}.sock`);

function fakeManager() {
  return {
    backend: { name: 'fake', capabilities: { list: true } },
    snapshot: () => [{ id: 'abc', label: 'x', hwnd: 7 }],
    launch: (req) => ({ id: 'new', profile: req.profileName, label: req.label, resume: !!req.resume }),
    findId: (ref) => { if (ref !== 'abc') throw new Error(`No session matches "${ref}"`); return 'abc'; },
    focus() {}, close() {},
    tile: () => 2, cascade: () => 1, minimizeGroup: () => 3,
    displays: () => [{ id: 1 }],
  };
}

test('control socket: roundtrip, dispatch errors, and absence of a server', async () => {
  const server = startControlServer(fakeManager(), PIPE);
  await new Promise((r) => server.on('listening', r));

  const list = await controlRequest(PIPE, { cmd: 'list' });
  assert.equal(list.ok, true);
  assert.equal(list.result.pid, process.pid); // proves the reply comes from the server process
  assert.equal(list.result.sessions[0].id, 'abc');

  const launch = await controlRequest(PIPE, { cmd: 'launch', profileName: 'P', label: 'L', resume: true });
  assert.deepEqual(launch, { ok: true, result: { id: 'new', profile: 'P', label: 'L', resume: true } });

  const focused = await controlRequest(PIPE, { cmd: 'focus', ref: 'abc' });
  assert.equal(focused.ok, true);

  const bad = await controlRequest(PIPE, { cmd: 'focus', ref: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /No session matches/);

  const unknown = await controlRequest(PIPE, { cmd: 'wat' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown command/);

  await new Promise((r) => server.close(r));
  assert.equal(await controlRequest(PIPE, { cmd: 'list' }, 750), null); // no GUI -> standalone fallback
});
