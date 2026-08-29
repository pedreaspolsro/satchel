// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, Notification, Menu, dialog, Tray, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const config = require('./config');
const store = require('./store');
const { createBackend } = require('./backends');
const { createTerminal } = require('./terminals');
const { SessionManager } = require('./sessions');
const { HookWatcher, hookStatus, installClaudeHooks, uninstallClaudeHooks, migrateHookPath } = require('./hooks');

const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const CLI_FLAGS = ['--list', '--launch', '--focus', '--close', '--tile', '--cascade', '--displays', '--help'];
const cliMode = argv.some((a) => CLI_FLAGS.includes(a));
const argValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

// The hook script Claude Code runs must live at a stable, real path (not inside the packaged
// app, which moves between builds), so we copy it into the data dir at every start.
const HOOK_SOURCE = path.join(__dirname, '..', '..', 'hooks', 'claude-code-hook.js');
const HOOK_SCRIPT = path.join(config.DIR, 'claude-code-hook.js');
const OLD_HOOK_SCRIPT = path.join(config.OLD_DIR, 'claude-code-hook.js'); // ShellMan -> Satchel rename
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const ICON_ATTENTION = path.join(__dirname, '..', '..', 'build', 'icon-attention.png');

let win = null;
let newWin = null;
let tray = null;
let trayAttention = false;
let quitting = false;
let firstShow = true;
let lastDockKey = null;
let dockTarget = null; // DIP rect the docked strip must occupy
let manager = null;
let hooks = null;
let cfg = null;

app.setAppUserModelId('sk.pedrea.satchel');
if (!cliMode && !app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  cfg = config.load();
  ensureHookScript();
  // ShellMan -> Satchel: repoint any hooks that still call the old ~/.shellman script.
  try { migrateHookPath(claudeConfigDirs(), OLD_HOOK_SCRIPT, HOOK_SCRIPT); } catch (e) { console.error('[satchel] hook migration:', e.message); }
  const backend = createBackend();
  manager = new SessionManager({ config: cfg, backend, terminal: createTerminal(cfg.terminal, backend), store, screen });
  manager.on('error', (e) => console.error('[satchel]', e));
  if (cliMode) return runCli(backend);

  hooks = new HookWatcher(config.EVENTS_FILE, (ev) => {
    const matched = manager.applyHookEvent(ev);
    console.log(`[satchel] hook ${ev.event} ${matched ? 'matched' : 'unmatched'} (satchelId=${ev.satchelId || '-'} ppid=${ev.ppid || '-'} configDir=${ev.configDir || '-'})`);
  });
  hooks.start();
  createWindow();
  createTray();
  registerIpc();
  manager.on('update', (list) => {
    if (win && !win.isDestroyed()) win.webContents.send('sessions:update', list);
    updateTray(list);
  });
  manager.on('attention', notifyAttention);
  manager.start();
  registerHotkey();
  screen.on('display-metrics-changed', () => reapplyDockIfNeeded());
  screen.on('display-added', () => reapplyDockIfNeeded());
  screen.on('display-removed', () => reapplyDockIfNeeded());
  setInterval(verifyDock, 3000); // safety net: keep the docked strip exactly on its edge
});

// A second launch focuses the running panel; `Satchel.exe --quit` (or satchel.bat --quit) stops it.
app.on('second-instance', (_e, argv2) => {
  if (argv2.includes('--quit')) return quitApp();
  showWindow();
});

app.on('window-all-closed', () => { if (quitting || !tray) { shutdown(); app.quit(); } });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', shutdown);

function quitApp() {
  quitting = true;
  app.quit();
}

function shutdown() {
  releaseDock();
  if (manager) { manager.stop(); manager.persist(); }
  if (hooks) hooks.stop();
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
}

