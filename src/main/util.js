// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const os = require('os');
const path = require('path');

/** True if a process with this pid exists (EPERM counts as alive). */
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Expand a leading ~ to the home directory. */
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isSymbol(ch) {
  return !!ch && ch.codePointAt(0) > 127 && !/\p{L}|\p{N}/u.test(ch);
}

/**
 * Derive a coarse status from a terminal window title.
 * Claude Code rewrites the title with a leading glyph: "✳ topic" when idle,
 * a spinner frame ("◐ ◓ ◑ ◒") while working. Anything else is 'unknown'
 * (a plain shell, some other program).
 */
function statusFromTitle(title, glyphs = {}) {
  const t = (title || '').trimStart();
  if (!t) return 'unknown';
  const first = Array.from(t)[0];
  if ((glyphs.idle || []).includes(first)) return 'idle';
  if ((glyphs.working || []).includes(first)) return 'working';
  // An unlisted non-ASCII symbol in first position is most likely another spinner frame.
  if (isSymbol(first)) return 'working';
  return 'unknown';
}

/** Strip the leading status glyph (if any) from a title. */
function cleanTitle(title, glyphs = {}) {
  const t = (title || '').trim();
  const first = Array.from(t)[0];
  const all = [...(glyphs.idle || []), ...(glyphs.working || [])];
  if (first && (all.includes(first) || isSymbol(first))) return t.slice(first.length).trim();
  return t;
}

/** Split a work area into an n-cell grid; returns rects in the same units as `area`. */
function gridLayout(n, area) {
  if (n <= 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = Math.floor(area.width / cols);
  const h = Math.floor(area.height / rows);
  const rects = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    rects.push({ x: area.x + c * w, y: area.y + r * h, width: w, height: h });
  }
  return rects;
}

/** Cascade n windows from the top-left of `area`. */
function cascadeLayout(n, area, step = 36, ratio = 0.65) {
  const rects = [];
  const w = Math.floor(area.width * ratio), h = Math.floor(area.height * ratio);
  const room = Math.max(1, Math.min(area.width - w, area.height - h));
  for (let i = 0; i < n; i++) {
    const off = (i * step) % room;
    rects.push({ x: area.x + off, y: area.y + off, width: w, height: h });
  }
  return rects;
}

function toNum(v) { return typeof v === 'bigint' ? Number(v) : v; }

module.exports = { isAlive, expandHome, statusFromTitle, cleanTitle, gridLayout, cascadeLayout, toNum };
