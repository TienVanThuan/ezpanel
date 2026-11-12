'use strict';

// ================= Tiện ích =================
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), isError ? 6000 : 3000);
}

async function api(url, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    showLogin();
    throw new Error(data.error || 'Bạn cần đăng nhập.');
  }
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

// Chạy một thao tác, báo lỗi bằng toast, khóa nút trong lúc chờ
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const fmtSize = n => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtDate = ms => ms ? new Date(ms).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '';
const fmtUptime = s => {
  const d = Math.floor(s / 86400), hr = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return [d && `${d} ngày`, hr && `${hr} giờ`, `${m} phút`].filter(Boolean).join(' ');
};

// ================= Đăng nhập =================
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#pw').focus();
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
    $('#pw').value = '';
    enterApp();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ================= Đèn LED trên thanh bên =================
async function refreshLeds() {
  try {
    const [s, v, lg] = await Promise.all([api('/api/sites'), api('/api/services'), api('/api/laragon').catch(() => null)]);
    const sv = lg?.detected ? await api('/api/laragon/services').catch(() => null) : null;
    const mail = await api('/api/mail').catch(() => null);
    const badge = $('#mailBadge');
    badge.hidden = !mail?.messages?.unread;
    badge.textContent = mail?.messages?.unread || '';
    const led = x => x.running ? 'on' : x.starting ? 'warn' : '';
    $('#ledLaragon').innerHTML = sv ? `<i class="${led(sv.apache)}" title="Apache"></i><i class="${led(sv.mysql)}" title="MySQL"></i>` : '';
    $('#ledSites').innerHTML = s.sites.slice(0, 6).map(x => `<i class="${x.enabled ? 'on' : ''}"></i>`).join('');
    $('#ledServices').innerHTML = v.supported
      ? v.services.slice(0, 6).map(x => `<i class="${x.state === 'running' ? 'on' : /ing$/.test(x.state) ? 'warn' : ''}"></i>`).join('')
      : '';
  } catch { /* bỏ qua */ }
}

// ================= Điều hướng =================
const views = { settings: renderSettings, backups: renderBackups, overview: renderOverview, files: renderFiles, sites: renderSites, db: renderDb, services: renderServices, laragon: renderLaragon, wp: renderWp, import: renderImport, mail: renderMail, logs: renderLogs };
function route() {
  const name = location.hash.slice(1) || 'overview';
  const fn = views[name] || renderOverview;
  document.querySelectorAll('.side a').forEach(a => a.classList.toggle('active', a.dataset.view === name));
  if (name !== 'logs') closeLogStream();
  // Trang Terminal nằm riêng để các phiên vẫn chạy khi chuyển sang trang khác
  const isTerm = name === 'terminal';
  view.hidden = isTerm;
  $('#termRoot').hidden = !isTerm;
  if (isTerm) {
    renderTerminal().catch(e => toast(e.message, true));
    refreshLeds();
    return;
  }
  view.innerHTML = '<p class="muted">Đang tải…</p>';
  fn().catch(e => { view.innerHTML = `<p class="error">${h(e.message)}</p>`; });
  refreshLeds();
}
window.addEventListener('hashchange', route);

// ================= Tổng quan =================
async function loadDesktop() {
  const box = $('#desktopBox');
  if (!box) return;
  if (!desk) {
    box.innerHTML = `<h2>Ứng dụng desktop</h2><p class="sub" style="margin:0">Bạn đang mở Sitebench trong trình duyệt. Cài bản desktop (Sitebench-Setup.exe) để có cửa sổ riêng, biểu tượng ở khay hệ thống và chạy cùng Windows.</p>`;
    return;
  }
  const [info, auto] = await Promise.all([desk.info(), desk.getAutostart()]);
  if (!document.body.contains(box)) return;
  box.innerHTML = `
    <h2>Ứng dụng desktop</h2>
    <label class="switch"><input type="checkbox" id="autorun" ${auto ? 'checked' : ''}> <span>Chạy Sitebench cùng Windows (ẩn dưới khay hệ thống)</span></label>
    <p class="sub" style="margin:.6rem 0 0">Đóng cửa sổ thì Sitebench thu vào khay, Apache/MySQL vẫn chạy. Thoát hẳn: chuột phải biểu tượng Sitebench ở khay → Thoát Sitebench.<br>
      Dữ liệu (cài đặt, sao lưu, nhật ký): <span class="log-path">${h(info.data)}</span></p>`;
  $('#autorun').addEventListener('change', async e => {
    const on = await desk.setAutostart(e.target.checked);
    e.target.checked = on;
    toast(on ? 'Sitebench sẽ chạy cùng Windows.' : 'Đã tắt chạy cùng Windows.');
  });
}

// ================= Quản lý file =================
let cwd = '';
const join = (...p) => p.filter(Boolean).join('/');

async function renderFiles() {
  const data = await api(`/api/files/list?path=${encodeURIComponent(cwd)}`);
  cwd = data.path;
  const parts = cwd ? cwd.split('/') : [];
  const crumbs = ['<button data-go="">Thư mục gốc</button>']
    .concat(parts.map((p, i) => `<span class="sep">/</span><button data-go="${h(parts.slice(0, i + 1).join('/'))}">${h(p)}</button>`))
    .join('');
  const rows = data.items.map(it => `
    <tr data-name="${h(it.name)}" data-dir="${it.dir ? 1 : 0}">
      <td><button class="name-btn" data-act="open"><span class="icon">${it.dir ? '📁' : '📄'}</span>${h(it.name)}</button></td>
      <td class="num">${it.dir ? '' : fmtSize(it.size)}</td>
      <td class="num hide-sm">${fmtDate(it.mtime)}</td>
      <td class="actions">
        ${it.dir ? '' : '<button class="btn small" data-act="download">Tải về</button>'}
        <button class="btn small" data-act="rename">Đổi tên</button>
        <button class="btn small danger" data-act="delete">Xóa</button>
      </td>
    </tr>`).join('');

  view.innerHTML = `
    <h1>Quản lý file</h1>
    <p class="lead">Tạo, sửa, tải lên và xóa tệp trong thư mục được quản lý. Kéo thả tệp vào bảng để tải lên.</p>
    <div class="panel flush drop" id="drop">
      <div class="toolbar">
        <nav class="crumbs" aria-label="Đường dẫn">${crumbs}</nav>
        <button class="btn" id="newFolder">Thư mục mới</button>
        <button class="btn" id="newFile">Tệp mới</button>
        <button class="btn primary" id="uploadBtn">Tải lên</button>
        <input type="file" id="uploadInput" multiple hidden>
      </div>
      <div class="table-wrap">
        ${data.items.length ? `<table>
          <thead><tr><th>Tên</th><th style="text-align:right">Dung lượng</th><th class="hide-sm" style="text-align:right">Sửa lần cuối</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table>`
        : '<p class="empty">Thư mục trống. Tạo tệp mới hoặc kéo thả tệp vào đây.</p>'}
      </div>
    </div>`;

  view.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { cwd = b.dataset.go; renderFiles(); });

  $('#newFolder').onclick = async () => {
    const name = prompt('Tên thư mục mới:');
    if (!name) return;
    await act(null, () => api('/api/files/mkdir', { method: 'POST', body: { path: join(cwd, name) } }), 'Đã tạo thư mục.');
    renderFiles();
  };
  $('#newFile').onclick = async () => {
    const name = prompt('Tên tệp mới (ví dụ: index.html):');
    if (!name) return;
    const ok = await act(null, () => api('/api/files/write', { method: 'POST', body: { path: join(cwd, name), content: '' } }));
    if (ok) { await renderFiles(); openEditor(join(cwd, name)); }
  };

  const doUpload = async files => {
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    await act($('#uploadBtn'), () => api(`/api/files/upload?path=${encodeURIComponent(cwd)}`, { method: 'POST', body: fd }), `Đã tải lên ${files.length} tệp.`);
    renderFiles();
  };
  $('#uploadBtn').onclick = () => $('#uploadInput').click();
  $('#uploadInput').onchange = e => doUpload([...e.target.files]);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('dragging'); };
  drop.ondragleave = e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('dragging'); };
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('dragging'); doUpload([...e.dataTransfer.files]); };

  view.querySelector('tbody')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const name = tr.dataset.name;
    const isDir = tr.dataset.dir === '1';
    const full = join(cwd, name);
    switch (btn.dataset.act) {
      case 'open':
        if (isDir) { cwd = full; renderFiles(); } else openEditor(full);
        break;
      case 'download':
        location.href = `/api/files/download?path=${encodeURIComponent(full)}`;
        break;
      case 'rename': {
        const next = prompt('Tên mới:', name);
        if (!next || next === name) return;
        await act(btn, () => api('/api/files/rename', { method: 'POST', body: { from: full, to: join(cwd, next) } }), 'Đã đổi tên.');
        renderFiles();
        break;
      }
      case 'delete':
        if (!confirm(`Xóa ${isDir ? 'thư mục' : 'tệp'} "${name}"${isDir ? ' và toàn bộ nội dung bên trong' : ''}? Không thể hoàn tác.`)) return;
        await act(btn, () => api('/api/files/delete', { method: 'POST', body: { path: full } }), 'Đã xóa.');
        renderFiles();
        break;
    }
  });
}

// ----- Trình soạn thảo -----
const editor = $('#editor');
let editorPath = null, editorSaved = '';
async function openEditor(path) {
  const data = await act(null, () => api(`/api/files/read?path=${encodeURIComponent(path)}`));
  if (!data) return;
  editorPath = path;
  editorSaved = data.content;
  $('#editorTitle').textContent = path;
  $('#editorText').value = data.content;
  $('#editorState').textContent = '';
  editor.showModal();
  $('#editorText').focus();
}
async function saveEditor() {
  const content = $('#editorText').value;
  const ok = await act($('#editorSave'), () => api('/api/files/write', { method: 'POST', body: { path: editorPath, content } }));
  if (ok) { editorSaved = content; $('#editorState').textContent = 'Đã lưu'; }
}
$('#editorSave').onclick = saveEditor;
$('#editorText').addEventListener('input', () => {
  $('#editorState').textContent = $('#editorText').value === editorSaved ? '' : 'Chưa lưu';
});
$('#editorText').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEditor(); }
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target, s = t.selectionStart;
    t.setRangeText('  ', s, t.selectionEnd, 'end');
    t.dispatchEvent(new Event('input'));
  }
});
editor.addEventListener('cancel', e => {
  if ($('#editorText').value !== editorSaved && !confirm('Có thay đổi chưa lưu. Vẫn đóng?')) e.preventDefault();
});
editor.addEventListener('close', () => { if (location.hash === '#files') renderFiles(); });

// ================= Website =================
async function renderSites() {
  const data = await api('/api/sites');
  const rows = data.sites.map(s => `
    <tr class="site-row" data-name="${h(s.name)}">
      <td><span class="led ${s.enabled ? (s.portError ? 'warn' : 'on') : ''}" title="${s.enabled ? 'Đang chạy' : 'Đã dừng'}"></span></td>
      <td>
        <div class="site-name">${h(s.name)}</div>
        <div class="sub">${s.enabled ? `<a href="${h(s.url)}" target="_blank" rel="noopener">${h(s.url)}</a>` : h(s.url)}
        ${s.portUrl ? ` và ${s.enabled && s.portRunning ? `<a href="${h(s.portUrl)}" target="_blank" rel="noopener">${h(s.portUrl)}</a>` : h(s.portUrl)}` : ''}</div>
        ${s.portError ? `<div class="sub error">${h(s.portError)}</div>` : ''}
      </td>
      <td class="actions">
        <button class="btn small" data-act="files">Mở thư mục</button>
        <button class="btn small" data-act="toggle">${s.enabled ? 'Dừng' : 'Chạy'}</button>
        <button class="btn small danger" data-act="delete">Xóa</button>
      </td>
    </tr>`).join('');

  view.innerHTML = `
    <h1>Website</h1>
    <p class="lead">Mỗi website là một thư mục trong <code>sites/</code>, chạy tại <b>tên.localhost:${data.sitesPort}</b>. Trình duyệt tự hiểu tên miền .localhost nên không cần sửa tệp hosts.</p>
    <form class="panel" id="siteForm">
      <h2>Tạo website mới</h2>
      <div class="row">
        <div class="field grow"><label for="siteName">Tên (chữ thường, số, dấu -)</label><input id="siteName" required pattern="[a-z0-9-]+" placeholder="blog-cua-toi"></div>
        <div class="field grow"><label for="siteDomain">Tên miền (để trống = tên.localhost)</label><input id="siteDomain" placeholder="blog-cua-toi.localhost"></div>
        <div class="field" style="width:11rem"><label for="sitePort">Cổng riêng (tùy chọn)</label><input id="sitePort" type="number" min="1024" max="65535" placeholder="3001"></div>
        <button class="btn primary">Tạo website</button>
      </div>
    </form>
    <div class="panel flush"><div class="table-wrap">
      ${data.sites.length ? `<table><tbody>${rows}</tbody></table>` : '<p class="empty">Chưa có website nào. Tạo website đầu tiên ở trên.</p>'}
    </div></div>`;

  $('#siteForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { name: $('#siteName').value.trim(), domain: $('#siteDomain').value.trim() || undefined, port: $('#sitePort').value || undefined };
    const ok = await act(e.submitter, () => api('/api/sites', { method: 'POST', body }), 'Đã tạo website.');
    if (ok) route();
  });

  view.querySelector('tbody')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const name = btn.closest('tr').dataset.name;
    const site = data.sites.find(s => s.name === name);
    if (btn.dataset.act === 'files') { cwd = site.folder; location.hash = '#files'; return; }
    if (btn.dataset.act === 'toggle') {
      await act(btn, () => api(`/api/sites/${encodeURIComponent(name)}/toggle`, { method: 'POST' }), site.enabled ? 'Đã dừng website.' : 'Đã chạy website.');
    }
    if (btn.dataset.act === 'delete') {
      if (!confirm(`Xóa website "${name}"?`)) return;
      const files = confirm('Xóa luôn thư mục chứa mã nguồn của website?\n\nOK = xóa cả tệp, Cancel = giữ lại tệp.');
      await act(btn, () => api(`/api/sites/${encodeURIComponent(name)}${files ? '?files=1' : ''}`, { method: 'DELETE' }), 'Đã xóa website.');
    }
    route();
  });
}

// ================= Database =================
const dbState = { engine: 'mysql', db: null, sql: '', tab: 'tables', table: null, page: 1, q: '', sort: null, dir: 'asc', showSystem: false };
async function renderDb() {
  view.innerHTML = `
    <h1>Database</h1>
    <p class="lead">Database MySQL/MariaDB: tìm kiếm, xem dữ liệu, chạy SQL, nhập và xuất tệp .sql.</p>
    <div class="seg" role="tablist">
      <button data-engine="mysql" class="${dbState.engine === 'mysql' ? 'active' : ''}">MySQL</button>
      <button data-engine="sqlite" class="${dbState.engine === 'sqlite' ? 'active' : ''}">SQLite</button>
    </div>
    <div id="dbBody"><p class="muted">Đang tải…</p></div>`;
  view.querySelectorAll('[data-engine]').forEach(b => b.onclick = () => {
    if (dbState.engine !== b.dataset.engine) { dbState.engine = b.dataset.engine; dbState.db = null; }
    renderDb();
  });
  return dbState.engine === 'sqlite' ? renderSqlite() : renderMysqlX();
}

function mysqlCfgForm(cfg = {}) {
  return `<form id="myCfg" class="settings-grid">
    <div class="field"><label for="myHost">Host</label><input id="myHost" value="${h(cfg.host)}" required></div>
    <div class="field"><label for="myPort">Cổng</label><input id="myPort" type="number" value="${h(cfg.port)}"></div>
    <div class="field"><label for="myUser">User</label><input id="myUser" value="${h(cfg.user)}" required></div>
    <div class="field"><label for="myPass">Mật khẩu (để trống = giữ nguyên)</label><input id="myPass" type="password" autocomplete="off"></div>
    <div class="field" style="align-self:end"><button class="btn primary">Lưu và kết nối</button></div>
  </form>`;
}
function bindMysqlCfg() {
  $('#myCfg')?.addEventListener('submit', async e => {
    e.preventDefault();
    const pass = $('#myPass').value;
    const ok = await act(e.submitter, () => api('/api/db/mysql/config', { method: 'POST', body: {
      host: $('#myHost').value, port: $('#myPort').value, user: $('#myUser').value, password: pass === '' ? null : pass } }), 'Đã lưu thông tin kết nối.');
    if (ok) renderDb();
  });
}

async function renderMysqlX() {
  const body = $('#dbBody');
  const d = await api('/api/dbx/databases');
  if (!d.connected) {
    body.innerHTML = `<div class="notice"><b>Chưa kết nối được MySQL.</b> ${h(d.error)}<br>
      Bật MySQL ở mục <a href="#laragon">Máy chủ &amp; dự án</a> (hoặc menu ở khay hệ thống), rồi kiểm tra thông tin kết nối bên dưới.</div>
      <div class="panel">${mysqlCfgForm(d.config)}</div>`;
    bindMysqlCfg();
    return;
  }
  if (dbState.db && !d.databases.some(x => x.name === dbState.db)) dbState.db = null;
  const list = d.databases.filter(x => dbState.showSystem || !x.system);
  body.innerHTML = `
    <div class="db2">
      <aside class="panel db-side">
        <input type="search" id="dbSearch" placeholder="Tìm database hoặc dự án…" aria-label="Tìm database">
        <div class="row" style="justify-content:space-between;margin:.5rem 0">
          <span class="sub" id="dbCount">${list.length} database</span>
          <label class="switch small"><input type="checkbox" id="dbSys" ${dbState.showSystem ? 'checked' : ''}> <span>Hệ thống</span></label>
        </div>
        <ul class="db-list2">${list.map(x => `
          <li data-search="${h(`${x.name} ${x.projects.join(' ')}`.toLowerCase())}">
            <button class="pick ${dbState.db === x.name ? 'active' : ''}" data-pick="${h(x.name)}">
              <span class="db-n">${h(x.name)}</span>
              <span class="sub">${x.tables} bảng · ${fmtSize(x.size)}${x.projects.length ? ` · <span class="tag">${x.projects.map(h).join(', ')}</span>` : ''}${x.system ? ' · hệ thống' : ''}</span>
            </button></li>`).join('')}</ul>
        <p class="empty" id="dbNone" hidden>Không có database nào khớp.</p>
        <form id="dbNew" class="row" style="margin-top:.75rem"><input id="dbNewName" class="grow" placeholder="ten_database_moi" required aria-label="Tên database mới"><button class="btn primary">Tạo</button></form>
        <details style="margin-top:.75rem"><summary class="sub" style="cursor:pointer">${h(d.config.user)}@${h(d.config.host)}:${h(d.config.port)} · ${h(d.version)}</summary>
          <div style="margin-top:.6rem">${mysqlCfgForm(d.config)}</div></details>
      </aside>
      <section class="panel flush db-main" id="dbMain">${dbState.db ? '<p class="empty">Đang tải…</p>' : '<p class="empty">Chọn một database bên trái để xem bảng, dữ liệu và chạy SQL.</p>'}</section>
    </div>`;
  bindSearch('#dbSearch', body.querySelectorAll('.db-list2 li'), '#dbCount', '#dbNone', 'database');
  bindMysqlCfg();
  $('#dbSys').onchange = e => { dbState.showSystem = e.target.checked; renderMysqlX(); };
  body.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    dbState.db = b.dataset.pick;
    Object.assign(dbState, { tab: 'tables', table: null, page: 1, q: '', sort: null, sql: '' });
    body.querySelectorAll('[data-pick]').forEach(x => x.classList.toggle('active', x === b));
    renderMysqlMain(d.databases.find(x => x.name === dbState.db));
  });
  $('#dbNew').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#dbNewName').value.trim();
    if (await act(e.submitter, () => api('/api/db/mysql', { method: 'POST', body: { name } }), `Đã tạo database ${name}.`)) { dbState.db = name; renderMysqlX(); }
  });
  if (dbState.db) renderMysqlMain(d.databases.find(x => x.name === dbState.db));
}

function renderMysqlMain(info) {
  const box = $('#dbMain');
  const enc = encodeURIComponent(info.name);
  box.innerHTML = `
    <div class="toolbar db-head">
      <div class="grow"><b>${h(info.name)}</b>
        <div class="sub">${info.tables} bảng · ${fmtSize(info.size)}${info.projects.length ? ` · dùng cho dự án ${info.projects.map(h).join(', ')}` : ''}</div></div>
      <a class="btn small" href="/api/dbx/${enc}/export">Xuất .sql</a>
      ${info.system ? '' : '<button class="btn small" id="dbImport">Nhập .sql</button><button class="btn small danger" id="dbDrop">Xóa</button>'}
    </div>
    <div class="tabs" role="tablist">
      ${[['tables', 'Bảng'], ['data', 'Dữ liệu'], ['sql', 'SQL']].map(([k, l]) => `<button role="tab" data-tab="${k}" class="${dbState.tab === k ? 'active' : ''}">${l}</button>`).join('')}
    </div>
    <div id="dbTab" class="db-tab"></div>`;
  box.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { dbState.tab = b.dataset.tab; renderMysqlMain(info); });
  $('#dbImport')?.addEventListener('click', () => openDbImport(info.name));
  $('#dbDrop')?.addEventListener('click', async e => {
    const warn = info.projects.length ? `\n\nCảnh báo: dự án ${info.projects.join(', ')} đang dùng database này.` : '';
    if (prompt(`Gõ "${info.name}" để xóa vĩnh viễn database cùng toàn bộ dữ liệu.${warn}`) !== info.name) return;
    if (await act(e.target, () => api(`/api/db/mysql/${enc}`, { method: 'DELETE' }), `Đã xóa database ${info.name}.`)) { dbState.db = null; renderMysqlX(); }
  });
  ({ tables: dbTablesTab, data: dbDataTab, sql: dbSqlTab })[dbState.tab](info);
}

async function dbTablesTab(info) {
  const tab = $('#dbTab');
  const { tables } = await api(`/api/dbx/${encodeURIComponent(info.name)}/tables`);
  tab.innerHTML = tables.length ? `
    <div class="toolbar"><input type="search" id="tbSearch" class="grow" placeholder="Lọc bảng…" aria-label="Lọc bảng"><span class="sub" id="tbCount">${tables.length} bảng</span></div>
    <div class="table-wrap"><table><thead><tr><th>Bảng</th><th style="text-align:right">Số dòng (ước tính)</th><th style="text-align:right">Dung lượng</th></tr></thead><tbody>
      ${tables.map(t => `<tr data-search="${h(t.name.toLowerCase())}" class="clickable" data-table="${h(t.name)}">
        <td><button class="name-btn">${h(t.name)}</button>${t.view ? ' <span class="tag">view</span>' : ''}</td>
        <td class="num">${t.rows.toLocaleString('vi-VN')}</td><td class="num">${fmtSize(t.size)}</td></tr>`).join('')}
    </tbody></table><p class="empty" id="tbNone" hidden>Không có bảng nào khớp.</p></div>`
    : `<p class="empty">Database chưa có bảng nào. Dùng tab SQL để tạo bảng, hoặc Nhập .sql.</p>`;
  bindSearch('#tbSearch', tab.querySelectorAll('tr[data-search]'), '#tbCount', '#tbNone', 'bảng');
  tab.querySelectorAll('tr[data-table]').forEach(tr => tr.onclick = () => {
    Object.assign(dbState, { tab: 'data', table: tr.dataset.table, page: 1, q: '', sort: null });
    renderMysqlMain(info);
  });
}