function ensureHookScript() {
  try {
    fs.mkdirSync(config.DIR, { recursive: true });
    const src = fs.readFileSync(HOOK_SOURCE);
    if (!fs.existsSync(HOOK_SCRIPT) || !src.equals(fs.readFileSync(HOOK_SCRIPT))) fs.writeFileSync(HOOK_SCRIPT, src);
  } catch (e) { console.error('[satchel] cannot install hook script:', e.message); }
}

/** Every Claude config dir we know about: from profiles' CLAUDE_CONFIG_DIR plus ~/.claude. */
function claudeConfigDirs() {
  const dirs = [];
  for (const p of cfg.profiles || []) if (p.env && p.env.CLAUDE_CONFIG_DIR) dirs.push(p.env.CLAUDE_CONFIG_DIR);
  const home = path.join(os.homedir(), '.claude');
  if (fs.existsSync(home)) dirs.push(home);
  const seen = new Set();
  return dirs.filter((d) => { const k = path.resolve(d).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---- window (panel or docked strip) ------------------------------------------------------------

/** Persisted dock state: { edge: 'top'|'bottom'|'left'|'right', displayId } or null (floating panel). */
function dockState() {
  const s = store.loadState();
  return s.dock && s.dock.edge ? s.dock : null;
}
const dockThickness = () => Number((cfg.dock && cfg.dock.height) || 40);
function dockDisplay(dock) {
  const displays = screen.getAllDisplays();
  return displays.find((d) => d.id === (dock && dock.displayId)) || screen.getPrimaryDisplay();
}
/** Requested strip for the dock, in DIP. */
function dockRect(dock) {
  const d = dockDisplay(dock);
  const t = dockThickness();
  const b = d.bounds;
  switch (dock.edge) {
    case 'bottom': return { x: b.x, y: b.y + b.height - t, width: b.width, height: t };
    case 'left': return { x: b.x, y: b.y, width: t, height: b.height };
    case 'right': return { x: b.x + b.width - t, y: b.y, width: t, height: b.height };
    default: return { x: b.x, y: b.y, width: b.width, height: t };
  }
}
function hwndOf(w) {
  const b = w.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

function createWindow() {
  const dock = dockState();
  const state = store.loadState();
  const common = {
    title: 'Satchel',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#1a1d23',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (dock) {
    const r = dockRect(dock);
    win = new BrowserWindow({
      ...common, ...r, minWidth: 100, minHeight: 24,
      frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      thickFrame: false, // no invisible Win32 resize border, so the strip sits flush with the screen edge
      skipTaskbar: true, alwaysOnTop: true, type: 'toolbar',
    });
  } else {
    const bounds = validBounds(state.bounds) || { width: 560, height: 640 };
    win = new BrowserWindow({ ...common, ...bounds, minWidth: 380, minHeight: 320, alwaysOnTop: state.alwaysOnTop ?? cfg.alwaysOnTop });
  }
  const me = win;
  me.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  me.once('ready-to-show', () => {
    const hidden = firstShow && cfg.startMinimized;
    firstShow = false;
    if (hidden) return;
    me.show();
    if (dock) applyDock();
  });
  me.webContents.once('did-finish-load', () => console.log(`[satchel] renderer loaded (${dock ? `docked ${dock.edge}` : 'panel'})`));
  // Surface renderer problems on the main process' stderr (works with both the old positional
  // and the new event-object signature of 'console-message').
  me.webContents.on('console-message', (e, ...rest) => {
    const level = e && e.level !== undefined ? e.level : rest[0];
    const message = e && e.message !== undefined ? e.message : rest[1];
    const line = e && e.lineNumber !== undefined ? e.lineNumber : rest[2];
    const source = e && e.sourceId !== undefined ? e.sourceId : rest[3];
    if (level === 'error' || level === 'warning' || level >= 2) console.error(`[renderer:${level}] ${message} (${source}:${line})`);
  });
  me.webContents.on('preload-error', (_e, p, err) => console.error('[preload]', p, err));

  if (!dock) {
    const saveState = debounce(() => {
      if (me.isDestroyed()) return;
      store.saveState({ ...store.loadState(), bounds: me.getBounds(), alwaysOnTop: me.isAlwaysOnTop() });
    }, 400);
    me.on('resize', saveState);
    me.on('move', saveState);
    me.on('close', (e) => { saveState.flush(); onClose(e, me); });
  } else {
    me.on('close', (e) => onClose(e, me));
  }
  me.on('closed', () => { if (win === me) win = null; });

  // Dev aid: --screenshot <file> captures the panel after --screenshot-delay ms (default 2500);
  // --screenshot-every <ms> keeps overwriting the file at that interval.
  const shot = argValue('--screenshot');
  if (shot) {
    const capture = () => win && !win.isDestroyed() && win.webContents.capturePage()
      .then((img) => { fs.writeFileSync(shot, img.toPNG()); console.log(`[satchel] screenshot saved to ${shot} at ${new Date().toISOString().slice(11, 23)}`); })
      .catch((err) => console.error('[satchel] screenshot failed:', err.message));
    setTimeout(capture, Number(argValue('--screenshot-delay')) || 2500);
    const every = Number(argValue('--screenshot-every'));
    if (every > 0) setInterval(capture, every);
  }
}

/** Close = hide to tray (unless quitting or closeToTray is off). */
function onClose(e, w) {
  if (quitting || cfg.closeToTray === false || !tray) return;
  e.preventDefault();
  releaseDock();
  w.hide();
  const state = store.loadState();
  if (!state.trayHintShown) {
    store.saveState({ ...state, trayHintShown: true });
    try { tray.displayBalloon({ title: 'Satchel keeps running in the tray', content: 'Click the tray icon to reopen it; right-click to quit.', iconType: 'info' }); } catch { /* not supported */ }
  }
}

function validBounds(b) {
  if (!b || !(b.width > 0) || !(b.height > 0)) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const r = d.bounds;
    return b.x < r.x + r.width && b.x + b.width > r.x && b.y < r.y + r.height && b.y + b.height > r.y;
  });
  return visible ? b : null;
}

function debounce(fn, ms) {
  let t = null;
  const d = () => { clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = null; } fn(); };
  return d;
}

// The shared "New session" dialog (Profile / Folder / Label), opened by "+ New" and Ctrl+N in both modes.
function openNewSession() {
  if (newWin && !newWin.isDestroyed()) { newWin.show(); newWin.focus(); return; }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = 400, h = 216;
  newWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(d.workArea.x + (d.workArea.width - w) / 2),
    y: Math.round(d.workArea.y + (d.workArea.height - h) / 2),
    title: 'New session',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    parent: win && !win.isDestroyed() ? win : undefined,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#1a1d23',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  newWin.loadFile(path.join(__dirname, '..', 'renderer', 'new.html'));
  newWin.once('ready-to-show', () => { newWin.show(); newWin.focus(); });
  newWin.on('closed', () => { newWin = null; });
}

function closeNewSession() {
  if (newWin && !newWin.isDestroyed()) newWin.close();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (dockState()) applyDock();
}

function hideWindow() {
  if (!win) return;
  releaseDock();
  win.hide();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) { hideWindow(); return; }
  showWindow();
}

