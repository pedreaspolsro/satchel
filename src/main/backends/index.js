// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Window backend abstraction — the ONLY platform-specific layer in Satchel's core.
 *
 * Every backend exports the same surface:
 *
 *   name
 *   capabilities        { list: bool, focus: bool, move: bool }   what really works here
 *   listWindows()       -> [{ id, pid, title }]   top-level, visible, titled windows
 *   processImage(pid)   -> string | null          full path of the process executable
 *   processParents()    -> Map<pid, ppid>         snapshot of the process tree (hook matching)
 *   focus(id)                                     raise + activate
 *   setBounds(id, rect)                           rect in DIP { x, y, width, height }
 *   getBounds(id)       -> rect | null            DIP
 *   minimize(id) / restore(id)
 *   isMinimized(id)     -> bool
 *   close(id)                                     polite close request (WM_CLOSE-like)
 *   foreground()        -> id | null              currently active window
 *   reserveEdge(id, edge, rect) -> rect | null    reserve a screen edge for our own window (dock);
 *                                                 rect in physical px, returns the granted strip
 *   releaseEdge(id)                               undo reserveEdge
 *
 * Window ids are opaque numbers (HWND on Windows, X11 window id on Linux, ...).
 */
function createBackend(platform = process.platform) {
  switch (platform) {
    case 'win32': return require('./win32');
    case 'linux': return require('./linux');
    case 'darwin': return require('./darwin');
    default: return require('./noop');
  }
}

module.exports = { createBackend };
