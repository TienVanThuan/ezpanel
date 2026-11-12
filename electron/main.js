// Sitebench — tiến trình chính của Electron: cửa sổ, khay hệ thống, chạy phần xử lý (server.js), chạy cùng Windows,
// hộp thoại chọn thư mục/tệp, cập nhật (GitHub Releases hoặc tệp bộ cài), chuyển dữ liệu từ bản 2.0.x.

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, utilityProcess, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const DATA = path.join(app.getPath('appData'), 'Sitebench'); // %APPDATA%\Sitebench: cài đặt, công cụ, sao lưu, nhật ký
const ICONS = path.join(__dirname, 'icons');
// Chạy cùng Windows: dùng tên mặc định của Electron (mã ứng dụng) cho cả ghi lẫn đọc.
// Bản 3.0.0–3.0.7 ghi dưới tên "Sitebench" nhưng hàm đọc của Electron tìm theo mã ứng dụng → công tắc luôn hiện "tắt".
const LEGACY_RUN_NAMES = ['EzPanel', 'tPanel'];

// EzPanel → Sitebench (3.0.9): chuyển %APPDATA%\EzPanel thành %APPDATA%\Sitebench TRƯỚC khi Electron tạo thư mục mới
;(function migrateDataDir() {
  // Electron có thể đã tự tạo thư mục Sitebench (Crashpad, Local State…) trước khi đoạn này chạy,
  // nên xét theo config.json chứ không theo việc thư mục đã tồn tại
  const old = path.join(app.getPath('appData'), 'EzPanel');
  try {
    if (fs.existsSync(path.join(DATA, 'config.json')) || !fs.existsSync(path.join(old, 'config.json'))) return;
    fs.mkdirSync(DATA, { recursive: true });
    for (const name of fs.readdirSync(old)) {
      const from = path.join(old, name), to = path.join(DATA, name);
      if (fs.existsSync(to)) continue; // Electron vừa tạo: giữ bản mới
      try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true }); } // tệp đang bị giữ: chép sang
    }
    try { fs.writeFileSync(path.join(old, 'DA-CHUYEN-SANG-SITEBENCH.txt'), `Dữ liệu đã chuyển sang ${DATA}\n`); } catch { /* bỏ qua */ }
  } catch { /* để bước sau báo lỗi rõ ràng nếu thiếu dữ liệu */ }
})();
app.setPath('userData', path.join(DATA, 'electron'));
app.setAppUserModelId('vn.ezpanel.app');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const background = process.argv.includes('--background');
let win = null, tray = null, server = null, quitting = false, restarts = 0, port = 2083;
let status = { apache: 'off', mysql: 'off', raw: null };

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const logFile = () => path.join(DATA, 'logs', 'app.log');
function log(...a) {
  try { fs.mkdirSync(path.dirname(logFile()), { recursive: true }); fs.appendFileSync(logFile(), `${new Date().toISOString()} ${a.join(' ')}\n`); } catch { /* bỏ qua */ }
}

// ---------- Chuyển dữ liệu từ bản 2.0.x (bộ cài đã giữ lại ở %LOCALAPPDATA%\tPanel-ban-cu) ----------
function migrateLegacy() {
  if (exists(path.join(DATA, 'config.json'))) return;
  const src = path.join(process.env.LOCALAPPDATA || '', 'tPanel-ban-cu');
  if (!exists(path.join(src, 'config.json'))) return;
  fs.mkdirSync(DATA, { recursive: true });
  for (const item of ['config.json', 'backups', 'data', 'sites.json', 'logs', path.join('tools', 'php-ini')]) {
    const from = path.join(src, item);
    if (exists(from)) fs.cpSync(from, path.join(DATA, item), { recursive: true });
  }
  if (exists(path.join(src, 'autorun.txt'))) setAutostart(true); // bản cũ có bật chạy cùng Windows
  try { fs.renameSync(src, `${src}.da-chuyen`); } catch { /* bỏ qua */ }
  log('Đã chuyển dữ liệu từ bản 2.0.x');
}