// Dock geometry is done in physical pixels end to end (monitor rect -> strip -> AppBar -> SetWindowPos)
// so DIP rounding at 125%/150% scaling cannot leave a 1-2 px gap or overshoot.
const toPhys = (r) => (screen.dipToScreenRect ? screen.dipToScreenRect(win, r) : r);
const toDip = (r) => (screen.screenToDipRect ? screen.screenToDipRect(win, r) : r);
/** Exact physical rect of an Electron display: the backend's monitor list when available (no DIP rounding). */
function physicalMonitor(d) {
  const approx = toPhys(d.bounds);
  if (typeof manager.backend.monitors !== 'function') return approx;
  let best = null, bestArea = 0;
  for (const m of manager.backend.monitors()) {
    const w = Math.min(approx.x + approx.width, m.x + m.width) - Math.max(approx.x, m.x);
    const h = Math.min(approx.y + approx.height, m.y + m.height) - Math.max(approx.y, m.y);
    const area = w > 0 && h > 0 ? w * h : 0;
    if (area > bestArea) { bestArea = area; best = m; }
  }
  return best ? { x: best.x, y: best.y, width: best.width, height: best.height } : approx;
}

function stripOf(edge, m, t) {
  switch (edge) {
    case 'bottom': return { x: m.x, y: m.y + m.height - t, width: m.width, height: t };
    case 'left': return { x: m.x, y: m.y, width: t, height: m.height };
    case 'right': return { x: m.x + m.width - t, y: m.y, width: t, height: m.height };
    default: return { x: m.x, y: m.y, width: m.width, height: t };
  }
}

