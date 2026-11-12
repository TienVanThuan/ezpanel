// Bắt email bằng Mailpit: mọi email do PHP gửi được giữ lại ở máy, xem trong Sitebench, không gửi ra ngoài.
//  - Tải Mailpit chính thức từ GitHub, chạy và giám sát tiến trình.
//  - Chuyển email của PHP vào Mailpit mà không sửa php.ini của Laragon:
//      * PHP chạy trong Apache (mod_php): tệp 00-localpanel-mail.conf với php_admin_value
//      * php-cgi, PHP trong terminal, WP-CLI: tệp .ini trong thư mục PHP_INI_SCAN_DIR của Sitebench

const express = require('express');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const extractZip = (file, opts) => require('./util').unzip(file, opts.dir, opts); // tar.exe trên Windows
const tar = require('tar');
const { wrap, httpError, download } = require('./util');

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(700, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

module.exports = (config, { laragon }) => {
  config.mail = Object.assign({ autoStart: true, catchPhp: true, uiPort: 8025, smtpPort: 1025 }, config.mail || {});
  const M = config.mail;
  const dir = path.join(config.paths.tools, 'mailpit');
  const exe = path.join(dir, `mailpit${EXE}`);
  const logFile = path.join(config.paths.logs, 'mailpit.log');
  const iniFile = path.join(config.paths.phpIni, 'localpanel-mailpit.ini');
  const APACHE_FILE = '00-localpanel-mail.conf';
  const pidFile = path.join(dir, 'mailpit.pid');
  let child = null;
  // Tắt Mailpit còn sót từ lần chạy trước (Sitebench bị đóng đột ngột)
  function killStale() {
    if (child) return;
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* không còn */ }
    fs.rmSync(pidFile, { force: true });
  }
  let stopping = false;
  let restarts = 0;
  let lastError = null;

  // ---------- Cài đặt ----------
  function asset() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    if (isWin) return `mailpit-windows-${arch}.zip`;
    if (process.platform === 'darwin') return `mailpit-darwin-${arch}.tar.gz`;
    return `mailpit-linux-${arch}.tar.gz`;
  }
  async function install() {
    fs.mkdirSync(dir, { recursive: true });
    const name = asset();
    const file = path.join(config.paths.tools, name);
    const wasRunning = !!child;
    try {
      await download(`https://github.com/axllent/mailpit/releases/latest/download/${name}`, file)
        .catch(e => { throw httpError(502, `Không tải được Mailpit (${e.message}). Kiểm tra kết nối Internet.`); });
      if (wasRunning) await stop();
      if (name.endsWith('.zip')) await extractZip(file, { dir, preferTar: true });
      else await tar.x({ file, cwd: dir });
      if (!exists(exe)) throw httpError(500, 'Gói tải về không có tệp chạy của Mailpit.');
      if (!isWin) fs.chmodSync(exe, 0o755);
    } finally {
      fs.rmSync(file, { force: true });
    }
    if (wasRunning || M.autoStart) await start();
    return version();
  }
  function version() {
    if (!exists(exe)) return Promise.resolve(null);
    return new Promise(resolve => {
      require('child_process').execFile(exe, ['version', '--no-release-check'], { windowsHide: true, timeout: 10000 }, (err, out) => {
        const m = /v\d+\.\d+\.\d+/.exec(out || '');
        if (m) return resolve(m[0]);
        require('child_process').execFile(exe, ['version'], { windowsHide: true, timeout: 10000 }, (e2, o2) => resolve((/v\d+\.\d+\.\d+/.exec(o2 || '') || [null])[0]));
      });
    });
  }

  // ---------- Chạy / dừng ----------
  async function start() {
    if (!exists(exe)) throw httpError(400, 'Chưa tải Mailpit.');
    if (child) return;
    killStale();
    await sleep(300);
    if (await portOpen(M.smtpPort)) throw httpError(409, `Cổng ${M.smtpPort} đang bị chương trình khác dùng (có thể là Mailpit/MailHog khác hoặc mail catcher của Laragon).`);
    if (await portOpen(M.uiPort)) throw httpError(409, `Cổng ${M.uiPort} đang bị chương trình khác dùng.`);
    stopping = false;
    killStale();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    child = spawn(exe, [
      '--listen', `127.0.0.1:${M.uiPort}`,
      '--smtp', `127.0.0.1:${M.smtpPort}`,
      '--database', path.join(dir, 'mailpit.db'),
      '--max', '2000',
      '--smtp-auth-accept-any', '--smtp-auth-allow-insecure', // ứng dụng có cấu hình tài khoản SMTP vẫn gửi được
      '--disable-version-check',
    ], { cwd: dir, windowsHide: true, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    try { fs.writeFileSync(pidFile, String(child.pid)); } catch { /* bỏ qua */ }
    const started = Date.now();
    child.on('exit', code => {
      child = null;
      if (stopping) return;
      lastError = `Mailpit đã thoát (mã ${code}). Xem nhật ký mailpit.log.`;
      restarts = Date.now() - started < 10000 ? restarts + 1 : 0;
      if (restarts < 5) setTimeout(() => start().catch(e => { lastError = e.message; }), 2000 * (restarts + 1));
    });
    for (let i = 0; i < 25; i++) {
      if (await portOpen(M.uiPort)) { lastError = null; return; }
      if (!child) break;
      await sleep(200);
    }
    if (!child) throw httpError(500, lastError || 'Mailpit không chạy được. Xem nhật ký mailpit.log.');
  }
  async function stop() {
    stopping = true;
    if (child) {
      const c = child;
      c.kill();
      for (let i = 0; i < 25 && child; i++) await sleep(200);
    }
    child = null;
  }

  // ---------- Chuyển email của PHP vào Mailpit ----------
  // Windows: mail() dùng SMTP/smtp_port khi sendmail_path rỗng. Nơi khác: dùng "mailpit sendmail".
  const phpSettings = () => (isWin
    ? { sendmail_path: '', SMTP: '127.0.0.1', smtp_port: String(M.smtpPort) }
    : { sendmail_path: `${exe} sendmail -S 127.0.0.1:${M.smtpPort}` });

  async function applyPhpRouting() {
    const on = M.catchPhp && exists(exe);
    fs.mkdirSync(config.paths.phpIni, { recursive: true });
    const settings = phpSettings();
    if (on) {
      fs.writeFileSync(iniFile, '; Do Sitebench tạo: chuyển email của PHP vào Mailpit\r\n' +
        Object.entries(settings).map(([k, v]) => `${k} = "${v}"`).join('\r\n') + '\r\n');
    } else {
      fs.rmSync(iniFile, { force: true });
    }
    let apache = { changed: false };
    if (laragon.detected()) {
      const file = path.join(laragon.P.sitesEnabled(), APACHE_FILE);
      const lines = Object.entries(settings).map(([k, v]) => `    php_admin_value ${k} "${v.replace(/"/g, '\\"')}"`).join('\n');
      const content = on
        ? `# Do Sitebench tạo: chuyển email của PHP (chạy trong Apache) vào Mailpit\n${['php_module', 'php7_module', 'php5_module'].map(m => `<IfModule ${m}>\n${lines}\n</IfModule>`).join('\n')}\n`
        : null;
      const before = exists(file) ? fs.readFileSync(file, 'utf8') : null;
      if (before !== content) {
        await laragon.applyFiles([{ file, content }]);
        apache = { changed: true, ...(await laragon.afterApacheChange()) };
      }
    }
    laragon.restartFcgi(); // php-cgi đọc lại cấu hình
    return apache;
  }

  async function count() {
    if (!child) return null;
    return new Promise(resolve => {
      http.get({ host: '127.0.0.1', port: M.uiPort, path: '/api/v1/messages?limit=1', timeout: 2000, agent: false }, res => {
        let b = '';
        res.on('data', d => { b += d; });
        res.on('end', () => { try { const j = JSON.parse(b); resolve({ total: j.total, unread: j.unread }); } catch { resolve(null); } });
      }).on('error', () => resolve(null)).on('timeout', function onTimeout() { this.destroy(); resolve(null); });
    });
  }

  // ---------- API ----------
  const r = express.Router();
  r.get('/', wrap(async (req, res) => {
    res.json({
      installed: exists(exe),
      version: await version(),
      running: !!child,
      error: lastError,
      uiUrl: `http://127.0.0.1:${M.uiPort}/`,
      smtp: `127.0.0.1:${M.smtpPort}`,
      autoStart: M.autoStart,
      catchPhp: M.catchPhp,
      messages: await count(),
    });
  }));
  r.post('/install', wrap(async (req, res) => {
    const v = await install();
    const apache = await applyPhpRouting();
    res.json({ ok: true, version: v, ...apache });
  }));
  r.post('/start', wrap(async (req, res) => { await start(); res.json({ ok: true }); }));
  r.post('/stop', wrap(async (req, res) => { await stop(); res.json({ ok: true }); }));
  r.post('/settings', wrap(async (req, res) => {
    if (typeof req.body?.autoStart === 'boolean') M.autoStart = req.body.autoStart;
    let apache = {};
    if (typeof req.body?.catchPhp === 'boolean') {
      M.catchPhp = req.body.catchPhp;
      config.save();
      apache = await applyPhpRouting();
    } else config.save();
    res.json({ ok: true, ...apache });
  }));

  return {
    router: r,
    stop,
    kill() { stopping = true; if (child) { try { child.kill(); } catch { /* đã tắt */ } } },
    async autoStart() {
      if (!exists(exe)) return;
      try {
        if (M.autoStart) await start();
        await applyPhpRouting();
      } catch (e) { console.warn(`  Mailpit: ${e.message}`); }
    },
  };
};