const readConfig = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch { return {}; } };
const token = () => { try { return fs.readFileSync(path.join(DATA, 'tools', '.control-token'), 'utf8').trim(); } catch { return ''; } };
const base = () => `http://localhost:${port}`;

// Gọi API của Sitebench bằng mã điều khiển (giống ứng dụng khay cũ)
function request(method, p, body, timeout = 8000) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout,
      headers: { 'X-LocalPanel-Token': token(), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (data) req.write(data);
    req.end();
  });
}
async function waitReady(ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await request('GET', '/api/health', null, 2000)).status === 200) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// ---------- Phần xử lý (server.js) trong tiến trình riêng ----------
function startServer() {
  port = Number(readConfig().port) || 2083;
  fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
  const out = fs.createWriteStream(path.join(DATA, 'logs', 'server.log'), { flags: 'a' });
  server = utilityProcess.fork(path.join(APP_DIR, 'server.js'), [], {
    cwd: APP_DIR, stdio: 'pipe', serviceName: 'Sitebench',
    env: { ...process.env, TPANEL_DATA: DATA, LOCALPANEL_TRAY: '1', TPANEL_ELECTRON: '1' },
  });
  server.stdout?.pipe(out);
  server.stderr?.pipe(out);
  server.on('exit', code => {
    server = null;
    if (quitting) return;
    if (code === 75) { log('Khởi động lại phần xử lý theo yêu cầu'); startServer(); reloadWhenReady(); return; }
    restarts++;
    log(`Phần xử lý dừng bất ngờ (mã ${code}), lần ${restarts}`);
    if (restarts <= 5) setTimeout(() => { startServer(); reloadWhenReady(); }, 2000);
    else notify('Sitebench gặp lỗi', `Phần xử lý dừng nhiều lần. Xem nhật ký: ${path.join(DATA, 'logs', 'server.log')}`);
  });
}
async function reloadWhenReady() {
  if (await waitReady() && win && !win.isDestroyed()) win.loadURL(`${base()}/${win.webContents.getURL().split('#')[1] ? `#${win.webContents.getURL().split('#')[1]}` : ''}`);
}
function stopServer() {
  return new Promise(resolve => {
    if (!server) return resolve();
    const s = server;
    const t = setTimeout(() => { try { s.kill(); } catch { /* đã tắt */ } resolve(); }, 5000);
    s.once('exit', () => { clearTimeout(t); resolve(); });
    request('POST', '/api/system/shutdown', { stopServices: false }, 3000);
  });
}

// ---------- Cửa sổ ----------
const stateFile = () => path.join(DATA, 'electron', 'window.json');
function readState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { width: 1320, height: 880 }; } }
function saveState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* bỏ qua */ }
}
const LOADING = `data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b1630;color:#c3cee2;font:15px 'Segoe UI',sans-serif">
  <div style="text-align:center"><div style="width:34px;height:34px;margin:0 auto 14px;border:3px solid #1e3a6e;border-top-color:#2fd0f5;border-radius:50%;animation:s 1s linear infinite"></div>Đang mở Sitebench…</div>
  <style>@keyframes s{to{transform:rotate(360deg)}}</style></body></html>`)}`;

function createWindow() {
  const st = readState();
  win = new BrowserWindow({
    width: st.width || 1320, height: st.height || 880, x: st.x, y: st.y, minWidth: 880, minHeight: 560,
    show: false, title: 'Sitebench', icon: path.join(ICONS, process.platform === 'win32' ? 'sitebench.ico' : 'app.png'),
    backgroundColor: '#0b1630', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.removeMenu();
  if (st.maximized) win.maximize();
  win.loadURL(LOADING);
  // Liên kết ra ngoài (site .test, tài liệu…) mở bằng trình duyệt
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${port}`) && !url.startsWith(`http://127.0.0.1:${port}`) && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('close', e => {
    saveState();
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!readState().tipShown) {
      notify('Sitebench vẫn chạy ở khay hệ thống', 'Apache, MySQL và các site vẫn hoạt động. Chuột phải biểu tượng Sitebench để thoát hẳn.');
      try { fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), tipShown: true })); } catch { /* bỏ qua */ }
    }
  });
  win.on('resized', saveState);
  win.on('moved', saveState);
  waitReady().then(ok => {
    if (!win || win.isDestroyed()) return;
    if (ok) win.loadURL(`${base()}/`);
    else win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="font:15px Segoe UI;padding:2rem;background:#0b1630;color:#fff">Sitebench chưa khởi động được. Xem nhật ký: ${path.join(DATA, 'logs', 'server.log')}</body>`)}`);
  });
}
function showWindow(hash) {
  if (!win || win.isDestroyed()) createWindow();
  if (hash) {
    const url = `${base()}/#${hash}`;
    if (win.webContents.getURL().startsWith(base())) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#${hash}`)}`).catch(() => win.loadURL(url));
    else waitReady().then(() => win.loadURL(url));
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, icon: path.join(ICONS, 'app.png') }).show(); } catch { /* bỏ qua */ }
}