/** Put the docked strip on its edge and reserve that edge (Windows: AppBar). */
function applyDock() {
  const dock = dockState();
  if (!dock || !win || win.isDestroyed()) return;
  const d = dockDisplay(dock);
  const monitor = physicalMonitor(d);
  const requested = stripOf(dock.edge, monitor, Math.round(dockThickness() * d.scaleFactor));
  let strip = requested;
  if (typeof manager.backend.reserveEdge === 'function') {
    try { strip = manager.backend.reserveEdge(hwndOf(win), dock.edge, requested) || requested; }
    catch (e) { console.error('[satchel] dock:', e.message); }
  }
  dockTarget = strip; // physical px
  placeDock();
  win.setAlwaysOnTop(true);
  console.log(`[satchel] dock ${dock.edge} on display ${d.id} (${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}): requested ${JSON.stringify(requested)} -> granted ${JSON.stringify(strip)} (physical) -> window ${JSON.stringify(win.getBounds())} (DIP)`);
  lastDockKey = `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}@${d.scaleFactor}:${dock.edge}:${dockThickness()}`;
  // Reserving the edge changes the work area, and Chromium answers that by nudging its windows back
  // inside the new work area (out of our own band). Re-check shortly after, and periodically.
  setTimeout(verifyDock, 300);
  setTimeout(verifyDock, 1500);
}

/** Move the strip to dockTarget with raw Win32 (Electron's setBounds keeps windows inside the work area). */
function placeDock() {
  if (!dockTarget || !win || win.isDestroyed()) return;
  if (typeof manager.backend.setBoundsPhysical === 'function') manager.backend.setBoundsPhysical(hwndOf(win), dockTarget);
  else win.setBounds(toDip(dockTarget));
}

function verifyDock() {
  if (!dockTarget || !win || win.isDestroyed() || !win.isVisible()) return;
  const cur = toPhys(win.getBounds());
  const tol = 2; // physical px, allows for DIP rounding in getBounds()
  const off = Math.abs(cur.x - dockTarget.x) > tol || Math.abs(cur.y - dockTarget.y) > tol
    || Math.abs(cur.width - dockTarget.width) > tol || Math.abs(cur.height - dockTarget.height) > tol;
  if (off) {
    console.log(`[satchel] dock drifted to ${JSON.stringify(cur)}, re-placing at ${JSON.stringify(dockTarget)}`);
    placeDock();
  }
}

function releaseDock() {
  dockTarget = null;
  if (!win || win.isDestroyed() || !manager || typeof manager.backend.releaseEdge !== 'function') return;
  try { manager.backend.releaseEdge(hwndOf(win)); } catch { /* ignore */ }
  lastDockKey = null;
}