async function dbDataTab(info) {
  const tab = $('#dbTab');
  const enc = encodeURIComponent(info.name);
  const { tables } = await api(`/api/dbx/${enc}/tables`);
  if (!tables.length) { tab.innerHTML = '<p class="empty">Database chưa có bảng nào.</p>'; return; }
  if (!tables.some(t => t.name === dbState.table)) dbState.table = tables[0].name;
  tab.innerHTML = `
    <div class="toolbar">
      <select id="dtTable" aria-label="Chọn bảng">${tables.map(t => `<option ${t.name === dbState.table ? 'selected' : ''}>${h(t.name)}</option>`).join('')}</select>
      <input type="search" id="dtSearch" class="grow" placeholder="Tìm trong mọi cột của bảng…" value="${h(dbState.q)}" aria-label="Tìm trong bảng">
      <span class="sub" id="dtInfo"></span>
    </div>
    <div id="dtGrid"><p class="empty">Đang tải…</p></div>`;
  $('#dtTable').onchange = e => { Object.assign(dbState, { table: e.target.value, page: 1, q: '', sort: null }); dbDataTab(info); };
  let timer;
  $('#dtSearch').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { dbState.q = e.target.value; dbState.page = 1; loadGrid(); }, 300); };
  const loadGrid = async () => {
    const qs = new URLSearchParams({ page: dbState.page, per: 50, q: dbState.q, ...(dbState.sort ? { sort: dbState.sort, dir: dbState.dir } : {}) });
    let d;
    try { d = await api(`/api/dbx/${enc}/table/${encodeURIComponent(dbState.table)}?${qs}`); } catch (e) { $('#dtGrid').innerHTML = `<p class="error" style="padding:1rem">${h(e.message)}</p>`; return; }
    const pages = Math.max(1, Math.ceil(d.total / d.per));
    $('#dtInfo').textContent = `${d.total.toLocaleString('vi-VN')} dòng${dbState.q ? ' khớp' : ''}`;
    $('#dtGrid').innerHTML = `
      <div class="result grid"><table>
        <thead><tr>${d.columns.map(c => `<th data-col="${h(c.name)}" title="${h(c.type)}${c.key === 'PRI' ? ' · khóa chính' : ''}">${c.key === 'PRI' ? '🔑 ' : ''}${h(c.name)}${d.sort === c.name ? (d.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead>
        <tbody>${d.rows.map(row => `<tr>${row.map(v => v === null ? '<td class="null">NULL</td>' : `<td title="${h(String(v).slice(0, 500))}">${h(v)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>${d.rows.length ? '' : `<p class="empty">${dbState.q ? 'Không có dòng nào khớp.' : 'Bảng trống.'}</p>`}</div>
      <div class="toolbar pager">
        <button class="btn small" data-pg="1" ${d.page <= 1 ? 'disabled' : ''}>«</button>
        <button class="btn small" data-pg="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>‹ Trước</button>
        <span class="sub">Trang ${d.page} / ${pages}</span>
        <button class="btn small" data-pg="${d.page + 1}" ${d.page >= pages ? 'disabled' : ''}>Sau ›</button>
        <button class="btn small" data-pg="${pages}" ${d.page >= pages ? 'disabled' : ''}>»</button>
        <span class="sub grow" style="text-align:right">Bấm tên cột để sắp xếp</span>
      </div>`;
    $('#dtGrid').querySelectorAll('[data-pg]').forEach(b => b.onclick = () => { dbState.page = Number(b.dataset.pg); loadGrid(); });
    $('#dtGrid').querySelectorAll('th[data-col]').forEach(th => th.onclick = () => {
      const c = th.dataset.col;
      if (dbState.sort === c) dbState.dir = dbState.dir === 'asc' ? 'desc' : 'asc'; else { dbState.sort = c; dbState.dir = 'asc'; }
      dbState.page = 1;
      loadGrid();
    });
  };
  loadGrid();
}

function dbSqlTab(info) {
  const tab = $('#dbTab');
  const enc = encodeURIComponent(info.name);
  tab.innerHTML = `
    <div style="padding:1rem">
      <textarea id="sql" class="code sql" spellcheck="false" placeholder="SELECT * FROM ...">${h(dbState.sql)}</textarea>
      <div class="row" style="margin-top:.5rem">
        <button class="btn primary" id="runSql">Chạy SQL (Ctrl+Enter)</button>
        <span class="muted" style="font-size:.85rem">Câu lệnh chạy trực tiếp trên ${h(info.name)}, hãy cẩn thận với DELETE và DROP.</span>
      </div>
      <div id="sqlOut"></div>
    </div>`;
  const run = async () => {
    const sql = $('#sql').value;
    dbState.sql = sql;
    const out = await act($('#runSql'), () => api(`/api/db/mysql/${enc}/query`, { method: 'POST', body: { sql } }));
    if (out) $('#sqlOut').innerHTML = renderResults(out);
  };
  $('#runSql').onclick = run;
  $('#sql').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
}

function openDbImport(db) {
  const dlg = modal(`Nhập tệp .sql vào ${db}`, `
    <form id="imForm">
      <div class="field"><label for="imFile">Tệp .sql hoặc .sql.gz</label><input type="file" id="imFile" accept=".sql,.gz" required></div>
      <label class="switch" style="margin-top:.75rem"><input type="checkbox" id="imReplace"> <span>Xóa sạch dữ liệu hiện có của ${h(db)} trước khi nhập</span></label>
      <p class="sub">Các lệnh CREATE DATABASE / USE trong tệp được bỏ qua để dữ liệu chỉ vào đúng database ${h(db)}.</p>
      <p><button class="btn primary">Nhập</button> <span class="sub" id="imProg"></span></p>
    </form>
    <div id="imJob"></div>`);
  $('#imForm', dlg).addEventListener('submit', async e => {
    e.preventDefault();
    const file = $('#imFile', dlg).files[0];
    if ($('#imReplace', dlg).checked && !confirm(`Xóa toàn bộ dữ liệu hiện có của ${db}?`)) return;
    e.submitter.disabled = true;
    const fd = new FormData();
    fd.append('replace', $('#imReplace', dlg).checked ? '1' : '0');
    fd.append('file', file);
    try {
      const r = await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('POST', `/api/dbx/${encodeURIComponent(db)}/import`);
        x.upload.onprogress = ev => ev.lengthComputable && ($('#imProg', dlg).textContent = `Đang tải lên ${Math.round(ev.loaded / ev.total * 100)}%`);
        x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch { /* bỏ qua */ } x.status < 300 ? resolve(d) : reject(new Error(d.error || `Lỗi ${x.status}`)); };
        x.onerror = () => reject(new Error('Tải lên thất bại.'));
        x.send(fd);
      });
      e.target.hidden = true;
      watchJob(r.job, $('#imJob', dlg), (res, out) => {
        out.innerHTML = `<p><b>Đã nhập xong vào ${h(db)}.</b></p>${res.notes.length ? `<ul class="notes">${res.notes.map(n => `<li>${h(n)}</li>`).join('')}</ul>` : ''}`;
        if (location.hash === '#db') renderMysqlX();
      });
    } catch (err) { toast(err.message, true); e.submitter.disabled = false; }
  });
}

function dbListHtml(dbs) {
  if (!dbs.length) return '<p class="muted">Chưa có database nào.</p>';
  return `<ul class="db-list">${dbs.map(d => `
    <li><button class="pick ${dbState.db === d.name ? 'active' : ''}" data-pick="${h(d.name)}">${h(d.name)}
      ${d.size !== undefined ? `<span class="sys">${fmtSize(d.size)}</span>` : ''}${d.system ? ' <span class="sys">hệ thống</span>' : ''}</button>
      ${d.system ? '' : `<button class="btn small danger" data-drop="${h(d.name)}" title="Xóa database">Xóa</button>`}</li>`).join('')}</ul>`;
}

async function renderSqlite() {
  const data = await api('/api/db/sqlite');
  if (dbState.db && !data.databases.some(d => d.name === dbState.db)) dbState.db = null;
  renderDbLayout(data.databases, '/api/db/sqlite');
}

function renderDbLayout(dbs, base, status = '') {
  $('#dbBody').innerHTML = `
    <div class="db-grid">
      <div class="panel">
        <h2>Danh sách</h2>
        ${status ? `<p class="sub" style="margin-top:-.4rem">${status}</p>` : ''}
        ${dbListHtml(dbs)}
        <form id="dbCreate" class="field">
          <label for="dbName">Database mới</label>
          <div class="row"><input id="dbName" class="grow" required placeholder="ten_database"><button class="btn primary">Tạo</button></div>
        </form>
      </div>
      <div class="panel" id="dbWork">${dbState.db ? '<p class="muted">Đang tải…</p>' : '<p class="empty">Chọn một database bên trái để xem bảng và chạy câu lệnh SQL.</p>'}</div>
    </div>`;

  $('#dbCreate').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#dbName').value.trim();
    const ok = await act(e.submitter, () => api(base, { method: 'POST', body: { name } }), `Đã tạo database ${name}.`);
    if (ok) { dbState.db = name; renderDb(); }
  });
  $('#dbBody').querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { dbState.db = b.dataset.pick; dbState.sql = ''; renderDb(); });
  $('#dbBody').querySelectorAll('[data-drop]').forEach(b => b.onclick = async () => {
    const name = b.dataset.drop;
    if (!confirm(`Xóa vĩnh viễn database "${name}" cùng toàn bộ dữ liệu?`)) return;
    const ok = await act(b, () => api(`${base}/${encodeURIComponent(name)}`, { method: 'DELETE' }), 'Đã xóa database.');
    if (ok) { if (dbState.db === name) dbState.db = null; renderDb(); }
  });
  if (dbState.db) renderDbWork(base);
}

async function renderDbWork(base) {
  const name = dbState.db;
  const box = $('#dbWork');
  const { tables } = await api(`${base}/${encodeURIComponent(name)}/tables`).catch(e => { box.innerHTML = `<p class="error">${h(e.message)}</p>`; throw e; });
  const q = dbState.engine === 'mysql' ? (t => "`" + t.replace(/`/g, "``") + "`") : (t => `"${t.replace(/"/g, '""')}"`);
  box.innerHTML = `
    <h2>${h(name)}</h2>
    ${tables.length
      ? `<div class="chips">${tables.map(t => `<button class="chip" data-table="${h(t)}" title="Xem 100 dòng đầu">${h(t)}</button>`).join('')}</div>`
      : `<p class="muted">Chưa có bảng nào. Thử tạo một bảng, ví dụ:<br><code>CREATE TABLE users (id INTEGER PRIMARY KEY${dbState.engine === 'mysql' ? ' AUTO_INCREMENT' : ''}, name TEXT);</code></p>`}
    <textarea id="sql" class="code sql" spellcheck="false" placeholder="SELECT * FROM ...">${h(dbState.sql)}</textarea>
    <div class="row" style="margin-top:.5rem">
      <button class="btn primary" id="runSql">Chạy SQL (Ctrl+Enter)</button>
      <span class="muted" style="font-size:.85rem">Câu lệnh chạy trực tiếp trên database, hãy cẩn thận với DELETE và DROP.</span>
    </div>
    <div id="sqlOut"></div>`;

  const run = async () => {
    const sql = $('#sql').value;
    dbState.sql = sql;
    const out = await act($('#runSql'), () => api(`${base}/${encodeURIComponent(name)}/query`, { method: 'POST', body: { sql } }));
    if (!out) return;
    $('#sqlOut').innerHTML = renderResults(out);
    if (!out.results.length || /\b(create|drop|alter)\b/i.test(sql)) {
      // Cấu trúc có thể đã đổi: tải lại danh sách bảng, giữ kết quả vừa chạy
      const html = $('#sqlOut').innerHTML;
      await renderDbWork(base);
      $('#sqlOut').innerHTML = html;
    }
  };
  $('#runSql').onclick = run;
  $('#sql').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
  box.querySelectorAll('[data-table]').forEach(b => b.onclick = () => {
    $('#sql').value = `SELECT * FROM ${q(b.dataset.table)} LIMIT 100;`;
    run();
  });
}

function renderResults(out) {
  const summary = `<p class="result-meta">Đã chạy xong${out.statements > 1 ? ` ${out.statements} câu lệnh` : ''}. ${out.changes} dòng bị ảnh hưởng${out.insertId ? ` · ID vừa thêm: ${out.insertId}` : ''}.</p>`;
  if (!out.results.length) return summary;
  return (out.statements > 1 ? summary : '') + out.results.map(r => `
    <p class="result-meta">${r.total} dòng${r.total > r.rows.length ? `, hiển thị ${r.rows.length} dòng đầu` : ''}</p>
    <div class="result"><table>
      <thead><tr>${r.columns.map(c => `<th>${h(c)}</th>`).join('')}</tr></thead>
      <tbody>${r.rows.map(row => `<tr>${row.map(v => v === null ? '<td class="null">NULL</td>' : `<td title="${h(v)}">${h(v)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`).join('');
}

// ================= Dịch vụ =================
const STATE_TEXT = { running: 'Đang chạy', stopped: 'Đã dừng', starting: 'Đang khởi động', stopping: 'Đang dừng', paused: 'Tạm dừng', missing: 'Không có trên máy', unknown: 'Không rõ' };

async function renderServices() {
  const data = await api('/api/services');
  const rows = data.services.map(s => {
    const led = s.state === 'running' ? 'on' : s.state === 'missing' ? 'bad' : /ing$/.test(s.state) ? 'warn' : '';
    const can = data.supported && s.state !== 'missing';
    return `
    <tr class="svc-row" data-name="${h(s.name)}">
      <td><span class="led ${led}"></span></td>
      <td><div class="site-name">${h(s.displayName || s.name)}</div><div class="sub">${h(s.name)} · ${STATE_TEXT[s.state] || h(s.state)}</div></td>
      <td class="actions">
        ${can && s.state !== 'running' ? '<button class="btn small" data-act="start">Bật</button>' : ''}
        ${can && s.state === 'running' ? '<button class="btn small" data-act="restart">Khởi động lại</button><button class="btn small" data-act="stop">Tắt</button>' : ''}
        <button class="btn small danger" data-act="remove" title="Bỏ khỏi danh sách theo dõi (không gỡ dịch vụ)">Bỏ theo dõi</button>
      </td>
    </tr>`;
  }).join('');

  view.innerHTML = `
    <h1>Dịch vụ</h1>
    <p class="lead">Bật, tắt và khởi động lại các dịch vụ Windows như MySQL, Apache hay IIS. Để điều khiển dịch vụ, hãy chạy Sitebench bằng quyền Administrator.</p>
    ${data.supported ? '' : '<div class="notice">Máy này không chạy Windows nên chỉ xem được danh sách, không bật tắt được dịch vụ.</div>'}
    <form class="panel" id="svcForm">
      <h2>Theo dõi thêm dịch vụ</h2>
      <div class="row">
        <div class="field grow"><label for="svcName">Tên dịch vụ (Service name trong services.msc, ví dụ MySQL80, Apache2.4, MariaDB)</label><input id="svcName" required></div>
        <button class="btn primary">Thêm</button>
      </div>
    </form>
    <div class="panel flush"><div class="table-wrap">
      ${data.services.length ? `<table><tbody>${rows}</tbody></table>` : '<p class="empty">Chưa theo dõi dịch vụ nào. Thêm tên dịch vụ ở trên.</p>'}
    </div></div>`;

  $('#svcForm').addEventListener('submit', async e => {
    e.preventDefault();
    const ok = await act(e.submitter, () => api('/api/services', { method: 'POST', body: { name: $('#svcName').value.trim() } }), 'Đã thêm dịch vụ.');
    if (ok) route();
  });
  view.querySelector('tbody')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const name = btn.closest('tr').dataset.name;
    const a = btn.dataset.act;
    if (a === 'remove') {
      await act(btn, () => api(`/api/services/${encodeURIComponent(name)}`, { method: 'DELETE' }), 'Đã bỏ theo dõi.');
    } else {
      if (a === 'stop' && !confirm(`Tắt dịch vụ ${name}?`)) return;
      btn.textContent = 'Đang xử lý…';
      const msg = { start: 'Đã bật', stop: 'Đã tắt', restart: 'Đã khởi động lại' }[a];
      await act(btn, () => api(`/api/services/${encodeURIComponent(name)}/${a}`, { method: 'POST' }), `${msg} ${name}.`);
    }
    route();
  });
}

// ================= Laragon: PHP theo dự án =================
// Báo kết quả sau khi đổi cấu hình Apache
function reportApache(r, done) {
  if (r.reloaded) toast(`${done} Apache đã được khởi động lại.`);
  else if (r.reloadError) toast(`${done} Nhưng khởi động lại Apache thất bại: ${r.reloadError}`, true);
  else toast(`${done} Apache đang tắt, thay đổi sẽ có hiệu lực khi bật Apache.`);
  for (const w of r.warnings || []) toast(w, true);
}

async function loadSsl(anyHttps) {
  const box = $('#sslBox');
  const st = await api('/api/ssl').catch(() => null);
  if (!st || !box || !document.body.contains(box)) return;
  if (!anyHttps && !st.hasCA) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `
    <h2>Chứng chỉ HTTPS</h2>
    ${st.trusted
      ? '<p class="sub" style="margin:0"><span class="led on"></span> Chứng chỉ gốc của Sitebench đã được Windows tin cậy: Chrome và Edge mở https://ten.test không báo lỗi.</p>'
      : `<p class="sub" style="margin-top:0">${st.supported
        ? 'Chứng chỉ gốc chưa được cài vào Windows nên trình duyệt sẽ báo "kết nối không an toàn". Bấm nút dưới đây, Windows hỏi xác nhận thì chọn <b>Yes</b>.'
        : 'Cài chứng chỉ gốc vào hệ điều hành để trình duyệt tin cậy các tên miền .test.'}</p>
        ${st.supported ? '<button class="btn primary" id="sslTrust">Cài chứng chỉ gốc vào Windows</button>' : ''}`}
    <p class="sub" style="margin:.6rem 0 0">Chứng chỉ gốc chỉ cấp được cho tên miền .test và .localhost, không dùng được cho website thật.
      Firefox có thể cần nhập thủ công: <a href="/api/ssl/ca.crt">tải chứng chỉ gốc</a>.</p>`;
  $('#sslTrust')?.addEventListener('click', async e => {
    e.target.textContent = 'Đang chờ bạn xác nhận trong hộp thoại của Windows…';
    await act(e.target, () => api('/api/ssl/trust', { method: 'POST' }), 'Đã cài chứng chỉ gốc. Mở lại trình duyệt nếu vẫn thấy cảnh báo.');
    loadSsl(true);
  });
}

async function loadServices() {
  const box = $('#svcBox');
  let st;
  try { st = await api('/api/laragon/services'); } catch (e) {
    if (box) box.innerHTML = `<p class="error" style="padding:1rem">${h(e.message)}</p>`;
    return;
  }
  if (!document.body.contains(box)) return;
  const row = (key, label, x) => {
    const state = x.running ? 'Đang chạy' : x.starting ? 'Đang khởi động' : x.portTaken ? `Cổng ${x.port} bị chương trình khác dùng` : x.found ? 'Đã tắt' : 'Không tìm thấy trong Laragon';
    const led = x.running ? 'on' : x.starting ? 'warn' : x.portTaken ? 'bad' : '';
    return `<tr data-svc="${key}">
      <td><span class="led ${led}"></span></td>
      <td><div class="site-name">${label}</div><div class="sub">${h(x.version || '')} · cổng ${x.port} · ${state}</div></td>
      <td class="actions">${!x.found ? '' : x.running
        ? '<button class="btn small" data-sa="restart">Khởi động lại</button><button class="btn small" data-sa="stop">Tắt</button>'
        : '<button class="btn small primary" data-sa="start">Bật</button>'}</td></tr>`;
  };
  box.innerHTML = `
    <div class="toolbar"><strong style="flex:1">Apache và MySQL</strong>
      <button class="btn small primary" data-all="start">Bật tất cả</button>
      <button class="btn small" data-all="stop">Tắt tất cả</button></div>
    <div class="table-wrap"><table><tbody>${row('apache', 'Apache', st.apache)}${row('mysql', 'MySQL', st.mysql)}</tbody></table></div>
    <div class="toolbar" style="border-top:1px solid var(--line);border-bottom:0">
      <label class="switch"><input type="checkbox" id="autoStart" ${st.autoStart ? 'checked' : ''}> <span>Tự bật Apache và MySQL khi mở Sitebench</span></label></div>`;
  const runSvc = async (btn, svc, action) => {
    const label = { start: 'Đang bật…', stop: 'Đang tắt…', restart: 'Đang khởi động lại…' }[action];
    box.querySelectorAll('button').forEach(b => { b.disabled = true; });
    btn.textContent = label;
    const r = await act(null, () => api(`/api/laragon/services/${svc}/${action}`, { method: 'POST' }));
    if (r) toast(r.message);
    loadServices();
    refreshLeds();
  };
  box.querySelectorAll('[data-sa]').forEach(b => b.onclick = () => runSvc(b, b.closest('tr').dataset.svc, b.dataset.sa));
  box.querySelectorAll('[data-all]').forEach(b => b.onclick = () => runSvc(b, 'all', b.dataset.all));
  $('#autoStart').onchange = e => act(e.target, () => api('/api/laragon/services/autostart', { method: 'POST', body: { on: e.target.checked } }),
    e.target.checked ? 'Sitebench sẽ tự bật Apache và MySQL khi mở.' : 'Đã tắt tự bật Apache và MySQL.');
}

async function renderLaragon() {
  const d = await api('/api/laragon');
  if (!d.detected) {
    view.innerHTML = `
      <h1>Máy chủ &amp; dự án</h1>
      <p class="lead">Kết nối Sitebench với Laragon để chọn phiên bản PHP riêng cho từng dự án và dùng WP Toolkit.</p>
      <div class="notice">Không tìm thấy Laragon tại <b>${h(d.root)}</b>. Nhập đúng thư mục cài Laragon bên dưới.</div>
      ${laragonConfigForm(d)}`;
  bindLaragonConfig();
    return;
  }
  const opts = sel => `<option value="">Mặc định của Laragon (${h(d.versions.find(v => v.isDefault)?.version || '?')})</option>` +
    d.versions.map(v => `<option value="${h(v.id)}" ${sel === v.id ? 'selected' : ''}>PHP ${h(v.version)}${v.isDefault ? ' (đang chọn trong Laragon)' : ''}</option>`).join('');

  const verRows = d.versions.map(v => {
    const led = v.running ? 'on' : v.restarting || v.error ? 'warn' : '';
    const status = v.running ? `${v.workersRunning}/${v.workers} tiến trình đang chạy` : v.restarting ? 'Đang khởi động lại' : v.projects.length ? 'Đã dừng' : v.isDefault ? 'Chạy trong Apache' : 'Chưa dùng';
    return `<tr>
      <td><span class="led ${led}"></span></td>
      <td><div class="site-name">PHP ${h(v.version)}</div><div class="sub">${h(v.id)}${v.isDefault ? ' · đang chọn trong Laragon (chạy bằng module Apache)' : ''}</div>
        ${v.error ? `<div class="sub error">${h(v.error)}</div>` : ''}</td>
      <td class="sub">${status}${v.projects.length ? `<br>Dùng cho: ${v.projects.map(h).join(', ')}` : ''}</td>
      <td class="actions"><button class="btn small" data-phpcfg="${h(v.id)}">Cài đặt</button>${v.projects.length ? `<button class="btn small" data-restart="${h(v.id)}">Khởi động lại</button>` : ''}</td>
    </tr>`;
  }).join('');

  const projRows = d.projects.map(p => `
    <tr data-name="${h(p.name)}" data-search="${h(`${p.name} ${p.domain} ${p.wordpress ? 'wordpress' : ''} ${p.php || ''} ${p.https ? 'https' : ''}`.toLowerCase())}">
      <td><div class="site-name">${h(p.name)} ${p.wordpress ? '<span class="tag">WordPress</span>' : ''}</div>
        <div class="sub"><a href="${h(p.url)}" target="_blank" rel="noopener">${h(p.url)}</a></div>
        ${p.conflict ? '<div class="sub error">Laragon đã tạo lại tệp auto.* nên PHP riêng đang bị lấn át. Bấm Áp dụng để sửa.</div>' : ''}
        ${p.hasVhost ? '' : '<div class="sub">Dự án chưa có tên miền. Bấm "Tạo tên miền" để mở được trên trình duyệt.</div>'}
        ${p.customConf ? '<div class="sub">Dự án có tệp cấu hình tự viết, Sitebench sẽ giữ nội dung và chỉ thêm phần PHP.</div>' : ''}</td>
      <td><select data-php aria-label="Phiên bản PHP cho ${h(p.name)}">${opts(p.php)}</select>
        <div class="row" style="gap:.9rem;margin-top:.35rem">
          <label class="switch small"><input type="checkbox" data-https ${p.https ? 'checked' : ''}> <span>HTTPS</span></label>
          <label class="switch small"><input type="checkbox" data-lan ${p.lan ? 'checked' : ''}> <span>Wi-Fi</span></label>
          ${p.lan ? '<button class="btn small" data-qr>Mã QR</button>' : ''}
        </div></td>
      <td class="actions">
        ${p.hasVhost ? '' : '<button class="btn small" data-domain title="Tạo virtual host và thêm tên miền vào tệp hosts">Tạo tên miền</button>'}
        <button class="btn small primary" data-apply>Áp dụng</button>
        <button class="btn small" data-check>Kiểm tra</button>
        <button class="btn small" data-term title="Mở terminal tại thư mục dự án, dùng đúng PHP của dự án">Terminal</button>
        <button class="btn small danger" data-delete title="Sao lưu rồi xóa dự án và mọi thứ liên quan">Xóa</button>
        <div class="sub check-out"></div>
      </td>
    </tr>`).join('');

  view.innerHTML = `
    <h1>Máy chủ &amp; dự án</h1>
    <p class="lead">Bật tắt Apache và MySQL, chọn phiên bản PHP riêng cho từng dự án. Dự án để "Mặc định" dùng PHP đang chọn trong Laragon; dự án chọn bản khác chạy qua php-cgi do Sitebench quản lý.</p>
    <div class="panel" id="sslBox" hidden></div>
    <div class="panel flush" id="svcBox"><div class="toolbar"><strong style="flex:1">Apache và MySQL</strong></div><p class="empty">Đang kiểm tra…</p></div>
    <div class="panel flush">
      <div class="toolbar"><strong>Dự án trong ${h(d.root)}/www</strong>
        <input type="search" id="prSearch" class="grow" placeholder="Tìm dự án theo tên, tên miền, PHP…" aria-label="Tìm dự án">
        <span class="sub" id="prCount">${d.projects.length} dự án</span></div>
      <div class="table-wrap">${d.projects.length ? `<table><tbody>${projRows}</tbody></table><p class="empty" id="prNone" hidden>Không có dự án nào khớp.</p>` : '<p class="empty">Thư mục www chưa có dự án nào.</p>'}</div>
    </div>
    <div class="panel flush">
      <div class="toolbar"><strong style="flex:1">Phiên bản PHP có trong Laragon</strong>
        <label class="sub" for="phpWorkers">Số tiến trình cho mỗi bản PHP riêng</label>
        <select id="phpWorkers" title="Nhiều tiến trình = xử lý nhiều request cùng lúc (trang quản trị WooCommerce nhanh hơn), tốn thêm khoảng 30 MB RAM mỗi tiến trình">${[1, 2, 4, 6, 8, 12].map(n => `<option ${n === d.phpWorkers ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="table-wrap"><table><tbody>${verRows || '<tr><td class="empty">Không tìm thấy phiên bản PHP nào.</td></tr>'}</tbody></table></div>
    </div>
    <form class="panel" id="phpGet">
      <h2>Tải thêm phiên bản PHP</h2>
      <p class="sub" style="margin-top:-.4rem">Tải bản chính thức (Thread Safe, x64) từ downloads.php.net và cài vào ${h(d.root)}/bin/php. Chọn đúng phiên bản production đang dùng.</p>
      <div class="row">
        <div class="field grow"><label for="phpPick">Phiên bản</label><select id="phpPick" disabled><option>Đang tải danh sách…</option></select></div>
        <button class="btn primary" id="phpGetBtn" disabled>Tải và cài</button>
      </div>
    </form>
    <details class="panel"><summary style="cursor:pointer"><b>Cài đặt kết nối Laragon</b> <span class="sub">Apache: ${h(d.apache || 'không tìm thấy')} · MySQL: ${d.mysqlBin ? 'có' : 'không tìm thấy'}</span></summary>
      <div style="margin-top:1rem">${laragonConfigForm(d)}</div></details>`;

  bindLaragonConfig();
  bindSearch('#prSearch', view.querySelectorAll('tr[data-search]'), '#prCount', '#prNone', 'dự án');
  loadPhpCatalog();
  loadServices();
  loadSsl(d.projects.some(p => p.https));
  view.querySelectorAll('[data-phpcfg]').forEach(b => b.onclick = () => openPhpSettings(b.dataset.phpcfg).catch(e => toast(e.message, true)));
  $('#phpWorkers').onchange = async e => {
    const r = await act(e.target, () => api('/api/laragon/workers', { method: 'POST', body: { count: Number(e.target.value) } }));
    if (r) { reportApache(r, `Mỗi bản PHP riêng giờ chạy ${r.workers} tiến trình.`); setTimeout(renderLaragon, 800); }
  };
  view.querySelectorAll('[data-restart]').forEach(b => b.onclick = async () => {
    await act(b, () => api(`/api/laragon/php/${encodeURIComponent(b.dataset.restart)}/restart`, { method: 'POST' }), 'Đã khởi động lại php-cgi.');
    setTimeout(renderLaragon, 800);
  });
  view.querySelector('tbody')?.addEventListener('change', async e => {
    if (e.target.matches('[data-lan]')) {
      const ok = await toggleLan(e.target.closest('tr[data-name]').dataset.name, e.target.checked, e.target);
      if (ok) renderLaragon();
      return;
    }
    if (!e.target.matches('[data-https]')) return;
    const tr = e.target.closest('tr[data-name]');
    const name = tr.dataset.name, on = e.target.checked;
    const r = await act(e.target, () => api(`/api/laragon/projects/${encodeURIComponent(name)}/https`, { method: 'POST', body: { on } }));
    if (!r) { e.target.checked = !on; return; }
    reportApache(r, on ? `Đã bật HTTPS cho ${name}.` : `Đã tắt HTTPS cho ${name}.`);
    if (r.note) toast(r.note);
    renderLaragon();
  });
  view.querySelector('tbody')?.addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-name]');
    if (!tr) return;
    const name = tr.dataset.name;
    if (e.target.matches('[data-apply]')) {
      const php = $('[data-php]', tr).value || null;
      e.target.textContent = 'Đang áp dụng…';
      const r = await act(e.target, () => api(`/api/laragon/projects/${encodeURIComponent(name)}/php`, { method: 'POST', body: { php } }));
      e.target.textContent = 'Áp dụng';
      if (r) { reportApache(r, `Đã đổi PHP cho ${name}.`); setTimeout(renderLaragon, 600); }
    }
    if (e.target.matches('[data-term]')) { openTerminalFor(name); return; }
    if (e.target.matches('[data-delete]')) { openDelete(name, () => renderLaragon()); return; }
    if (e.target.matches('[data-https], [data-lan]')) return; // xử lý ở sự kiện change
    if (e.target.matches('[data-qr]')) { showLan(name); return; }
    if (e.target.matches('[data-domain]')) {
      e.target.textContent = 'Đang tạo…';
      const r = await act(e.target, () => api(`/api/laragon/projects/${encodeURIComponent(name)}/domain`, { method: 'POST' }));
      if (r) { reportApache(r, `Đã tạo tên miền cho ${name}.`); renderLaragon(); }
      return;
    }
    if (e.target.matches('[data-check]')) {
      const out = $('.check-out', tr);
      out.textContent = 'Đang kiểm tra…';
      const r = await act(e.target, () => api(`/api/laragon/projects/${encodeURIComponent(name)}/check`, { method: 'POST' }));
      out.innerHTML = !r ? '' : r.ok
        ? `<span class="led on"></span> Đang chạy PHP ${h(r.version)} (${h(r.sapi)})`
        : `<span class="error">${h(r.message)}</span>`;
    }
  });
}

async function loadPhpCatalog() {
  const sel = $('#phpPick');
  let list;
  try { list = (await api('/api/laragon/php-catalog')).versions; } catch (e) {
    if (sel) sel.innerHTML = `<option>${h(e.message)}</option>`;
    return;
  }
  if (!document.body.contains(sel)) return;
  const branches = new Map();
  for (const v of list) {
    const b = v.version.split('.').slice(0, 2).join('.');
    if (!branches.has(b)) branches.set(b, []);
    branches.get(b).push(v);
  }
  sel.innerHTML = [...branches].map(([b, vs]) => `<optgroup label="PHP ${h(b)}">${vs.map(v =>
    `<option value="${h(v.file)}" ${v.installed ? 'disabled' : ''}>PHP ${h(v.version)}${v.installed ? ' (đã có)' : ''}</option>`).join('')}</optgroup>`).join('');
  const first = list.find(v => !v.installed);
  if (first) sel.value = first.file;
  sel.disabled = false;
  $('#phpGetBtn').disabled = false;
  $('#phpGet').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#phpGetBtn');
    btn.textContent = 'Đang tải và giải nén…';
    const r = await act(btn, () => api('/api/laragon/php-install', { method: 'POST', body: { file: sel.value } }));
    btn.textContent = 'Tải và cài';
    if (!r) return;
    if (r.warning) toast(r.warning, true);
    else toast(`Đã cài PHP ${r.version}. Giờ có thể chọn bản này cho dự án.`);
    renderLaragon();
  };
}

function laragonConfigForm(d) {
  return `<form id="lgForm" class="row">
    <div class="field grow"><label for="lgRoot">Thư mục cài Laragon</label><input id="lgRoot" value="${h(d.root)}" required></div>
    <div class="field" style="width:8rem"><label for="lgSuffix">Đuôi tên miền</label><input id="lgSuffix" value="${h(d.domainSuffix)}"></div>
    <div class="field" style="width:7rem"><label for="lgPort">Cổng Apache</label><input id="lgPort" type="number" value="${h(d.httpPort || 80)}"></div>
    <button class="btn primary">Lưu</button></form>`;
}
function bindLaragonConfig() {
  $('#lgForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const ok = await act(e.submitter, () => api('/api/laragon/config', { method: 'POST', body: {
      root: $('#lgRoot').value, domainSuffix: $('#lgSuffix').value, httpPort: $('#lgPort').value } }), 'Đã lưu cài đặt Laragon.');
    if (ok) renderLaragon();
  });
}

// ================= WordPress (WP Toolkit) =================
// ----- Tương thích WordPress / PHP (theo yêu cầu tối thiểu và mức hỗ trợ PHP của WordPress) -----
const verGE = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return true;
};
function wpPhpWarnings(wpVer, phpVer) {
  if (!wpVer || wpVer === 'latest' || !phpVer || !/^\d/.test(wpVer)) return [];
  const out = [];
  const minPhp = verGE(wpVer, '6.6') ? '7.2.24' : verGE(wpVer, '6.3') ? '7.0' : verGE(wpVer, '5.2') ? '5.6.20' : '5.2.4';
  if (!verGE(phpVer, minPhp)) out.push(`WordPress ${wpVer} cần PHP ${minPhp} trở lên.`);
  for (const [php, needWp] of [['8.4', '6.7'], ['8.3', '6.4'], ['8.2', '6.1'], ['8.1', '5.9'], ['8.0', '5.6']]) {
    if (verGE(phpVer, php)) {
      if (!verGE(wpVer, needWp)) out.push(`WordPress chỉ hỗ trợ PHP ${php} từ bản ${needWp}, nên WordPress ${wpVer} chạy trên PHP ${phpVer} có thể báo lỗi hoặc cảnh báo.`);
      break;
    }
  }
  return out;
}
let wpVersionList = null;
async function loadWpVersions() {
  if (!wpVersionList) {
    wpVersionList = api('/api/wp/versions').then(d => d.versions).catch(() => { wpVersionList = null; return []; });
  }
  return wpVersionList;
}
// Gợi ý phiên bản: bản mới nhất của mỗi nhánh trước, rồi tới mọi bản
async function fillWpDatalist(id) {
  const list = await loadWpVersions();
  const dl = document.getElementById(id);
  if (!dl || !list.length) return;
  const seen = new Set(), heads = [], rest = [];
  for (const v of list) {
    const branch = v.version.split('.').slice(0, 2).join('.');
    (seen.has(branch) ? rest : heads).push(v);
    seen.add(branch);
  }
  const label = st => st === 'latest' ? 'mới nhất' : st === 'insecure' ? 'có lỗ hổng bảo mật' : 'bản cũ';
  dl.innerHTML = [...heads, ...rest].map(v => `<option value="${h(v.version)}">${label(v.status)}</option>`).join('');
}

const wpState = { selected: null };
const randomPass = () => {
  const c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => c[b % c.length]).join('');
};

async function renderWp() {
  const d = await api('/api/wp');
  if (!d.detected) {
    view.innerHTML = `<h1>WordPress</h1><div class="notice">Cần kết nối Laragon trước. Vào mục <a href="#laragon">Laragon</a> để nhập thư mục cài Laragon.</div>`;
    return;
  }
  if (wpState.selected && !d.sites.some(s => s.name === wpState.selected)) wpState.selected = null;
  if (wpState.selected) return renderWpSite(wpState.selected);

  const rows = d.sites.map(s => `
    <tr data-search="${h(`${s.name} ${s.url} ${s.version || ''} php ${s.phpVersion}`.toLowerCase())}">
      <td><span class="led ${s.maintenance ? 'warn' : s.installed ? 'on' : ''}"></span></td>
      <td><div class="site-name">${h(s.name)}</div>
        <div class="sub"><a href="${h(s.url)}/" target="_blank" rel="noopener">${h(s.url)}</a> · <a href="${h(s.url)}/wp-admin/" target="_blank" rel="noopener">Trang quản trị</a></div></td>
      <td class="sub">WordPress ${h(s.version || '?')}<br>PHP ${h(s.phpVersion)}${s.php ? '' : ' (mặc định)'}</td>
      <td class="sub">${[s.debug && 'Debug bật', s.maintenance && 'Đang bảo trì', s.busy && `Đang ${s.busy}`].filter(Boolean).map(h).join('<br>')}</td>
      <td class="actions"><button class="btn small primary" data-open="${h(s.name)}">Quản lý</button></td>
    </tr>`).join('');

  view.innerHTML = `
    <div class="page-head">
      <div><h1>WordPress</h1>
        <p class="lead">Cài mới, cập nhật, sao lưu, nhân bản và quản lý các site WordPress trong Laragon.</p></div>
      <div class="row">
        <button class="btn" id="wpTemplates">Template</button>
        <button class="btn primary" id="wpAdd">+ Thêm dự án WordPress</button>
      </div>
    </div>
    <div class="panel flush">
      <div class="toolbar"><input type="search" id="wpSearch" class="grow" placeholder="Tìm site theo tên, địa chỉ, phiên bản…" aria-label="Tìm site"><span class="sub" id="wpCount">${d.sites.length} site</span></div>
      <div class="table-wrap">
        ${d.sites.length ? `<table><tbody>${rows}</tbody></table><p class="empty" id="wpNone" hidden>Không có site nào khớp.</p>`
          : '<p class="empty">Chưa có site WordPress nào. Bấm "Thêm dự án WordPress" để cài site đầu tiên.</p>'}
      </div>
    </div>`;
  view.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { wpState.selected = b.dataset.open; renderWp(); });
  bindSearch('#wpSearch', view.querySelectorAll('tr[data-search]'), '#wpCount', '#wpNone', 'site');
  $('#wpAdd').onclick = () => openWpInstall(d).catch(e => toast(e.message, true));
  $('#wpTemplates').onclick = () => openTemplates().catch(e => toast(e.message, true));
}

// Ô tìm kiếm lọc các hàng có data-search
function bindSearch(input, rows, countSel, noneSel, unit) {
  const box = $(input);
  if (!box) return;
  const run = () => {
    const terms = box.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let shown = 0;
    rows.forEach(r => { const ok = terms.every(t => r.dataset.search.includes(t)); r.hidden = !ok; if (ok) shown++; });
    if (countSel && $(countSel)) $(countSel).textContent = terms.length ? `${shown}/${rows.length} ${unit}` : `${rows.length} ${unit}`;
    if (noneSel && $(noneSel)) $(noneSel).hidden = shown > 0 || !rows.length;
  };
  box.addEventListener('input', run);
  box.addEventListener('keydown', e => { if (e.key === 'Escape') { box.value = ''; run(); } });
}

// ----- Hộp thoại: cài WordPress mới -----
const WP_LOCALES = [['vi', 'Tiếng Việt'], ['en_US', 'English'], ['ja', '日本語 (Tiếng Nhật)']];
async function openWpInstall(d) {
  const { templates } = await api('/api/templates');
  const phpOpts = `<option value="">Mặc định của Laragon</option>` + d.versions.map(v => `<option value="${h(v.id)}">PHP ${h(v.version)}</option>`).join('');
  const dlg = modal('Thêm dự án WordPress', `
    <form id="wpInstall">
      <div class="settings-grid">
        <div class="field"><label for="wpName">Tên dự án (thành tên miền .test)</label><input id="wpName" required pattern="[a-z0-9-]+" placeholder="shop-moi" autofocus></div>
        <div class="field"><label for="wpTitle">Tên website</label><input id="wpTitle" placeholder="Cửa hàng mới"></div>
        <div class="field"><label for="wpLocale">Ngôn ngữ</label><select id="wpLocale">${WP_LOCALES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field"><label for="wpVer">Phiên bản WordPress</label><input id="wpVer" list="wpVerList" value="latest" required><datalist id="wpVerList"></datalist></div>
        <div class="field"><label for="wpPhp">PHP (<a href="#laragon" data-close-link>tải thêm</a>)</label><select id="wpPhp">${phpOpts}</select></div>
        <div class="field"><label for="wpTpl">Template</label><select id="wpTpl"><option value="">Không dùng (giao diện mặc định)</option>
          ${templates.map(t => `<option value="${h(t.id)}">${h(t.name)}</option>`).join('')}</select>
          <span class="sub"><a href="#" id="wpTplManage">Quản lý template</a></span></div>
      </div>
      <label class="switch" style="margin-top:.75rem"><input type="checkbox" id="wpLock"> <span>Giữ nguyên phiên bản, tắt tự động cập nhật (nên bật khi muốn giống production)</span></label>
      <div id="wpCompat" class="compat"></div>
      <h2>Tài khoản quản trị</h2>
      <div class="settings-grid">
        <div class="field"><label for="wpUser">Tên đăng nhập</label><input id="wpUser" value="admin" required></div>
        <div class="field"><label for="wpPass">Mật khẩu</label><input id="wpPass" value="${h(randomPass())}" required minlength="8"></div>
        <div class="field"><label for="wpEmail">Email</label><input id="wpEmail" type="email" value="admin@example.com" required></div>
      </div>
      <p class="sub">Sitebench tự tạo tên miền .test và khởi động lại Apache. Hãy lưu lại mật khẩu quản trị.</p>
      <button class="btn primary">Cài WordPress</button>
    </form>
    <div id="wpJob"></div>`);
  fillWpDatalist('wpVerList');
  dlg.querySelector('[data-close-link]').onclick = () => dlg.close();
  $('#wpTplManage', dlg).onclick = e => {
    e.preventDefault();
    let known = null;
    openTemplates(list => {
      const sel = $('#wpTpl', dlg), keep = sel.value;
      sel.innerHTML = '<option value="">Không dùng (giao diện mặc định)</option>' + list.map(t => `<option value="${h(t.id)}">${h(t.name)}</option>`).join('');
      // Template vừa thêm thì chọn sẵn; còn lại giữ lựa chọn cũ
      const added = known ? list.find(t => !known.includes(t.id)) : null;
      sel.value = added ? added.id : list.some(t => t.id === keep) ? keep : '';
      known = list.map(t => t.id);
    });
  };
  const phpVerOf = id => (d.versions.find(v => v.id === id) || d.versions.find(v => v.id === d.defaultPhp) || {}).version;
  const updateCompat = () => {
    $('#wpCompat', dlg).innerHTML = wpPhpWarnings($('#wpVer', dlg).value.trim(), phpVerOf($('#wpPhp', dlg).value)).map(x => `<p class="warn-line">${h(x)}</p>`).join('');
  };
  $('#wpVer', dlg).addEventListener('input', () => { $('#wpLock', dlg).checked = !['', 'latest'].includes($('#wpVer', dlg).value.trim()); updateCompat(); });
  $('#wpPhp', dlg).addEventListener('change', updateCompat);
  $('#wpInstall', dlg).addEventListener('submit', async e => {
    e.preventDefault();
    const body = { name: $('#wpName', dlg).value.trim(), title: $('#wpTitle', dlg).value.trim(), locale: $('#wpLocale', dlg).value,
      php: $('#wpPhp', dlg).value || undefined, user: $('#wpUser', dlg).value.trim(), pass: $('#wpPass', dlg).value, email: $('#wpEmail', dlg).value.trim(),
      version: $('#wpVer', dlg).value.trim() || 'latest', autoUpdate: !$('#wpLock', dlg).checked, template: $('#wpTpl', dlg).value || undefined };
    const r = await act(e.submitter, () => api('/api/wp', { method: 'POST', body }));
    if (!r) return;
    e.target.hidden = true;
    watchJob(r.job, $('#wpJob', dlg), (res, out) => {
      out.innerHTML = `<p><b>Đã cài ${h(res.name)}.</b> <a href="${h(res.url)}" target="_blank" rel="noopener">${h(res.url)}</a> ·
        <a href="${h(res.adminUrl)}" target="_blank" rel="noopener">Trang quản trị</a> (tài khoản ${h(body.user)})</p>
        ${res.notes.length ? `<ul class="notes">${res.notes.map(n => `<li>${h(n)}</li>`).join('')}</ul>` : ''}
        <p><button class="btn small primary" data-go>Quản lý site</button> <button class="btn small" data-t>Mở terminal</button></p>`;
      out.querySelector('[data-go]').onclick = () => { dlg.close(); wpState.selected = res.name; renderWp(); };
      out.querySelector('[data-t]').onclick = () => { dlg.close(); openTerminalFor(res.name); };
      if (location.hash === '#wp' && !wpState.selected) renderWp();
    });
  });
}

// ----- Hộp thoại: quản lý template -----
async function openTemplates(onChange) {
  const { templates } = await api('/api/templates');
  onChange?.(templates);
  const dlg = modal('Template cho site WordPress mới', `
    <p class="sub" style="margin-top:0">Template là giao diện (theme), plugin hoặc cả thư mục wp-content mà bạn hay dùng để bắt đầu dự án, ví dụ một starter theme dùng Vite.
      Nguồn có thể là thư mục trên máy, tệp .zip hoặc địa chỉ Git. Khi cài site, Sitebench chép template vào, chạy npm install / composer install và kích hoạt.</p>
    <div class="table-wrap">${templates.length ? `<table><tbody>${templates.map(t => `
      <tr data-id="${h(t.id)}"><td><div class="site-name">${h(t.name)}</div><div class="sub log-path">${h(t.source)}</div>
        <div class="sub">${t.install === false ? 'Không tự cài thư viện' : 'Tự chạy npm install / composer install'}</div></td>
        <td class="actions"><button class="btn small" data-check>Kiểm tra</button><button class="btn small danger" data-del>Xóa</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="empty">Chưa có template nào.</p>'}</div>
    <form id="tplForm">
      <h2>Thêm template</h2>
      <div class="settings-grid">
        <div class="field"><label for="tplName">Tên</label><input id="tplName" required placeholder="wp-vite-starter"></div>
        <div class="field" style="grid-column: span 2"><label for="tplSource">Nguồn: thư mục, tệp .zip hoặc địa chỉ Git</label>
          <input id="tplSource" required placeholder="D:\\code\\wp-vite-starter  hoặc  https://github.com/ban/wp-vite-starter"></div>
      </div>
      <label class="switch" style="margin-top:.6rem"><input type="checkbox" id="tplInstall" checked> <span>Tự chạy npm install / composer install sau khi chép</span></label>
      <p class="sub">Repo riêng tư trên GitHub: dùng địa chỉ SSH (git@github.com:…) nếu máy đã cài khóa SSH, hoặc tải về thành thư mục rồi chọn thư mục đó. Thêm "#ten-nhanh" vào cuối địa chỉ Git để chọn nhánh.</p>
      <div class="row"><button class="btn" type="button" id="tplCheck">Kiểm tra nguồn</button><button class="btn primary">Lưu template</button></div>
      <div id="tplResult"></div>
    </form>`, 'modal-tpl');
  const showCheck = (r, box) => {
    if (!r) { box.innerHTML = ''; return; }
    box.innerHTML = r.type === 'site'
      ? `<div class="warn-line" style="border-color:var(--on)">Nhận ra: <b>${h(r.label)}</b>${r.manifest ? ' (theo tpanel.json)' : ''}, chép chồng lên gốc site.${r.nodeRange ? ` Cần Node ${h(r.nodeRange)}.` : ''}
          ${r.steps?.length ? `<br>Khi tạo dự án, Sitebench sẽ: ${r.steps.map(h).join('; ')}.` : ''}</div>`
      : `<p class="warn-line" style="border-color:var(--on)">Nhận ra: ${r.type === 'theme' ? `giao diện <b>${h(r.label)}</b>` : r.type === 'plugin' ? `plugin <b>${h(r.label)}</b>` : 'thư mục wp-content'}
      ${r.nested ? ` (trong ${h(r.nested)})` : ''} · ${[r.vite && 'Vite', r.npm && 'npm', r.composer && 'Composer'].filter(Boolean).join(', ') || 'không có công cụ build'}</p>`;
  };
  $('#tplCheck', dlg).onclick = async e => {
    e.target.textContent = 'Đang kiểm tra…';
    const r = await act(e.target, () => api('/api/templates/inspect', { method: 'POST', body: { source: $('#tplSource', dlg).value } }));
    e.target.textContent = 'Kiểm tra nguồn';
    showCheck(r, $('#tplResult', dlg));
  };
  $('#tplForm', dlg).addEventListener('submit', async e => {
    e.preventDefault();
    const r = await act(e.submitter, () => api('/api/templates', { method: 'POST', body: { name: $('#tplName', dlg).value, source: $('#tplSource', dlg).value, install: $('#tplInstall', dlg).checked } }), 'Đã lưu template.');
    if (r) openTemplates(onChange);
  });
  dlg.querySelectorAll('tr[data-id]').forEach(tr => {
    const t = templates.find(x => x.id === tr.dataset.id);
    tr.querySelector('[data-check]').onclick = async e => {
      e.target.textContent = 'Đang kiểm tra…';
      const r = await act(e.target, () => api('/api/templates/inspect', { method: 'POST', body: { source: t.source } }));
      e.target.textContent = 'Kiểm tra';
      if (r) toast(`${t.name}: ${r.type === 'site' ? `${r.label}${r.steps?.length ? ` · ${r.steps.join('; ')}` : ''}` : r.type === 'theme' ? `giao diện "${r.label}"` : r.type === 'plugin' ? `plugin "${r.label}"` : 'wp-content'}${r.vite ? ', có Vite' : ''}.`);
    };
    tr.querySelector('[data-del]').onclick = async e => {
      if (!confirm(`Xóa template ${t.name}? (Không xóa thư mục nguồn của bạn.)`)) return;
      if (await act(e.target, () => api(`/api/templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' }))) openTemplates(onChange);
    };
  });
}

async function renderWpSite(name) {
  const s = await api(`/api/wp/${encodeURIComponent(name)}`);
  const enc = encodeURIComponent(name);
  const backups = s.backups.map(b => `
    <tr data-file="${h(b.file)}">
      <td>${fmtDate(b.created)}</td><td class="num">${fmtSize(b.size)}</td>
      <td class="actions">
        <a class="btn small" href="/api/wp/${enc}/backups/${encodeURIComponent(b.file)}">Tải về</a>
        <button class="btn small" data-restore>Khôi phục</button>
        <button class="btn small danger" data-del>Xóa</button>
      </td></tr>`).join('');

  view.innerHTML = `
    <p><button class="btn small" id="wpBack">Tất cả site WordPress</button></p>
    <h1>${h(s.name)}</h1>
    <p class="lead"><a href="${h(s.url)}/" target="_blank" rel="noopener">${h(s.url)}</a> · <a href="${h(s.url)}/wp-admin/" target="_blank" rel="noopener">Trang quản trị</a>
      · WordPress ${h(s.version || '?')} · PHP ${h(s.phpVersion)}${s.php ? '' : ' (mặc định)'} · Database ${h(s.db || '?')}
      · <a href="#terminal" id="wpTerm">Mở terminal</a></p>

    <div class="panel">
      <h2>Chế độ</h2>
      <div class="toggles">
        <label class="switch"><input type="checkbox" id="tDebug" ${s.debug ? 'checked' : ''}> <span>Debug: hiện lỗi PHP và ghi vào wp-content/debug.log</span></label>
        <label class="switch"><input type="checkbox" id="tMaint" ${s.maintenance ? 'checked' : ''}> <span>Bảo trì: khách truy cập thấy thông báo "đang bảo trì"</span></label>
        <label class="switch"><input type="checkbox" id="tAuto" ${s.autoUpdate ? 'checked' : ''}> <span>Tự động cập nhật WordPress và plugin (tắt để giữ đúng phiên bản như production)</span></label>
      </div>
      <p class="sub" style="margin:.75rem 0 0">Đổi phiên bản PHP của site trong mục <a href="#laragon">Laragon</a>.</p>
    </div>

    <div class="panel" id="wpShop"><h2>Shop, ảnh và điện thoại</h2><p class="muted">Đang kiểm tra…</p></div>

    <div class="panel" id="wpExtras"><h2>Cập nhật, plugin và tài khoản</h2><p class="muted">Đang đọc thông tin từ WordPress…</p></div>

    <div class="panel flush">
      <div class="toolbar"><strong style="flex:1">Sao lưu</strong><button class="btn primary" id="wpBackup">Sao lưu ngay</button></div>
      <div class="table-wrap">${backups ? `<table><tbody>${backups}</tbody></table>` : '<p class="empty">Chưa có bản sao lưu. Bản sao lưu gồm toàn bộ tệp và database.</p>'}</div>
    </div>

    <form class="panel" id="wpClone">
      <h2>Nhân bản thành site thử nghiệm</h2>
      <p class="sub" style="margin-top:-.4rem">Sao chép toàn bộ tệp và database sang tên mới, tự đổi địa chỉ ${h(s.name)}.test thành tên mới.</p>
      <div class="row"><div class="field grow"><label for="cloneName">Tên site mới</label><input id="cloneName" required pattern="[a-z0-9-]+" value="${h(s.name)}-staging"></div>
        <button class="btn primary">Nhân bản</button></div>
    </form>

    <div class="panel">
      <h2>Sửa .htaccess từ host</h2>
      <p class="sub" style="margin-top:-.4rem">Site kéo từ host báo "Internal Server Error"? Tắt các dòng .htaccess chỉ chạy được trên host (khóa mật khẩu trỏ tới .htpasswd của host, php_value, bộ xử lý PHP của cPanel…), rồi mở thử site.</p>
      <button class="btn" id="wpFixHta">Sửa .htaccess và mở thử</button>
      <div id="wpFixHtaOut"></div>
    </div>

    <div class="panel danger-zone">
      <h2>Xóa site</h2>
      <p class="sub" style="margin-top:-.4rem">Sao lưu rồi xóa thư mục ${h(s.name)}, database ${h(s.db || '')} và cấu hình liên quan. Khôi phục lại được ở mục Sao lưu.</p>
      <button class="btn danger" id="wpDelete">Xóa site này</button>
    </div>`;

  $('#wpBack').onclick = () => { wpState.selected = null; renderWp(); };
  $('#wpFixHta').onclick = async e => {
    const r = await act(e.target, () => api(`/api/import/fix-htaccess/${encodeURIComponent(name)}`, { method: 'POST' }));
    if (!r) return;
    const pages = Object.entries(r.probe.pages).map(([p, c]) => `${h(p)} → <b>${c || 'không phản hồi'}</b>`).join(' · ');
    $('#wpFixHtaOut').innerHTML = `<ul class="notes">${(r.notes.length ? r.notes : ['Không có dòng nào cần sửa.']).map(n => `<li>${h(n)}</li>`).join('')}
      <li>Mở thử: ${pages}${r.probe.reason ? `<br><span class="error">Apache báo: ${h(r.probe.reason)}</span>` : ''}</li></ul>`;
  };
  $('#wpTerm').onclick = e => { e.preventDefault(); openTerminalFor(name); };
  const post = (url, body) => api(`/api/wp/${enc}${url}`, { method: 'POST', body });
  $('#tDebug').onchange = e => act(e.target, () => post('/debug', { on: e.target.checked }), e.target.checked ? 'Đã bật debug.' : 'Đã tắt debug.');
  $('#tAuto').onchange = e => act(e.target, () => post('/autoupdate', { on: e.target.checked }), e.target.checked ? 'Đã bật tự động cập nhật.' : 'Đã tắt tự động cập nhật.');
  $('#tMaint').onchange = e => act(e.target, () => post('/maintenance', { on: e.target.checked }), e.target.checked ? 'Đã bật chế độ bảo trì.' : 'Đã tắt chế độ bảo trì.');

  $('#wpBackup').onclick = async e => {
    e.target.textContent = 'Đang sao lưu…';
    await act(e.target, () => post('/backups'), 'Đã tạo bản sao lưu.');
    renderWpSite(name);
  };
  view.querySelector('.panel.flush tbody')?.addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-file]');
    if (!tr) return;
    const file = encodeURIComponent(tr.dataset.file);
    if (e.target.matches('[data-restore]')) {
      if (!confirm('Khôi phục bản sao lưu này? Toàn bộ tệp và database hiện tại của site sẽ bị thay thế.')) return;
      e.target.textContent = 'Đang khôi phục…';
      await act(e.target, () => post(`/backups/${file}/restore`), 'Đã khôi phục site.');
      renderWpSite(name);
    }
    if (e.target.matches('[data-del]')) {
      if (!confirm('Xóa bản sao lưu này?')) return;
      await act(e.target, () => api(`/api/wp/${enc}/backups/${file}`, { method: 'DELETE' }), 'Đã xóa bản sao lưu.');
      renderWpSite(name);
    }
  });

  $('#wpClone').addEventListener('submit', async e => {
    e.preventDefault();
    const target = $('#cloneName').value.trim();
    e.submitter.textContent = 'Đang nhân bản…';
    const r = await act(e.submitter, () => post('/clone', { target }));
    e.submitter.textContent = 'Nhân bản';
    if (r) reportApache(r, `Đã tạo ${target}.`);
    if (r) { wpState.selected = target; renderWp(); }
  });

  $('#wpDelete').onclick = () => openDelete(name, () => { wpState.selected = null; });

  loadWpExtras(name);
  loadWpShop(name, s);
}

