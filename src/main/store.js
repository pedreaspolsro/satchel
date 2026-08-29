// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const fs = require('fs');
const path = require('path');
const { DIR } = require('./config');

const SESSIONS = path.join(DIR, 'sessions.json');
const STATE = path.join(DIR, 'state.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = {
  loadSessions: () => { const v = readJson(SESSIONS, []); return Array.isArray(v) ? v : []; },
  saveSessions: (list) => writeJson(SESSIONS, list),
  loadState: () => readJson(STATE, {}),
  saveState: (state) => writeJson(STATE, state),
};
