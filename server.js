const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { listen, wrap: wrapAsync } = require('./lib/util');

// ---------- Cấu hình ----------
// APP: mã nguồn (chỉ đọc). ROOT: dữ liệu (cài đặt, công cụ, sao lưu, nhật ký).
// Bản Electron truyền TPANEL_DATA = %APPDATA%\EzPanel để cập nhật / cài lại không bao giờ đụng tới dữ liệu.
const APP = __dirname;
const ROOT = process.env.TPANEL_DATA ? path.resolve(process.env.TPANEL_DATA) : __dirname;
fs.mkdirSync(ROOT, { recursive: true });
const CONFIG_PATH = path.join(ROOT, 'config.json');
// config.json là cài đặt của người dùng: gói cập nhật chỉ mang config.default.json, nên chép đè không làm mất cài đặt
if (!fs.existsSync(CONFIG_PATH)) fs.copyFileSync(path.join(APP, 'config.default.json'), CONFIG_PATH);
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const abs = p => path.resolve(ROOT, p);

config.paths = {
  files: abs(config.fileRoot),
  sites: abs(config.sitesDir),
  sqlite: abs(config.sqliteDir),
  sitesDb: path.join(ROOT, 'sites.json'),
  laragonState: path.join(ROOT, 'laragon-state.json'),
  tools: path.join(ROOT, 'tools'),
  backups: path.join(ROOT, 'backups'),
  ssl: path.join(ROOT, 'ssl'), // vị trí cũ, chỉ dùng khi chưa có Laragon
  // Dữ liệu gắn với cấu hình Apache của Laragon (chứng chỉ, trạng thái dự án) nằm trong chính Laragon,
  // để chuyển hoặc cài lại EzPanel không làm hỏng Apache
  laragonData: () => {
    const root = path.resolve(config.laragon?.root || 'C:/laragon');
    return fs.existsSync(path.join(root, 'www')) ? path.join(root, 'etc', 'localpanel') : null;
  },
  logs: path.join(ROOT, 'logs'),
  phpIni: path.join(ROOT, 'tools', 'php-ini'),
};
for (const dir of [config.paths.files, config.paths.sites, config.paths.sqlite]) {
  fs.mkdirSync(dir, { recursive: true });
}
// Lưu lại config.json (bỏ các trường chỉ dùng lúc chạy)
Object.defineProperty(config, 'save', {
  enumerable: false,
  value() {
    const { paths, ...rest } = config;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(rest, null, 2));
  },
});

// ---------- Xác thực ----------
const sessions = new Map(); // token -> thời điểm hết hạn
const SESSION_MS = 12 * 60 * 60 * 1000;

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function tokenOf(req) {
  const m = /(?:^|;\s*)lp_token=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  return m && m[1];
}
function isLoggedIn(req) {
  const t = tokenOf(req);
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}