// ---------- Khay hệ thống ----------
const LED = s => (s.running ? 'on' : s.starting ? 'warn' : s.portTaken ? 'bad' : 'off');
const STATE_TEXT = { on: 'đang chạy', warn: 'đang khởi động', bad: 'cổng bị chiếm', off: 'đã tắt' };
function trayImage() {
  const img = nativeImage.createFromPath(path.join(ICONS, `tray-${status.apache}-${status.mysql}.png`));
  const hi = path.join(ICONS, `tray-${status.apache}-${status.mysql}@2x.png`);
  if (exists(hi)) img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(hi) });
  return img;
}
async function svc(name, action) {
  const r = await request('POST', `/api/laragon/services/${name}/${action}`, null, 120000);
  if (r.json?.message) notify('Sitebench', r.json.message);
  else if (r.json?.error) notify('Sitebench', r.json.error);
  pollStatus();
}
const LOGIN = () => ({ path: process.execPath, args: ['--background'] });
function autostart() { return app.getLoginItemSettings(LOGIN()).openAtLogin; }
function setAutostart(on) { app.setLoginItemSettings({ openAtLogin: !!on, ...LOGIN() }); return autostart(); }
// Dọn khóa tên cũ trong HKCU\...\Run; nếu có thì bật lại bằng tên đúng (giữ lựa chọn của người dùng)
function migrateRunKeys() {
  if (process.platform !== 'win32') return;
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const { execFileSync } = require('child_process');
  let found = false;
  for (const name of LEGACY_RUN_NAMES) {
    try {
      execFileSync('reg', ['query', KEY, '/v', name], { windowsHide: true, stdio: 'ignore' });
      found = true;
      execFileSync('reg', ['delete', KEY, '/v', name, '/f'], { windowsHide: true, stdio: 'ignore' });
      log(`Đã dọn khóa chạy cùng Windows tên cũ: ${name}`);
    } catch { /* không có khóa này */ }
  }
  if (found && app.isPackaged) setAutostart(true);
  // Đang bật chạy cùng Windows nhưng khóa còn trỏ tới tệp chạy cũ (EzPanel.exe): trỏ lại sang tệp hiện tại
  try {
    const out = execFileSync('reg', ['query', KEY, '/v', 'vn.ezpanel.app'] /* tên khóa = mã ứng dụng, giữ nguyên qua các lần đổi tên */, { windowsHide: true }).toString();
    if (app.isPackaged && /ezpanel\.exe/i.test(out) && !out.toLowerCase().includes(process.execPath.toLowerCase())) {
      setAutostart(true);
      log('Đã trỏ chạy cùng Windows sang', process.execPath);
    }
  } catch { /* chưa bật chạy cùng Windows */ }
}
function buildMenu() {
  const s = status.raw;
  const row = (key, label) => {
    const x = s?.[key];
    if (!x?.found) return [{ label: `${label}: chưa cài`, enabled: false }];
    return [
      { label: `${label}: ${STATE_TEXT[status[key]]}`, enabled: false },
      x.running ? { label: `   Tắt ${label}`, click: () => svc(key, 'stop') } : { label: `   Bật ${label}`, click: () => svc(key, 'start') },
      ...(x.running ? [{ label: `   Khởi động lại ${label}`, click: () => svc(key, 'restart') }] : []),
    ];
  };
  return Menu.buildFromTemplate([
    { label: 'Mở Sitebench', click: () => showWindow(), default: true },
    { type: 'separator' },
    ...row('apache', 'Apache'), ...row('mysql', 'MySQL'),
    { label: 'Bật tất cả', click: () => svc('all', 'start') },
    { label: 'Tắt tất cả', click: () => svc('all', 'stop') },
    { type: 'separator' },
    { label: 'Terminal', click: () => showWindow('terminal') },
    { label: 'Hộp thư', click: () => showWindow('mail') },
    { label: 'Nhật ký', click: () => showWindow('logs') },
    { type: 'separator' },
    { label: 'Chạy cùng Windows', type: 'checkbox', checked: autostart(), click: m => setAutostart(m.checked) },
    { label: 'Khởi động lại Sitebench', click: async () => { await stopServer(); restarts = 0; startServer(); reloadWhenReady(); } },
    { label: 'Thoát Sitebench', click: () => quit() },
  ]);
}
async function pollStatus() {
  const r = await request('GET', '/api/laragon/services', null, 5000);
  if (r.json?.apache) {
    status = { apache: LED(r.json.apache), mysql: LED(r.json.mysql), raw: r.json };
  }
  if (tray && !tray.isDestroyed()) {
    tray.setImage(trayImage());
    tray.setToolTip(`Sitebench — Apache: ${STATE_TEXT[status.apache]} · MySQL: ${STATE_TEXT[status.mysql]}`);
    tray.setContextMenu(buildMenu());
  }
}
function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Sitebench');
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  tray.setContextMenu(buildMenu());
  setInterval(pollStatus, 4000);
}

