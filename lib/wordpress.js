// WP Toolkit cho các dự án WordPress trong thư mục www của Laragon.
// Các thao tác cần WordPress (cài đặt, cập nhật, đổi mật khẩu, sao lưu database…) chạy qua WP-CLI
// bằng đúng phiên bản PHP của từng dự án.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const archiver = require('archiver');
const extractZip = (file, opts) => require('./util').unzip(file, opts.dir, opts); // tar.exe trên Windows
const { wrap, httpError, download, fetchText } = require('./util');

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const WPCLI_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// ---------- Đọc / sửa wp-config.php ----------
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Đọc giá trị define() trong wp-config.php, hiểu đúng chuỗi PHP có ký tự thoát (mật khẩu có dấu nháy…)
function readDefine(src, key) {
  const re = new RegExp(`define\\s*\\(\\s*['"]${key}['"]\\s*,\\s*(?:'((?:\\\\.|[^'\\\\])*)'|"((?:\\\\.|[^"\\\\])*)"|(true|false|\\d+))\\s*\\)`, 'i');
  const m = re.exec(src || '');
  if (!m) return null;
  if (m[1] !== undefined) return m[1].replace(/\\(['\\])/g, '$1');
  if (m[2] !== undefined) {
    const map = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', $: '$' };
    return m[2].replace(/\\([nrt"\\$])/g, (x, c) => map[c]);
  }
  return m[3];
}
function setDefine(src, key, literal) {
  const re = new RegExp(`define\\s*\\(\\s*['"]${escRe(key)}['"]\\s*,[^;]*\\)\\s*;`, 'i');
  const line = `define( '${key}', ${literal} );`;
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  if (re.test(src)) return src.replace(re, line);
  // Chưa có: chèn trước dòng "That's all, stop editing" hoặc trước require wp-settings.php
  const anchor = /^.*(That's all, stop editing|require_once\s*\(?\s*ABSPATH).*$/mi.exec(src);
  if (anchor) return src.slice(0, anchor.index) + line + eol + src.slice(anchor.index);
  return `${src.trimEnd()}${eol}${line}${eol}`;
}
const phpStr = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const salt = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#%^&*()-_=+[]{}<>~;:,.|';
  return Array.from(crypto.randomBytes(64), b => chars[b % chars.length]).join('');
};

module.exports = (config, laragon) => {
  const ext = {};
  const r = express.Router();
  const toolsDir = config.paths.tools;
  const backupsRoot = config.paths.backups;
  const wpcliPath = path.join(toolsDir, 'wp-cli.phar');

  const need = () => {
    if (!laragon.detected()) throw httpError(400, 'Chưa tìm thấy Laragon. Cấu hình đường dẫn Laragon trong mục Máy chủ & dự án trước.');
  };
  const siteDir = name => laragon.projectDir(name);
  const isWp = name => exists(path.join(siteDir(name), 'wp-includes', 'version.php'));
  function checkSite(name) {
    need();
    laragon.checkProject(name);
    if (!isWp(name)) throw httpError(404, `"${name}" không phải dự án WordPress.`);
    return name;
  }
  const configPath = name => path.join(siteDir(name), 'wp-config.php');
  const readConfig = name => (exists(configPath(name)) ? fs.readFileSync(configPath(name), 'utf8') : null);

  // ---------- Khóa: mỗi site chỉ chạy một thao tác tại một thời điểm ----------
  const busy = new Map();
  async function withLock(name, label, fn) {
    if (busy.has(name)) throw httpError(409, `"${name}" đang ${busy.get(name)}. Đợi xong rồi thử lại.`);
    busy.set(name, label);
    try { return await fn(); } finally { busy.delete(name); }
  }

  // ---------- WP-CLI ----------
  let wpcliReady = null;
  function ensureWpCli() {
    if (exists(wpcliPath)) return Promise.resolve();
    if (!wpcliReady) {
      fs.mkdirSync(toolsDir, { recursive: true });
      wpcliReady = download(WPCLI_URL, wpcliPath)
        .catch(e => { wpcliReady = null; throw httpError(502, `Không tải được WP-CLI (${e.message}). Kiểm tra kết nối Internet.`); });
    }
    return wpcliReady;
  }

  // Chạy WP-CLI cho một thư mục, bằng PHP của dự án (hoặc PHP mặc định của Laragon)
  async function wp(name, args, { timeout = 10 * 60 * 1000, safe = false } = {}) {
    await ensureWpCli();
    const folder = laragon.phpFor(name) || laragon.defaultPhp();
    if (!folder) throw httpError(400, 'Không tìm thấy PHP nào trong Laragon.');
    try { laragon.ensurePhpIni(folder); } catch { /* bỏ qua */ }
    const extraPath = [laragon.mysqlBin(), laragon.phpDir(folder)].filter(Boolean).join(path.delimiter);
    const fullArgs = ['-d', 'memory_limit=1024M', wpcliPath, `--path=${siteDir(name)}`, ...(safe ? ['--skip-plugins', '--skip-themes'] : []),
      ...(process.getuid && process.getuid() === 0 ? ['--allow-root'] : []), ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(laragon.phpCli(folder), fullArgs, {
        cwd: siteDir(name),
        env: { ...process.env, PHPRC: laragon.phpDir(folder), PHP_INI_SCAN_DIR: laragon.scanDir(process.env), PATH: `${extraPath}${path.delimiter}${process.env.PATH || process.env.Path || ''}`, WP_CLI_DISABLE_AUTO_CHECK_UPDATE: '1' },
        windowsHide: true,
      });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      const timer = setTimeout(() => { child.kill(); reject(httpError(504, 'WP-CLI chạy quá lâu nên đã bị dừng.')); }, timeout);
      child.on('error', e => { clearTimeout(timer); reject(httpError(500, `Không chạy được PHP: ${e.message}`)); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) return resolve(out.trim());
        // Ghi đầy đủ để tra cứu; trên màn hình ưu tiên dòng nói rõ lỗi (Fatal error / Uncaught / Error:), không phải dấu vết gọi hàm
        const all = `${err}\n${out}`.trim();
        try {
          fs.mkdirSync(config.paths.logs, { recursive: true });
          fs.appendFileSync(path.join(config.paths.logs, 'wp-cli.log'), `\n[${new Date().toISOString()}] ${name}: wp ${args.join(' ')} (PHP ${laragon.versionOf(folder)}, mã ${code})\n${all}\n`);
        } catch { /* bỏ qua */ }
        const lines = all.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^(PHP )?(Deprecated|Warning|Notice)/.test(l));
        const key = lines.find(l => /Fatal error|Uncaught|^Error:/i.test(l));
        const msg = key ? key.replace(/^PHP\s+/, '').replace(/\s*Stack trace:.*$/, '').slice(0, 400) : lines.slice(-4).join(' ');
        reject(httpError(400, `${msg || `WP-CLI lỗi (mã ${code}).`} (Chi tiết: logs\\wp-cli.log)`));
      });
    });
  }
  const wpJson = async (name, args, opts) => {
    const out = await wp(name, [...args, '--format=json'], opts);
    try { return JSON.parse(out.slice(out.indexOf('['))); } catch { return []; }
  };

  // ---------- MySQL ----------
  const ident = s => '`' + s.replace(/`/g, '``') + '`';
  async function sql(q) {
    let c;
    try { c = await mysql.createConnection({ ...config.mysql, charset: 'utf8mb4', connectTimeout: 4000 }); } catch (e) {
      throw httpError(502, `Không kết nối được MySQL (${e.message}). Bấm Start All trong Laragon rồi thử lại.`);
    }
    try { return (await c.query(q))[0]; } finally { c.end().catch(() => {}); }
  }
  const dbExists = async name => (await sql(`SHOW DATABASES LIKE ${mysql.escape(name)}`)).length > 0;
  const dbNameFor = name => `wp_${name.replace(/-/g, '_')}`.slice(0, 64);

  function writeConfig(name, dbName, { prefix = 'wp_' } = {}) {
    const dir = siteDir(name);
    const sample = path.join(dir, 'wp-config-sample.php');
    if (!exists(sample)) throw httpError(500, 'Thiếu tệp wp-config-sample.php trong mã nguồn WordPress.');
    let src = fs.readFileSync(sample, 'utf8');
    src = setDefine(src, 'DB_NAME', phpStr(dbName));
    src = setDefine(src, 'DB_USER', phpStr(config.mysql.user));
    src = setDefine(src, 'DB_PASSWORD', phpStr(config.mysql.password || ''));
    src = setDefine(src, 'DB_HOST', phpStr(`${config.mysql.host === '127.0.0.1' ? 'localhost' : config.mysql.host}${Number(config.mysql.port) !== 3306 ? `:${config.mysql.port}` : ''}`));
    src = src.replace(/'put your unique phrase here'/g, () => phpStr(salt()));
    src = src.replace(/\$table_prefix\s*=\s*['"][^'"]*['"]/, `$table_prefix = ${phpStr(prefix)}`);
    src = setDefine(src, 'WP_ENVIRONMENT_TYPE', "'local'");
    fs.writeFileSync(configPath(name), src);
  }

  // ---------- Thông tin site ----------
  function info(name) {
    const dir = siteDir(name);
    const cfg = readConfig(name) || '';
    const ver = /\$wp_version\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(dir, 'wp-includes', 'version.php'), 'utf8'));
    const debug = readDefine(cfg, 'WP_DEBUG');
    const phpFolder = laragon.phpFor(name);
    return {
      name,
      url: laragon.urlOf(name),
      version: ver ? ver[1] : null,
      installed: !!cfg,
      db: readDefine(cfg, 'DB_NAME'),
      prefix: (/\$table_prefix\s*=\s*['"]([^'"]+)['"]/.exec(cfg) || [])[1] || null,
      debug: debug === 'true' || debug === '1',
      maintenance: exists(path.join(dir, '.maintenance')),
      autoUpdate: readDefine(cfg, 'AUTOMATIC_UPDATER_DISABLED') !== 'true' && readDefine(cfg, 'WP_AUTO_UPDATE_CORE') !== 'false',
      php: phpFolder,
      phpVersion: laragon.versionOf(phpFolder || laragon.defaultPhp() || ''),
      busy: busy.get(name) || null,
    };
  }

  // ---------- Sao lưu ----------
  const safeName = name => {
    if (!name || /[\\/]/.test(name) || name.startsWith('.')) throw httpError(400, 'Tên site không hợp lệ.');
    return name;
  };
  const backupDir = name => path.join(backupsRoot, safeName(name));
  const BACKUP_FILE = /^[A-Za-z0-9_.-]+-\d{8}-\d{6}\.zip$/;
  function listBackups(name) {
    if (!exists(backupDir(name))) return [];
    return fs.readdirSync(backupDir(name)).filter(f => BACKUP_FILE.test(f)).map(f => {
      const st = fs.statSync(path.join(backupDir(name), f));
      return { file: f, size: st.size, created: st.mtimeMs };
    }).sort((a, b) => b.created - a.created);
  }
  async function exportDb(name, file) {
    await wp(name, ['db', 'export', file, '--add-drop-table'], { safe: true });
  }
  async function createBackup(name) {
    fs.mkdirSync(backupDir(name), { recursive: true });
    const file = path.join(backupDir(name), `${name}-${stamp()}.zip`);
    const sqlFile = path.join(backupDir(name), `.db-${crypto.randomBytes(4).toString('hex')}.sql`);
    try {
      await exportDb(name, sqlFile);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        const zip = archiver('zip', { zlib: { level: 6 } });
        out.on('close', resolve);
        zip.on('error', reject);
        zip.pipe(out);
        zip.file(sqlFile, { name: 'database.sql' });
        zip.append(JSON.stringify({ site: name, created: new Date().toISOString(), ...info(name) }, null, 2), { name: 'localpanel.json' });
        zip.glob('**/*', { cwd: siteDir(name), dot: true, ignore: ['**/node_modules/**'] }, { prefix: 'files' }); // node_modules tạo lại bằng npm install
        zip.finalize();
      });
      return path.basename(file);
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    } finally {
      fs.rmSync(sqlFile, { force: true });
    }
  }
  async function restoreBackup(name, fileName) {
    if (!BACKUP_FILE.test(fileName) || !exists(path.join(backupDir(name), fileName))) throw httpError(404, 'Không tìm thấy bản sao lưu.');
    const www = laragon.P.www();
    const tmp = path.join(www, `.lp-restore-${crypto.randomBytes(4).toString('hex')}`);
    const old = path.join(www, `.lp-old-${name}-${stamp()}`);
    const dir = siteDir(name);
    let moved = false;
    try {
      await extractZip(path.join(backupDir(name), fileName), { dir: tmp });
      if (!exists(path.join(tmp, 'files', 'wp-config.php')) || !exists(path.join(tmp, 'database.sql'))) {
        throw httpError(400, 'Bản sao lưu không hợp lệ (thiếu files/ hoặc database.sql).');
      }
      const dbName = readDefine(fs.readFileSync(path.join(tmp, 'files', 'wp-config.php'), 'utf8'), 'DB_NAME');
      if (dbName) await sql(`CREATE DATABASE IF NOT EXISTS ${ident(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      if (exists(dir)) { await fsp.rename(dir, old); moved = true; }
      await fsp.rename(path.join(tmp, 'files'), dir);
      await wp(name, ['db', 'import', path.join(tmp, 'database.sql')], { safe: true });
      fs.rmSync(old, { recursive: true, force: true });
    } catch (e) {
      // Trả lại mã nguồn cũ nếu khôi phục thất bại
      if (moved) {
        fs.rmSync(dir, { recursive: true, force: true });
        await fsp.rename(old, dir).catch(() => {});
      }
      throw e;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---------- Danh sách phiên bản WordPress ----------
  const WP_VERSIONS_URL = config.wpVersionsUrl || 'https://api.wordpress.org/core/stable-check/1.0/';
  const VERSION = /^\d+\.\d+(\.\d+)?$/;
  let versionsCache = null;
  async function wpVersions() {
    if (versionsCache && Date.now() - versionsCache.at < 3600e3) return versionsCache.list;
    let data;
    try { data = JSON.parse(await fetchText(WP_VERSIONS_URL)); } catch (e) {
      throw httpError(502, `Không tải được danh sách phiên bản WordPress (${e.message}).`);
    }
    const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
    const list = Object.entries(data)
      .filter(([v]) => VERSION.test(v) && Number(v.split('.')[0]) >= 4)
      .map(([version, status]) => ({ version, status }))
      .sort((a, b) => cmp(a.version, b.version));
    versionsCache = { at: Date.now(), list };
    return list;
  }

  // Tắt/bật tự động cập nhật (giữ đúng phiên bản giống production)
  function setAutoUpdate(name, on) {
    let src = readConfig(name);
    if (!src) throw httpError(400, 'Site chưa có wp-config.php.');
    src = setDefine(src, 'AUTOMATIC_UPDATER_DISABLED', on ? 'false' : 'true');
    src = setDefine(src, 'WP_AUTO_UPDATE_CORE', on ? "'minor'" : 'false');
    fs.writeFileSync(configPath(name), src);
  }

  // Giữ email ở local: ép mọi email của WordPress đi qua Mailpit (kể cả khi site cấu hình SMTP của production)
  const MAIL_GUARD = `<?php
/**
 * Plugin Name: EzPanel - Giữ email ở máy local
 * Description: Chuyển mọi email của site vào Mailpit (127.0.0.1:${config.mail?.smtpPort || 1025}) để không gửi email thật cho khách. Do EzPanel cài; xóa tệp này nếu muốn gửi email thật.
 */
add_action('phpmailer_init', function ($mailer) {
    $mailer->isSMTP();
    $mailer->Host = '127.0.0.1';
    $mailer->Port = ${config.mail?.smtpPort || 1025};
    $mailer->SMTPAuth = false;
    $mailer->SMTPSecure = '';
    $mailer->SMTPAutoTLS = false;
}, PHP_INT_MAX);
`;
  function installMailGuard(name) {
    const dir = path.join(siteDir(name), 'wp-content', 'mu-plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'localpanel-mail.php'), MAIL_GUARD);
    installCaFix(name);
  }

  // WordPress dùng danh sách chứng chỉ riêng trong wp-includes/certificates (bản cũ đã lỗi thời → cURL error 60
  // khi cập nhật plugin). mu-plugin này cho WordPress dùng danh sách mới mà PHP đang dùng (curl.cainfo do EzPanel đặt).
  const CA_FIX = `<?php
/*
Plugin Name: EzPanel - chứng chỉ HTTPS cho máy local
Description: Do EzPanel tạo. WordPress (kể cả bản cũ) dùng danh sách chứng chỉ gốc mới để cập nhật plugin và gọi API qua HTTPS. Chỉ dùng ở máy local.
*/
add_filter('http_request_args', function ($args) {
    $ca = ini_get('curl.cainfo');
    if ($ca && is_readable($ca)) {
        $args['sslcertificates'] = $ca;
    }
    return $args;
}, 1);
`;
  function installCaFix(name) {
    try {
      const dir = path.join(siteDir(name), 'wp-content', 'mu-plugins');
      const file = path.join(dir, 'ezpanel-ca.php');
      if (exists(file) && fs.readFileSync(file, 'utf8') === CA_FIX) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, CA_FIX);
    } catch { /* bỏ qua */ }
  }
  // Khi khởi động: cài cho mọi site WordPress đang có
  setTimeout(() => {
    try { if (laragon.detected()) for (const p of laragon.projects()) if (p.wordpress) installCaFix(p.name); } catch { /* bỏ qua */ }
  }, 4000).unref?.();

  // Tạo tên miền .test cho site mới và khởi động lại Apache; lỗi ở bước này không làm hỏng việc cài
  async function publish(name) {
    const out = { warnings: [] };
    try { await laragon.ensureDomain(name); } catch (e) { out.warnings.push(e.message); }
    Object.assign(out, await laragon.afterApacheChange());
    if (out.reloadError) out.warnings.push(out.reloadError);
    return out;
  }

  // ======================= API =======================
  r.get('/', wrap(async (req, res) => {
    if (!laragon.detected()) return res.json({ detected: false, sites: [] });
    const sites = laragon.P && fs.readdirSync(laragon.P.www(), { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && isWp(d.name))
      .map(d => info(d.name));
    res.json({
      detected: true,
      sites,
      versions: laragon.phpVersions().map(id => ({ id, version: laragon.versionOf(id) })),
      defaultPhp: laragon.defaultPhp(),
      wpcli: exists(wpcliPath),
    });
  }));

  r.get('/versions', wrap(async (req, res) => {
    res.json({ versions: await wpVersions() });
  }));

  // Cài WordPress mới
  r.post('/', wrap(async (req, res) => {
    need();
    const b = req.body || {};
    const name = String(b.name || '').trim().toLowerCase();
    if (!NAME.test(name)) throw httpError(400, 'Tên dự án chỉ gồm chữ thường không dấu, số và dấu gạch ngang.');
    const title = String(b.title || name).trim();
    const user = String(b.user || '').trim();
    const pass = String(b.pass || '');
    const email = String(b.email || '').trim();
    const locale = /^[a-z]{2,3}(_[A-Z]{2})?$/.test(b.locale) ? b.locale : 'vi';
    if (!/^[A-Za-z0-9_.@-]{3,60}$/.test(user)) throw httpError(400, 'Tên đăng nhập admin cần 3–60 ký tự: chữ không dấu, số, _ . @ -');
    if (pass.length < 8) throw httpError(400, 'Mật khẩu admin cần ít nhất 8 ký tự.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Email admin không hợp lệ.');
    if (b.php && !laragon.phpVersions().includes(b.php)) throw httpError(400, 'Phiên bản PHP không hợp lệ.');
    const version = b.version && b.version !== 'latest' ? String(b.version).trim() : 'latest';
    if (version !== 'latest' && !VERSION.test(version)) throw httpError(400, 'Phiên bản WordPress không hợp lệ, ví dụ đúng: 6.4.5');
    const lockVersion = b.autoUpdate === false || (b.autoUpdate === undefined && version !== 'latest');
    let usedLocale = locale;

    const dir = siteDir(name);
    const hadDir = exists(dir);
    if (hadDir && exists(path.join(dir, 'wp-config.php'))) throw httpError(409, `Thư mục ${name} đã có WordPress được cài.`);
    if (hadDir && !exists(path.join(dir, 'wp-includes')) && fs.readdirSync(dir).length) {
      throw httpError(409, `Thư mục ${name} đã tồn tại và có tệp khác. Chọn tên khác.`);
    }
    const dbName = dbNameFor(name);
    if (await dbExists(dbName)) throw httpError(409, `Database ${dbName} đã tồn tại. Chọn tên khác hoặc xóa database cũ.`);

    const template = b.template ? ext.templates?.get(b.template) : null;
    if (b.template && !template) throw httpError(404, 'Không tìm thấy template này.');
    if (!ext.jobs) throw httpError(500, 'Chưa sẵn sàng.');

    const job = ext.jobs.start(`Cài WordPress ${name}`, ctx => withLock(name, 'được cài đặt', async () => {
      let createdDb = false;
      const notes = [];
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (b.php) { ctx.step(`Cấu hình PHP ${laragon.versionOf(b.php)}`); await laragon.setPhp(name, b.php); }
        if (!exists(path.join(dir, 'wp-includes'))) {
          ctx.step(`Tải WordPress ${version === 'latest' ? 'mới nhất' : version} (${locale})`);
          const dl = loc => wp(name, ['core', 'download', `--locale=${loc}`, ...(version !== 'latest' ? [`--version=${version}`] : [])]);
          try { await dl(locale); } catch (e) {
            // Một số bản cũ không có gói ngôn ngữ: thử lại bằng tiếng Anh
            if (locale === 'en_US') throw e;
            ctx.log(`  không có gói ${locale} cho bản này, dùng tiếng Anh`);
            await dl('en_US');
            usedLocale = 'en_US';
          }
        }
        ctx.step(`Tạo database ${dbName}`);
        await sql(`CREATE DATABASE ${ident(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        createdDb = true;
        writeConfig(name, dbName);
        ctx.step('Cài đặt WordPress');
        await wp(name, ['core', 'install', `--url=${laragon.urlOf(name)}`, `--title=${title}`, `--admin_user=${user}`,
          `--admin_password=${pass}`, `--admin_email=${email}`, '--skip-email']);
        if (usedLocale !== 'en_US') await wp(name, ['site', 'switch-language', usedLocale]).catch(() => {});
        if (lockVersion) setAutoUpdate(name, false);
        installMailGuard(name);
      } catch (e) {
        // Dọn dẹp những gì đã tạo
        ctx.log('Đang hoàn tác…');
        if (createdDb) await sql(`DROP DATABASE IF EXISTS ${ident(dbName)}`).catch(() => {});
        if (!hadDir) { laragon.forget(name); fs.rmSync(dir, { recursive: true, force: true }); }
        else fs.rmSync(configPath(name), { force: true });
        throw e;
      }
      // Template: lỗi ở đây không làm mất site vừa cài
      let applied = null;
      if (template) {
        try { applied = await ext.templates.apply(name, template, ctx, { title }); } catch (e) {
          notes.push(`Chưa áp dụng được template ${template.name}: ${e.message}`);
          ctx.log(`Lỗi template: ${e.message}`);
        }
        if (applied) notes.push(...applied.notes);
      }
      ctx.step('Tạo tên miền và khởi động lại Apache');
      const domain = await publish(name);
      for (const w of domain.warnings || []) notes.push(w);
      if (usedLocale !== locale) notes.push('Phiên bản này không có gói ngôn ngữ đã chọn nên đã cài bản tiếng Anh.');
      return { name, url: `${laragon.urlOf(name)}/`, adminUrl: `${laragon.urlOf(name)}/wp-admin/`, template: applied, notes, ...domain };
    }));
    res.json({ ok: true, job });
  }));

  r.get('/:name', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    res.json({ ...info(name), backups: listBackups(name) });
  }));

  // Danh sách plugin, giao diện và admin (chạy WP-CLI nên tách riêng)
  r.get('/:name/extras', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    const [plugins, themes, admins, core] = await Promise.all([
      wpJson(name, ['plugin', 'list', '--fields=name,title,status,version,update_version']),
      wpJson(name, ['theme', 'list', '--fields=name,title,status,version,update_version']),
      wpJson(name, ['user', 'list', '--role=administrator', '--fields=user_login,user_email'], { safe: true }),
      wpJson(name, ['core', 'check-update'], { safe: true }).catch(() => []),
    ]);
    res.json({ plugins, themes, admins, coreUpdate: core[0]?.version || null });
  }));

  r.post('/:name/debug', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    const on = !!req.body?.on;
    let src = readConfig(name);
    if (!src) throw httpError(400, 'Site chưa có wp-config.php.');
    src = setDefine(src, 'WP_DEBUG', on ? 'true' : 'false');
    src = setDefine(src, 'WP_DEBUG_LOG', on ? 'true' : 'false');
    src = setDefine(src, 'WP_DEBUG_DISPLAY', on ? 'true' : 'false');
    fs.writeFileSync(configPath(name), src);
    res.json({ ok: true });
  }));

  r.post('/:name/maintenance', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    const file = path.join(siteDir(name), '.maintenance');
    // time() được tính lại ở mỗi lượt truy cập nên chế độ bảo trì không tự hết hạn sau 10 phút
    if (req.body?.on) fs.writeFileSync(file, '<?php $upgrading = time(); // Bật bởi EzPanel\n');
    else fs.rmSync(file, { force: true });
    res.json({ ok: true });
  }));

  r.post('/:name/autoupdate', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    setAutoUpdate(name, !!req.body?.on);
    res.json({ ok: true });
  }));

  // Đổi sang một phiên bản WordPress cụ thể (nâng hoặc hạ), tự sao lưu trước
  r.post('/:name/core-version', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    const version = String(req.body?.version || '').trim();
    if (!VERSION.test(version)) throw httpError(400, 'Phiên bản WordPress không hợp lệ, ví dụ đúng: 6.4.5');
    const out = await withLock(name, 'đổi phiên bản WordPress', async () => {
      const backup = await createBackup(name);
      await wp(name, ['core', 'update', `--version=${version}`, '--force'], { safe: true });
      await wp(name, ['core', 'update-db'], { safe: true }).catch(() => {});
      return { backup };
    });
    res.json({ ok: true, ...out, site: info(name) });
  }));

  r.post('/:name/password', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    const user = String(req.body?.user || '');
    const pass = String(req.body?.pass || '');
    if (pass.length < 8) throw httpError(400, 'Mật khẩu cần ít nhất 8 ký tự.');
    await wp(name, ['user', 'update', user, `--user_pass=${pass}`, '--skip-email'], { safe: true });
    res.json({ ok: true });
  }));

  r.post('/:name/update', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    const what = req.body?.what;
    const log = await withLock(name, 'được cập nhật', async () => {
      const out = [];
      if (what === 'core' || what === 'all') {
        out.push(await wp(name, ['core', 'update'], { safe: true }));
        out.push(await wp(name, ['core', 'update-db'], { safe: true }));
      }
      if (what === 'plugins' || what === 'all') out.push(await wp(name, ['plugin', 'update', '--all']));
      if (what === 'themes' || what === 'all') out.push(await wp(name, ['theme', 'update', '--all']));
      if (!out.length) throw httpError(400, 'Chọn mục cần cập nhật.');
      return out.join('\n');
    });
    res.json({ ok: true, log });
  }));

  r.post('/:name/plugins/:plugin/:action', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    const { plugin, action } = req.params;
    if (!/^[a-z0-9_.-]+$/i.test(plugin)) throw httpError(400, 'Tên plugin không hợp lệ.');
    if (!['activate', 'deactivate', 'update'].includes(action)) throw httpError(400, 'Thao tác không hợp lệ.');
    await withLock(name, 'cập nhật plugin', () => wp(name, ['plugin', action, plugin]));
    res.json({ ok: true });
  }));

  // ----- Sao lưu & khôi phục -----
  r.post('/:name/backups', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    const file = await withLock(name, 'được sao lưu', () => createBackup(name));
    res.json({ ok: true, file });
  }));
  r.post('/:name/backups/:file/restore', wrap(async (req, res) => {
    const name = req.params.name;
    need();
    if (!exists(backupDir(name))) throw httpError(404, 'Không tìm thấy bản sao lưu của site này.');
    await withLock(name, 'được khôi phục', () => restoreBackup(name, req.params.file));
    res.json({ ok: true });
  }));
  r.get('/:name/backups/:file', wrap(async (req, res) => {
    const f = path.join(backupDir(req.params.name), req.params.file);
    if (!BACKUP_FILE.test(req.params.file) || !exists(f)) throw httpError(404, 'Không tìm thấy bản sao lưu.');
    res.download(f);
  }));
  r.delete('/:name/backups/:file', wrap(async (req, res) => {
    if (!BACKUP_FILE.test(req.params.file)) throw httpError(400, 'Tên tệp không hợp lệ.');
    fs.rmSync(path.join(backupDir(req.params.name), req.params.file), { force: true });
    res.json({ ok: true });
  }));

  // ----- Nhân bản (tạo bản staging) -----
  r.post('/:name/clone', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    const target = String(req.body?.target || '').trim().toLowerCase();
    if (!NAME.test(target)) throw httpError(400, 'Tên bản sao chỉ gồm chữ thường không dấu, số và dấu gạch ngang.');
    if (exists(siteDir(target))) throw httpError(409, `Đã có thư mục ${target}.`);
    const srcDb = readDefine(readConfig(name) || '', 'DB_NAME');
    const dbName = dbNameFor(target);
    if (await dbExists(dbName)) throw httpError(409, `Database ${dbName} đã tồn tại.`);

    await withLock(name, 'được nhân bản', () => withLock(target, 'được tạo', async () => {
      const sqlFile = path.join(config.paths.tools, `.clone-${crypto.randomBytes(4).toString('hex')}.sql`);
      let createdDb = false;
      try {
        fs.mkdirSync(config.paths.tools, { recursive: true });
        await exportDb(name, sqlFile);
        await fsp.cp(siteDir(name), siteDir(target), { recursive: true });
        fs.rmSync(path.join(siteDir(target), '.maintenance'), { force: true });
        await sql(`CREATE DATABASE ${ident(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        createdDb = true;
        fs.writeFileSync(configPath(target), setDefine(readConfig(target), 'DB_NAME', phpStr(dbName)));
        const php = laragon.phpFor(name);
        if (php) await laragon.setPhp(target, php);
        installMailGuard(target);
        await wp(target, ['db', 'import', sqlFile], { safe: true });
        // Đổi địa chỉ (an toàn với dữ liệu serialize của WordPress)
        await wp(target, ['search-replace', `//${laragon.domainOf(name)}`, `//${laragon.domainOf(target)}`, '--all-tables-with-prefix', '--precise'], { safe: true });
      } catch (e) {
        if (createdDb) await sql(`DROP DATABASE IF EXISTS ${ident(dbName)}`).catch(() => {});
        laragon.forget(target);
        fs.rmSync(siteDir(target), { recursive: true, force: true });
        throw e;
      } finally {
        fs.rmSync(sqlFile, { force: true });
      }
    }));
    const domain = await publish(target);
    res.json({ ok: true, source: srcDb, site: info(target), ...domain });
  }));

  // ----- Xóa site -----
  r.delete('/:name', wrap(async (req, res) => {
    const name = checkSite(req.params.name);
    await withLock(name, 'bị xóa', async () => {
      const db = readDefine(readConfig(name) || '', 'DB_NAME');
      if (req.query.db === '1' && db) await sql(`DROP DATABASE IF EXISTS ${ident(db)}`);
      laragon.forget(name);
      fs.rmSync(siteDir(name), { recursive: true, force: true });
    });
    res.json({ ok: true });
  }));

  // Bật/tắt HTTPS cho site WordPress: đổi địa chỉ trong database cho khớp
  laragon.hooks.httpsChanged = async (name, on) => {
    if (!isWp(name) || !readConfig(name)) return null;
    const d = laragon.domainOf(name);
    const [from, to] = on ? [`http://${d}`, `https://${d}`] : [`https://${d}`, `http://${d}`];
    await wp(name, ['search-replace', from, to, '--all-tables-with-prefix', '--precise'], { safe: true });
    await wp(name, ['search-replace', from.replace(/\//g, '\\/'), to.replace(/\//g, '\\/'), '--all-tables-with-prefix'], { safe: true }).catch(() => {});
    return `Đã đổi địa chỉ WordPress sang ${to}.`;
  };
  r.ensureWpCli = ensureWpCli;
  r.attach = o => Object.assign(ext, o); // jobs, templates (gắn sau khi các module đó được tạo)
  r.tools = { wp, sql, ident, dbExists, readDefine, setDefine, phpStr, readConfig, configPath, setAutoUpdate, installMailGuard, publish, info, isWp, withLock };
  return r;
};
