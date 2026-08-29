// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Linux (X11) backend — EXPERIMENTAL / UNTESTED. Shells out to wmctrl + xdotool (EWMH).
 * On Wayland there is no portable way to enumerate or move other apps' windows; this backend
 * degrades to status-only mode there (listWindows returns []).
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

function run(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}
function has(cmd) { return run('which', [cmd]) !== null; }

const available = process.env.XDG_SESSION_TYPE !== 'wayland' && has('wmctrl') && has('xdotool');
if (!available) console.warn('[satchel] linux backend: wmctrl/xdotool missing or Wayland session - window ops disabled');

module.exports = {
  name: 'linux-x11',
  capabilities: { list: available, focus: available, move: available, dock: false },
  reserveEdge: () => null, // TODO: _NET_WM_STRUT_PARTIAL via xprop would reserve the edge on X11
  releaseEdge: () => {},
  listWindows() {
    const out = available ? run('wmctrl', ['-lp']) : null;
    if (!out) return [];
    return out.split('\n').filter(Boolean).map((line) => {
      // 0x04a00003  0 12345 host  The title
      const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s*(.*)$/i);
      if (!m) return null;
      return { id: parseInt(m[1], 16), pid: Number(m[3]), title: m[5] };
    }).filter((w) => w && w.title);
  },
  processImage(pid) { try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return null; } },
  processParents() {
    const map = new Map();
    let dirs = [];
    try { dirs = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return map; }
    for (const d of dirs) {
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // state ppid ...
        map.set(Number(d), Number(after[1]));
      } catch { /* process vanished */ }
    }
    return map;
  },
  focus(id) { run('wmctrl', ['-i', '-a', String(id)]); },
  setBounds(id, r) { run('wmctrl', ['-i', '-r', String(id), '-e', `0,${r.x},${r.y},${r.width},${r.height}`]); },
  getBounds() { return null; },
  minimize(id) { run('xdotool', ['windowminimize', String(id)]); },
  restore(id) { run('xdotool', ['windowactivate', String(id)]); },
  raise(id) { run('xdotool', ['windowraise', String(id)]); return true; },
  isMinimized() { return false; },
  close(id) { run('wmctrl', ['-i', '-c', String(id)]); },
  foreground() { const o = run('xdotool', ['getactivewindow']); return o ? Number(o.trim()) : null; },
};