/** Display geometry changed (monitor plugged, DPI, resolution): move the strip if its display moved. */
function reapplyDockIfNeeded() {
  const dock = dockState();
  if (!dock || !win || win.isDestroyed() || !win.isVisible()) return;
  const d = dockDisplay(dock);
  const key = `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}@${d.scaleFactor}:${dock.edge}:${dockThickness()}`;
  if (key !== lastDockKey) applyDock();
  else setTimeout(verifyDock, 200); // work-area-only change (taskbar moved/auto-hid): Chromium may have nudged us
}

/** Switch between floating panel (edge null/'none') and docked strip. Recreates the window. */
function setDock(edge, displayId) {
  const state = store.loadState();
  const valid = ['top', 'bottom', 'left', 'right'];
  if (!edge || edge === 'none') {
    releaseDock();
    store.saveState({ ...state, dock: null });
  } else {
    if (!valid.includes(edge)) throw new Error(`Unknown dock edge "${edge}"`);
    releaseDock();
    store.saveState({ ...state, dock: { edge, displayId: displayId ?? (state.dock && state.dock.displayId) ?? null } });
  }
  const old = win;
  win = null;
  if (old && !old.isDestroyed()) { old.removeAllListeners('close'); old.destroy(); }
  createWindow();
  refreshTrayMenu();
  return dockState();
}

function registerHotkey() {
  if (!cfg.hotkey) return;
  try {
    if (!globalShortcut.register(cfg.hotkey, toggleWindow)) console.warn(`[satchel] hotkey ${cfg.hotkey} is taken`);
  } catch (e) { console.warn('[satchel] hotkey:', e.message); }
}

function notifyAttention(s) {
  if (!cfg.notifications || !Notification.isSupported()) return;
  const who = s.label || s.cleanTitle || s.profile || `pid ${s.pid}`;
  const n = new Notification({ title: `${who} — ${s.note || 'waiting for you'}`, body: `${s.group} · ${s.cleanTitle || s.title}` });
  n.on('click', () => { try { manager.focus(s.id); } catch { /* window may be gone */ } });
  n.show();
}

// ---- tray ---------------------------------------------------------------------------------------

function trayImage(attention) {
  const file = attention && fs.existsSync(ICON_ATTENTION) ? ICON_ATTENTION : ICON;
  return fs.existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
}

function createTray() {
  try {
    tray = new Tray(trayImage(false));
  } catch (e) {
    console.error('[satchel] tray unavailable:', e.message);
    tray = null;
    return;
  }
  tray.setToolTip('Satchel');
  tray.on('click', toggleWindow);
  tray.on('double-click', showWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const safe = (fn) => () => { try { fn(); } catch (e) { console.error('[satchel]', e.message); } };
  const dock = dockState();
  const profiles = (cfg.profiles || []).map((p) => ({ label: p.name, click: safe(() => manager.launch({ profileName: p.name })) }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Satchel', click: showWindow },
    { label: 'New session', submenu: profiles.length ? profiles : [{ label: '(no profiles configured)', enabled: false }] },
    { type: 'separator' },
    {
      label: 'Dock',
      submenu: [
        { label: 'Floating panel', type: 'radio', checked: !dock, click: safe(() => setDock('none')) },
        { label: 'Top of screen', type: 'radio', checked: !!dock && dock.edge === 'top', click: safe(() => setDock('top')) },
        { label: 'Bottom of screen', type: 'radio', checked: !!dock && dock.edge === 'bottom', click: safe(() => setDock('bottom')) },
      ],
    },
    { label: 'Tile all windows', click: safe(() => manager.tile('All')) },
    { label: 'Minimize all windows', click: safe(() => manager.minimizeGroup('All')) },
    { type: 'separator' },
    { label: 'Quit Satchel', click: quitApp },
  ]));
}

function updateTray(list) {
  if (!tray) return;
  const need = list.filter((s) => s.attention).length;
  const working = list.filter((s) => s.status === 'working' && !s.attention).length;
  tray.setToolTip(`Satchel — ${list.length} session${list.length === 1 ? '' : 's'}, ${working} working${need ? `, ${need} need you` : ''}`);
  if ((need > 0) !== trayAttention) {
    trayAttention = need > 0;
    tray.setImage(trayImage(trayAttention));
  }
}

