// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
// The shared "New session" dialog, opened by "+ New" (and Ctrl+N) in both panel and docked mode.
(() => {
  const api = window.satchel;
  const $ = (s) => document.querySelector(s);
  let profiles = [];
  let candidates = []; // closed-but-remembered Claude sessions, for "Resume"

  const showErr = (msg) => { const e = $('#err'); e.textContent = msg; e.hidden = !msg; };
  const cleanMsg = (e) => (e && e.message ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e));

  function syncCwd() {
    const p = profiles.find((x) => x.name === $('#profile').value);
    $('#cwd').value = p ? (p.cwd || '~') : '';
  }

  // Resume mode: the label becomes "which session to continue" — suggest the remembered ones,
  // and when a suggestion is picked, bring its folder along.
  function syncResume() {
    const on = $('#resume').checked;
    if (on) $('#label').setAttribute('list', 'known'); else $('#label').removeAttribute('list');
    $('#label').placeholder = on ? 'session to resume (empty = choose in the window)' : 'what is this session about?';
    $('#launch').textContent = on ? 'Resume' : 'Launch';
  }
  function labelInput() {
    if (!$('#resume').checked) return;
    const v = $('#label').value.trim().toLowerCase();
    const c = candidates.find((x) => x.name.toLowerCase() === v);
    if (c && c.cwd) $('#cwd').value = c.cwd;
  }
  function fillKnown() {
    const dl = $('#known');
    dl.textContent = '';
    for (const c of candidates) {
      const o = document.createElement('option');
      o.value = c.name;
      if (c.group) o.label = c.group;
      dl.appendChild(o);
    }
  }

  async function launch() {
    const req = { profileName: $('#profile').value, cwd: $('#cwd').value.trim(), label: $('#label').value.trim(), resume: $('#resume').checked };
    if (!req.profileName) return showErr('No profiles configured — edit config.json');
    $('#launch').disabled = true;
    showErr('');
    try {
      await api.launch(req);
      try { localStorage.setItem('lastProfile', req.profileName); } catch { /* ignore */ }
      api.newSessionDone();
    } catch (e) {
      showErr(cleanMsg(e));
      $('#launch').disabled = false;
    }
  }

  async function init() {
    let cfg = { profiles: [] };
    try { cfg = await api.getConfig(); } catch (e) { showErr(cleanMsg(e)); }
    profiles = cfg.profiles || [];
    $('#profile').innerHTML = profiles.map((p) => `<option value="${p.name}">${p.name}${p.group ? ` (${p.group})` : ''}</option>`).join('');
    let pre = null;
    try { pre = localStorage.getItem('lastProfile'); } catch { /* ignore */ }
    if (pre && profiles.some((p) => p.name === pre)) $('#profile').value = pre;
    if (!profiles.length) { $('#launch').disabled = true; showErr('No profiles configured — edit config.json'); }
    syncCwd();

    try { candidates = await api.resumeCandidates(); } catch { candidates = []; }
    fillKnown();

    $('#profile').addEventListener('change', syncCwd);
    $('#resume').addEventListener('change', syncResume);
    $('#label').addEventListener('input', labelInput);
    $('#browse').addEventListener('click', async () => { const d = await api.pickDir($('#cwd').value); if (d) $('#cwd').value = d; });
    $('#f').addEventListener('submit', (e) => { e.preventDefault(); launch(); });
    $('#cancel').addEventListener('click', () => api.newSessionDone());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.newSessionDone(); });
    $('#label').focus();
  }

  init();
})();
