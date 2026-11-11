// Tự cập nhật EzPanel: từ tệp zip tải lên, hoặc từ GitHub Releases (nếu cấu hình kho).
// Bản mới được giải nén và kiểm tra trước; khi áp dụng, một script chạy riêng sẽ tắt EzPanel, sao lưu bản hiện tại,
// chép bản mới (giữ config.json và dữ liệu), chạy setup.cmd /quiet rồi mở lại EzPanel. Có thể quay lại bản trước.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const multer = require('multer');
const extractZip = (file, opts) => require('./util').unzip(file, opts.dir, opts); // tar.exe trên Windows
const { wrap, httpError, fetchText, download } = require('./util');

const isWin = process.platform === 'win32';
const ROOT = path.resolve(__dirname, '..');
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const cmpVer = (a, b) => {
  const x = String(a).replace(/^v/, '').split('.').map(Number), y = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
const sha256 = file => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

module.exports = (config, { jobs, prepare = () => {} }) => {
  const r = express.Router();
  const dir = path.join(config.paths.tools, 'update');
  const stageDir = path.join(dir, 'moi');
  const backupDir = path.join(dir, 'ban-truoc');
  const current = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } };
  config.update = { repo: null, ...(config.update || {}) };
  let latest = null;

  // Bản mới đã giải nén, sẵn sàng áp dụng
  function staged() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'));
      if (cmpVer(pkg.version, current()) <= 0) { fs.rmSync(stageDir, { recursive: true, force: true }); return null; }
      return { version: pkg.version };
    } catch { return null; }
  }
  const backupVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(backupDir, 'package.json'), 'utf8')).version; } catch { return null; } };

  // Giải nén zip, tìm thư mục chứa EzPanel (server.js + package.json tên "tpanel"), đặt vào thư mục chờ
  async function stage(zip, ctx) {
    const tmp = path.join(dir, `.giai-nen-${crypto.randomBytes(4).toString('hex')}`);
    try {
      ctx.step('Giải nén và kiểm tra gói');
      await extractZip(zip, { dir: tmp });
      const find = (d, depth) => {
        if (exists(path.join(d, 'server.js')) && exists(path.join(d, 'package.json'))) return d;
        if (depth > 2) return null;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { const x = find(path.join(d, e.name), depth + 1); if (x) return x; }
        return null;
      };
      const src = find(tmp, 0);
      if (!src) throw httpError(400, 'Tệp zip không phải gói EzPanel (không thấy server.js).');
      const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
      if (!['ezpanel', 'tpanel', 'localpanel'].includes(pkg.name)) throw httpError(400, 'Tệp zip không phải gói EzPanel.');
      if (!exists(path.join(src, 'node_modules', 'express'))) throw httpError(400, 'Gói thiếu thư viện (node_modules). Hãy dùng bản phát hành đầy đủ.');
      if (cmpVer(pkg.version, current()) <= 0) throw httpError(400, `Gói này là EzPanel ${pkg.version}, không mới hơn bản đang dùng (${current()}).`);
      for (const keep of ['config.json', 'data', 'tools', 'logs', 'backups', 'ssl', 'runtime']) fs.rmSync(path.join(src, keep), { recursive: true, force: true });
      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.renameSync(src, stageDir);
      ctx.log(`  gói EzPanel ${pkg.version} (đang dùng ${current()})`);
      return { version: pkg.version, current: current(), newer: cmpVer(pkg.version, current()) > 0 };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
    }
  }

  // Script chạy riêng: tắt EzPanel → sao lưu → chép bản mới → setup.cmd /quiet → mở lại
  function applyScript(source, saveBackup) {
    const q = s => s.replace(/"/g, '');
    const log = path.join(config.paths.logs, 'cap-nhat.log');
    const lines = [
      '@echo off', 'chcp 65001 >nul',
      `set "APP=${q(ROOT)}"`, `set "SRC=${q(source)}"`, `set "BAK=${q(backupDir)}"`, `set "LOG=${q(log)}"`,
      'echo [%date% %time%] Bat dau cap nhat >> "%LOG%"',
      'timeout /t 2 /nobreak >nul',
      // Chỉ tắt EzPanel.exe (không /T: script này cũng nằm trong cây tiến trình của EzPanel). Node tắt theo nhờ Job Object của ứng dụng khay.
      'taskkill /F /IM EzPanel.exe >nul 2>nul',
      ':cho',
      'timeout /t 2 /nobreak >nul',
      'tasklist /FI "IMAGENAME eq EzPanel.exe" 2>nul | find /I "EzPanel.exe" >nul && goto cho',
      'timeout /t 2 /nobreak >nul',
      ...(saveBackup ? [
        'if exist "%BAK%" rmdir /s /q "%BAK%"',
        // Sao lưu bản đang dùng (trừ dữ liệu) để quay lại khi cần
        'robocopy "%APP%" "%BAK%" /E /XD "%APP%\\data" "%APP%\\tools" "%APP%\\logs" "%APP%\\backups" "%APP%\\ssl" "%APP%\\runtime" /NFL /NDL /NJH /NJS /NP >> "%LOG%"',
        'if %ERRORLEVEL% GEQ 8 goto loi',
      ] : []),
      'robocopy "%SRC%" "%APP%" /E /NFL /NDL /NJH /NJS /NP >> "%LOG%"',
      'if %ERRORLEVEL% GEQ 8 goto khoiphuc',
      'call "%APP%\\setup.cmd" /quiet >> "%LOG%" 2>&1',
      'echo [%date% %time%] Xong >> "%LOG%"',
      'goto mo',
      ':khoiphuc',
      'echo [%date% %time%] Chep that bai, tra lai ban cu >> "%LOG%"',
      ...(saveBackup ? ['robocopy "%BAK%" "%APP%" /E /NFL /NDL /NJH /NJS /NP >> "%LOG%"'] : []),
      'goto mo',
      ':loi',
      'echo [%date% %time%] Sao luu that bai, khong cap nhat >> "%LOG%"',
      ':mo',
      'start "" "%APP%\\EzPanel.exe"',
    ];
    const file = path.join(dir, 'ap-dung.cmd');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
    return file;
  }
  function runDetached(file) {
    if (!isWin) throw httpError(400, 'Tự cập nhật chỉ chạy trên Windows.');
    const child = spawn('cmd.exe', ['/d', '/c', file], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }

  // ---------- Kiểm tra bản mới trên GitHub Releases ----------
  async function check() {
    if (!config.update.repo) return null;
    let rel;
    try { rel = JSON.parse(await fetchText(`https://api.github.com/repos/${config.update.repo}/releases/latest`, { Accept: 'application/vnd.github+json' })); } catch (e) {
      if (/HTTP 403/.test(e.message)) throw httpError(502, 'GitHub tạm giới hạn số lần kiểm tra (60 lần mỗi giờ). Thử lại sau ít phút.');
      if (/HTTP 404/.test(e.message)) throw httpError(404, `Kho ${config.update.repo} không có hoặc chưa có bản phát hành nào.`);
      throw httpError(502, `Không đọc được bản phát hành từ GitHub (${e.message}).`);
    }
    const zip = (rel.assets || []).find(a => /^tpanel.*\.zip$/i.test(a.name));
    const sum = (rel.assets || []).find(a => /\.sha256$/i.test(a.name));
    latest = { version: String(rel.tag_name || '').replace(/^v/, ''), notes: (rel.body || '').slice(0, 2000), url: zip?.browser_download_url || null,
      sha256Url: sum?.browser_download_url || null, page: rel.html_url };
    latest.newer = !!latest.url && cmpVer(latest.version, current()) > 0;
    return latest;
  }
  setTimeout(() => { check().catch(() => {}); setInterval(() => check().catch(() => {}), 24 * 3600 * 1000).unref(); }, 120 * 1000).unref();

  // ---------- API ----------
  r.get('/', (req, res) => res.json({ version: current(), repo: config.update.repo, latest, staged: staged(), backup: backupVersion(), windows: isWin }));
  r.post('/repo', wrap(async (req, res) => {
    const repo = String(req.body?.repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw httpError(400, 'Nhập kho GitHub dạng chu-so-huu/ten-kho.');
    config.update.repo = repo || null;
    config.save();
    latest = null;
    res.json({ ok: true, repo: config.update.repo });
  }));
  r.post('/check', wrap(async (req, res) => res.json({ latest: await check() })));
  r.post('/download', wrap(async (req, res) => {
    const l = latest || await check();
    if (!l?.url) throw httpError(404, 'Không có bản phát hành để tải.');
    res.json({ ok: true, job: jobs.start(`Tải EzPanel ${l.version}`, async ctx => {
      fs.mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, `tpanel-${l.version}.zip`);
      ctx.step(`Tải EzPanel ${l.version}`);
      await download(l.url, zip);
      if (l.sha256Url) {
        const expect = (await fetchText(l.sha256Url)).trim().split(/\s+/)[0].toLowerCase();
        if ((await sha256(zip)) !== expect) { fs.rmSync(zip, { force: true }); throw httpError(400, 'Tệp tải về không khớp mã băm SHA-256.'); }
        ctx.log('  mã băm SHA-256 khớp');
      }
      return stage(zip, ctx);
    }) });
  }));
  const upload = multer({ dest: path.join(config.paths.tools, 'uploads'), limits: { fileSize: 500 * 1024 * 1024 } });
  r.post('/upload', upload.single('file'), wrap(async (req, res) => {
    if (!req.file || !/\.zip$/i.test(req.file.originalname)) { if (req.file) fs.rmSync(req.file.path, { force: true }); throw httpError(400, 'Chọn tệp .zip của EzPanel.'); }
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, `tai-len-${Date.now()}.zip`);
    fs.renameSync(req.file.path, zip);
    res.json({ ok: true, job: jobs.start('Kiểm tra gói EzPanel', ctx => stage(zip, ctx)) });
  }));
  r.post('/apply', wrap(async (req, res) => {
    const s = staged();
    if (!s) throw httpError(400, 'Chưa có bản mới để áp dụng.');
    const file = applyScript(stageDir, true);
    try { prepare(); } catch { /* bỏ qua */ }
    runDetached(file);
    res.json({ ok: true, version: s.version });
  }));
  r.post('/rollback', wrap(async (req, res) => {
    const v = backupVersion();
    if (!v) throw httpError(400, 'Không có bản trước để quay lại.');
    // Chép bản trước sang thư mục chờ rồi áp dụng (không ghi đè bản sao lưu)
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.cpSync(backupDir, stageDir, { recursive: true });
    const file = applyScript(stageDir, false);
    try { prepare(); } catch { /* bỏ qua */ }
    runDetached(file);
    res.json({ ok: true, version: v });
  }));
  r.delete('/staged', (req, res) => { fs.rmSync(stageDir, { recursive: true, force: true }); res.json({ ok: true }); });

  return { router: r, check, pending: () => !!(latest?.newer) };
};
