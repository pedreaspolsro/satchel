// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Windows backend: talks to user32/kernel32 directly through koffi (prebuilt FFI, no compiler needed).
 * Window ids are HWNDs as plain numbers. Out-parameters are passed as raw Buffers so we never
 * depend on koffi's struct/array marshalling rules.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const koffi = require('koffi');
const { toNum } = require('../util');

// ---- MSYS (git-bash) process links ---------------------------------------------------------
// mintty starts the shell through a fork/exec stub that exits, so the shell's Win32 parent pid is
// dead and the Win32 tree never reaches the mintty window. The MSYS runtime keeps its own table
// with the logical links (`ps -l`: PID PPID PGID WINPID ...), which we use to bridge the gap.
let msysPsPath;
function findMsysPs() {
  if (msysPsPath !== undefined) return msysPsPath;
  const candidates = [
    process.env.SATCHEL_MSYS_PS,
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'usr', 'bin', 'ps.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'ps.exe'),
  ].filter(Boolean);
  msysPsPath = candidates.find((p) => fs.existsSync(p)) || null;
  return msysPsPath;
}

/** Map<winpid, parent winpid> for MSYS processes, from the MSYS process table. */
function msysParents() {
  const ps = findMsysPs();
  if (!ps) return new Map();
  let out;
  try { out = execFileSync(ps, ['-l'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return new Map(); }
  const rows = [];
  const winOfMsys = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/);
    if (!m) continue;
    const r = { pid: Number(m[1]), ppid: Number(m[2]), winpid: Number(m[4]) };
    rows.push(r);
    winOfMsys.set(r.pid, r.winpid);
  }
  const map = new Map();
  for (const r of rows) {
    const parentWin = winOfMsys.get(r.ppid);
    if (parentWin && parentWin !== r.winpid) map.set(r.winpid, parentWin);
  }
  return map;
}

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const shell32 = koffi.load('shell32.dll');

// ---- AppBar (screen-edge reservation, what the taskbar uses) ----------------------------------
const SHAppBarMessage = shell32.func('uintptr_t __stdcall SHAppBarMessage(uint32_t msg, void *data)');
const ABM_NEW = 0, ABM_REMOVE = 1, ABM_QUERYPOS = 2, ABM_SETPOS = 3;
const ABE = { left: 0, top: 1, right: 2, bottom: 3 };
// APPBARDATA on x64: cbSize@0, hWnd@8, uCallbackMessage@16, uEdge@20, rc@24..40, lParam@40 -> 48 bytes
const APPBARDATA_SIZE = 48;
const appBars = new Set();

function appBarData(hwnd, edge, r) {
  const b = Buffer.alloc(APPBARDATA_SIZE);
  b.writeUInt32LE(APPBARDATA_SIZE, 0);
  b.writeBigUInt64LE(BigInt(hwnd), 8);
  b.writeUInt32LE(0, 16); // no callback message: we re-apply on Electron's display events instead
  b.writeUInt32LE(edge, 20);
  if (r) { b.writeInt32LE(r.left, 24); b.writeInt32LE(r.top, 28); b.writeInt32LE(r.right, 32); b.writeInt32LE(r.bottom, 36); }
  return b;
}
const readAppBarRect = (b) => ({ left: b.readInt32LE(24), top: b.readInt32LE(28), right: b.readInt32LE(32), bottom: b.readInt32LE(36) });

const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const GetWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)');
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, void *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, void *pid)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
const PostMessageW = user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, void *rect)');
const keybd_event = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
const AttachThreadInput = user32.func('int __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, int fAttach)');
const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()');

const MonitorEnumProc = koffi.proto('int __stdcall MonitorEnumProc(intptr_t hmon, intptr_t hdc, void *rect, intptr_t lParam)');
const EnumDisplayMonitors = user32.func('int __stdcall EnumDisplayMonitors(intptr_t hdc, void *clip, MonitorEnumProc *cb, intptr_t lParam)');
const GetMonitorInfoW = user32.func('int __stdcall GetMonitorInfoW(intptr_t hmon, void *info)');
const MONITORINFO_SIZE = 40; // cbSize@0, rcMonitor@4, rcWork@20, dwFlags@36