async function quit() {
  quitting = true;
  saveState();
  await stopServer();
  if (tray) tray.destroy();
  // Đã tải bản mới: cài im lặng khi thoát (không tự mở lại, vì người dùng đang thoát)
  if (updater && updateState.downloaded) {
    log(`Cài bản ${updateState.downloaded} khi thoát`);
    try { updater.quitAndInstall(true, false); return; } catch (e) { log('Không cài được khi thoát:', e.message); }
  }
  app.exit(0);
}

// ---------- Cầu nối cho giao diện (preload) ----------
ipcMain.handle('pick-folder', async (e, def) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: def || undefined });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-file', async (e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: opts.filters, defaultPath: opts.defaultPath });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('autostart:get', () => autostart());
ipcMain.handle('autostart:set', (e, on) => setAutostart(on));
ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, data: DATA, electron: process.versions.electron }));

// Cập nhật: GitHub Releases (electron-updater) hoặc tệp bộ cài tải về.
// Tự tải ngầm (có công tắc): kiểm tra 1 phút sau khi mở rồi mỗi 6 giờ, tải phần thay đổi, cài khi thoát Sitebench.
// Bản thử nghiệm (pre-release trên GitHub) chỉ nhận khi bật "Nhận bản thử nghiệm" ở máy đó.
let updater = null;
let updateState = { checking: false, available: null, percent: null, downloaded: null, error: null };
function setUpdateState(patch) {
  Object.assign(updateState, patch);
  if (win && !win.isDestroyed()) win.webContents.send('update:state', updateState);
}
function getUpdater(repo, prerelease) {
  if (!app.isPackaged) throw new Error('Chỉ cập nhật được bản đã cài đặt.');
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new Error('Chưa cấu hình kho GitHub (chu-so-huu/ten-kho).');
  if (!updater) {
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false; // Sitebench tự cài trong quit() (app.exit bỏ qua cơ chế tự động)
    updater.on('checking-for-update', () => setUpdateState({ checking: true, error: null }));
    updater.on('update-available', i => setUpdateState({ checking: false, available: i.version }));
    updater.on('update-not-available', () => setUpdateState({ checking: false, available: null }));
    updater.on('download-progress', p => {
      setUpdateState({ percent: Math.round(p.percent) });
      win?.webContents.send('update:progress', Math.round(p.percent));
    });
    updater.on('update-downloaded', i => {
      setUpdateState({ downloaded: i.version, percent: 100 });
      notify(`Sitebench ${i.version} đã tải xong`, 'Bản mới sẽ được cài khi bạn thoát Sitebench. Hoặc vào Cài đặt → Cập nhật → Cài ngay.');
      log(`Đã tải bản ${i.version}, chờ cài khi thoát`);
    });
    updater.on('error', e => { setUpdateState({ checking: false, error: e.message }); log('Lỗi cập nhật:', e.message); });
  }
  updater.allowPrerelease = !!prerelease;
  updater.setFeedURL({ provider: 'github', owner, repo: name });
  return updater;
}
async function updatePrefs() {
  const r = await request('GET', '/api/selfupdate', null, 5000);
  return r.json || {};
}
// Tự kiểm tra và tải ngầm (khi bật công tắc)
async function autoUpdateCycle() {
  try {
    if (!app.isPackaged || quitting || updateState.downloaded) return;
    const p = await updatePrefs();
    if (!p.repo || p.autoDownload === false) return;
    const u = getUpdater(p.repo, p.prerelease);
    u.autoDownload = true;
    await u.checkForUpdates();
  } catch (e) { log('Tự kiểm tra cập nhật:', e.message); }
}
ipcMain.handle('update:state', () => updateState);
ipcMain.handle('update:check', async (e, repo, prerelease) => {
  const u = getUpdater(repo, prerelease);
  u.autoDownload = false;
  const r = await u.checkForUpdates();
  const latest = r?.updateInfo?.version;
  return { current: app.getVersion(), latest, available: !!latest && latest !== app.getVersion() && r?.isUpdateAvailable !== false, notes: r?.updateInfo?.releaseNotes || null, downloaded: updateState.downloaded };
});
ipcMain.handle('update:download', async () => { if (!updater) throw new Error('Chưa kiểm tra bản mới.'); await updater.downloadUpdate(); return true; });
ipcMain.handle('update:install', async () => { quitting = true; await stopServer(); updater.quitAndInstall(true, true); });
// Cập nhật bằng tệp bộ cài: chạy im lặng rồi tự mở lại Sitebench
ipcMain.handle('update:from-file', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Chọn tệp bộ cài Sitebench', properties: ['openFile'], filters: [{ name: 'Bộ cài Sitebench', extensions: ['exe'] }] });
  if (r.canceled) return false;
  const file = r.filePaths[0];
  if (!/sitebench|ezpanel|tpanel/i.test(path.basename(file))) throw new Error('Hãy chọn tệp Sitebench-Setup-x.y.z.exe.');
  quitting = true;
  await stopServer();
  spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  if (tray) tray.destroy();
  app.exit(0);
  return true;
});