async function loadWpShop(name, site) {
  const box = $('#wpShop');
  const enc = encodeURIComponent(name);
  let x, lg;
  try { [x, lg] = await Promise.all([api(`/api/wpx/${enc}`), api('/api/laragon')]); } catch (e) {
    box.innerHTML = `<h2>Shop, ảnh và điện thoại</h2><p class="error">${h(e.message)}</p>`;
    return;
  }
  if (!document.body.contains(box)) return;
  const sh = x.shop, up = x.uploads;
  const proj = lg.projects.find(p => p.name === name) || {};
  box.innerHTML = `
    <h2>Shop, ảnh và điện thoại</h2>
    ${sh.woocommerce ? `
      <label class="switch"><input type="checkbox" id="shSafety" ${sh.safety ? 'checked' : ''}> <span><b>Chế độ an toàn cho shop</b>: tắt cổng thanh toán trực tuyến, tạm dừng tác vụ ngầm (Action Scheduler, WP-Cron) và webhook</span></label>
      ${sh.safety ? `<p class="sub" style="margin:.3rem 0 0 1.7rem">${sh.gatewaysDisabled.length ? `Đã tắt: ${sh.gatewaysDisabled.map(h).join(', ')}.` : 'Không có cổng thanh toán trực tuyến nào đang bật.'} Chuyển khoản, séc, COD vẫn dùng được để đặt đơn thử.</p>` : ''}
      <p style="margin:.9rem 0 0"><button class="btn" id="shAnon">Ẩn danh dữ liệu khách hàng</button>
        <span class="sub">${sh.anonymized ? `Đã ẩn danh lúc ${fmtDate(Date.parse(sh.anonymized))}.` : 'Đổi email, số điện thoại, địa chỉ, tên của khách và đơn hàng; không đụng tài khoản quản trị.'}</span></p>
      <hr>` : '<p class="sub" style="margin-top:-.4rem">Site không dùng WooCommerce nên không cần chế độ an toàn cho shop.</p>'}
    <form id="upForm" class="row" style="align-items:center">
      <label class="switch"><input type="checkbox" id="upOn" ${up.enabled ? 'checked' : ''}> <span><b>Ảnh lấy từ production</b> khi máy này không có</span></label>
      <input id="upUrl" class="grow" placeholder="https://ten-mien-that.vn" value="${h(up.prodUrl || '')}">
      <button class="btn small">Lưu</button>
    </form>
    <hr>
    <div class="row" style="align-items:center">
      <label class="switch"><input type="checkbox" id="lanOn" ${proj.lan ? 'checked' : ''}> <span><b>Xem trên điện thoại</b> qua Wi-Fi</span></label>
      ${proj.lan ? '<button class="btn small" id="lanQr">Mã QR</button>' : ''}
    </div>`;
  $('#shSafety')?.addEventListener('change', async e => {
    const on = e.target.checked;
    let restore = false;
    if (!on) restore = confirm('Bật lại các cổng thanh toán đã tắt?\n\nOK = bật lại như trước (cẩn thận: có thể trừ tiền thật nếu là chế độ live)\nCancel = giữ các cổng thanh toán đang tắt');
    const r = await act(e.target, () => api(`/api/wpx/${enc}/safety`, { method: 'POST', body: { on, restoreGateways: restore } }));
    if (r) { toast(on ? `Đã bật chế độ an toàn${r.gateways.length ? `, tắt ${r.gateways.join(', ')}` : ''}.` : 'Đã tắt chế độ an toàn.'); loadWpShop(name, site); }
    else e.target.checked = !on;
  });
  $('#shAnon')?.addEventListener('click', async e => {
    if (!confirm('Ẩn danh dữ liệu khách hàng của site này? Không thể hoàn tác (dữ liệu thật vẫn còn trên production).')) return;
    const r = await act(e.target, () => api(`/api/wpx/${enc}/anonymize`, { method: 'POST' }));
    if (r) { toast(`Đã ẩn danh ${Object.values(r.counts).reduce((a, b) => a + b, 0)} bản ghi.`); loadWpShop(name, site); }
  });
  $('#upForm').addEventListener('submit', async e => {
    e.preventDefault();
    const on = $('#upOn').checked;
    const r = await act(e.submitter, () => api(`/api/wpx/${enc}/uploads`, { method: 'POST', body: { on, prodUrl: $('#upUrl').value } }));
    if (r) toast(on ? `Ảnh thiếu sẽ lấy từ ${r.prodUrl}.` : 'Đã tắt lấy ảnh từ production.');
  });
  $('#upOn').onchange = () => $('#upForm').requestSubmit();
  $('#lanOn').onchange = async e => { if (await toggleLan(name, e.target.checked, e.target)) loadWpShop(name, site); };
  $('#lanQr')?.addEventListener('click', () => showLan(name));
}