const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, void *buf, void *size)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t h)');
// NB: Win32 BOOL is a 32-bit int — never declare it as koffi's 1-byte `bool` for parameters.
const CreateProcessW = kernel32.func('int __stdcall CreateProcessW(str16 app, void *cmdline, void *pa, void *ta, int32_t inherit, uint32_t flags, void *env, str16 cwd, void *si, void *pi)');
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

const CreateToolhelp32Snapshot = kernel32.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)');
const Process32FirstW = kernel32.func('int __stdcall Process32FirstW(intptr_t snap, void *entry)');
const Process32NextW = kernel32.func('int __stdcall Process32NextW(intptr_t snap, void *entry)');

const TH32CS_SNAPPROCESS = 0x2;
// PROCESSENTRY32W on x64: dwSize@0, th32ProcessID@8, th32ParentProcessID@32, szExeFile@44 (260 WCHARs) -> 568 bytes
const PROCESSENTRY32W_SIZE = 568;
const CREATE_NEW_PROCESS_GROUP = 0x200, CREATE_UNICODE_ENVIRONMENT = 0x400, DETACHED_PROCESS = 0x8;
const STARTUPINFOW_SIZE = 104, PROCESS_INFORMATION_SIZE = 24;

/** Quote one argument the way CommandLineToArgvW / the MS CRT will parse it back. */
function quoteArg(a) {
  a = String(a);
  if (a === '') return '""';
  if (!/[\s"]/.test(a)) return a;
  let out = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === '\\') { bs++; continue; }
    if (ch === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += '\\'.repeat(bs) + ch;
    bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}

/** Windows environment block: "K=V\0K=V\0\0", keys sorted case-insensitively, UTF-16LE. */
function envBlock(env) {
  const keys = Object.keys(env).filter((k) => env[k] != null && !k.startsWith('='));
  keys.sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()));
  return Buffer.from(`${keys.map((k) => `${k}=${env[k]}`).join('\0')}\0\0`, 'utf16le');
}