// ---------- Khởi động ----------
app.on('second-instance', () => showWindow());
app.on('window-all-closed', e => { /* vẫn chạy ở khay */ });
app.whenReady().then(() => {
  try { migrateLegacy(); } catch (e) { log('Lỗi chuyển dữ liệu:', e.message); }
  try { migrateRunKeys(); } catch (e) { log('Lỗi dọn khóa chạy cùng Windows:', e.message); }
  startServer();
  createTray();
  if (!background) createWindow(), win.once('ready-to-show', () => win.show());
  waitReady().then(() => pollStatus());
  // Tự kiểm tra cập nhật: 1 phút sau khi mở, rồi mỗi 6 giờ
  setTimeout(autoUpdateCycle, 60 * 1000);
  setInterval(autoUpdateCycle, 6 * 3600 * 1000);
  // Chỉ dùng khi kiểm thử: chụp cửa sổ rồi thoát
  if (process.env.TPANEL_SHOT) {
    waitReady().then(() => setTimeout(async () => {
      try { fs.writeFileSync(process.env.TPANEL_SHOT, (await win.webContents.capturePage()).toPNG()); } catch (e) { log('Lỗi chụp:', e.message); }
      log('Tiêu đề:', win.getTitle(), '| URL:', win.webContents.getURL(), '| khay:', !!tray, '| máy chủ:', !!server);
      quit();
    }, 6000));
  }
});
