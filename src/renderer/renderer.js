// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
(() => {
  const api = window.satchel;
  const $ = (sel) => document.querySelector(sel);
  const state = {
    sessions: [], config: { groups: [], profiles: [], defaultGroup: 'Other', dock: { edge: 'top' } }, info: {}, displays: [],
    tab: 'All', editingId: null, pinned: false, displayId: null, error: null, docked: null,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDur = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  };
  const showErr = (e) => {
    state.error = e && e.message ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e);
    renderFooter();
    setTimeout(() => { state.error = null; renderFooter(); }, 6000);
  };
  const flash = (html, ms = 8000) => { $('#footer').innerHTML = html; if (ms) setTimeout(renderFooter, ms); };

  function groupsInUse() {
    const names = state.config.groups.map((g) => g.name);
    for (const s of state.sessions) if (s.group && !names.includes(s.group)) names.push(s.group);
    return names;
  }
  const groupColor = (name) => (state.config.groups.find((g) => g.name === name) || {}).color || '#8b95a5';
  const visible = () => (state.tab === 'All' ? state.sessions : state.sessions.filter((s) => s.group === state.tab));

  function statusText(s) {
    const since = fmtDur(Date.now() - (s.statusSince || Date.now()));
    if (s.pending) return 'starting…';
    if (s.attention) return `needs you · ${since}`;
    if (s.status === 'working') return `working · ${since}`;
    if (s.status === 'idle') return `idle · ${since}`;
    return 'shell';
  }
  const rowClass = (s) => ['row', s.attention ? 'attention' : '', s.status, s.minimized ? 'minimized' : '', s.pending ? 'pending' : '', s.focused ? 'focused' : ''].filter(Boolean).join(' ');
  const chipClass = (s) => rowClass(s).replace(/^row/, 'chip');
  // Claude's topic: the live title while Claude runs (follows /rename instantly), otherwise the last
  // session title the hooks reported (survives Claude exiting to the shell prompt).
  const topic = (s) => (s.status !== 'unknown' && s.cleanTitle) || s.sessionTitle || '';
  const displayLabel = (s) => s.label || topic(s) || s.cleanTitle || s.profile || `pid ${s.pid}`;

  // ---- tabs (shared by panel and dock) --------------------------------------------------

  function tabsHtml() {
    const tabs = ['All', ...groupsInUse()];
    if (!tabs.includes(state.tab)) state.tab = 'All';
    return tabs.map((t) => {
      const list = t === 'All' ? state.sessions : state.sessions.filter((s) => s.group === t);
      const att = list.filter((s) => s.attention).length;
      return `<button class="tab${t === state.tab ? ' active' : ''}" data-tab="${esc(t)}">`
        + (t !== 'All' ? `<i class="dot" style="background:${esc(groupColor(t))}"></i>` : '')
        + `${esc(t)} <span class="count">${list.length}</span>${att ? `<span class="att">${att}</span>` : ''}</button>`;
    }).join('');
  }

  // ---- panel rendering ------------------------------------------------------------------

  function renderList() {
    const list = visible();
    if (!list.length) {
      $('#list').innerHTML = `<div class="empty">No sessions${state.tab !== 'All' ? ` in <b>${esc(state.tab)}</b>` : ''}.<br>Press <b>+ New</b> to launch one, or open a terminal — Satchel adopts it automatically.</div>`;
      return;
    }
    $('#list').innerHTML = list.map((s, i) => {
      const label = displayLabel(s);
      const sub = s.label ? (topic(s) || s.cleanTitle) : (s.profile || '');
      const exe = s.exe ? s.exe.replace(/\.exe$/i, '') : '';
      return `<div class="${rowClass(s)}" data-id="${esc(s.id)}" style="--c:${esc(s.color)}" tabindex="0">
        <div class="bar"></div>
        <div class="body">
          <div class="l1"><i class="st"></i><span class="label">${esc(label)}</span>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}<span class="grow"></span><span class="status">${esc(statusText(s))}</span></div>
          <div class="l2">${esc(sub)}</div>
          <div class="l3">${s.note ? `<span class="note">${esc(s.note)}</span>` : ''}<span class="meta">${esc(s.group)}${s.cwd ? ` · ${esc(s.cwd)}` : ''}${exe ? ` · ${esc(exe)}` : ''} · ${s.pid}</span></div>
        </div>
        <div class="actions">
          <button class="icon" data-act="rename" title="Rename (F2)">✎</button>
          <button class="icon" data-act="min" title="Minimize">–</button>
          <button class="icon" data-act="menu" title="More">⋯</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderFooter() {
    if (state.docked) return;
    const all = state.sessions;
    const n = (f) => all.filter(f).length;
    const parts = [
      `${all.length} session${all.length === 1 ? '' : 's'}`,
      `${n((s) => s.status === 'working' && !s.attention)} working`,
      `${n((s) => s.attention)} need you`,
    ];
    if (state.info.hotkey) parts.push(`toggle: ${state.info.hotkey.replace('CommandOrControl', 'Ctrl')}`);
    if (state.info.capabilities && !state.info.capabilities.list) parts.push(`status-only mode (${state.info.backend})`);
    $('#footer').innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join('') + (state.error ? `<span class="grow"></span><span class="err" title="${esc(state.error)}">⚠ ${esc(state.error)}</span>` : '');
  }

  // ---- dock rendering -------------------------------------------------------------------

  function renderDock() {
    $('#dock-tabs').innerHTML = tabsHtml();
    const list = visible();
    if (!list.length) {
      $('#dock-chips').innerHTML = `<span class="dock-empty">No sessions${state.tab !== 'All' ? ` in ${esc(state.tab)}` : ''}</span>`;
    } else {
      $('#dock-chips').innerHTML = list.map((s, i) => {
        const tip = [statusText(s), topic(s) || s.cleanTitle || s.title, s.group, s.cwd, s.note].filter(Boolean).join('\n');
        return `<div class="${chipClass(s)}" data-id="${esc(s.id)}" style="--c:${esc(s.color)}" title="${esc(tip)}" tabindex="0">`
          + `<span class="bar"></span><i class="st"></i><span class="label">${esc(displayLabel(s))}</span>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}</div>`;
      }).join('');
    }
  }

  function render() {
    if (state.editingId) return; // don't blow away the rename input
    if (state.docked) { renderDock(); return; }
    $('#tabs').innerHTML = tabsHtml();
    renderList();
    renderFooter();
  }

  async function refresh() { state.sessions = await api.getSessions(); render(); }

  async function refreshHookStatus() {
    try {
      const st = await api.hookStatus();
      const done = st.filter((x) => x.installed).length;
      const title = st.length
        ? `Claude Code hooks installed in ${done} of ${st.length} config dirs:\n${st.map((x) => `${x.installed ? '✓' : '✗'} ${x.dir}`).join('\n')}\n\nClick to install / remove (precise "needs you" events + automatic grouping by account).`
        : 'No Claude config dirs found in profiles';
      const btn = $('#btn-hooks');
      if (btn) {
        btn.classList.toggle('on', st.length > 0 && done === st.length);
        btn.textContent = st.length ? `Hooks ${done}/${st.length}` : 'Hooks';
        btn.title = title;
      }
    } catch (e) { showErr(e); }
  }

  async function hooksClick() {
    try {
      const r = await api.installHooks();
      if (r.cancelled) return;
      if (r.removed) {
        const n = r.removed.filter((x) => x.removed).length;
        flash(`<span>Hooks removed from ${n} config dir${n === 1 ? '' : 's'} — affects new Claude sessions</span>`);
      } else {
        const changed = r.results.filter((x) => x.changed).length;
        const skipped = r.results.filter((x) => x.skipped);
        flash(`<span>Hooks: ${changed ? `installed in ${changed} config dir${changed === 1 ? '' : 's'}` : 'already installed'}${skipped.length ? ` · skipped: ${esc(skipped.map((x) => `${x.dir} (${x.skipped})`).join(', '))}` : ''} — takes effect for new Claude sessions</span>`);
      }
      await refreshHookStatus();
    } catch (e) { showErr(e); }
  }

  // ---- rename ---------------------------------------------------------------------------

  function startRename(id) {
    if (state.editingId) return;
    const row = $(`.row[data-id="${CSS.escape(id)}"], .chip[data-id="${CSS.escape(id)}"]`);
    const s = state.sessions.find((x) => x.id === id);
    if (!row || !s) return;
    const span = row.querySelector('.label');
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = s.label || topic(s) || s.cleanTitle || '';
    span.replaceWith(input);
    state.editingId = id;
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      state.editingId = null;
      if (state.docked) api.dockInteractive(false).catch(() => {}); // hand focus back (strip is non-activating)
      if (commit) { try { await api.rename(id, input.value); } catch (e) { showErr(e); } }
      refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    // The docked strip does not activate on click; typing needs the window focused for real first.
    const focusInput = () => { input.focus(); input.select(); };
    if (state.docked) api.dockInteractive(true).then(focusInput, focusInput); else focusInput();
  }

  // ---- displays -------------------------------------------------------------------------

  function fillDisplays() {
    const sel = $('#display');
    sel.innerHTML = state.displays.map((d) => `<option value="${d.id}">${esc(d.label)} ${d.bounds.width}×${d.bounds.height}${d.primary ? ' ★' : ''}</option>`).join('');
    sel.hidden = state.displays.length < 2;
    let saved = null;
    try { saved = localStorage.getItem('displayId'); } catch { /* ignore */ }
    const pick = state.displays.find((d) => String(d.id) === saved) || state.displays.find((d) => d.primary) || state.displays[0];
    if (pick) { sel.value = String(pick.id); state.displayId = pick.id; }
  }

  // ---- events ---------------------------------------------------------------------------

  function setTab(tab) {
    state.tab = tab;
    try { localStorage.setItem('tab', tab); } catch { /* ignore */ }
    render();
  }
  function tabClick(e) {
    const b = e.target.closest('.tab');
    if (!b) return;
    const tab = b.dataset.tab;
    setTab(tab);
    // Docked strip acts like a taskbar: selecting a group also brings its non-minimized windows
    // forward (re-clicking the active group re-raises them).
    if (state.docked && state.config.raiseGroupOnSelect !== false) api.raiseGroup(tab).catch(showErr);
  }

  function sessionClick(e) {
    const el = e.target.closest('.row, .chip');
    if (!el || e.target.closest('input')) return;
    const id = el.dataset.id;
    const act = (e.target.closest('[data-act]') || {}).dataset?.act;
    if (act === 'rename') return startRename(id);
    if (act === 'min') return api.minimize(id).catch(showErr);
    if (act === 'menu') return api.contextMenu(id);
    if (e.button === 1) { e.preventDefault(); return api.minimize(id).catch(showErr); }
    api.focus(id).catch(showErr);
  }
  function sessionContext(e) {
    const el = e.target.closest('.row, .chip');
    if (el) { e.preventDefault(); api.contextMenu(el.dataset.id); }
  }

  const newSession = () => api.newSession().catch(showErr);

  function bind() {
    // shared
    for (const sel of ['#tabs', '#dock-tabs']) $(sel).addEventListener('click', tabClick);
    for (const sel of ['#list', '#dock-chips']) {
      $(sel).addEventListener('click', sessionClick);
      $(sel).addEventListener('auxclick', sessionClick);
      $(sel).addEventListener('contextmenu', sessionContext);
    }
    $('#dock-chips').addEventListener('wheel', (e) => { // vertical wheel scrolls the strip horizontally
      if (e.deltaY && !e.deltaX) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });

    // panel toolbar
    $('#btn-new').addEventListener('click', newSession);
    $('#btn-tile').addEventListener('click', () => api.tile(state.tab, state.displayId).catch(showErr));
    $('#btn-cascade').addEventListener('click', () => api.cascade(state.tab, state.displayId).catch(showErr));
    $('#btn-minall').addEventListener('click', () => api.minimizeGroup(state.tab).catch(showErr));
    $('#display').addEventListener('change', (e) => {
      state.displayId = Number(e.target.value);
      try { localStorage.setItem('displayId', String(state.displayId)); } catch { /* ignore */ }
    });
    $('#btn-pin').addEventListener('click', async () => {
      state.pinned = await api.setAlwaysOnTop(!state.pinned);
      $('#btn-pin').classList.toggle('on', state.pinned);
    });
    $('#btn-dock').addEventListener('click', () => api.setDock((state.config.dock && state.config.dock.edge) || 'top', state.displayId).catch(showErr));
    $('#btn-config').addEventListener('click', () => api.openConfig());
    $('#btn-hooks').addEventListener('click', hooksClick);
    $('#btn-reload').addEventListener('click', async () => {
      try { state.config = await api.reloadConfig(); state.info = await api.appInfo(); refresh(); }
      catch (e) { showErr(e); }
    });

    // dock tools
    $('#dock-new').addEventListener('click', newSession);
    $('#dock-tile').addEventListener('click', () => api.tile(state.tab, state.docked && state.docked.displayId).catch(showErr));
    $('#dock-cascade').addEventListener('click', () => api.cascade(state.tab, state.docked && state.docked.displayId).catch(showErr));
    $('#dock-minall').addEventListener('click', () => api.minimizeGroup(state.tab).catch(showErr));
    $('#dock-config').addEventListener('click', () => api.openConfig());
    $('#dock-hide').addEventListener('click', () => api.hideToTray().catch(showErr));
    $('#dock-undock').addEventListener('click', () => api.setDock('none').catch(showErr));

    document.addEventListener('keydown', (e) => {
      if (state.editingId) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); return; }
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const s = visible()[Number(e.key) - 1];
        if (s) { e.preventDefault(); api.focus(s.id).catch(showErr); }
        return;
      }
      if (e.key === 'F2') {
        const el = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.row, .chip') : null;
        if (el) startRename(el.dataset.id);
      }
    });
    api.onSessions((list) => { state.sessions = list; render(); });
    api.onStartRename((id) => startRename(id));
    setInterval(render, 5000); // keep the "since" durations fresh
  }

  function applyMode() {
    state.docked = state.info.dock || null;
    document.body.classList.toggle('docked', !!state.docked);
    document.body.classList.toggle('dock-bottom', !!state.docked && state.docked.edge === 'bottom');
    $('#dock').hidden = !state.docked;
  }

  async function init() {
    [state.config, state.info, state.displays, state.sessions, state.pinned] = await Promise.all([
      api.getConfig(), api.appInfo(), api.getDisplays(), api.getSessions(), api.getAlwaysOnTop(),
    ]);
    applyMode();
    try { const t = localStorage.getItem('tab'); if (t) state.tab = t; } catch { /* ignore */ } // remembered across dock/undock and restarts
    $('#btn-pin').classList.toggle('on', state.pinned);
    fillDisplays();
    bind();
    render();
    refreshHookStatus();
  }

  init().catch(showErr);
})();