async function loadWpExtras(name) {
  const box = $('#wpExtras');
  const enc = encodeURIComponent(name);
  let x;
  try { x = await api(`/api/wp/${enc}/extras`); } catch (e) {
    box.innerHTML = `<h2>Cập nhật, plugin và tài khoản</h2><p class="error">${h(e.message)}</p>`;
    return;
  }
  if (wpState.selected !== name || !document.body.contains(box)) return;
  const pluginUpdates = x.plugins.filter(p => p.update_version).length;
  const themeUpdates = x.themes.filter(t => t.update_version).length;
  const pRows = x.plugins.map(p => `
    <tr data-plugin="${h(p.name)}">
      <td><span class="led ${p.status === 'active' ? 'on' : ''}"></span></td>
      <td><div class="site-name">${h(p.title || p.name)}</div><div class="sub">${h(p.name)} · ${h(p.version)}${p.update_version ? ` → <b>${h(p.update_version)}</b>` : ''}</div></td>
      <td class="actions">
        ${p.update_version ? '<button class="btn small" data-pa="update">Cập nhật</button>' : ''}
        ${p.status === 'active' ? '<button class="btn small" data-pa="deactivate">Tắt</button>'
          : p.status === 'inactive' ? '<button class="btn small" data-pa="activate">Bật</button>' : `<span class="sub">${h(p.status)}</span>`}
      </td></tr>`).join('');

  box.innerHTML = `
    <h2>Cập nhật</h2>
    <div class="row" style="margin-bottom:1.25rem">
      <span class="grow">${x.coreUpdate ? `Có WordPress ${h(x.coreUpdate)}.` : 'WordPress đã là bản mới nhất.'}
        ${pluginUpdates} plugin và ${themeUpdates} giao diện có bản cập nhật.</span>
      ${x.coreUpdate ? '<button class="btn" data-up="core">Cập nhật WordPress</button>' : ''}
      ${pluginUpdates || themeUpdates ? '<button class="btn" data-up="all">Cập nhật tất cả</button>' : ''}
    </div>
    <h2>Đổi phiên bản WordPress</h2>
    <form class="row" id="wpCoreVer" style="margin-bottom:.4rem">
      <div class="field" style="width:10rem"><label for="coreVer">Phiên bản (nâng hoặc hạ)</label><input id="coreVer" list="coreVerList" required placeholder="ví dụ 6.4.5"><datalist id="coreVerList"></datalist></div>
      <button class="btn">Đổi phiên bản</button>
      <span class="sub grow">Sitebench tự sao lưu site trước khi đổi.</span>
    </form>
    <div id="coreCompat" class="compat" style="margin-bottom:1.25rem"></div>
    <h2>Plugin</h2>
    <div class="table-wrap" style="margin-bottom:1.25rem">${x.plugins.length ? `<table><tbody>${pRows}</tbody></table>` : '<p class="muted">Chưa có plugin nào.</p>'}</div>
    <h2>Đặt lại mật khẩu admin</h2>
    <form class="row" id="wpPw">
      <div class="field"><label for="pwUser">Tài khoản</label><select id="pwUser">${x.admins.map(a => `<option value="${h(a.user_login)}">${h(a.user_login)} (${h(a.user_email)})</option>`).join('')}</select></div>
      <div class="field grow"><label for="pwVal">Mật khẩu mới (Sitebench tạo ngẫu nhiên, sửa được; chỉ có hiệu lực khi bấm Đặt mật khẩu)</label>
        <div class="pick-wrap"><input id="pwVal" value="${h(randomPass())}" minlength="8" required><button type="button" class="btn small" id="pwCopy">Sao chép</button></div></div>
      <button class="btn primary">Đặt mật khẩu</button>
    </form>
    <p class="sub">Mật khẩu hiện tại của site kéo từ host giống hệt trên host (database được chép nguyên). Đặt lại ở đây chỉ đổi trên máy này.</p>`;

  fillWpDatalist('coreVerList');
  const site = await api(`/api/wp/${enc}`).catch(() => null);
  $('#coreVer').addEventListener('input', () => {
    $('#coreCompat').innerHTML = wpPhpWarnings($('#coreVer').value.trim(), site?.phpVersion).map(x => `<p class="warn-line">${h(x)}</p>`).join('');
  });
  $('#wpCoreVer').addEventListener('submit', async e => {
    e.preventDefault();
    const version = $('#coreVer').value.trim();
    if (!confirm(`Đổi ${name} sang WordPress ${version}? Sitebench sẽ sao lưu trước, có thể mất vài phút.`)) return;
    e.submitter.textContent = 'Đang sao lưu và đổi phiên bản…';
    const r = await act(e.submitter, () => api(`/api/wp/${enc}/core-version`, { method: 'POST', body: { version } }), `Đã chuyển sang WordPress ${version}.`);
    e.submitter.textContent = 'Đổi phiên bản';
    if (r) renderWpSite(name);
  });
  box.querySelectorAll('[data-up]').forEach(b => b.onclick = async () => {
    b.textContent = 'Đang cập nhật…';
    await act(b, () => api(`/api/wp/${enc}/update`, { method: 'POST', body: { what: b.dataset.up } }), 'Đã cập nhật xong.');
    renderWpSite(name);
  });
  box.querySelector('tbody')?.addEventListener('click', async e => {
    const b = e.target.closest('[data-pa]');
    if (!b) return;
    const plugin = b.closest('tr').dataset.plugin;
    const msg = { activate: 'Đã bật', deactivate: 'Đã tắt', update: 'Đã cập nhật' }[b.dataset.pa];
    await act(b, () => api(`/api/wp/${enc}/plugins/${encodeURIComponent(plugin)}/${b.dataset.pa}`, { method: 'POST' }), `${msg} ${plugin}.`);
    loadWpExtras(name);
  });
  $('#pwCopy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#pwVal').value); toast('Đã sao chép mật khẩu.'); } catch { $('#pwVal').select(); document.execCommand('copy'); toast('Đã sao chép mật khẩu.'); }
  });
  $('#wpPw').addEventListener('submit', async e => {
    e.preventDefault();
    await act(e.submitter, () => api(`/api/wp/${enc}/password`, { method: 'POST', body: { user: $('#pwUser').value, pass: $('#pwVal').value } }),
      `Đã đặt mật khẩu mới cho ${$('#pwUser').value}. Hãy lưu lại mật khẩu.`);
  });
}



// ================= Hộp thoại dùng chung =================
function modal(title, bodyHtml, id = 'modal') {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = id;
    dlg.className = 'modal';
    document.body.append(dlg);
  }
  dlg.innerHTML = `<div class="modal-head"><h2>${h(title)}</h2><button class="btn small" data-close>Đóng</button></div><div class="modal-body">${bodyHtml}</div>`;
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
  return dlg;
}

// Báo kết quả sau khi đổi cấu hình PHP
function reportPhp(r, done) {
  const extra = [r.reloaded && 'Apache đã khởi động lại', r.fcgi && 'php-cgi đã chạy lại'].filter(Boolean).join(', ');
  toast(`${done}${extra ? ` ${extra}.` : ''}`);
  if (r.reloadError) toast(r.reloadError, true);
}

// ================= Cài đặt PHP (php.ini, extension, Xdebug) =================
async function openPhpSettings(folder) {
  const enc = encodeURIComponent(folder);
  const d = await api(`/api/php/${enc}`);
  const usedFor = [d.isDefault && 'PHP mặc định của Laragon', d.usedBy.length && `dự án ${d.usedBy.join(', ')}`].filter(Boolean).join(' và ') || 'chưa có dự án nào dùng';
  const field = s => {
    const v = s.value ?? '';
    const input = s.type === 'onoff'
      ? `<select name="${h(s.key)}"><option value="">(chưa đặt)</option>${(s.key === 'display_errors' ? ['On', 'Off'] : ['1', '0']).map(o =>
        `<option value="${o}" ${String(v).toLowerCase() === o.toLowerCase() || (o === '1' && /^on$/i.test(v)) || (o === '0' && /^off$/i.test(v)) ? 'selected' : ''}>${o === '1' || o === 'On' ? 'Bật' : 'Tắt'}</option>`).join('')}</select>`
      : `<input name="${h(s.key)}" value="${h(v)}" placeholder="(chưa đặt)">`;
    return `<div class="field"><label>${h(s.label)} <span class="sub">${h(s.key)}</span></label>${input}${s.hint ? `<span class="sub">${h(s.hint)}</span>` : ''}</div>`;
  };
  const xd = d.xdebug;
  const dlg = modal(`Cài đặt PHP ${d.version}`, `
    <p class="sub" style="margin-top:0">Đang dùng cho: ${h(usedFor)} · <span class="log-path">${h(d.iniPath)}</span></p>
    <div class="notice" style="margin-bottom:1rem"><b>Tối ưu cho WooCommerce:</b> max_input_vars 10000, memory_limit 512M, tải lên 256M, bật OPcache (vẫn nhận code mới ngay), tăng realpath cache, bật các extension WooCommerce cần.
      <button class="btn small primary" id="phpPreset" style="margin-left:.4rem">Áp dụng</button></div>
    <form id="phpForm"><div class="settings-grid">${d.settings.map(field).join('')}</div>
      <p><button class="btn primary">Lưu cài đặt</button> ${d.hasBackup ? '<button class="btn" type="button" id="phpRestore">Khôi phục php.ini gốc</button>' : ''}</p></form>
    <h2>Xdebug</h2>
    <p class="sub" style="margin-top:-.4rem">${xd.other ? 'php.ini đã có cấu hình Xdebug khác (không do Sitebench thêm).' : xd.enabled
      ? `<span class="led on"></span> Đang bật, chế độ ${h(xd.mode || 'debug')}. Chỉ hoạt động khi bạn bật trong tiện ích trình duyệt "Xdebug Helper", nên bình thường không làm chậm site.`
      : 'Đang tắt. Bật lên, Sitebench tự tải đúng bản Xdebug cho phiên bản PHP này.'}</p>
    <div class="row">
      <div class="field"><label for="xdMode">Chế độ</label><select id="xdMode">
        <option value="debug">Gỡ lỗi từng bước (debug)</option>
        <option value="debug,develop" ${xd.mode === 'debug,develop' ? 'selected' : ''}>Gỡ lỗi + báo lỗi chi tiết (debug, develop)</option>
        <option value="profile" ${xd.mode === 'profile' ? 'selected' : ''}>Đo hiệu năng (profile)</option></select></div>
      <button class="btn ${xd.enabled ? '' : 'primary'}" id="xdToggle" ${xd.other ? 'disabled' : ''}>${xd.enabled ? 'Tắt Xdebug' : 'Bật Xdebug'}</button>
      ${xd.enabled && xd.managed ? '<button class="btn" id="xdApply">Đổi chế độ</button>' : ''}
    </div>
    <p class="sub">Dùng với VS Code: cài tiện ích "PHP Debug", cổng 9003, rồi bật "Xdebug Helper" trên trình duyệt. File kết quả đo hiệu năng nằm trong thư mục logs/xdebug của Sitebench.</p>
    <h2>Extension</h2>
    ${d.extensions.length ? `<div class="ext-grid">${d.extensions.map(e => `<label class="switch small"><input type="checkbox" data-ext="${h(e.name)}" ${e.enabled ? 'checked' : ''}> <span>${h(e.name)}</span></label>`).join('')}</div>`
      : '<p class="muted">Không tìm thấy thư mục ext của phiên bản PHP này.</p>'}`);
  const again = () => openPhpSettings(folder);
  $('#phpPreset', dlg).onclick = async e => {
    const r = await act(e.target, () => api(`/api/php/${enc}/preset`, { method: 'POST' }));
    if (r) { reportPhp(r, 'Đã áp dụng cài đặt tối ưu cho WooCommerce.'); again(); }
  };
  $('#phpForm', dlg).addEventListener('submit', async e => {
    e.preventDefault();
    const values = Object.fromEntries([...new FormData(e.target)].filter(([, v]) => v !== ''));
    const r = await act(e.submitter, () => api(`/api/php/${enc}/settings`, { method: 'POST', body: { values } }));
    if (r) { reportPhp(r, 'Đã lưu cài đặt PHP.'); again(); }
  });
  $('#phpRestore', dlg)?.addEventListener('click', async e => {
    if (!confirm('Trả php.ini về bản trước khi Sitebench sửa lần đầu?')) return;
    const r = await act(e.target, () => api(`/api/php/${enc}/restore`, { method: 'POST' }));
    if (r) { reportPhp(r, 'Đã khôi phục php.ini gốc.'); again(); }
  });
  const xdebug = async (btn, on) => {
    btn.textContent = on ? 'Đang tải và bật…' : 'Đang tắt…';
    const r = await act(btn, () => api(`/api/php/${enc}/xdebug`, { method: 'POST', body: { on, mode: $('#xdMode', dlg).value } }));
    if (r) { reportPhp(r, on ? `Đã bật Xdebug${r.installed ? ` ${r.installed}` : ''}.` : 'Đã tắt Xdebug.'); again(); }
    else btn.textContent = on ? 'Bật Xdebug' : 'Tắt Xdebug';
  };
  $('#xdToggle', dlg).onclick = e => xdebug(e.target, !xd.enabled);
  $('#xdApply', dlg)?.addEventListener('click', e => xdebug(e.target, true));
  dlg.querySelectorAll('[data-ext]').forEach(c => c.onchange = async () => {
    const r = await act(c, () => api(`/api/php/${enc}/extension`, { method: 'POST', body: { name: c.dataset.ext, on: c.checked } }));
    if (r) reportPhp(r, `Đã ${c.checked ? 'bật' : 'tắt'} ${c.dataset.ext}.`); else c.checked = !c.checked;
  });
}