// ---- ipc ----------------------------------------------------------------------------------------

const publicConfig = () => ({
  groups: cfg.groups, profiles: cfg.profiles, defaultGroup: cfg.defaultGroup, hotkey: cfg.hotkey, statusGlyphs: cfg.statusGlyphs, dock: cfg.dock, raiseGroupOnSelect: cfg.raiseGroupOnSelect,
});

function appInfo() {
  return {
    platform: process.platform,
    backend: manager.backend.name,
    capabilities: manager.backend.capabilities,
    configFile: config.FILE,
    eventsFile: config.EVENTS_FILE,
    hookScript: HOOK_SCRIPT,
    hotkey: cfg.hotkey,
    version: app.getVersion(),
    dock: dockState(),
  };
}

function registerIpc() {
  const h = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => fn(...args));
  h('sessions:get', () => manager.snapshot());
  h('sessions:launch', (req) => manager.launch(req));
  h('ui:newSession', () => openNewSession());
  h('ui:newSessionDone', () => closeNewSession());
  h('sessions:focus', (id) => manager.focus(id));
  h('sessions:rename', (id, label) => manager.rename(id, label));
  h('sessions:setGroup', (id, group) => manager.setGroup(id, group));
  h('sessions:close', (id) => manager.close(id));
  h('sessions:minimize', (id) => manager.minimize(id));
  h('sessions:restore', (id) => manager.restore(id));
  h('sessions:forget', (id) => manager.forget(id));
  h('sessions:tile', (group, displayId) => manager.tile(group, displayId));
  h('sessions:cascade', (group, displayId) => manager.cascade(group, displayId));
  h('sessions:minimizeGroup', (group) => manager.minimizeGroup(group));
  h('sessions:raiseGroup', (group) => manager.raiseGroup(group));
  h('sessions:contextMenu', (id) => showContextMenu(id));
  h('config:get', () => publicConfig());
  h('config:open', () => shell.openPath(config.FILE));
  h('config:reload', () => {
    cfg = config.load();
    manager.setConfig(cfg);
    manager.setTerminal(createTerminal(cfg.terminal, manager.backend));
    globalShortcut.unregisterAll();
    registerHotkey();
    refreshTrayMenu();
    if (dockState()) applyDock();
    return publicConfig();
  });
  h('displays:get', () => manager.displays());
  h('window:setAlwaysOnTop', (v) => { win.setAlwaysOnTop(!!v); return win.isAlwaysOnTop(); });
  h('window:getAlwaysOnTop', () => win.isAlwaysOnTop());
  h('window:setDock', (edge, displayId) => setDock(edge, displayId));
  h('dialog:pickDir', async (def) => {
    const parent = BrowserWindow.getFocusedWindow() || win; // parent to the New-session popup when it's up
    const r = await dialog.showOpenDialog(parent, { properties: ['openDirectory'], defaultPath: def || undefined });
    return r.canceled ? null : r.filePaths[0];
  });
  h('app:info', () => appInfo());
  h('hooks:status', () => hookStatus(claudeConfigDirs(), HOOK_SCRIPT));
  h('hooks:install', async () => {
    const dirs = claudeConfigDirs();
    const status = hookStatus(dirs, HOOK_SCRIPT);
    if (status.length && status.every((s) => s.installed)) {
      // Everything is wired: show the status and offer removal instead of re-installing.
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['Close', 'Remove hooks'],
        defaultId: 0,
        cancelId: 0,
        title: 'Claude Code hooks',
        message: `Hooks are installed in all ${status.length} config dir${status.length === 1 ? '' : 's'}.`,
        detail: `${status.map((s) => `✓ ${s.settingsFile}`).join('\n')}\n\nHook script: ${HOOK_SCRIPT}\n\n"Remove hooks" takes Satchel's entries out again and leaves your other hooks untouched.`,
      });
      if (response !== 1) return { cancelled: true };
      return { removed: uninstallClaudeHooks(dirs, HOOK_SCRIPT) };
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Install', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Install Claude Code hooks',
      message: 'Add the Satchel hook to Claude Code settings?',
      detail: `This merges SessionStart / UserPromptSubmit / Notification / Stop command hooks into settings.json in:\n\n${dirs.join('\n')}\n\nExisting hooks are kept; a one-time backup (settings.json.satchel-backup) is written. Hooks run "node", so node must be on PATH for Claude Code.`,
    });
    if (response !== 0) return { cancelled: true };
    return { results: installClaudeHooks(dirs, HOOK_SCRIPT) };
  });
}