// ---------- Ứng dụng ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(APP, 'public')));
// Thư viện hiển thị terminal (xterm.js), phục vụ ngay từ máy, không cần Internet
app.use('/vendor/xterm', express.static(path.join(APP, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(APP, 'node_modules', '@xterm', 'addon-fit')));

function startSession(res) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `lp_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

app.post('/api/login', (req, res) => {
  if (!config.setupDone) return res.status(409).json({ error: 'EzPanel chưa được thiết lập.', setup: true });
  if (!sameSecret(req.body?.password ?? '', config.password)) {
    return res.status(401).json({ error: 'Sai mật khẩu.' });
  }
  startSession(res);
  res.json({ ok: true });
});

// ---------- Thiết lập lần đầu (chỉ mở khi chưa thiết lập) ----------
// Bản cài cũ (đã đổi mật khẩu hoặc đã trỏ tới Laragon) được coi là đã thiết lập
if (config.setupDone === undefined) {
  config.setupDone = config.password !== 'admin123' || fs.existsSync(path.join(path.resolve(config.laragon?.root || 'C:/laragon'), 'www'));
  config.save();
}
let runtime = null; // gắn sau khi tạo các module
app.get('/api/setup/status', (req, res) => {
  const drive = process.platform === 'win32' ? (fs.existsSync('D:\\') ? 'D:\\' : path.parse(APP).root) : null;
  res.json({
    setupDone: !!config.setupDone,
    windows: process.platform === 'win32',
    laragon: runtime ? runtime.findLaragon() : [],
    suggestRoot: drive ? path.join(drive, 'EzPanel').split(path.sep).join('/') : '/tmp/tpanel-root',
  });
});
app.post('/api/setup', (req, res, next) => {
  try {
    if (config.setupDone) return res.status(403).json({ error: 'EzPanel đã được thiết lập.' });
    const b = req.body || {};
    if (typeof b.password !== 'string' || b.password.length < 8) return res.status(400).json({ error: 'Mật khẩu cần ít nhất 8 ký tự.' });
    if (b.mode === 'laragon') {
      const r = path.resolve(String(b.root || ''));
      if (!fs.existsSync(path.join(r, 'www')) || !fs.existsSync(path.join(r, 'bin', 'php'))) return res.status(400).json({ error: `Không thấy Laragon tại ${r}.` });
      Object.assign(config, { password: b.password, mode: 'laragon', setupDone: true });
      config.laragon.root = r.split(path.sep).join('/');
      config.save();
      startSession(res);
      return res.json({ ok: true, done: true });
    }
    if (b.mode !== 'standalone') return res.status(400).json({ error: 'Chọn cách chạy máy chủ.' });
    config.password = b.password;
    config.save();
    startSession(res);
    const job = jobs.start('Dựng máy chủ EzPanel', async ctx => {
      const out = await runtime.setupStandalone(ctx, b);
      config.setupDone = true;
      config.save();
      return out;
    });
    res.json({ ok: true, job });
  } catch (e) { next(e); }
});

app.post('/api/logout', (req, res) => {
  sessions.delete(tokenOf(req));
  res.setHeader('Set-Cookie', 'lp_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// Mã điều khiển cho ứng dụng ở khay hệ thống (EzPanel.exe), chỉ đọc được trên máy này
const CONTROL_TOKEN = crypto.randomBytes(24).toString('hex');
fs.mkdirSync(config.paths.tools, { recursive: true });
fs.writeFileSync(path.join(config.paths.tools, '.control-token'), CONTROL_TOKEN);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Mọi API phía dưới đều cần đăng nhập (hoặc mã điều khiển của ứng dụng khay)
app.use('/api', (req, res, next) => {
  const t = req.headers['x-localpanel-token'];
  if (t && sameSecret(t, CONTROL_TOKEN)) return next();
  if (!isLoggedIn(req)) return res.status(401).json({ error: 'Bạn cần đăng nhập.' });
  next();
});

const sites = require('./lib/sites')(config);
const certs = require('./lib/certs')(config);
const laragon = require('./lib/laragon')(config, certs);

// Danh sách chứng chỉ gốc cho PHP (PHP bản Windows không kèm sẵn → cURL error 60 khi cập nhật plugin, gọi API HTTPS):
// lấy danh sách Mozilla có sẵn trong EzPanel + chứng chỉ gốc của EzPanel (để gọi được các site .test qua HTTPS),
// rồi khai báo cho mọi bản PHP qua thư mục .ini dùng chung (PHP_INI_SCAN_DIR)
function writeCaBundle() {
  try {
    const bundle = path.join(config.paths.tools, 'cacert.pem');
    let pem = require('tls').rootCertificates.join('\n') + '\n';
    try { if (certs.caPath && fs.existsSync(certs.caPath)) pem += fs.readFileSync(certs.caPath, 'utf8'); } catch { /* chưa có chứng chỉ gốc */ }
    fs.mkdirSync(config.paths.tools, { recursive: true });
    if (!fs.existsSync(bundle) || fs.readFileSync(bundle, 'utf8') !== pem) fs.writeFileSync(bundle, pem);
    const fwdPath = bundle.split(path.sep).join('/');
    const ini = `; Do EzPanel tạo: danh sách chứng chỉ gốc cho HTTPS của PHP (curl, openssl)\r\ncurl.cainfo = "${fwdPath}"\r\nopenssl.cafile = "${fwdPath}"\r\n`;
    fs.mkdirSync(config.paths.phpIni, { recursive: true });
    const iniFile = path.join(config.paths.phpIni, 'ezpanel-ca.ini');
    if (!fs.existsSync(iniFile) || fs.readFileSync(iniFile, 'utf8') !== ini) fs.writeFileSync(iniFile, ini);
  } catch (e) { console.warn('  Danh sách chứng chỉ gốc cho PHP:', e.message); }
}
writeCaBundle();
const services = require('./lib/laragon-services')(config, laragon);
laragon.hooks.apacheChanged = () => services.reloadApacheIfRunning();
app.use('/api/files', require('./lib/files')(config));
app.use('/api/sites', sites.router);
app.use('/api/db', require('./lib/db')(config));
app.use('/api/services', require('./lib/services')(config));
app.use('/api/laragon/services', services.router);
// Chứng chỉ gốc cho HTTPS
app.get('/api/ssl', wrapAsync(async (req, res) => {
  res.json({ supported: certs.supported, hasCA: certs.hasCA(), trusted: await certs.trusted() });
}));
app.post('/api/ssl/trust', wrapAsync(async (req, res) => { await certs.trust(); res.json({ ok: true }); }));
app.post('/api/ssl/untrust', wrapAsync(async (req, res) => { await certs.untrust(); res.json({ ok: true }); }));
app.get('/api/ssl/ca.crt', (req, res) => { certs.ensureCA(); res.download(certs.caPath, 'EzPanel-CA.crt'); });
app.use('/api/laragon', laragon.router);
app.use('/api/system', require('./lib/system')(config, { laragon, services }));
const wordpress = require('./lib/wordpress')(config, laragon);
app.use('/api/wp', wordpress);
const terminal = require('./lib/terminal')(config, { laragon, isLoggedIn, ensureWpCli: wordpress.ensureWpCli, certs });
app.use('/api/terminal', terminal.router);
const mail = require('./lib/mail')(config, { laragon });
app.use('/api/mail', mail.router);
const jobs = require('./lib/jobs')();
runtime = require('./lib/runtime')(config, { laragon, services, jobs, certs });
app.use('/api/runtime', runtime.router);
app.use('/api/settings', require('./lib/settings')(config, { laragon, services, runtime, jobs }).router);
app.use('/api/jobs', jobs.router);
const templates = require('./lib/templates')(config, { laragon, wpTools: wordpress.tools, terminal, jobs });
app.use('/api/templates', templates.router);
wordpress.attach({ jobs, templates });
const dbtools = require('./lib/dbtools')(config, { laragon });
const wpExtras = require('./lib/wpextras')(config, { laragon, wpTools: wordpress.tools });
app.use('/api/wpx', wpExtras.router);
app.use('/api/import', require('./lib/importer')(config, { laragon, jobs, wpTools: wordpress.tools, wpExtras, dbtools }).router);
app.use('/api/dbx', require('./lib/dbui')(config, { laragon, dbtools, jobs, wpExtras }).router);
const updates = require('./lib/updates')(config, { laragon, runtime, services, dbtools, jobs });
app.use('/api/updates', updates.router);
const selfupdate = require('./lib/selfupdate')(config, { jobs, prepare: () => { laragon.stopAll(); try { mail.kill(); } catch { /* bỏ qua */ } } });
app.use('/api/selfupdate', selfupdate.router);
app.get('/api/updates-count', (req, res) => res.json({ software: updates.pending(), tpanel: selfupdate.pending() }));
app.use('/api/migrate', require('./lib/migrate')(config, { laragon, services, dbtools, wpTools: wordpress.tools, wpExtras, certs, jobs }).router);
app.use('/api/projects', require('./lib/projects')(config, { laragon, dbtools, wpTools: wordpress.tools, wpExtras, certs, jobs }).router);
app.use('/api/logs', require('./lib/logs')(config, { laragon }).router);
app.use('/api/php', require('./lib/phpconfig')(config, { laragon }).router);

app.get('/api/overview', (req, res) => {
  const sqliteCount = fs.readdirSync(config.paths.sqlite).filter(f => f.endsWith('.sqlite')).length;
  res.json({
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptime: os.uptime(),
    node: process.version,
    cpus: os.cpus().length,
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    panelPort: config.port,
    sitesPort: config.sitesPort,
    sites: sites.summary(),
    sqliteCount,
    servicesWatched: config.services.length,
    fileRoot: config.paths.files,
  });
});

app.post('/api/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!sameSecret(current ?? '', config.password)) return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.' });
  if (typeof next !== 'string' || next.length < 6) return res.status(400).json({ error: 'Mật khẩu mới cần ít nhất 6 ký tự.' });
  config.password = next;
  config.save();
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Không có API này.' }));

// Xử lý lỗi chung
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Lỗi máy chủ.' });
});

// Tắt các tiến trình php-cgi khi đóng EzPanel
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { laragon.stopAll(); process.exit(0); });
}
// Ứng dụng khay yêu cầu tắt: dừng php-cgi (và Apache/MySQL nếu được yêu cầu) rồi thoát
// Khởi động lại EzPanel (ứng dụng khay chạy lại ngay khi thấy mã thoát 75), ví dụ sau khi đổi cổng
app.locals.restart = () => {
  laragon.stopAll();
  try { mail.kill(); } catch { /* bỏ qua */ }
  setTimeout(() => process.exit(75), 300);
};
app.locals.shutdown = async stopServices => {
  if (stopServices) await services.run('all', 'stop').catch(e => console.warn(e.message));
  await mail.stop().catch(() => {});
  laragon.stopAll();
  setTimeout(() => process.exit(0), 200);
};
process.on('exit', () => { laragon.stopAll(); terminal.stopAll(); mail.kill(); });

// ---------- Khởi động ----------
(async () => {
  try {
    const servers = await listen(app, config.port, config.host);
    for (const srv of servers) srv.on('upgrade', terminal.upgrade);
    await sites.start();
    laragon.start();
    services.autoStart().then(() => mail.autoStart());
    const shown = config.host === '127.0.0.1' ? 'localhost' : config.host;
    console.log('');
    console.log('  EzPanel đang chạy');
    console.log(`  Bảng điều khiển:  http://${shown}:${config.port}`);
    console.log(`  Website:          http://<tên-site>.localhost:${config.sitesPort}`);
    if (config.password === 'admin123') {
      console.log('\n  Lưu ý: bạn đang dùng mật khẩu mặc định "admin123" — hãy đổi trong mục Tổng quan.');
    }
    console.log('');
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`Cổng ${err.port} đang bị chương trình khác dùng. Đổi "port" hoặc "sitesPort" trong config.json rồi chạy lại.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
})();
