'use strict';
/*
 * Admin console for MindMapShare.
 * Auth is a single password (ADMIN_PASSWORD env var on the server), exchanged
 * for a short-lived signed cookie. This script talks only to /api/admin/*.
 */
(function () {
  const $ = sel => document.querySelector(sel);
  const loginView = $('#loginView');
  const dashView = $('#dashView');

  let allUsers = [];

  // --- helpers ---
  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }, opts));
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    return { ok: res.ok, status: res.status, data };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtDate(ms) {
    if (!ms) return '—';
    const d = new Date(Number(ms));
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function show(view) {
    loginView.classList.toggle('hidden', view !== 'login');
    dashView.classList.toggle('hidden', view !== 'dash');
  }

  // --- login ---
  const loginForm = $('#loginForm');
  const loginMsg = $('#loginMsg');
  const loginBtn = $('#loginBtn');

  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    loginMsg.textContent = '';
    loginMsg.className = 'msg';
    loginBtn.disabled = true;
    const password = $('#pw').value;
    const { ok, data } = await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    loginBtn.disabled = false;
    if (ok) {
      $('#pw').value = '';
      await loadDashboard();
    } else {
      loginMsg.textContent = (data && data.error) || 'Sign-in failed.';
      loginMsg.className = 'msg err';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    show('login');
  });

  $('#refreshBtn').addEventListener('click', loadStats);
  $('#search').addEventListener('input', renderRows);

  // --- dashboard ---
  async function loadDashboard() {
    show('dash');
    await loadStats();
  }

  async function loadStats() {
    const { ok, status, data } = await api('/api/admin/stats');
    if (!ok) {
      if (status === 401) { show('login'); return; }
      return;
    }
    renderStats(data);
  }

  function renderStats(data) {
    const t = data.totals || {};
    const tiles = [
      { k: 'Users', n: t.users, accent: true },
      { k: 'Maps', n: t.maps },
      { k: 'Nodes', n: t.nodes },
      { k: 'New (24h)', n: t.newToday },
      { k: 'New (7d)', n: t.newWeek },
    ];
    $('#statTiles').innerHTML = tiles.map(x =>
      `<div class="tile"><div class="n${x.accent ? ' accent' : ''}">${Number(x.n || 0).toLocaleString()}</div><div class="k">${esc(x.k)}</div></div>`
    ).join('');

    $('#storageChip').innerHTML = `Storage: <b>${esc(data.storage || 'unknown')}</b>`;
    $('#metaRow').innerHTML =
      `<span class="chip">AI generation: <b>${data.aiEnabled ? 'enabled' : 'off'}</b></span>`;

    allUsers = Array.isArray(data.users) ? data.users : [];
    renderRows();
  }

  function renderRows() {
    const q = $('#search').value.trim().toLowerCase();
    const rows = q
      ? allUsers.filter(u =>
          u.username.toLowerCase().includes(q) ||
          (u.displayName && u.displayName.toLowerCase().includes(q)))
      : allUsers;

    $('#rowCount').textContent =
      rows.length === allUsers.length
        ? `${allUsers.length} user${allUsers.length === 1 ? '' : 's'}`
        : `${rows.length} of ${allUsers.length}`;

    const empty = $('#emptyState');
    empty.classList.toggle('hidden', rows.length !== 0);

    $('#userRows').innerHTML = rows.map(u => {
      const vis = esc(u.visibility || 'friends');
      const dn = u.displayName ? `<div class="dn">${esc(u.displayName)}</div>` : '';
      return `<tr data-id="${esc(u.id)}" data-username="${esc(u.username)}">
        <td class="user"><b>@${esc(u.username)}</b>${dn}</td>
        <td><span class="vis ${vis}">${vis}</span></td>
        <td class="num">${u.mapCount || 0}</td>
        <td class="num">${u.nodeCount || 0}</td>
        <td class="num">${u.friendCount || 0}</td>
        <td class="num">${u.followerCount || 0}</td>
        <td>${fmtDate(u.createdAt)}</td>
        <td class="actions"><button class="danger" data-del="${esc(u.id)}">Delete</button></td>
      </tr>`;
    }).join('');
  }

  // Delegated delete handler.
  $('#userRows').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-del]');
    if (!btn) return;
    const row = btn.closest('tr');
    const id = btn.getAttribute('data-del');
    const username = row ? row.getAttribute('data-username') : '';
    if (!confirm(`Permanently delete @${username} and all their maps? This cannot be undone.`)) return;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    const { ok, status } = await api('/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
    if (ok) {
      allUsers = allUsers.filter(u => u.id !== id);
      renderRows();
      // refresh the stat tiles to reflect the removal
      loadStats();
    } else if (status === 401) {
      show('login');
    } else {
      btn.disabled = false;
      btn.textContent = 'Delete';
      alert('Delete failed. Please try again.');
    }
  });

  // --- boot: are we already signed in? ---
  (async function init() {
    const { ok, data } = await api('/api/admin/session');
    if (ok && data && data.authed) {
      await loadDashboard();
    } else {
      show('login');
      if (ok && data && !data.configured) {
        loginMsg.textContent = 'Admin access is not configured. Set the ADMIN_PASSWORD environment variable on the server.';
        loginMsg.className = 'msg err';
        loginBtn.disabled = true;
      }
    }
  })();
})();