// ================= Xem trên điện thoại qua Wi-Fi =================
async function showLan(name, info) {
  const enc = encodeURIComponent(name);
  const d = info || await api(`/api/laragon/projects/${enc}/lan`);
  if (!d.port) { toast('Dự án chưa bật xem qua Wi-Fi.', true); return; }
  const dlg = modal(`Xem ${name} trên điện thoại`, `
    <div class="lan">
      ${d.qr ? `<div class="qr" aria-label="Mã QR mở site trên điện thoại">${d.qr}</div>` : ''}
      <div>
        <p style="margin-top:0">Quét mã QR bằng camera điện thoại, hoặc gõ địa chỉ:</p>
        ${d.urls.length ? d.urls.map((u, i) => `<p class="lan-url ${i ? 'sub' : ''}"><a href="${h(u.url)}" target="_blank" rel="noopener">${h(u.url)}</a>${i ? ` <span class="sub">(${h(u.iface)})</span>` : ''}</p>`).join('')
          : '<p class="error">Máy chưa kết nối mạng nội bộ nào.</p>'}
        <ul class="notes">
          <li>Điện thoại và máy tính phải dùng chung một mạng Wi-Fi.</li>
          <li>Site WordPress được tự đổi địa chỉ khi mở bằng IP; site khác cần dùng đường dẫn tương đối.</li>
          <li>Chế độ này dùng http, không có https.</li>
        </ul>
        ${d.windows && d.firewall === false ? `<p class="warn-line">Nếu điện thoại không vào được, có thể Windows Firewall đang chặn cổng ${d.port}.
          <button class="btn small" id="lanFw">Mở tường lửa cho cổng ${d.port}</button></p>` : ''}
      </div>
    </div>`);
  $('#lanFw', dlg)?.addEventListener('click', async e => {
    e.target.textContent = 'Đang chờ bạn xác nhận trong hộp thoại của Windows…';
    const r = await act(e.target, () => api(`/api/laragon/projects/${enc}/lan/firewall`, { method: 'POST' }), `Đã mở tường lửa cho cổng ${d.port} (chỉ mạng riêng).`);
    if (r) showLan(name);
  });
}
async function toggleLan(name, on, el) {
  const r = await act(el, () => api(`/api/laragon/projects/${encodeURIComponent(name)}/lan`, { method: 'POST', body: { on } }));
  if (!r) { if (el) el.checked = !on; return false; }
  reportApache(r, on ? `Đã bật xem ${name} qua Wi-Fi.` : `Đã tắt xem ${name} qua Wi-Fi.`);
  if (on) showLan(name, { ...r, windows: true });
  return true;
}

// ================= Xóa dự án (sao lưu trước) =================
async function openDelete(name, onDone) {
  const dlg = modal(`Xóa dự án ${name}`, '<p class="muted">Đang kiểm tra những gì thuộc về dự án…</p>');
  let i;
  try { i = await api(`/api/projects/${encodeURIComponent(name)}`); } catch (e) {
    dlg.querySelector('.modal-body').innerHTML = `<p class="error">${h(e.message)}</p>`;
    return;
  }
  const items = [
    `Thư mục <span class="log-path">${h(i.dir)}</span> (${fmtSize(i.size.size)}${i.size.partial ? '+' : ''}, ${i.size.files} tệp)`,
    i.db ? (i.db.exists ? `Database <b>${h(i.db.name)}</b> (${i.db.tables} bảng, ${fmtSize(i.db.size)}; lấy từ ${h(i.db.from)})` : `Database ${h(i.db.name)} (không còn trong MySQL)`) : null,
    i.confs.length ? `Cấu hình Apache: ${i.confs.map(h).join(', ')}` : null,
    i.php ? `PHP riêng ${h(i.php)}` : null,
    i.https ? 'HTTPS và chứng chỉ của tên miền' : null,
    i.lan ? `Xem qua Wi-Fi (cổng ${i.lan})` : null,
    i.inHosts ? `Dòng ${h(i.domain)} trong tệp hosts (nếu có quyền ghi)` : null,
  ].filter(Boolean);
  dlg.querySelector('.modal-body').innerHTML = `
    <p style="margin-top:0">Những gì sẽ bị xóa:</p>
    <ul class="notes" style="color:var(--ink)">${items.map(x => `<li>${x}</li>`).join('')}</ul>
    <form id="delForm">
      <label class="switch"><input type="checkbox" id="delBackup" checked> <span><b>Sao lưu trước khi xóa</b> (mã nguồn${i.db?.exists ? ' và database' : ''}), lưu ở mục <a href="#backups" data-close-link>Sao lưu</a> để khôi phục sau</span></label>
      ${i.db?.exists ? `<label class="switch" style="margin-top:.5rem"><input type="checkbox" id="delDb" checked> <span>Xóa database ${h(i.db.name)}</span></label>` : ''}
      <div class="field" style="margin-top:1rem"><label for="delConfirm">Gõ <b>${h(name)}</b> để xác nhận</label><input id="delConfirm" autocomplete="off" required></div>
      <p><button class="btn danger" id="delGo" disabled>Xóa dự án</button></p>
    </form>
    <div id="delJob"></div>`;
  dlg.querySelector('[data-close-link]').onclick = () => dlg.close();
  const go = $('#delGo', dlg);
  $('#delConfirm', dlg).oninput = e => { go.disabled = e.target.value.trim() !== name; };
  $('#delBackup', dlg).onchange = e => { go.textContent = e.target.checked ? 'Xóa dự án' : 'Xóa vĩnh viễn, không sao lưu'; };
  $('#delForm', dlg).addEventListener('submit', async e => {
    e.preventDefault();
    const body = { confirm: $('#delConfirm', dlg).value.trim(), backup: $('#delBackup', dlg).checked, dropDb: !!$('#delDb', dlg)?.checked };
    const r = await act(go, () => api(`/api/projects/${encodeURIComponent(name)}/delete`, { method: 'POST', body }));
    if (!r) return;
    e.target.hidden = true;
    watchJob(r.job, $('#delJob', dlg), (res, out) => {
      out.innerHTML = `<p><b>Đã xóa ${h(name)}.</b> ${res.backup ? `Bản sao lưu: <span class="log-path">${h(res.backup.file)}</span>. <a href="#backups" data-close-link>Mở mục Sao lưu</a>` : ''}</p>`;
      out.querySelector('[data-close-link]')?.addEventListener('click', () => dlg.close());
      refreshLeds();
      onDone?.();
    });
  });
}

// ================= Sao lưu (mọi dự án, kể cả đã xóa) =================
async function renderBackups() {
  const { backups, dir } = await api('/api/projects/backups');
  const groups = {};
  for (const b of backups) (groups[b.project] = groups[b.project] || []).push(b);
  const kindLabel = { wordpress: 'WordPress', laravel: 'Laravel', php: 'PHP' };
  const reasonLabel = r => (r === 'truoc-khi-xoa' ? 'trước khi xóa' : r || 'thủ công');
  view.innerHTML = `
    <h1>Sao lưu</h1>
    <p class="lead">Bản sao lưu của mọi dự án, kể cả dự án đã xóa. Khôi phục để cài lại dự án (giữ tên cũ hoặc đặt tên mới).</p>
    <div class="panel flush">
      <div class="toolbar"><input type="search" id="bkSearch" class="grow" placeholder="Tìm theo tên dự án…" aria-label="Tìm bản sao lưu">
        <span class="sub" id="bkCount">${backups.length} bản</span></div>
      <div class="table-wrap">${backups.length ? `<table><tbody>${Object.entries(groups).map(([p, list]) => list.map((b, k) => `
        <tr data-id="${h(b.id)}" data-search="${h(`${p} ${b.kind || ''} ${b.db || ''}`.toLowerCase())}">
          <td>${k === 0 ? `<div class="site-name">${h(p)} ${b.deleted ? '<span class="tag tag-off">đã xóa</span>' : ''}</div>` : ''}
            <div class="sub">${fmtDate(b.created)} · ${fmtSize(b.size)} · ${h(kindLabel[b.kind] || 'dự án')}${b.db ? ` · database ${h(b.db)}` : ''} · ${h(reasonLabel(b.reason))}</div></td>
          <td class="actions">
            <button class="btn small primary" data-restore>Khôi phục</button>
            <a class="btn small" href="/api/projects/backups/download?id=${encodeURIComponent(b.id)}">Tải về</a>
            <button class="btn small danger" data-del>Xóa</button>
          </td></tr>`).join('')).join('')}</tbody></table><p class="empty" id="bkNone" hidden>Không có bản sao lưu nào khớp.</p>`
        : '<p class="empty">Chưa có bản sao lưu nào. Bản sao lưu được tạo khi bạn sao lưu site WordPress hoặc xóa dự án.</p>'}</div>
    </div>
    <p class="sub">Thư mục lưu: <span class="log-path">${h(dir)}</span></p>`;
  bindSearch('#bkSearch', view.querySelectorAll('tr[data-search]'), '#bkCount', '#bkNone', 'bản');
  view.querySelectorAll('tr[data-id]').forEach(tr => {
    const b = backups.find(x => x.id === tr.dataset.id);
    tr.querySelector('[data-restore]').onclick = () => openRestore(b);
    tr.querySelector('[data-del]').onclick = async e => {
      if (!confirm(`Xóa vĩnh viễn bản sao lưu ${b.file}?`)) return;
      if (await act(e.target, () => api(`/api/projects/backups?id=${encodeURIComponent(b.id)}`, { method: 'DELETE' }), 'Đã xóa bản sao lưu.')) renderBackups();
    };
  });
}

async function openRestore(b) {
  const lg = await api('/api/laragon');
  const taken = lg.projects.some(p => p.name === b.project);
  const suggest = taken ? `${b.project}-khoi-phuc` : b.project;
  const phpOpts = `<option value="__keep">Như lúc sao lưu${b.phpVersion ? ` (PHP ${h(b.phpVersion)})` : ''}</option><option value="">Mặc định của Laragon</option>` +
    lg.versions.map(v => `<option value="${h(v.id)}">PHP ${h(v.version)}</option>`).join('');
  const dlg = modal(`Khôi phục ${b.project}`, `
    <p class="sub" style="margin-top:0">${h(b.file)} · ${fmtDate(b.created)} · ${fmtSize(b.size)}</p>
    ${taken ? `<p class="warn-line">Dự án ${h(b.project)} đang có trong www, nên khôi phục dưới tên mới. ${b.kind === 'wordpress' ? 'Địa chỉ site sẽ được đổi theo tên mới.' : ''}</p>` : ''}
    <form id="rsForm"><div class="settings-grid">
      <div class="field"><label for="rsName">Tên dự án</label><input id="rsName" required pattern="[a-z0-9-]+" value="${h(suggest)}"></div>
      ${b.db ? `<div class="field"><label for="rsDb">Tên database (để trống = tự đặt)</label><input id="rsDb" placeholder="${h(taken ? '' : b.db)}"></div>` : ''}
      <div class="field"><label for="rsPhp">PHP</label><select id="rsPhp">${phpOpts}</select></div>
    </div>
    <p><button class="btn primary">Khôi phục</button></p></form>
    <div id="rsJob"></div>`);
  $('#rsForm', dlg).addEventListener('submit', async e => {
    e.preventDefault();
    const php = $('#rsPhp', dlg).value;
    const body = { id: b.id, name: $('#rsName', dlg).value.trim(), db: $('#rsDb', dlg)?.value.trim() || undefined, ...(php === '__keep' ? {} : { php: php || null }) };
    const r = await act(e.submitter, () => api('/api/projects/backups/restore', { method: 'POST', body }));
    if (!r) return;
    e.target.hidden = true;
    watchJob(r.job, $('#rsJob', dlg), (res, out) => {
      out.innerHTML = `<p><b>Đã khôi phục ${h(res.name)}.</b> <a href="${h(res.url)}" target="_blank" rel="noopener">${h(res.url)}</a>${res.db ? ` · database ${h(res.db)}` : ''}</p>
        ${res.notes.length ? `<ul class="notes">${res.notes.map(n => `<li>${h(n)}</li>`).join('')}</ul>` : ''}`;
      if (location.hash === '#backups') renderBackups();
    });
  });
}

// ================= Tác vụ nền (dùng chung) =================
// Hiện tiến độ của một tác vụ nền vào box, gọi onDone(kết quả) khi xong
function watchJob(id, box, onDone) {
  let since = 0;
  box.innerHTML = `
    <div class="panel job">
      <div class="job-head"><span class="spinner" aria-hidden="true"></span><b class="job-step">Đang bắt đầu…</b></div>
      <div class="bar"><i style="width:0"></i></div>
      <pre class="job-log"></pre>
      <div class="job-result"></div>
    </div>`;
  const step = $('.job-step', box), bar = $('.bar i', box), log = $('.job-log', box), out = $('.job-result', box);
  const tick = async () => {
    let j;
    try { j = await api(`/api/jobs/${id}?since=${since}`); } catch (e) { step.textContent = e.message; return; }
    since = j.logTotal;
    if (j.log.length) { log.textContent += (log.textContent ? '\n' : '') + j.log.join('\n'); log.scrollTop = log.scrollHeight; }
    step.textContent = j.step;
    bar.style.width = j.progress == null ? '100%' : `${j.progress}%`;
    bar.parentElement.classList.toggle('indeterminate', j.progress == null && j.status === 'running');
    if (j.status === 'running') return setTimeout(tick, 1000);
    box.querySelector('.spinner').remove();
    if (j.status === 'failed') {
      step.textContent = 'Không thành công';
      out.innerHTML = `<p class="error">${h(j.error)}</p><p class="sub">Những gì đã tạo dở đã được dọn dẹp.</p>`;
    } else {
      step.textContent = 'Hoàn tất';
      onDone?.(j.result, out);
    }
  };
  tick();
}

// Tải tệp lên với thanh tiến độ
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    const x = new XMLHttpRequest();
    x.open('POST', '/api/import/upload');
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch { /* bỏ qua */ }
      x.status >= 200 && x.status < 300 ? resolve(d) : reject(new Error(d.error || `Tải lên thất bại (${x.status})`));
    };
    x.onerror = () => reject(new Error('Tải lên thất bại.'));
    x.send(fd);
  });
}

// ================= Nhập site =================
const importState = { mode: 'files', probe: null, sshForm: null };

async function renderImport() {
  const lg = await api('/api/laragon');
  if (!lg.detected) {
    view.innerHTML = '<h1>Nhập site</h1><div class="notice">Cần kết nối Laragon trước. Vào mục <a href="#laragon">Laragon</a> để nhập thư mục cài Laragon.</div>';
    return;
  }
  const phpOpts = sel => `<option value="">Mặc định của Laragon (${h(lg.versions.find(v => v.isDefault)?.version || '?')})</option>` +
    lg.versions.map(v => `<option value="${h(v.id)}" ${sel === v.id ? 'selected' : ''}>PHP ${h(v.version)}</option>`).join('');
  view.innerHTML = `
    <h1>Nhập site</h1>
    <p class="lead">Đưa site về máy để code: kéo từ host (tệp sao lưu hoặc SSH) hay chuyển từ Laragon. Sitebench tự lo database, đổi tên miền thật thành ten.test, chặn email thật và chạy site. Hỗ trợ WordPress, Laravel và website PHP.</p>
    <div class="seg" role="tablist">
      <button data-mode="files" class="${importState.mode === 'files' ? 'active' : ''}">Từ tệp sao lưu</button>
      <button data-mode="ssh" class="${importState.mode === 'ssh' ? 'active' : ''}">Qua SSH</button>
      <button data-mode="laragon" class="${importState.mode === 'laragon' ? 'active' : ''}">Từ Laragon</button>
    </div>
    <div id="impBody"></div>
    <div id="jobBox"></div>`;
  view.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { importState.mode = b.dataset.mode; renderImport(); });
  if (importState.mode === 'files') renderImportFiles(phpOpts);
  else if (importState.mode === 'laragon') renderImportLaragon();
  else renderImportSsh(phpOpts, lg);
}

const fileSource = (id, label, optional) => `
  <fieldset class="src">
    <legend>${label}${optional ? ' <span class="sub">(không bắt buộc)</span>' : ''}</legend>
    <label class="switch"><input type="radio" name="${id}Mode" value="upload" checked> <span>Chọn tệp để tải lên</span></label>
    <label class="switch"><input type="radio" name="${id}Mode" value="path"> <span>Tệp có sẵn trên máy (nhanh hơn với tệp lớn)</span></label>
    <input type="file" id="${id}File">
    <input id="${id}Path" placeholder="Ví dụ: D:\\Downloads\\backup.tar.gz" hidden>
  </fieldset>`;

function renderImportFiles(phpOpts) {
  $('#impBody').innerHTML = `
    <form class="panel" id="impFiles">
      <div class="row">
        <div class="field grow"><label for="impName">Tên dự án (thành tên miền .test)</label><input id="impName" required pattern="[a-z0-9-]+" placeholder="shop-cua-toi"></div>
        <div class="field"><label for="impPhp">PHP</label><select id="impPhp">${phpOpts('')}</select></div>
        <label class="switch" style="align-self:center"><input type="checkbox" id="impHttps"> <span>HTTPS</span></label>
      </div>
      ${fileSource('arc', 'Tệp mã nguồn: .zip, .tar.gz (bản backup đầy đủ của cPanel cũng được)')}
      ${fileSource('sql', 'Tệp database: .sql hoặc .sql.gz', true)}
      <p class="sub">Để trống tệp database nếu tệp sao lưu đã có sẵn .sql bên trong (ví dụ bản backup đầy đủ của cPanel).</p>
      <fieldset class="src"><legend>Cho site WordPress</legend>
        <label class="switch small"><input type="checkbox" id="impSafety" checked> <span>Chế độ an toàn cho shop WooCommerce: tắt cổng thanh toán trực tuyến, dừng tác vụ ngầm và webhook</span></label>
        <label class="switch small"><input type="checkbox" id="impAnon" checked> <span>Ẩn danh dữ liệu khách hàng (email, số điện thoại, địa chỉ, tên)</span></label>
        <label class="switch small"><input type="checkbox" id="impUp" checked> <span>Ảnh không có ở máy này thì lấy từ site production</span></label>
      </fieldset>
      <button class="btn primary">Nhập site</button>
    </form>`;
  for (const id of ['arc', 'sql']) {
    $('#impFiles').querySelectorAll(`[name=${id}Mode]`).forEach(r => r.onchange = () => {
      const path = $(`[name=${id}Mode]:checked`).value === 'path';
      $(`#${id}File`).hidden = path;
      $(`#${id}Path`).hidden = !path;
    });
  }
  $('#impFiles').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter;
    const name = $('#impName').value.trim();
    const pick = async (id, label) => {
      if ($(`[name=${id}Mode]:checked`).value === 'path') {
        const p = $(`#${id}Path`).value.trim();
        return p ? { path: p } : null;
      }
      const f = $(`#${id}File`).files[0];
      if (!f) return null;
      btn.textContent = `Đang tải lên ${label}… 0%`;
      const r = await uploadFile(f, x => { btn.textContent = `Đang tải lên ${label}… ${Math.round(x * 100)}%`; });
      return { upload: r.upload };
    };
    btn.disabled = true;
    try {
      const archive = await pick('arc', 'mã nguồn');
      if (!archive) throw new Error('Hãy chọn tệp mã nguồn.');
      const sql = await pick('sql', 'database');
      const r = await api('/api/import/start', { method: 'POST', body: { source: 'files', name, archive, sql, php: $('#impPhp').value || null, https: $('#impHttps').checked,
        shopSafety: $('#impSafety').checked, anonymize: $('#impAnon').checked, uploadsProxy: $('#impUp').checked } });
      watchJob(r.job, $('#jobBox'), showImportResult);
      $('#jobBox').scrollIntoView({ behavior: 'smooth' });
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; btn.textContent = 'Nhập site'; }
  });
}

function sshBody(f) {
  return {
    host: f.host.value.trim(), port: Number(f.port.value) || 22, user: f.user.value.trim(), auth: f.auth.value,
    password: f.password.value, privateKey: f.key.value.trim() || undefined, keyPath: f.keyPath.value.trim() || undefined,
    passphrase: f.passphrase.value || undefined, remotePath: f.rpath.value.trim(),
  };
}

function renderImportSsh(phpOpts, lg) {
  $('#impBody').innerHTML = `
    <form class="panel" id="impSsh" autocomplete="off">
      <h2>Kết nối tới host</h2>
      <div class="row">
        <div class="field grow"><label for="sHost">Máy chủ</label><input id="sHost" name="host" required placeholder="ten-mien.com hoặc IP"></div>
        <div class="field" style="width:6rem"><label for="sPort">Cổng</label><input id="sPort" name="port" type="number" value="22"></div>
        <div class="field grow"><label for="sUser">Tên đăng nhập</label><input id="sUser" name="user" required></div>
        <div class="field"><label for="sAuth">Xác thực</label><select id="sAuth" name="auth"><option value="password">Mật khẩu</option><option value="key">Khóa SSH</option></select></div>
      </div>
      <div class="row" id="sPassRow" style="margin-top:.6rem">
        <div class="field grow"><label for="sPass">Mật khẩu</label><input id="sPass" name="password" type="password"></div>
      </div>
      <div id="sKeyRow" hidden style="margin-top:.6rem">
        <div class="row">
          <div class="field grow"><label for="sKeyPath">Đường dẫn tệp khóa riêng</label><input id="sKeyPath" name="keyPath" placeholder="C:\\Users\\ban\\.ssh\\id_ed25519"></div>
          <div class="field grow"><label for="sPassphrase">Mật khẩu của khóa (nếu có)</label><input id="sPassphrase" name="passphrase" type="password"></div>
        </div>
        <div class="field" style="margin-top:.6rem"><label for="sKey">Hoặc dán nội dung khóa riêng</label><textarea id="sKey" name="key" class="code" rows="3" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></div>
      </div>
      <div class="row" style="margin-top:.6rem">
        <div class="field grow"><label for="sPath">Thư mục website trên host</label><input id="sPath" name="rpath" value="~/public_html"></div>
        <button class="btn primary">Kiểm tra kết nối</button>
      </div>
      <p class="sub" style="margin-bottom:0">Thông tin đăng nhập chỉ dùng cho lần nhập này, Sitebench không lưu lại.</p>
    </form>
    <div id="probeBox"></div>`;
  const f = $('#impSsh');
  f.auth.onchange = () => { $('#sPassRow').hidden = f.auth.value === 'key'; $('#sKeyRow').hidden = f.auth.value !== 'key'; };
  f.addEventListener('submit', async e => {
    e.preventDefault();
    e.submitter.textContent = 'Đang kết nối…';
    const info = await act(e.submitter, () => api('/api/import/ssh/probe', { method: 'POST', body: sshBody(f) }));
    e.submitter.textContent = 'Kiểm tra kết nối';
    if (info) showProbe(info, f, phpOpts, lg);
  });
}