const GW_OWNER = 4;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const SW_MINIMIZE = 6, SW_RESTORE = 9;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
const HWND_TOP = 0;
const WM_CLOSE = 0x10;
const VK_MENU = 0x12, KEYEVENTF_KEYUP = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function windowTitle(hwnd) {
  const len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return '';
  const buf = Buffer.alloc((len + 1) * 2);
  const n = GetWindowTextW(hwnd, buf, len + 1);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function windowPid(hwnd) {
  const b = Buffer.alloc(4);
  GetWindowThreadProcessId(hwnd, b);
  return b.readUInt32LE(0);
}

/** Electron's `screen` when we run inside Electron; null under plain Node. */
function getScreen() {
  try { const e = require('electron'); return e && typeof e === 'object' ? e.screen : null; } catch { return null; }
}
function dipToScreen(rect) {
  const s = getScreen();
  return s && typeof s.dipToScreenRect === 'function' ? s.dipToScreenRect(null, rect) : rect;
}
function screenToDip(rect) {
  const s = getScreen();
  return s && typeof s.screenToDipRect === 'function' ? s.screenToDipRect(null, rect) : rect;
}

module.exports = {
  name: 'win32',
  capabilities: { list: true, focus: true, move: true, dock: true },

  /**
   * Reserve a screen edge for window `hwnd` (AppBar). `rect` is the requested strip in physical
   * pixels; returns the strip the shell granted (physical pixels) — the caller must move the
   * window there itself. Maximized windows and the work area then stay clear of it.
   */
  reserveEdge(hwnd, edge, rect) {
    const e = ABE[edge];
    if (e === undefined) throw new Error(`Unknown edge "${edge}"`);
    if (!appBars.has(hwnd)) {
      SHAppBarMessage(ABM_NEW, appBarData(hwnd, 0, null));
      appBars.add(hwnd);
    }
    const thickness = edge === 'top' || edge === 'bottom' ? rect.height : rect.width;
    let r = { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
    let b = appBarData(hwnd, e, r);
    SHAppBarMessage(ABM_QUERYPOS, b);
    r = readAppBarRect(b); // the shell may shift us past another appbar/taskbar on the same edge
    if (edge === 'top') r.bottom = r.top + thickness;
    else if (edge === 'bottom') r.top = r.bottom - thickness;
    else if (edge === 'left') r.right = r.left + thickness;
    else r.left = r.right - thickness;
    b = appBarData(hwnd, e, r);
    SHAppBarMessage(ABM_SETPOS, b);
    r = readAppBarRect(b);
    return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  },

  releaseEdge(hwnd) {
    if (!appBars.has(hwnd)) return;
    SHAppBarMessage(ABM_REMOVE, appBarData(hwnd, 0, null));
    appBars.delete(hwnd);
  },

  listWindows() {
    const out = [];
    EnumWindows((h) => {
      const hwnd = toNum(h);
      if (!IsWindowVisible(hwnd)) return true;
      if (toNum(GetWindow(hwnd, GW_OWNER))) return true; // owned popups
      if (toNum(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) return true;
      const title = windowTitle(hwnd).trim(); // Claude pads titles with trailing spaces
      if (!title) return true;
      out.push({ id: hwnd, pid: windowPid(hwnd), title });
      return true;
    }, 0);
    return out;
  },

  processImage(pid) {
    const h = toNum(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
    if (!h) return null;
    try {
      const cap = 1024;
      const buf = Buffer.alloc(cap * 2);
      const size = Buffer.alloc(4);
      size.writeUInt32LE(cap, 0);
      if (!QueryFullProcessImageNameW(h, 0, buf, size)) return null;
      return buf.toString('utf16le', 0, size.readUInt32LE(0) * 2);
    } finally {
      CloseHandle(h);
    }
  },

  /** Physical monitor rects (exact, no DIP rounding): [{ x, y, width, height, work: {...}, primary }]. */
  monitors() {
    const out = [];
    EnumDisplayMonitors(0, null, (h) => {
      const hmon = toNum(h);
      const info = Buffer.alloc(MONITORINFO_SIZE);
      info.writeUInt32LE(MONITORINFO_SIZE, 0);
      if (GetMonitorInfoW(hmon, info)) {
        const r = (o) => ({ x: info.readInt32LE(o), y: info.readInt32LE(o + 4), width: info.readInt32LE(o + 8) - info.readInt32LE(o), height: info.readInt32LE(o + 12) - info.readInt32LE(o + 4) });
        out.push({ ...r(4), work: r(20), primary: !!(info.readUInt32LE(36) & 1) });
      }
      return 1;
    }, 0);
    return out;
  },

  /** Map of pid -> parent pid for every running process (one Toolhelp32 snapshot). */
  processParents() {
    const map = new Map();
    const snap = toNum(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (!snap || snap === -1) return map;
    try {
      const entry = Buffer.alloc(PROCESSENTRY32W_SIZE);
      entry.writeUInt32LE(PROCESSENTRY32W_SIZE, 0);
      let ok = Process32FirstW(snap, entry);
      while (ok) {
        map.set(entry.readUInt32LE(8), entry.readUInt32LE(32));
        ok = Process32NextW(snap, entry);
      }
    } finally {
      CloseHandle(snap);
    }
    return map;
  },

  /**
   * Like processParents(), but where a Win32 parent is dead (not in the snapshot) the logical
   * MSYS parent is substituted, so shells inside git-bash windows lead back to their mintty.
   * Costs one `ps -l` run (~100 ms); use it for hook matching, not for polling.
   */
  processParentsDeep() {
    const map = module.exports.processParents();
    const msys = msysParents();
    for (const [pid, ppid] of map) {
      if (!map.has(ppid) && msys.has(pid)) map.set(pid, msys.get(pid));
    }
    return map;
  },

  focus(hwnd) {
    if (!IsWindow(hwnd)) return false;
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    if (!SetForegroundWindow(hwnd)) {
      // Windows refuses foreground changes from a background process; a synthetic ALT tap unlocks it.
      keybd_event(VK_MENU, 0, 0, 0);
      keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
      SetForegroundWindow(hwnd);
    }
    BringWindowToTop(hwnd);
    return true;
  },

  setBounds(hwnd, rect) {
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    return module.exports.setBoundsPhysical(hwnd, dipToScreen(rect));
  },

  /** Raw SetWindowPos in physical pixels (bypasses Electron, which keeps its windows inside the work area). */
  setBoundsPhysical(hwnd, r) {
    return !!SetWindowPos(hwnd, 0, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height),
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  },

  getBounds(hwnd) {
    const b = Buffer.alloc(16);
    if (!GetWindowRect(hwnd, b)) return null;
    const l = b.readInt32LE(0), t = b.readInt32LE(4), r = b.readInt32LE(8), bo = b.readInt32LE(12);
    return screenToDip({ x: l, y: t, width: r - l, height: bo - t });
  },

  /**
   * Start a detached process WITHOUT handle inheritance. Node's child_process.spawn passes
   * bInheritHandles=TRUE, so a terminal launched that way keeps our stdout pipe open and
   * whoever started Satchel (a script, the CLI) blocks until that terminal window closes.
   */
  spawnDetached({ exe, args = [], cwd, env }) {
    const cmdline = Buffer.from(`${[exe, ...args].map(quoteArg).join(' ')}\0`, 'utf16le');
    const si = Buffer.alloc(STARTUPINFOW_SIZE);
    si.writeUInt32LE(STARTUPINFOW_SIZE, 0);
    const pi = Buffer.alloc(PROCESS_INFORMATION_SIZE);
    const flags = CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS;
    const ok = CreateProcessW(exe, cmdline, null, null, 0 /* bInheritHandles = FALSE */, flags, env ? envBlock(env) : null, cwd || null, si, pi);
    if (!ok) throw new Error(`CreateProcessW failed with Win32 error ${GetLastError()} for ${exe}`);
    CloseHandle(Number(pi.readBigUInt64LE(0)));
    CloseHandle(Number(pi.readBigUInt64LE(8)));
    return { pid: pi.readUInt32LE(16) };
  },

  minimize(hwnd) { ShowWindow(hwnd, SW_MINIMIZE); },
  restore(hwnd) { ShowWindow(hwnd, SW_RESTORE); },
  isMinimized(hwnd) { return !!IsIconic(hwnd); },

  /** Raise to the top of the z-order WITHOUT activating (skips minimized windows). */
  raise(hwnd) {
    if (!IsWindow(hwnd) || IsIconic(hwnd)) return false;
    return !!SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  },

  /**
   * Bring SEVERAL windows to the front together (they are usually separate processes, e.g. one
   * mintty per session). A background process cannot reorder another app's window above the active
   * one, and attaching to a single foreground thread only unlocks that one window — so we force each
   * window to the foreground in turn, re-attaching to whatever is foreground at that moment (the
   * per-window AttachThreadInput + SetForegroundWindow workaround). Ordered oldest -> newest, so the
   * newest ends up focused and on top with the rest stacked just beneath it. Minimized windows are skipped.
   */
  raiseAll(hwnds) {
    const live = hwnds.filter((h) => IsWindow(h) && !IsIconic(h));
    const me = GetCurrentThreadId();
    for (const h of live) {
      const fg = toNum(GetForegroundWindow());
      let t = 0;
      if (fg && fg !== h) { const pb = Buffer.alloc(4); t = GetWindowThreadProcessId(fg, pb); }
      const attached = t && t !== me ? !!AttachThreadInput(me, t, 1) : false;
      try {
        BringWindowToTop(h);
        if (!SetForegroundWindow(h)) {
          keybd_event(VK_MENU, 0, 0, 0);
          keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
          SetForegroundWindow(h);
        }
      } finally {
        if (attached) AttachThreadInput(me, t, 0);
      }
    }
    return live.length;
  },
  close(hwnd) { PostMessageW(hwnd, WM_CLOSE, 0, 0); },
  foreground() { return toNum(GetForegroundWindow()) || null; },

  /** exposed for unit tests */
  _internal: { quoteArg, envBlock },
};
