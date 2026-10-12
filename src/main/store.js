// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const fs = require('fs');
const path = require('path');
const { DIR } = require('./config');

const SESSIONS = path.join(DIR, 'sessions.json');
const STATE = path.join(DIR, 'state.json');
const NAMES = path.join(DIR, 'names.json'); // per Claude session id: label / group / title (survives window restarts)
const CLOSED = path.join(DIR, 'closed.json'); // recently closed windows, newest last (what "reopen" brings back)

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
  /** When the session list was last written — about when the previous run stopped tracking. */
  sessionsSavedAt: () => { try { return fs.statSync(SESSIONS).mtimeMs; } catch { return null; } },
  loadClosed: () => { const v = readJson(CLOSED, []); return Array.isArray(v) ? v : []; },
  saveClosed: (list) => writeJson(CLOSED, list),
  loadState: () => readJson(STATE, {}),
  saveState: (state) => writeJson(STATE, state),
  loadNames: () => { const v = readJson(NAMES, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; },
  saveNames: (names) => writeJson(NAMES, names),
};