function showProbe(info, f, phpOpts, lg) {
  const kind = { wordpress: 'WordPress', laravel: 'Laravel', php: 'Website PHP' }[info.kind];
  const phpNote = info.php
    ? (info.suggestPhp ? '' : `<p class="warn-line">Laragon chưa có PHP ${h(info.php.split('.').slice(0, 2).join('.'))}. Tải ở mục <a href="#laragon">Laragon → Tải thêm phiên bản PHP</a> rồi kiểm tra lại để chạy giống host.</p>`)
    : '';
  const guess = (f.host.value.split('.').slice(0, -1).join('-') || f.user.value).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  $('#probeBox').innerHTML = `
    <form class="panel" id="impSshGo">
      <h2>Tìm thấy ${kind}${info.wpVersion ? ` ${h(info.wpVersion)}` : ''}</h2>
      <dl class="facts">
        <dt>Thư mục</dt><dd>${h(info.dir)} (${h(info.size || '?')})</dd>
        <dt>PHP trên host</dt><dd>${h(info.php || 'không rõ')}${info.phpSource === 'cli' ? ' <span class="sub">(bản dòng lệnh, bản web có thể khác)</span>' : info.phpSource === 'htaccess' ? ' <span class="sub">(theo .htaccess)</span>' : ''}</dd>
        <dt>Database</dt><dd>${info.db ? `${h(info.db.name)} <span class="sub">(user ${h(info.db.user)} @ ${h(info.db.host)})</span>` : 'không có'}</dd>
        ${info.uploads ? `<dt>Ảnh (uploads)</dt><dd>${h(info.uploads)}</dd>` : ''}
      </dl>
      ${phpNote}
      <div class="row" style="margin-top:1rem">
        <div class="field grow"><label for="gName">Tên dự án ở local</label><input id="gName" required pattern="[a-z0-9-]+" value="${h(guess)}"></div>
        <div class="field"><label for="gPhp">PHP ở local</label><select id="gPhp">${phpOpts(info.suggestPhp || '')}</select></div>
        <label class="switch" style="align-self:center"><input type="checkbox" id="gHttps" checked> <span>HTTPS</span></label>
      </div>
      ${info.uploads ? `<label class="switch" style="margin-top:.6rem"><input type="checkbox" id="gSkip"> <span>Không tải thư mục uploads (${h(info.uploads)}) cho nhanh; ảnh sẽ lấy trực tiếp từ site production</span></label>` : ''}
      ${info.kind === 'wordpress' ? `
      <fieldset class="src"><legend>Cho site WordPress</legend>
        <label class="switch small"><input type="checkbox" id="gSafety" checked> <span>Chế độ an toàn cho shop WooCommerce: tắt cổng thanh toán trực tuyến, dừng tác vụ ngầm và webhook</span></label>
        <label class="switch small"><input type="checkbox" id="gAnon" checked> <span>Ẩn danh dữ liệu khách hàng (email, số điện thoại, địa chỉ, tên)</span></label>
        <label class="switch small"><input type="checkbox" id="gUp" checked> <span>Ảnh không có ở máy này thì lấy từ site production</span></label>
      </fieldset>` : ''}
      <button class="btn primary" style="margin-top:1rem">Kéo site về</button>
    </form>`;
  $('#impSshGo').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { ...sshBody(f), source: 'ssh', name: $('#gName').value.trim(), php: $('#gPhp').value || null, https: $('#gHttps').checked, skipUploads: !!$('#gSkip')?.checked,
      shopSafety: $('#gSafety')?.checked ?? true, anonymize: $('#gAnon')?.checked ?? true, uploadsProxy: $('#gUp')?.checked ?? true };
    const r = await act(e.submitter, () => api('/api/import/start', { method: 'POST', body }));
    if (r) { watchJob(r.job, $('#jobBox'), showImportResult); $('#jobBox').scrollIntoView({ behavior: 'smooth' }); }
  });
}

function showImportResult(r, out) {
  out.innerHTML = `
    <p><b>Đã nhập ${h(r.name)}.</b> <a href="${h(r.url)}" target="_blank" rel="noopener">${h(r.url)}</a>
      ${r.adminUrl ? ` · <a href="${h(r.adminUrl)}" target="_blank" rel="noopener">Trang quản trị</a> (đăng nhập bằng tài khoản như trên production)` : ''}</p>
    ${r.notes.length ? `<ul class="notes">${r.notes.map(n => `<li>${h(n)}</li>`).join('')}</ul>` : ''}
    <p><button class="btn small" data-t="${h(r.name)}">Mở terminal</button> ${r.kind === 'wordpress' ? '<a class="btn small" href="#wp">Quản lý trong WordPress</a>' : ''}</p>`;
  out.querySelector('[data-t]').onclick = () => openTerminalFor(r.name);
  refreshLeds();
}

// ----- Nhập site: chuyển từ Laragon sang máy chủ độc lập -----
async function renderImportLaragon() {
  const body = $('#impBody');
  if (runtimeInfo?.mode !== 'standalone') {
    body.innerHTML = `<div class="notice">Mục này dùng khi Sitebench <b>tự quản lý máy chủ</b>: chuyển toàn bộ dự án và database từ Laragon sang. Hiện Sitebench đang dùng chính Laragon nên không cần chuyển.</div>`;
    return;
  }
  const st = await fetch('/api/setup/status').then(r => r.json()).catch(() => ({ laragon: [] }));
  body.innerHTML = `
    <form class="panel" id="migScan">
      <h2>Chuyển từ Laragon</h2>
      <p class="sub" style="margin-top:-.3rem">Chép mã nguồn và database từ Laragon sang Sitebench, giữ nguyên tên miền .test, phiên bản PHP, HTTPS và chứng chỉ. Laragon không bị thay đổi.</p>
      <div class="row">
        <div class="field grow"><label for="migRoot">Thư mục Laragon</label><input id="migRoot" list="migRoots" required value="${h(st.laragon[0] || '')}" placeholder="D:\\laragon">
          <datalist id="migRoots">${st.laragon.map(x => `<option value="${h(x)}">`).join('')}</datalist></div>
        <button class="btn primary">${ic('search')} Xem trước</button>
      </div>
    </form>
    <div id="migPlan"></div>`;
  $('#migScan').addEventListener('submit', async e => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      const plan = await api(`/api/migrate/laragon?root=${encodeURIComponent($('#migRoot').value.trim())}`);
      showMigPlan(plan);
    } catch (err) { toast(err.message, true); } finally { e.submitter.disabled = false; }
  });
}

function showMigPlan(p) {
  const kind = { wordpress: 'WordPress', laravel: 'Laravel', php: 'PHP' };
  const box = $('#migPlan');
  box.innerHTML = `
    <form class="panel" id="migGo">
      ${p.laragonRunning ? `<div class="warn-line">Apache/MySQL của Laragon đang chạy. Sitebench sẽ tắt chúng trước khi chuyển (dùng chung cổng 80/3306). Nên thoát hẳn Laragon.</div>` : ''}
      <dl class="facts" style="margin-bottom:1rem">
        <dt>MySQL của Laragon</dt><dd>${h(p.mysql?.name || 'không tìm thấy')}${p.mysql?.datadir ? ` <span class="sub">(dữ liệu: ${h(p.mysql.datadir)})</span>` : ''}</dd>
        <dt>PHP mặc định</dt><dd>${h(p.defaultPhp || '—')} <span class="sub">· có ${p.phps.length} bản: ${p.phps.map(x => h(x.version)).join(', ')}</span></dd>
        <dt>Chứng chỉ HTTPS</dt><dd>${p.ca ? 'dùng lại chứng chỉ gốc đã cài (không phải cài lại vào Windows)' : 'không có'}</dd>
      </dl>
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Dự án (${p.projects.length})</h2>
        <label class="switch small"><input type="checkbox" id="migAllP" checked> <span>Chọn tất cả</span></label></div>
      <div class="table-wrap" style="margin:.5rem 0 1.2rem"><table><tbody>
        ${p.projects.map(x => `<tr><td style="width:2rem"><input type="checkbox" data-p="${h(x.name)}" ${x.exists ? 'disabled' : 'checked'} aria-label="Chọn ${h(x.name)}"></td>
          <td><b>${h(x.name)}</b> <span class="tag">${h(kind[x.kind] || x.kind)}</span>${x.php ? `<span class="tag">PHP ${h(x.php)}</span>` : ''}${x.https ? '<span class="tag">HTTPS</span>' : ''}${x.lan ? '<span class="tag">Wi-Fi</span>' : ''}
            <div class="sub">${x.db ? `database ${h(x.db)}` : 'không có database'}${x.exists ? ' · <b>đã có trong Sitebench, bỏ qua</b>' : ''}</div></td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Database (${p.databases.length})</h2>
        <label class="switch small"><input type="checkbox" id="migAllD" checked> <span>Chọn tất cả</span></label></div>
      <div class="ext-grid" style="margin:.6rem 0 1.2rem">${p.databases.map(d => `<label class="switch small" title="${d.usedBy.length ? `dùng cho ${h(d.usedBy.join(', '))}` : 'không thuộc dự án nào'}">
        <input type="checkbox" data-d="${h(d.name)}" ${d.exists ? 'disabled' : 'checked'}> <span>${h(d.name)}${d.exists ? ' (đã có)' : ''}</span></label>`).join('') || '<span class="muted">Không có database.</span>'}</div>
      <div class="toggles">
        <label class="switch"><input type="checkbox" id="migSkipNm" checked> <span>Bỏ qua node_modules (nhanh hơn nhiều; chạy lại npm install sau)</span></label>
        <label class="switch"><input type="checkbox" id="migKeepPhp" checked> <span>Giữ phiên bản PHP như trong Laragon (chép bản PHP của Laragon sang, kèm php.ini)</span></label>
      </div>
      <div class="row" style="margin-top:1rem">
        <div class="field"><label for="migPw">Mật khẩu root MySQL của Laragon</label><input id="migPw" type="password" placeholder="(Laragon mặc định để trống)" autocomplete="off"></div>
        <button class="btn primary" style="align-self:end">${ic('rocket')} Chuyển sang Sitebench</button>
      </div>
    </form>
    <div id="migJob"></div>`;
  $('#migAllP').onchange = e => box.querySelectorAll('[data-p]:not(:disabled)').forEach(c => { c.checked = e.target.checked; });
  $('#migAllD').onchange = e => box.querySelectorAll('[data-d]:not(:disabled)').forEach(c => { c.checked = e.target.checked; });
  $('#migGo').addEventListener('submit', async e => {
    e.preventDefault();
    const body = {
      root: p.root,
      projects: [...box.querySelectorAll('[data-p]:checked')].map(c => c.dataset.p),
      databases: [...box.querySelectorAll('[data-d]:checked')].map(c => c.dataset.d),
      skipNodeModules: $('#migSkipNm').checked, keepPhp: $('#migKeepPhp').checked, password: $('#migPw').value,
    };
    if (!body.projects.length && !body.databases.length) { toast('Chưa chọn dự án hoặc database nào.', true); return; }
    const r = await act(e.submitter, () => api('/api/migrate/laragon', { method: 'POST', body }));
    if (!r) return;
    e.target.hidden = true;
    watchJob(r.job, $('#migJob'), (res, out) => {
      out.innerHTML = `<p><b>${ic('circle-check')} Đã chuyển ${res.projects.length} dự án và ${res.databases.length} database.</b> <a href="#laragon">Xem dự án</a></p>
        ${res.skipped.length ? `<p class="sub">Bỏ qua: ${res.skipped.map(h).join(', ')}</p>` : ''}
        ${res.notes.length ? `<ul class="notes">${res.notes.map(n => `<li>${h(n)}</li>`).join('')}</ul>` : ''}`;
      refreshLeds();
    });
  });
}

// ================= Email (Mailpit) =================
async function renderMail() {
  const m = await api('/api/mail');
  view.innerHTML = `
    <h1>Email</h1>
    <p class="lead">Mailpit giữ lại mọi email mà các website ở local gửi đi (đặt hàng, quên mật khẩu, form liên hệ…) để bạn xem ở đây. Không email nào được gửi tới người thật.</p>
    <div class="panel">
      <div class="row" style="align-items:center">
        <span class="led ${m.running ? 'on' : m.error ? 'bad' : ''}"></span>
        <div class="grow"><b>${m.installed ? `Mailpit ${h(m.version || '')}` : 'Chưa cài Mailpit'}</b>
          <div class="sub">${m.running ? `Đang chạy · SMTP ${h(m.smtp)}${m.messages ? ` · ${m.messages.total} email` : ''}` : m.installed ? 'Đã tắt' : 'Tải Mailpit (khoảng 15 MB) từ GitHub chính thức.'}</div>
          ${m.error ? `<div class="sub error">${h(m.error)}</div>` : ''}</div>
        ${!m.installed ? '<button class="btn primary" data-m="install">Tải Mailpit</button>' : m.running
          ? `<a class="btn" href="${h(m.uiUrl)}" target="_blank" rel="noopener">Mở trong tab mới</a><button class="btn" data-m="stop">Tắt</button>`
          : '<button class="btn primary" data-m="start">Bật</button>'}
        ${m.installed ? '<button class="btn" data-m="install" title="Tải bản Mailpit mới nhất">Cập nhật</button>' : ''}
      </div>
      ${m.installed ? `<div class="toggles" style="margin-top:1rem">
        <label class="switch"><input type="checkbox" id="mAuto" ${m.autoStart ? 'checked' : ''}> <span>Tự bật Mailpit khi mở Sitebench</span></label>
        <label class="switch"><input type="checkbox" id="mCatch" ${m.catchPhp ? 'checked' : ''}> <span>Chuyển email gửi bằng hàm mail() của PHP vào Mailpit (mọi dự án, mọi phiên bản PHP)</span></label>
      </div>
      <p class="sub" style="margin:.75rem 0 0">Laravel và ứng dụng dùng SMTP: đặt máy chủ 127.0.0.1, cổng ${h(m.smtp.split(':')[1])}, không mã hóa (site nhập bằng Sitebench đã được đặt sẵn).
        WordPress cài mới, nhân bản hoặc nhập bằng Sitebench có sẵn plugin ép email vào Mailpit, kể cả khi site đang cấu hình SMTP thật.</p>` : ''}
    </div>
    ${m.running ? `<iframe class="mail-frame" src="${h(m.uiUrl)}" title="Hộp thư Mailpit"></iframe>` : ''}`;
  view.querySelectorAll('[data-m]').forEach(b => b.onclick = async () => {
    const a = b.dataset.m;
    b.textContent = { install: 'Đang tải…', start: 'Đang bật…', stop: 'Đang tắt…' }[a];
    const r = await act(b, () => api(`/api/mail/${a}`, { method: 'POST' }), { install: 'Đã cài Mailpit.', start: 'Đã bật Mailpit.', stop: 'Đã tắt Mailpit.' }[a]);
    if (r?.reloadError) toast(r.reloadError, true);
    renderMail();
  });
  $('#mAuto')?.addEventListener('change', e => act(e.target, () => api('/api/mail/settings', { method: 'POST', body: { autoStart: e.target.checked } }), 'Đã lưu.'));
  $('#mCatch')?.addEventListener('change', async e => {
    const r = await act(e.target, () => api('/api/mail/settings', { method: 'POST', body: { catchPhp: e.target.checked } }));
    if (r) reportApache(r, e.target.checked ? 'Email của PHP sẽ vào Mailpit.' : 'PHP gửi email theo cấu hình gốc.');
  });
}

// ================= Nhật ký =================
const logState = { es: null, current: null, paused: false, buffer: [], lines: [] };
function closeLogStream() { if (logState.es) { logState.es.close(); logState.es = null; } }

async function renderLogs() {
  const { sources } = await api('/api/logs');
  const groups = {};
  for (const s of sources) (groups[s.group] = groups[s.group] || []).push(s);
  view.innerHTML = `
    <h1>Nhật ký</h1>
    <p class="lead">Log của Apache, PHP, MySQL và từng dự án, tự cập nhật khi có dòng mới. Bật Debug ở trang quản lý site WordPress để có debug.log.</p>
    <div class="logs-grid">
      <nav class="panel log-list" aria-label="Các tệp log">
        ${sources.length ? Object.entries(groups).map(([g, list]) => `<h3>${h(g)}</h3>${list.map(s => `
          <button class="log-item ${logState.current === s.id ? 'active' : ''}" data-log="${s.id}">${h(s.label)}<span class="sub">${fmtSize(s.size)}</span></button>`).join('')}`).join('')
          : '<p class="muted">Chưa có tệp log nào.</p>'}
      </nav>
      <section class="panel flush log-view" id="logView"><p class="empty">Chọn một tệp log bên trái.</p></section>
    </div>`;
  view.querySelectorAll('[data-log]').forEach(b => b.onclick = () => openLog(sources.find(s => s.id === b.dataset.log)));
  const cur = sources.find(s => s.id === logState.current);
  if (cur) openLog(cur);
}

function logClass(line) {
  if (/\b(fatal|error|crit|alert|emerg|exception|failed)\b/i.test(line)) return 'l-err';
  if (/\b(warn|warning|deprecated)\b/i.test(line)) return 'l-warn';
  if (/\b(notice|info|debug)\b/i.test(line)) return 'l-info';
  return '';
}

function openLog(src) {
  closeLogStream();
  logState.current = src.id;
  logState.paused = false;
  logState.lines = [];
  view.querySelectorAll('[data-log]').forEach(b => b.classList.toggle('active', b.dataset.log === src.id));
  const box = $('#logView');
  box.innerHTML = `
    <div class="toolbar">
      <div class="grow"><b>${h(src.label)}</b><div class="sub log-path">${h(src.path)}</div></div>
      <input id="logFilter" placeholder="Lọc dòng…" style="width:11rem">
      <label class="switch small"><input type="checkbox" id="logScroll" checked> <span>Tự cuộn</span></label>
      <button class="btn small" id="logPause">Tạm dừng</button>
      <button class="btn small" id="logClear">Xóa nội dung</button>
      <a class="btn small" href="/api/logs/${src.id}/download">Tải về</a>
    </div>
    <div class="log-out" id="logOut" tabindex="0"></div>`;
  const out = $('#logOut');
  const MAX = 5000;
  const filterOk = l => { const f = $('#logFilter').value.trim().toLowerCase(); return !f || l.toLowerCase().includes(f); };
  const draw = () => {
    out.innerHTML = logState.lines.filter(filterOk).map(l => `<div class="${logClass(l)}">${h(l) || '&nbsp;'}</div>`).join('');
    if ($('#logScroll').checked) out.scrollTop = out.scrollHeight;
  };
  let partial = '';
  const add = (text, reset) => {
    if (reset) { logState.lines = []; partial = ''; }
    const parts = (partial + text).split(/\r?\n/);
    partial = parts.pop();
    logState.lines.push(...parts);
    if (logState.lines.length > MAX) logState.lines.splice(0, logState.lines.length - MAX);
    if (!logState.paused) draw();
  };
  const es = logState.es = new EventSource(`/api/logs/${src.id}/stream`);
  es.addEventListener('init', e => { const d = JSON.parse(e.data); add((d.truncated ? '… (chỉ hiện phần cuối tệp)\n' : '') + d.text + '\n', true); });
  es.addEventListener('append', e => add(JSON.parse(e.data).text));
  es.addEventListener('reset', e => add(`--- tệp đã bị xóa nội dung hoặc xoay vòng ---\n${JSON.parse(e.data).text}\n`, true));
  es.addEventListener('gone', e => { add(`\n--- ${JSON.parse(e.data).message} ---\n`); closeLogStream(); });
  $('#logFilter').oninput = draw;
  $('#logPause').onclick = e => {
    logState.paused = !logState.paused;
    e.target.textContent = logState.paused ? 'Tiếp tục' : 'Tạm dừng';
    if (!logState.paused) draw();
  };
  $('#logClear').onclick = async e => {
    if (!confirm(`Xóa toàn bộ nội dung của ${src.label}? Không thể hoàn tác.`)) return;
    await act(e.target, () => api(`/api/logs/${src.id}/clear`, { method: 'POST' }), 'Đã xóa nội dung tệp log.');
  };
}

// ================= Terminal =================
const TERM_THEME = {
  background: '#141a21', foreground: '#dfe6ec', cursor: '#33c275', cursorAccent: '#141a21',
  selectionBackground: 'rgba(110, 149, 242, 0.35)',
  black: '#1c242d', red: '#ef6b5b', green: '#33c275', yellow: '#e0a42a', blue: '#6e95f2', magenta: '#c58af9', cyan: '#4fc1d9', white: '#c9d3dc',
  brightBlack: '#5c6a78', brightRed: '#ff8a7a', brightGreen: '#5fd895', brightYellow: '#f2c35b', brightBlue: '#94b2ff', brightMagenta: '#dbb0ff', brightCyan: '#7fd8ea', brightWhite: '#ffffff',
};
const termState = { inited: false, sessions: [], active: null, preset: undefined, info: null, assets: null, seq: 0 };

function loadTermAssets() {
  if (termState.assets) return termState.assets;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/vendor/xterm/css/xterm.css';
  document.head.append(css);
  const script = src => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Không tải được ${src}. Hãy cài lại Sitebench để cài thư viện terminal.`));
    document.head.append(el);
  });
  termState.assets = script('/vendor/xterm/lib/xterm.js').then(() => script('/vendor/xterm-fit/lib/addon-fit.js'))
    .catch(e => { termState.assets = null; throw e; });
  return termState.assets;
}

// Mở trang Terminal với một dự án chọn sẵn và tự mở phiên mới
function openTerminalFor(project) {
  termState.preset = project || '';
  if (location.hash === '#terminal') renderTerminal(); else location.hash = '#terminal';
}

async function renderTerminal() {
  const root = $('#termRoot');
  if (!termState.inited) {
    root.innerHTML = `
      <h1>Terminal</h1>
      <p class="lead">Dòng lệnh mở sẵn tại thư mục dự án và dùng đúng PHP của dự án. Có sẵn composer, git, node, mysql của Laragon và lệnh wp (WP-CLI).</p>
      <div class="notice" id="termBlocked" hidden></div>
      <div class="term-bar">
        <div class="field"><label for="termProject">Mở tại</label><select id="termProject"></select></div>
        <div class="field"><label for="termShell">Shell</label><select id="termShell"></select></div>
        <button class="btn primary" id="termNew">Mở phiên mới</button>
        <button class="btn" id="termNative" hidden>Mở cửa sổ Windows</button>
        <span class="grow"></span>
        <label class="switch"><input type="checkbox" id="termEnabled"> <span>Cho phép terminal trên web</span></label>
      </div>
      <div class="term-tabs" id="termTabs" role="tablist" aria-label="Các phiên terminal"></div>
      <div class="term-host" id="termHost"><p class="term-empty" id="termEmpty">Chưa có phiên nào. Chọn nơi mở rồi bấm "Mở phiên mới".</p></div>`;
    termState.inited = true;
    $('#termNew').onclick = () => openTermSession().catch(e => toast(e.message, true));
    $('#termNative').onclick = async e => {
      const r = await act(e.target, () => api('/api/terminal/open', { method: 'POST', body: { project: $('#termProject').value || null, shell: $('#termShell').value } }));
      if (r) toast(`Đã mở ${r.app}.`);
    };
    $('#termShell').onchange = () => api('/api/terminal/config', { method: 'POST', body: { shell: $('#termShell').value } }).catch(() => {});
    $('#termEnabled').onchange = async e => {
      const on = e.target.checked;
      if (!on && termState.sessions.some(s => !s.ended) && !confirm('Tắt terminal trên web sẽ đóng mọi phiên đang mở. Tiếp tục?')) { e.target.checked = true; return; }
      await act(e.target, () => api('/api/terminal/config', { method: 'POST', body: { enabled: on } }), on ? 'Đã bật terminal trên web.' : 'Đã tắt terminal trên web.');
      refreshTermInfo();
    };
    new ResizeObserver(() => fitActive()).observe($('#termHost'));
  }
  await refreshTermInfo();
  if (termState.preset !== undefined) {
    const p = termState.preset;
    termState.preset = undefined;
    $('#termProject').value = p;
    if (termState.info?.available) await openTermSession();
  } else if (termState.active) {
    fitActive();
    termState.active.term.focus();
  }
}

async function refreshTermInfo() {
  const info = termState.info = await api('/api/terminal');
  const projSel = $('#termProject'), shellSel = $('#termShell');
  const keepProj = projSel.value, keepShell = shellSel.value || info.shell;
  projSel.innerHTML = `<option value="">Thư mục www${info.defaultPhp ? ` (PHP ${h(info.defaultPhp)})` : ''}</option>` +
    info.projects.map(p => `<option value="${h(p.name)}">${h(p.name)} (PHP ${h(p.php || info.defaultPhp || '?')}${p.php ? '' : ', mặc định'})</option>`).join('');
  projSel.value = info.projects.some(p => p.name === keepProj) ? keepProj : '';
  shellSel.innerHTML = info.shells.map(x => `<option value="${h(x.id)}">${h(x.label)}</option>`).join('');
  shellSel.value = info.shells.some(x => x.id === keepShell) ? keepShell : info.shell;
  $('#termEnabled').checked = info.enabled;
  $('#termNative').hidden = !info.native;
  $('#termNew').disabled = !info.available;
  const blocked = $('#termBlocked');
  blocked.hidden = info.available;
  blocked.textContent = info.reason || '';
}

function fitActive() {
  const s = termState.active;
  if (!s || s.pane.hidden) return;
  try { s.fit.fit(); } catch { /* chưa hiển thị */ }
}