function showContextMenu(id) {
  const s = manager.get(id);
  if (!s || !win) return;
  const safe = (fn) => () => { try { fn(); } catch (e) { console.error('[satchel]', e.message); } };
  const template = [
    { label: 'Focus', enabled: s.hwnd != null, click: safe(() => manager.focus(id)) },
    { label: 'Rename…', click: () => win.webContents.send('sessions:startRename', id) },
    {
      label: 'Move to group',
      submenu: manager.groupNames().map((g) => ({ label: g, type: 'radio', checked: g === s.group, click: safe(() => manager.setGroup(id, g)) })),
    },
    { type: 'separator' },
    s.minimized
      ? { label: 'Restore', enabled: s.hwnd != null, click: safe(() => manager.restore(id)) }
      : { label: 'Minimize', enabled: s.hwnd != null, click: safe(() => manager.minimize(id)) },
    { label: 'Close window…', enabled: s.hwnd != null, click: safe(() => manager.close(id)) },
    { label: 'Forget (stop tracking)', click: safe(() => manager.forget(id)) },
    { type: 'separator' },
    { label: `pid ${s.pid} · hwnd ${s.hwnd ?? '-'}${s.claudeSessionId ? ' · claude ' + s.claudeSessionId.slice(0, 8) : ''}`, enabled: false },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
}

// ---- cli (development / scripting) ---------------------------------------------------------------

async function runCli(backend) {
  const out = (o) => new Promise((r) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`, r));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 250)); } };
  try {
    manager.poll();
    if (argv.includes('--list')) {
      await out({ backend: backend.name, capabilities: backend.capabilities, sessions: manager.snapshot() });
    } else if (argv.includes('--launch')) {
      const s = manager.launch({ profileName: argValue('--launch'), cwd: argValue('--cwd'), label: argValue('--label') });
      const attached = await waitFor(() => { manager.poll(); const x = manager.snapshot().find((v) => v.id === s.id); return x && x.hwnd ? x : null; }, 15000);
      await out(attached || { ...s, warning: 'window not detected within 15s' });
    } else if (argv.includes('--focus')) {
      manager.focus(manager.findId(argValue('--focus')));
      await out({ ok: true });
    } else if (argv.includes('--close')) {
      manager.close(manager.findId(argValue('--close')));
      await out({ ok: true });
    } else if (argv.includes('--tile')) {
      await out({ tiled: manager.tile(argValue('--tile'), Number(argValue('--display')) || undefined) });
    } else if (argv.includes('--cascade')) {
      await out({ cascaded: manager.cascade(argValue('--cascade'), Number(argValue('--display')) || undefined) });
    } else if (argv.includes('--displays')) {
      await out(manager.displays());
    } else {
      await out({ usage: 'Satchel [--list | --launch <profile> [--cwd dir] [--label text] | --focus <id|pid> | --close <id|pid> | --tile <group|All> [--display id] | --cascade <group|All> | --displays | --quit]' });
    }
    manager.persist();
    app.exit(0);
  } catch (e) {
    process.stderr.write(`${e.stack || e}\n`);
    app.exit(1);
  }
}