async function openTermSession() {
  await loadTermAssets();
  const project = $('#termProject').value;
  const shell = $('#termShell').value;
  const shellLabel = (termState.info.shells.find(x => x.id === shell) || {}).label || shell;
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  $('#termHost').append(pane);
  $('#termEmpty').hidden = true;

  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, theme: TERM_THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);

  const tab = document.createElement('div');
  tab.className = 'term-tab';
  tab.setAttribute('role', 'tab');
  tab.innerHTML = `<button class="term-tab-label">${h(project || 'www')} <span class="sub">${h(shellLabel.split(' (')[0])}</span></button><button class="term-x" aria-label="Đóng phiên">×</button>`;
  $('#termTabs').append(tab);

  const s = { id: ++termState.seq, term, fit, pane, tab, ws: null, ended: false };
  termState.sessions.push(s);
  activateTerm(s);
  tab.querySelector('.term-tab-label').onclick = () => activateTerm(s);
  tab.querySelector('.term-x').onclick = () => {
    if (!s.ended && !confirm('Đóng phiên terminal này? Lệnh đang chạy sẽ bị dừng.')) return;
    closeTerm(s);
  };

  const q = new URLSearchParams({ project, shell, cols: term.cols, rows: term.rows });
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal/ws?${q}`);
  s.ws = ws;
  let opened = false;
  ws.onopen = () => { opened = true; };
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'o') term.write(m.d);
    else if (m.t === 'x') endTerm(s, m.code);
  };
  ws.onclose = () => endTerm(s, null, opened ? null : 'Không kết nối được terminal. Thử tải lại trang hoặc đăng nhập lại.');

  term.onData(d => {
    if (s.ended) return closeTerm(s);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }));
  });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', c: cols, r: rows }));
  });
  // Ctrl+C khi đang chọn chữ: copy; Ctrl+V: để trình duyệt dán (xterm nhận qua sự kiện paste)
  term.attachCustomKeyEventHandler(ev => {
    if (ev.type !== 'keydown' || !ev.ctrlKey) return true;
    const k = ev.key.toLowerCase();
    if ((k === 'c' && term.hasSelection()) || (k === 'c' && ev.shiftKey)) {
      const text = term.getSelection();
      if (text) navigator.clipboard?.writeText(text).catch(() => {});
      term.clearSelection();
      return false;
    }
    if (k === 'v') return false;
    return true;
  });
  term.focus();
}

function activateTerm(s) {
  termState.active = s;
  for (const x of termState.sessions) {
    x.pane.hidden = x !== s;
    x.tab.classList.toggle('active', x === s);
    x.tab.setAttribute('aria-selected', x === s ? 'true' : 'false');
  }
  requestAnimationFrame(() => { fitActive(); s.term.focus(); });
}

function endTerm(s, code, message) {
  if (s.ended) return;
  s.ended = true;
  s.tab.classList.add('ended');
  if (message) s.term.write(`\r\n\x1b[31m${message}\x1b[0m`);
  s.term.write(`\r\n\x1b[90m[Phiên đã kết thúc${code != null ? ` (mã ${code})` : ''}. Nhấn phím bất kỳ để đóng tab.]\x1b[0m\r\n`);
}

function closeTerm(s) {
  s.ended = true;
  try { s.ws?.close(); } catch { /* đã đóng */ }
  s.term.dispose();
  s.pane.remove();
  s.tab.remove();
  termState.sessions = termState.sessions.filter(x => x !== s);
  if (termState.active === s) {
    termState.active = null;
    const last = termState.sessions[termState.sessions.length - 1];
    if (last) activateTerm(last);
    else $('#termEmpty').hidden = false;
  }
}

// ================= Giao diện Sitebench 2: icon, tiêu đề trang =================
const ic = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="icons.svg#i-${name}"/></svg>`;
const VIEW_ICONS = { overview: 'layout-dashboard', laragon: 'server', wp: 'newspaper', import: 'download-cloud', backups: 'archive', db: 'database',
  mail: 'mail', logs: 'scroll-text', terminal: 'terminal-square', files: 'folder-tree', sites: 'globe', services: 'cog', settings: 'settings' };
// Gắn icon vào tiêu đề h1 đầu tiên của mỗi trang (trừ trang Tổng quan đã có thiết kế riêng)
function decorateTitle(root, name) {
  const h1 = root.querySelector('h1');
  if (!h1 || h1.closest('.page-title, .dash-hero, .page-head .page-title') || !VIEW_ICONS[name]) return;
  const wrap = document.createElement('div');
  wrap.className = 'page-title';
  wrap.innerHTML = `<span class="pi">${ic(VIEW_ICONS[name])}</span>`;
  h1.replaceWith(wrap);
  wrap.append(h1);
}
new MutationObserver(() => decorateTitle(view, (location.hash.slice(1) || 'overview'))).observe(view, { childList: true });
const termObserver = new MutationObserver(() => decorateTitle($('#termRoot'), 'terminal'));
termObserver.observe($('#termRoot'), { childList: true });

let runtimeInfo = null;
async function loadRuntimeInfo() {
  runtimeInfo = await api('/api/runtime').catch(() => null);
  const tag = $('#modeTag');
  if (tag && runtimeInfo) tag.textContent = runtimeInfo.mode === 'standalone' ? 'Máy chủ độc lập' : 'Đang dùng Laragon';
  refreshUpdateBadge();
}

// ================= Tổng quan (bảng điều khiển) =================
async function renderOverview() {
  const [o, lg, sv, mail] = await Promise.all([
    api('/api/overview'), api('/api/laragon').catch(() => null), api('/api/laragon/services').catch(() => null), api('/api/mail').catch(() => null)]);
  const memUsed = o.memTotal - o.memFree;
  const memPct = Math.round((memUsed / o.memTotal) * 100);
  const standalone = runtimeInfo?.mode === 'standalone';
  const projects = lg?.detected ? lg.projects : [];
  const defPhp = lg?.versions?.find(v => v.isDefault);
  const svc = (x, label, icon) => {
    if (!x) return '';
    const state = x.running ? 'Đang chạy' : x.starting ? 'Đang khởi động' : x.portTaken ? `Cổng ${x.port} bị chiếm` : x.found ? 'Đã tắt' : 'Chưa cài';
    return `<div class="card">
      <div class="card-head">${ic(icon)} ${label}</div>
      <div class="card-value"><span class="led ${x.running ? 'on' : x.starting ? 'warn' : x.portTaken ? 'bad' : ''}"></span> ${state}</div>
      <div class="card-sub">${h(x.version || '—')} · cổng ${x.port}</div>
      ${x.found ? `<div class="row">${x.running
        ? `<button class="btn small" data-sv="${label === 'Apache' ? 'apache' : 'mysql'}" data-act="restart">${ic('rotate-cw')} Khởi động lại</button><button class="btn small" data-sv="${label === 'Apache' ? 'apache' : 'mysql'}" data-act="stop">${ic('square')} Tắt</button>`
        : `<button class="btn small primary" data-sv="${label === 'Apache' ? 'apache' : 'mysql'}" data-act="start">${ic('play')} Bật</button>`}</div>` : ''}
    </div>`;
  };
  view.innerHTML = `
    <section class="dash-hero">
      <h1>Xin chào!</h1>
      <p>${standalone ? 'Sitebench đang tự quản lý máy chủ' : lg?.detected ? 'Sitebench đang dùng máy chủ của Laragon' : 'Chưa kết nối máy chủ'} trên <b>${h(o.hostname)}</b> · bật được ${fmtUptime(o.uptime)}</p>
      <div class="hero-tags">
        <span>${projects.length} dự án</span>
        <span>${projects.filter(p => p.wordpress).length} site WordPress</span>
        ${defPhp ? `<span>PHP ${h(defPhp.version)} mặc định</span>` : ''}
        ${mail?.messages?.unread ? `<span>${mail.messages.unread} email chưa đọc</span>` : ''}
      </div>
      <img class="hero-logo" src="logo.png" alt="">
    </section>
    <div class="cards">
      ${svc(sv?.apache, 'Apache', 'server')}
      ${svc(sv?.mysql, 'MySQL', 'database')}
      <div class="card">
        <div class="card-head">${ic('cpu')} PHP</div>
        <div class="card-value">${h(defPhp?.version || '—')}</div>
        <div class="card-sub">${lg?.versions?.length || 0} phiên bản đã cài · ${standalone ? 'chạy qua FastCGI như PHP-FPM' : 'mặc định chạy trong Apache'}</div>
        <div class="row"><a class="btn small" href="#laragon">${ic('settings')} Quản lý</a></div>
      </div>
      <div class="card">
        <div class="card-head">${ic('memory-stick')} Bộ nhớ</div>
        <div class="card-value">${memPct}%</div>
        <div class="meter"><i style="width:${memPct}%"></i></div>
        <div class="card-sub">${fmtSize(memUsed)} / ${fmtSize(o.memTotal)} · ${o.cpus} luồng CPU</div>
      </div>
    </div>
    <div class="dash-grid">
      <div class="panel">
        <h2>Thao tác nhanh</h2>
        <div class="quick">
          <button data-go="wp-add"><span class="qi">${ic('plus')}</span><span><b>Thêm WordPress</b><span class="sub">Cài site mới, có template</span></span></button>
          <button data-go="import"><span class="qi">${ic('download-cloud')}</span><span><b>Nhập site</b><span class="sub">Kéo site từ host về</span></span></button>
          <button data-go="terminal"><span class="qi">${ic('terminal-square')}</span><span><b>Terminal</b><span class="sub">Dòng lệnh đúng PHP dự án</span></span></button>
          <button data-go="mail"><span class="qi">${ic('mail')}</span><span><b>Hộp thư</b><span class="sub">${mail?.messages ? `${mail.messages.total} email` : 'Email từ các site'}</span></span></button>
          <button data-go="db"><span class="qi">${ic('database')}</span><span><b>Database</b><span class="sub">Xem dữ liệu, chạy SQL</span></span></button>
          <button data-go="backups"><span class="qi">${ic('archive')}</span><span><b>Sao lưu</b><span class="sub">Khôi phục dự án</span></span></button>
        </div>
      </div>
      <div class="panel">
        <div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Dự án</h2><a class="btn small" href="#laragon">Tất cả ${ic('arrow-right')}</a></div>
        ${projects.length ? `<ul class="proj-list">${projects.slice(0, 7).map(p => `
          <li><span class="led ${p.hasVhost ? 'on' : ''}"></span>
            <span class="pname"><a href="${h(p.url)}" target="_blank" rel="noopener">${h(p.name)}</a>
              <span class="sub"> ${h(p.domain)}</span></span>
            ${p.wordpress ? '<span class="tag">WordPress</span>' : ''}${p.https ? '<span class="tag">HTTPS</span>' : ''}${p.php ? '<span class="tag">PHP riêng</span>' : ''}
          </li>`).join('')}</ul>` : '<p class="empty">Chưa có dự án nào.</p>'}
      </div>
    </div>
`;
  view.querySelectorAll('[data-sv]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    const r = await act(b, () => api(`/api/laragon/services/${b.dataset.sv}/${b.dataset.act}`, { method: 'POST' }));
    if (r) toast(r.message);
    renderOverview();
    refreshLeds();
  });
  view.querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
    const g = b.dataset.go;
    if (g === 'wp-add') { location.hash = '#wp'; setTimeout(() => $('#wpAdd')?.click(), 400); }
    else location.hash = `#${g}`;
  });
}

// ================= Trình hướng dẫn lần đầu =================
async function showSetup(status) {
  $('#app').hidden = true;
  $('#login').hidden = true;
  const box = $('#setup');
  box.hidden = false;
  const st = { step: 1, password: '', mode: 'standalone', laragonRoot: status.laragon[0] || '', root: status.suggestRoot, php: '8.4', dbType: 'mysql', dbVersion: '8.0.46', mariadb: '11.4' };
  const draw = () => {
    const steps = st.mode === 'standalone' ? 4 : 3;
    box.innerHTML = `
      <div class="wizard">
        <div class="wizard-head"><img src="logo.png" alt="" width="56" height="56"><div><h1>Chào mừng đến với Sitebench</h1><p>Thiết lập một lần, chỉ mất vài phút.</p></div></div>
        <div class="steps">${Array.from({ length: steps }, (_, i) => `<span class="${i < st.step ? 'done' : ''}"></span>`).join('')}</div>
        <div class="wizard-body" id="wzBody"></div>
      </div>`;
    const body = $('#wzBody');
    if (st.step === 1) {
      body.innerHTML = `
        <h2>Đặt mật khẩu đăng nhập</h2>
        <p class="muted">Dùng để mở bảng điều khiển Sitebench trên máy này.</p>
        <form id="wz1" class="settings-grid">
          <div class="field"><label for="wzPw">Mật khẩu (ít nhất 8 ký tự)</label><input id="wzPw" type="password" minlength="8" required autofocus autocomplete="new-password" value="${h(st.password)}"></div>
          <div class="field"><label for="wzPw2">Nhập lại mật khẩu</label><input id="wzPw2" type="password" minlength="8" required autocomplete="new-password" value="${h(st.password)}"></div>
        </form>
        <div class="wizard-actions"><span></span><button class="btn primary" form="wz1">Tiếp tục ${ic('arrow-right')}</button></div>`;
      $('#wz1').onsubmit = e => {
        e.preventDefault();
        if ($('#wzPw').value !== $('#wzPw2').value) { toast('Hai mật khẩu không khớp.', true); return; }
        st.password = $('#wzPw').value;
        st.step = 2;
        draw();
      };
    } else if (st.step === 2) {
      body.innerHTML = `
        <h2>Chọn cách chạy máy chủ</h2>
        <p class="muted">Có thể đổi sau trong Sitebench.</p>
        <label class="choice"><input type="radio" name="mode" value="standalone" ${st.mode === 'standalone' ? 'checked' : ''}>
          <span><b>Sitebench tự quản lý máy chủ <span class="tag">Khuyên dùng</span></b>
          <p>Không cần Laragon. Sitebench tự tải Apache, PHP, MySQL bản chính thức và chạy PHP qua FastCGI giống PHP-FPM trên hosting.</p></span></label>
        <label class="choice"><input type="radio" name="mode" value="laragon" ${st.mode === 'laragon' ? 'checked' : ''}>
          <span><b>Dùng Laragon đã cài trên máy</b>
          <p>${status.laragon.length ? `Tìm thấy Laragon tại ${status.laragon.map(h).join(', ')}.` : 'Không tìm thấy Laragon trên các ổ đĩa; bạn có thể nhập đường dẫn.'}</p>
          <input id="wzLg" class="${st.mode === 'laragon' ? '' : 'hidden-input'}" value="${h(st.laragonRoot)}" placeholder="D:\\laragon" style="margin-top:.6rem;width:100%"></span></label>
        <div class="wizard-actions"><button class="btn" id="wzBack">Quay lại</button><button class="btn primary" id="wzNext">Tiếp tục ${ic('arrow-right')}</button></div>`;
      body.querySelectorAll('[name=mode]').forEach(r => r.onchange = () => { st.mode = r.value; draw(); });
      $('#wzBack').onclick = () => { st.step = 1; draw(); };
      $('#wzNext').onclick = async e => {
        if (st.mode === 'laragon') {
          st.laragonRoot = $('#wzLg').value.trim();
          const r = await act(e.target, () => api('/api/setup', { method: 'POST', body: { password: st.password, mode: 'laragon', root: st.laragonRoot } }));
          if (r) { st.step = 3; draw(); }
        } else { st.step = 3; draw(); }
      };
    } else if (st.step === 3 && st.mode === 'laragon') {
      body.innerHTML = `<h2>${ic('circle-check')} Đã kết nối Laragon</h2>
        <p class="muted">Sitebench dùng Apache, PHP, MySQL của Laragon tại <b>${h(st.laragonRoot)}</b>. Bạn có thể bật Apache và MySQL ngay trong Sitebench.</p>
        <div class="wizard-actions"><span></span><button class="btn primary" id="wzDone">Vào Sitebench ${ic('arrow-right')}</button></div>`;
      $('#wzDone').onclick = () => { box.hidden = true; location.hash = '#overview'; enterApp(); };
    } else if (st.step === 3) {
      body.innerHTML = `
        <h2>Cấu hình máy chủ</h2>
        <p class="muted">Chọn giống hosting của bạn: xem trong WordPress → Công cụ → Tình trạng website → Thông tin (mục Máy chủ và Cơ sở dữ liệu).</p>
        <form id="wz3"><div class="settings-grid">
          <div class="field" style="grid-column:1/-1"><label for="wzRoot">Thư mục máy chủ (dự án nằm trong thư mục www bên trong)</label><input id="wzRoot" value="${h(st.root)}" required></div>
          <div class="field"><label for="wzPhp">PHP</label><select id="wzPhp">${['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'].map(v => `<option ${v === st.php ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="field"><label for="wzDb">Database</label><select id="wzDb">
            <option value="mysql" ${st.dbType === 'mysql' ? 'selected' : ''}>MySQL</option><option value="mariadb" ${st.dbType === 'mariadb' ? 'selected' : ''}>MariaDB</option></select></div>
          <div class="field">${st.dbType === 'mysql'
            ? `<label for="wzDbv">Phiên bản MySQL</label><input id="wzDbv" value="${h(st.dbVersion)}" pattern="\\d+\\.\\d+\\.\\d+" required>`
            : `<label for="wzDbv">Phiên bản MariaDB</label><select id="wzDbv">${['11.4', '10.11', '10.6'].map(v => `<option ${v === st.mariadb ? 'selected' : ''}>${v}</option>`).join('')}</select>`}</div>
        </div>
        <p class="sub">Sitebench sẽ tải Apache (Apache Lounge), PHP (windows.php.net) và ${st.dbType === 'mysql' ? 'MySQL (dev.mysql.com, khoảng 300 MB)' : 'MariaDB (mariadb.org)'}: mất vài phút tùy tốc độ mạng. Windows có thể hỏi quyền admin để cài Visual C++.</p></form>
        <div class="wizard-actions"><button class="btn" id="wzBack">Quay lại</button><button class="btn primary" form="wz3">${ic('rocket')} Dựng máy chủ</button></div>`;
      $('#wzDb').onchange = e => { st.dbType = e.target.value; st.root = $('#wzRoot').value; st.php = $('#wzPhp').value; draw(); };
      $('#wzBack').onclick = () => { st.step = 2; draw(); };
      $('#wz3').onsubmit = async e => {
        e.preventDefault();
        st.root = $('#wzRoot').value.trim(); st.php = $('#wzPhp').value;
        if (st.dbType === 'mysql') st.dbVersion = $('#wzDbv').value.trim(); else st.mariadb = $('#wzDbv').value;
        const body = { password: st.password, mode: 'standalone', root: st.root, php: st.php,
          database: st.dbType === 'mysql' ? { type: 'mysql', version: st.dbVersion } : { type: 'mariadb', version: st.mariadb } };
        const r = await act(null, () => api('/api/setup', { method: 'POST', body }));
        if (!r) return;
        st.step = 4; st.job = r.job; draw();
      };
    } else if (st.step === 4) {
      body.innerHTML = `<h2>Đang dựng máy chủ</h2><p class="muted">Đừng đóng cửa sổ này. Có thể mất vài phút.</p><div id="wzJob"></div>`;
      watchJob(st.job, $('#wzJob'), (res, out) => {
        out.innerHTML = `<p><b>${ic('circle-check')} Máy chủ đã sẵn sàng.</b> Apache ${h(res.apache)}, ${h(res.php)}, ${h(res.db)} tại ${h(res.root)}.</p>
          <p class="sub">${h(res.message || '')}</p>
          <button class="btn primary" id="wzDone">Vào Sitebench ${ic('arrow-right')}</button>`;
        $('#wzDone').onclick = () => { box.hidden = true; location.hash = '#overview'; enterApp(); };
      });
      // Lỗi giữa chừng: cho quay lại sửa cấu hình
      const timer = setInterval(() => {
        const err = $('#wzJob .job-result .error');
        if (err && !$('#wzRetry')) {
          clearInterval(timer);
          err.insertAdjacentHTML('afterend', '<button class="btn" id="wzRetry">Sửa cấu hình và thử lại</button>');
          $('#wzRetry').onclick = () => { st.step = 3; draw(); };
        }
        if ($('#wzDone')) clearInterval(timer);
      }, 1000);
    }
  };
  draw();
}

async function enterApp() {
  $('#login').hidden = true;
  $('#setup').hidden = true;
  $('#app').hidden = false;
  await loadRuntimeInfo();
  route();
}

// ================= Cài đặt =================
async function renderSettings() {
  const s = await api('/api/settings');
  const standalone = s.mode === 'standalone';
  const lgRoots = [...new Set([s.roots.laragon, ...s.laragonFound].filter(Boolean))];
  view.innerHTML = `
    <h1>Cài đặt</h1>
    <p class="lead">Chế độ máy chủ, phiên bản phần mềm đang dùng, cổng, ứng dụng và bảo mật.</p>

    <section class="panel" id="stMode">
      <h2>Chế độ máy chủ</h2>
      <label class="choice"><input type="radio" name="stmode" value="standalone" ${standalone ? 'checked' : ''}>
        <span><b>Sitebench tự quản lý máy chủ ${standalone ? '<span class="tag">Đang dùng</span>' : ''}</b>
        <p>${s.standaloneReady ? `Máy chủ tại <b>${h(s.roots.standalone)}</b>.` : 'Chưa dựng: chọn thư mục và phiên bản bên dưới, Sitebench sẽ tải và cài đặt.'}</p></span></label>
      <label class="choice"><input type="radio" name="stmode" value="laragon" ${standalone ? '' : 'checked'}>
        <span><b>Dùng Laragon đã cài ${standalone ? '' : '<span class="tag">Đang dùng</span>'}</b>
        <p>${lgRoots.length ? `Laragon tại ${lgRoots.map(h).join(', ')}.` : 'Không tìm thấy Laragon trên các ổ đĩa.'}</p></span></label>
      <div id="stModeForm" style="margin-top:1rem"></div>
      <div id="stModeJob"></div>
    </section>

    ${s.installed ? `<section class="panel" id="stVer"></section>` : ''}

    <section class="panel" id="stUpd"><h2>Cập nhật</h2><p class="muted">Đang tải…</p></section>

    <section class="panel">
      <h2>Cổng</h2>
      <form id="stPorts" class="settings-grid">
        <div class="field"><label for="stHttp">Apache (website)</label><input id="stHttp" type="number" min="1" max="65535" value="${s.httpPort}"></div>
        <div class="field"><label for="stDb">MySQL</label><input id="stDb" type="number" min="1" max="65535" value="${s.mysqlPort}"></div>
        <div class="field" style="align-self:end"><button class="btn primary">Lưu cổng máy chủ</button></div>
      </form>
      <p class="sub">${standalone ? 'Sitebench tự sửa httpd.conf, my.ini, virtual host của mọi dự án và khởi động lại Apache/MySQL.' : 'Đang dùng Laragon: hãy đổi cổng tương ứng trong Laragon cho khớp.'} Đổi cổng 80 thì địa chỉ site có dạng http://ten.test:cổng.</p>
      <form id="sSitebench" class="row" style="margin-top:.8rem">
        <div class="field"><label for="sSitebenchPort">Cổng của bảng điều khiển Sitebench</label><input id="sSitebenchPort" type="number" min="1024" max="65535" value="${s.panelPort}"></div>
        <button class="btn" style="align-self:end">Đổi cổng Sitebench</button>
      </form>
    </section>

    <section class="panel" id="desktopBox"></section>

    <section class="panel">
      <h2>Bảo mật</h2>
      <form id="pwForm" class="row">
        <div class="field grow"><label for="pwCur">Mật khẩu hiện tại</label><input id="pwCur" type="password" autocomplete="current-password" required></div>
        <div class="field grow"><label for="pwNew">Mật khẩu mới (ít nhất 8 ký tự)</label><input id="pwNew" type="password" autocomplete="new-password" minlength="8" required></div>
        <button class="btn primary" style="align-self:end">Đổi mật khẩu</button>
      </form>
    </section>

    <section class="panel">
      <h2>Thông tin</h2>
      <dl class="facts">
        <dt>Phiên bản Sitebench</dt><dd>${h(s.version)}</dd>
        <dt>Thư mục ứng dụng</dt><dd>${h(s.appDir)}</dd>
        <dt>Thư mục máy chủ</dt><dd>${h(s.root)}</dd>
        <dt>Bảng điều khiển</dt><dd>http://localhost:${s.panelPort}</dd>
      </dl>
      ${s.tray ? `<p style="margin-bottom:0"><button class="btn" id="stRestart">${ic('rotate-cw')} Khởi động lại Sitebench</button></p>` : ''}
    </section>`;

  // ----- Chế độ máy chủ -----
  const modeForm = () => {
    const m = $('[name=stmode]:checked').value;
    const box = $('#stModeForm');
    if (m === s.mode && (m === 'laragon' || s.standaloneReady)) { box.innerHTML = ''; return; }
    if (m === 'laragon') {
      box.innerHTML = `<div class="row"><div class="field grow"><label for="stLg">Thư mục Laragon</label>
        <input id="stLg" list="stLgList" value="${h(lgRoots[0] || '')}" placeholder="D:\\laragon"><datalist id="stLgList">${lgRoots.map(x => `<option value="${h(x)}">`).join('')}</datalist></div>
        <button class="btn primary" id="stGo" style="align-self:end">Chuyển sang Laragon</button></div>
        <p class="sub">Sitebench tắt Apache/MySQL của máy chủ độc lập (dữ liệu được giữ nguyên, chuyển lại được bất cứ lúc nào).</p>`;
    } else if (s.standaloneReady) {
      box.innerHTML = `<p class="sub">Sitebench tắt Apache/MySQL của Laragon rồi bật máy chủ tại ${h(s.roots.standalone)}.</p><button class="btn primary" id="stGo">Chuyển sang máy chủ độc lập</button>`;
    } else {
      box.innerHTML = `<div class="settings-grid">
        <div class="field" style="grid-column:1/-1"><label for="stRoot">Thư mục máy chủ</label><input id="stRoot" value="${h(s.roots.standalone || '')}" placeholder="D:\\Sitebench"></div>
        <div class="field"><label for="stPhp">PHP</label><select id="stPhp">${['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'].map(v => `<option>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="stDbType">Database</label><select id="stDbType"><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option></select></div>
        <div class="field"><label for="stDbVer">Phiên bản (MySQL: ví dụ 8.0.46 · MariaDB: 11.4, 10.11)</label><input id="stDbVer" value="8.0.46"></div>
      </div><p class="sub">Sitebench tải Apache, PHP, database bản chính thức rồi dựng máy chủ. Sau đó dùng Nhập site → Từ Laragon để chuyển dự án sang.</p>
      <button class="btn primary" id="stGo">${ic('rocket')} Dựng máy chủ độc lập</button>`;
      $('#stDbType').onchange = e => { $('#stDbVer').value = e.target.value === 'mysql' ? '8.0.46' : '11.4'; };
    }
    $('#stGo').onclick = async e => {
      let body;
      if (m === 'laragon') body = { mode: 'laragon', root: $('#stLg').value.trim() };
      else if (s.standaloneReady) body = { mode: 'standalone' };
      else body = { mode: 'standalone', root: $('#stRoot').value.trim(), php: $('#stPhp').value,
        database: { type: $('#stDbType').value, version: $('#stDbVer').value.trim() } };
      e.target.textContent = 'Đang chuyển…';
      const r = await act(e.target, () => api('/api/settings/mode', { method: 'POST', body }));
      if (!r) { e.target.textContent = 'Thử lại'; return; }
      const finish = async () => { await loadRuntimeInfo(); refreshLeds(); renderSettings(); };
      if (r.job) {
        box.innerHTML = '';
        watchJob(r.job, $('#stModeJob'), (res, out) => {
          out.innerHTML = `<p><b>${ic('circle-check')} Máy chủ đã sẵn sàng tại ${h(res.root)}.</b></p><button class="btn primary" id="stDone">Xong</button>`;
          $('#stDone').onclick = finish;
        });
      } else { toast(r.note || 'Đã chuyển chế độ.'); finish(); }
    };
  };
  view.querySelectorAll('[name=stmode]').forEach(x => x.onchange = modeForm);
  modeForm();

  // ----- Phiên bản đang dùng (máy chủ độc lập) -----
  if (s.installed) {
    const v = s.installed;
    const activeDb = v.mysql.find(x => x.active);
    $('#stVer').innerHTML = `
      <h2>Phiên bản đang dùng</h2>
      <div class="ver-grid">
        <div><h3>${ic('server')} Apache</h3>
          ${v.apache.map(x => `<label class="switch small"><input type="radio" name="vApache" value="${h(x.folder)}" ${x.active ? 'checked' : ''}> <span>${h(x.folder)}</span></label>`).join('') || '<p class="muted">Chưa có</p>'}
          <button class="btn small" id="vApacheNew">${ic('download-cloud')} Tải bản mới nhất</button></div>
        <div><h3>${ic('cpu')} PHP mặc định</h3>
          ${v.php.map(x => `<label class="switch small"><input type="radio" name="vPhp" value="${h(x.folder)}" ${x.active ? 'checked' : ''}> <span>PHP ${h(x.version)}</span></label>`).join('')}
          <a class="btn small" href="#laragon">${ic('download-cloud')} Tải thêm PHP</a></div>
        <div><h3>${ic('database')} Database</h3>
          ${v.mysql.map(x => `<label class="switch small"><input type="radio" name="vDb" value="${h(x.folder)}" data-series="${h(x.series)}" ${x.active ? 'checked' : ''}> <span>${h(x.folder)}</span></label>`).join('')}
          <div class="row" style="margin-top:.4rem"><select id="vDbType"><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option></select>
            <input id="vDbVer" placeholder="8.0.46" style="width:7rem"><button class="btn small" id="vDbNew">Cài thêm</button></div></div>
        <div><h3>${ic('terminal-square')} Node.js</h3>
          ${(v.node || []).map(f => `<span class="sub">${h(f)}</span>`).join('') || '<p class="sub" style="margin:0">Chưa có: npm trong terminal dự án dùng Node.js cài trên máy (nếu có).</p>'}
          <button class="btn small" id="vNodeNew">${ic('download-cloud')} ${(v.node || []).length ? 'Cài bản LTS mới nhất' : 'Cài Node.js LTS'}</button></div>
      </div>
      <div id="vJob"></div>`;
    const setActive = async (kind, folder, input) => {
      const r = await act(input, () => api('/api/runtime/active', { method: 'POST', body: { kind, folder } }));
      if (r) { toast(`Đã dùng ${folder}.${r.message ? ` ${r.message}` : ''}`); if (r.reloadError) toast(r.reloadError, true); renderSettings(); refreshLeds(); }
    };
    view.querySelectorAll('[name=vApache]').forEach(x => x.onchange = () => setActive('apache', x.value, x));
    view.querySelectorAll('[name=vPhp]').forEach(x => x.onchange = () => setActive('php', x.value, x));
    view.querySelectorAll('[name=vDb]').forEach(x => x.onchange = () => {
      if (activeDb && x.dataset.series !== activeDb.series &&
        !confirm(`${x.value} khác dòng với ${activeDb.folder} (${activeDb.series}), nên dùng thư mục dữ liệu riêng: các database hiện có sẽ KHÔNG xuất hiện (vẫn được giữ nguyên, chuyển lại là thấy).\n\nVẫn chuyển?`)) {
        view.querySelector(`[name=vDb][value="${CSS.escape(activeDb.folder)}"]`).checked = true;
        return;
      }
      setActive('mysql', x.value, x);
    });
    const runJob = async (btn, url, body) => {
      const r = await act(btn, () => api(url, { method: 'POST', body }));
      if (r) watchJob(r.job, $('#vJob'), (res, out) => { out.innerHTML = `<p><b>Đã cài ${h(res.folder)}.</b> Chọn bản này ở trên để dùng.</p>`; setTimeout(renderSettings, 1500); });
    };
    $('#vApacheNew').onclick = e => runJob(e.target, '/api/runtime/apache/install', {});
    $('#vNodeNew').onclick = e => runJob(e.target, '/api/runtime/node/install', {});
    $('#vDbType').onchange = e => { $('#vDbVer').placeholder = e.target.value === 'mysql' ? '8.0.46' : '11.4'; };
    $('#vDbNew').onclick = e => {
      const version = $('#vDbVer').value.trim() || $('#vDbVer').placeholder;
      runJob(e.target, '/api/runtime/database/install', { type: $('#vDbType').value, version });
    };
  }

  // ----- Cổng -----
  $('#stPorts').addEventListener('submit', async e => {
    e.preventDefault();
    e.submitter.textContent = 'Đang áp dụng…';
    const r = await act(e.submitter, () => api('/api/settings/ports', { method: 'POST', body: { httpPort: Number($('#stHttp').value), mysqlPort: Number($('#stDb').value) } }), 'Đã lưu cổng.');
    e.submitter.textContent = 'Lưu cổng máy chủ';
    for (const n of r?.notes || []) toast(n);
    if (r) refreshLeds();
  });
  $('#sSitebench').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await act(e.submitter, () => api('/api/settings/panel-port', { method: 'POST', body: { port: Number($('#sSitebenchPort').value) } }));
    if (!r) return;
    if (!r.restarting) { toast(`Đã lưu. Khởi động lại Sitebench rồi mở ${r.url}`); return; }
    toast(`Đang khởi động lại Sitebench ở ${r.url}…`);
    waitAndGo(r.url);
  });
  $('#stRestart')?.addEventListener('click', async e => {
    const r = await act(e.target, () => api('/api/settings/restart', { method: 'POST' }));
    if (r?.restarting) { toast('Đang khởi động lại Sitebench…'); waitAndGo(location.origin + '/'); }
  });
  loadDesktop();
  loadUpdatesPanel().catch(err => { $('#stUpd').innerHTML = `<h2>Cập nhật</h2><p class="error">${h(err.message)}</p>`; });
  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const ok = await act(e.submitter, () => api('/api/password', { method: 'POST', body: { current: $('#pwCur').value, next: $('#pwNew').value } }), 'Đã đổi mật khẩu.');
    if (ok) e.target.reset();
  });
}

// ----- Cài đặt → Cập nhật (Sitebench và phần mềm đi kèm) -----
async function loadUpdatesPanel() {
  const box = $('#stUpd');
  if (!box) return;
  const [su, up] = await Promise.all([api('/api/selfupdate'), api('/api/updates')]);
  if (desk) su.desktop = await desk.info();
  const kindName = { php: 'PHP', apache: 'Apache', mysql: 'Database', 'mysql-series': 'Database (khác dòng)', rollback: 'Quay lại' };
  const tpanelRow = su.desktop ? `
    <div class="upd-row">
      <div class="grow"><b>Sitebench ${h(su.desktop.version)}</b>
        <div class="sub" id="dkUpdInfo">${su.repo ? 'Bấm Kiểm tra để tìm bản mới trên GitHub Releases.' : 'Cập nhật bằng tệp bộ cài, hoặc nhập kho GitHub để tự kiểm tra bản mới.'}</div></div>
      ${su.repo ? `<button class="btn small" id="dkCheck">${ic('refresh-cw')} Kiểm tra</button>` : ''}
      <button class="btn small" id="dkFile">${ic('package')} Cập nhật từ tệp bộ cài</button>
    </div>
    <div id="dkUpd"></div>
    ${su.repo ? `<div class="toggles" style="margin:.6rem 0 .4rem">
      <label class="switch"><input type="checkbox" id="dkAuto" ${su.autoDownload ? 'checked' : ''}> <span><b>Tự tải bản mới</b> và cài khi thoát Sitebench (Apache/MySQL vẫn chạy trong lúc cài)</span></label>
      <label class="switch"><input type="checkbox" id="dkPre" ${su.prerelease ? 'checked' : ''}> <span><b>Nhận bản thử nghiệm</b>: chỉ bật trên máy dùng để thử bản mới trước khi phát hành chính thức</span></label>
    </div>` : ''}` : null;
  box.innerHTML = `
    <h2>Cập nhật</h2>
    ${tpanelRow ? tpanelRow : `<div class="upd-row">
      <div class="grow"><b>Sitebench ${h(su.version)}</b>
        <div class="sub">${su.latest ? (su.latest.newer ? `Có bản mới <b>${h(su.latest.version)}</b>${su.latest.page ? ` · <a href="${h(su.latest.page)}" target="_blank" rel="noopener">ghi chú phát hành</a>` : ''}` : `Đang dùng bản mới nhất (${h(su.latest.version || su.version)})`) : su.repo ? 'Chưa kiểm tra' : 'Cập nhật bằng tệp zip, hoặc nhập kho GitHub để tự kiểm tra bản mới.'}</div></div>
      ${su.repo ? `<button class="btn small" id="suCheck">${ic('refresh-cw')} Kiểm tra</button>` : ''}
      ${su.latest?.newer ? `<button class="btn small primary" id="suDl">${ic('download-cloud')} Tải ${h(su.latest.version)}</button>` : ''}
      <label class="btn small">${ic('package')} Cập nhật từ tệp zip<input type="file" id="suZip" accept=".zip" hidden></label>
    </div>`}
    ${su.staged ? `<div class="upd-row staged"><div class="grow"><b>Sẵn sàng cập nhật lên ${h(su.staged.version)}</b>
        <div class="sub">Sitebench sẽ tắt, sao lưu bản hiện tại, chép bản mới (giữ cài đặt và dữ liệu) rồi tự mở lại. Apache/MySQL vẫn chạy.</div></div>
        <button class="btn small primary" id="suApply" ${su.windows ? '' : 'disabled title="Chỉ trên Windows"'}>${ic('rocket')} Cập nhật ngay</button>
        <button class="btn small" id="suDrop">Bỏ</button></div>` : ''}
    ${su.backup ? `<p class="sub">Bản trước (${h(su.backup)}) được giữ để quay lại: <button class="btn small" id="suBack">Quay lại ${h(su.backup)}</button></p>` : ''}
    <details style="margin:.4rem 0 1rem"><summary class="sub" style="cursor:pointer">Nguồn cập nhật tự động (GitHub Releases)</summary>
      <form id="suRepo" class="row" style="margin-top:.6rem"><input id="suRepoIn" class="grow" placeholder="${h(su.repoBuiltIn ? `Mặc định của bộ cài: ${su.repoBuiltIn}` : 'chu-so-huu/ezpanel')}" value="${h(su.repoCustom || '')}">
        <button class="btn small">Lưu</button></form>
      ${su.repo ? `<p class="sub">Đang dùng: <b>${h(su.repo)}</b>${su.repoCustom ? '' : ' (mặc định của bộ cài, không cần nhập)'}. Để trống ô trên rồi Lưu để quay về mặc định.</p>` : ''}
      <p class="sub">Mỗi bản phát hành cần tệp tpanel-x.y.z.zip (và tpanel-x.y.z.zip.sha256 để kiểm tra mã băm). Sitebench tự kiểm tra mỗi ngày.</p></details>
    ${up.standalone ? `
      <div class="row" style="justify-content:space-between;align-items:center"><b>Phần mềm đi kèm</b>
        <button class="btn small" id="upCheck">${ic('refresh-cw')} Kiểm tra bản mới</button></div>
      <div id="upList">${upListHtml(up)}</div>
      <details style="margin-top:.8rem"><summary class="sub" style="cursor:pointer">Nâng cấp database sang dòng khác (ví dụ MySQL 8.0 → 8.4, hoặc sang MariaDB)</summary>
        <form id="upSeries" class="row" style="margin-top:.6rem">
          <select id="upSType"><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option></select>
          <input id="upSVer" placeholder="8.4.6" required style="width:8rem">
          <button class="btn small">Nâng cấp</button></form>
        <p class="sub">Sitebench xuất toàn bộ database, cài bản mới với thư mục dữ liệu mới rồi nạp lại. Dữ liệu cũ được giữ nguyên để quay lại. Chỉ nên nâng cấp khi host cũng đã lên dòng đó.</p></details>
      ${up.history.length ? `<details style="margin-top:.6rem"><summary class="sub" style="cursor:pointer">Lịch sử cập nhật</summary><ul class="upd-hist">${up.history.map(e => `
        <li><span>${h(kindName[e.kind] || e.kind)}: ${h(e.from)} → ${h(e.to)} <span class="sub">· ${fmtDate(e.at)}</span></span>
        ${e.kind !== 'rollback' ? `<button class="btn small" data-rb="${h(e.id)}">Quay lại ${h(e.from)}</button>` : ''}</li>`).join('')}</ul></details>` : ''}`
      : '<p class="sub">Đang dùng Laragon: phần mềm đi kèm (PHP, Apache, MySQL) do Laragon quản lý.</p>'}
    <div id="updJob"></div>`;

  const job = (r, done) => r && watchJob(r.job, $('#updJob'), (res, out) => { out.innerHTML = `<p><b>${ic('circle-check')} ${h(res.message || `Gói Sitebench ${res.version} đã sẵn sàng.`)}</b></p>`; done?.(); setTimeout(loadUpdatesPanel, 1200); refreshUpdateBadge(); });
  $('#suCheck')?.addEventListener('click', async e => { if (await act(e.target, () => api('/api/selfupdate/check', { method: 'POST' }))) loadUpdatesPanel(); });
  $('#suDl')?.addEventListener('click', async e => job(await act(e.target, () => api('/api/selfupdate/download', { method: 'POST' }))));
  if (su.desktop) bindDesktopUpdate(su);
  if ($('#suZip')) $('#suZip').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    toast('Đang tải gói lên…');
    try {
      const res = await fetch('/api/selfupdate/upload', { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Tải lên thất bại.');
      job(d);
    } catch (err) { toast(err.message, true); }
  };
  $('#suApply')?.addEventListener('click', async e => {
    if (!confirm(`Cập nhật Sitebench lên ${su.staged.version}? Sitebench sẽ tắt và mở lại sau khoảng 30 giây.`)) return;
    if (await act(e.target, () => api('/api/selfupdate/apply', { method: 'POST' }))) { toast('Đang cập nhật, Sitebench sẽ tự mở lại…'); waitAndGo(location.origin + '/#settings'); }
  });
  $('#suDrop')?.addEventListener('click', async e => { if (await act(e.target, () => api('/api/selfupdate/staged', { method: 'DELETE' }))) loadUpdatesPanel(); });
  $('#suBack')?.addEventListener('click', async e => {
    if (!confirm(`Quay lại Sitebench ${su.backup}?`)) return;
    if (await act(e.target, () => api('/api/selfupdate/rollback', { method: 'POST' }))) { toast('Đang quay lại bản trước…'); waitAndGo(location.origin + '/#settings'); }
  });
  $('#suRepo')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (await act(e.submitter, () => api('/api/selfupdate/repo', { method: 'POST', body: { repo: $('#suRepoIn').value } }), 'Đã lưu nguồn cập nhật.')) loadUpdatesPanel();
  });
  if (!up.standalone) return;
  const bindList = () => box.querySelectorAll('[data-up]').forEach(b => b.onclick = async () => {
    const [kind, from] = b.dataset.up.split('|');
    const item = up.items.find(x => x.kind === kind && x.from === from);
    const warn = kind === 'mysql' ? '\n\nMySQL sẽ tắt một lúc; Sitebench sao chép thư mục dữ liệu trước để quay lại khi cần.' : '';
    if (!confirm(`Cập nhật ${item.label} ${item.current} lên ${item.latest}?${warn}`)) return;
    job(await act(b, () => api('/api/updates/apply', { method: 'POST', body: { kind, from } })));
  });
  bindList();
  $('#upCheck').onclick = async e => {
    e.target.disabled = true;
    e.target.innerHTML = 'Đang kiểm tra…';
    const r = await act(null, () => api('/api/updates/check', { method: 'POST' }));
    if (r) { Object.assign(up, r); $('#upList').innerHTML = upListHtml(up); bindList(); refreshUpdateBadge(); }
    e.target.disabled = false;
    e.target.innerHTML = `${ic('refresh-cw')} Kiểm tra bản mới`;
  };
  $('#upSType').onchange = e => { $('#upSVer').placeholder = e.target.value === 'mysql' ? '8.4.6' : '11.4'; };
  $('#upSeries').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { type: $('#upSType').value, version: $('#upSVer').value.trim() };
    if (!confirm(`Nâng cấp database lên ${body.type === 'mysql' ? 'MySQL' : 'MariaDB'} ${body.version}? MySQL sẽ tắt trong lúc chuyển dữ liệu.`)) return;
    job(await act(e.submitter, () => api('/api/updates/database-series', { method: 'POST', body })));
  });
  box.querySelectorAll('[data-rb]').forEach(b => b.onclick = async () => {
    if (!confirm('Quay lại bản trước của lần cập nhật này?')) return;
    const r = await act(b, () => api('/api/updates/rollback', { method: 'POST', body: { id: b.dataset.rb } }));
    if (r) { toast(r.message); loadUpdatesPanel(); refreshLeds(); }
  });
}
function upListHtml(up) {
  if (!up.at) return '<p class="sub">Chưa kiểm tra. Sitebench tự kiểm tra mỗi ngày, hoặc bấm Kiểm tra bản mới.</p>';
  const errs = (up.errors || []).length ? `<p class="sub">Không kiểm tra được: ${up.errors.map(h).join('; ')}</p>` : '';
  if (!up.items.length) return `<p class="sub">${ic('circle-check')} PHP, Apache và database đều là bản mới nhất trong dòng đang dùng (kiểm tra lúc ${fmtDate(up.at)}).</p>${errs}`;
  return `<ul class="upd-hist">${up.items.map(x => `<li><span><b>${h(x.label)}</b> ${h(x.current)} → <b>${h(x.latest)}</b></span>
    <button class="btn small primary" data-up="${h(x.kind)}|${h(x.from)}">Cập nhật</button></li>`).join('')}</ul>${errs}`;
}
async function refreshUpdateBadge() {
  const link = document.querySelector('a[data-view=settings]');
  if (!link) return;
  const c = await api('/api/updates-count').catch(() => null);
  let b = link.querySelector('.badge');
  const n = c ? c.software + (c.tpanel ? 1 : 0) : 0;
  if (!n) { b?.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'badge'; link.append(b); }
  b.textContent = n;
  b.title = `${n} bản cập nhật`;
}

// Cập nhật bản desktop: GitHub Releases (electron-updater) hoặc tệp bộ cài
function bindDesktopUpdate(su) {
  const out = $('#dkUpd');
  // Trạng thái tự tải ngầm (đang tải / đã tải xong, chờ cài khi thoát)
  const showState = st => {
    if (!st || !out) return;
    if (st.downloaded) {
      out.innerHTML = `<div class="upd-row staged"><div class="grow"><b>Sitebench ${h(st.downloaded)} đã tải xong</b>
        <div class="sub">Sẽ được cài khi bạn thoát Sitebench (khay → Thoát Sitebench). Apache/MySQL vẫn chạy.</div></div>
        <button class="btn small primary" id="dkNow">${ic('rocket')} Cài ngay</button></div>`;
      $('#dkNow').onclick = () => desk.update.install();
    } else if (st.available && st.percent != null && st.percent < 100) {
      out.innerHTML = `<div class="upd-row staged"><div class="grow"><b>Đang tải Sitebench ${h(st.available)}</b><div class="sub">${st.percent}%</div></div></div>`;
    }
  };
  desk.update.state?.().then(showState);
  desk.update.onState?.(showState);
  const savePrefs = async (body, msg) => {
    const r = await act(null, () => api('/api/selfupdate/prefs', { method: 'POST', body }));
    if (r) { Object.assign(su, r); toast(msg(r)); }
  };
  $('#dkAuto')?.addEventListener('change', e => savePrefs({ autoDownload: e.target.checked }, r => (r.autoDownload ? 'Đã bật tự tải bản mới.' : 'Đã tắt tự tải: chỉ báo khi có bản mới.')));
  $('#dkPre')?.addEventListener('change', e => savePrefs({ prerelease: e.target.checked }, r => (r.prerelease ? 'Máy này sẽ nhận cả bản thử nghiệm.' : 'Máy này chỉ nhận bản chính thức.')));
  $('#dkFile').onclick = async () => {
    if (!confirm('Chọn tệp Sitebench-Setup-x.y.z.exe. Sitebench sẽ tắt, cài bản mới (giữ cài đặt và dữ liệu) rồi tự mở lại. Apache/MySQL vẫn chạy.')) return;
    try { await desk.update.fromFile(); } catch (e) { toast(e.message, true); }
  };
  $('#dkCheck')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const r = await desk.update.check(su.repo, su.prerelease);
      if (r.downloaded) { showState({ downloaded: r.downloaded }); e.target.disabled = false; return; }
      $('#dkUpdInfo').innerHTML = r.available ? `Có bản mới <b>${h(r.latest)}</b>` : `Đang dùng bản mới nhất (${h(r.current)})`;
      if (r.available) {
        out.innerHTML = `<div class="upd-row staged"><div class="grow"><b>Sitebench ${h(r.latest)}</b><div class="sub" id="dkProg">Tải về rồi cài khi bạn bấm.</div></div>
          <button class="btn small primary" id="dkGo">${ic('download-cloud')} Tải và cài</button></div>`;
        $('#dkGo').onclick = async b => {
          b.target.disabled = true;
          desk.update.onProgress(p => { $('#dkProg').textContent = `Đang tải ${p}%`; });
          try {
            await desk.update.download();
            $('#dkProg').textContent = 'Đã tải xong. Sitebench sẽ tắt, cài bản mới rồi tự mở lại.';
            setTimeout(() => desk.update.install(), 1200);
          } catch (err) { toast(err.message, true); b.target.disabled = false; }
        };
      }
    } catch (err) { toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
    e.target.disabled = false;
  });
}

// Chờ Sitebench chạy lại rồi mở địa chỉ mới
function waitAndGo(url) {
  let tries = 0;
  const tick = async () => {
    tries++;
    try { const r = await fetch(new URL('/api/health', url), { mode: 'no-cors', cache: 'no-store' }); if (r) { location.href = url; return; } } catch { /* chưa chạy lại */ }
    if (tries < 40) setTimeout(tick, 1000); else toast(`Chưa mở được ${url}. Mở thủ công trong trình duyệt.`, true);
  };
  setTimeout(tick, 1500);
}

// ================= Bản desktop (Electron) =================
const desk = window.tpanel?.desktop ? window.tpanel : null;
// Nút "Chọn…" (hộp thoại chọn thư mục của Windows) cạnh các ô đường dẫn
const FOLDER_INPUTS = ['wzLg', 'wzRoot', 'migRoot', 'stLg', 'stRoot', 'lgRoot', 'tplSource'];
function addFolderPickers(root = document) {
  if (!desk) return;
  for (const id of FOLDER_INPUTS) {
    const input = root.querySelector?.(`#${id}`);
    if (!input || input.dataset.picker) continue;
    input.dataset.picker = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small pick-btn';
    btn.innerHTML = `${ic('folder-tree')} Chọn…`;
    btn.onclick = async () => {
      const p = await desk.pickFolder(input.value || undefined);
      if (p) { input.value = p; input.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    const wrap = document.createElement('div');
    wrap.className = 'pick-wrap';
    input.replaceWith(wrap);
    wrap.append(input, btn);
  }
}
if (desk) new MutationObserver(() => addFolderPickers()).observe(document.body, { childList: true, subtree: true });

// ================= Khởi động =================
(async () => {
  const status = await fetch('/api/setup/status').then(r => r.json()).catch(() => ({ setupDone: true }));
  if (!status.setupDone) return showSetup(status);
  try {
    await api('/api/overview');
    enterApp();
  } catch {
    showLogin();
  }
})();
