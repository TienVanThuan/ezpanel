// Kéo site từ production về Laragon:
//  - Từ tệp sao lưu: bản backup đầy đủ của cPanel, zip/tar.gz mã nguồn, kèm hoặc không kèm tệp .sql/.sql.gz
//  - Qua SSH: đọc thông tin database trên host, kéo mã nguồn (tar) và database (mysqldump) về
// Sau đó: tạo database, nạp dữ liệu, sửa cấu hình (WordPress / Laravel), đổi tên miền thật thành ten.test,
// sửa các dòng .htaccess chỉ chạy được trên host, chặn email thật, tạo tên miền và chạy site.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const extractZip = (file, opts) => require('./util').unzip(file, opts.dir, opts); // tar.exe trên Windows
const tar = require('tar');
const { Client } = require('ssh2');
const mysql = require('mysql2/promise');
const { wrap, httpError } = require('./util');

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
const NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const mb = n => `${(n / 1048576).toFixed(n > 104857600 ? 0 : 1)} MB`;

// ---------- Nhận diện loại site ----------
function kindOf(dir) {
  if (exists(path.join(dir, 'wp-includes', 'version.php')) || exists(path.join(dir, 'wp-config.php'))) return 'wordpress';
  if (exists(path.join(dir, 'artisan'))) return 'laravel';
  if (exists(path.join(dir, 'index.php')) || exists(path.join(dir, 'index.html'))) return 'php';
  return null;
}
// Tìm thư mục gốc của site trong cây thư mục giải nén (ưu tiên WordPress, rồi Laravel, rồi thư mục có index)
function findSiteRoot(base) {
  const found = { wordpress: [], laravel: [], php: [] };
  const walk = (dir, depth) => {
    if (depth > 6) return;
    const k = kindOf(dir);
    if (k) { found[k].push({ dir, depth }); if (k !== 'php') return; }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !['node_modules', '.git', 'vendor', 'wp-content', 'wp-includes', 'wp-admin', 'cache'].includes(e.name)) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(base, 0);
  for (const k of ['wordpress', 'laravel', 'php']) {
    if (found[k].length) return { root: found[k].sort((a, b) => a.depth - b.depth)[0].dir, kind: k };
  }
  return null;
}
function findSqlFiles(base) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(p, depth + 1); }
      else if (/\.sql(\.gz)?$/i.test(e.name)) out.push({ path: p, size: fs.statSync(p).size });
    }
  };
  walk(base, 0);
  return out;
}

// ---------- Sửa cấu hình ----------
const setEnv = (text, key, value) => {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
};
const readEnv = (text, key) => {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text || '');
  return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null;
};

// Vô hiệu hóa những dòng chỉ chạy được trên host
// Sửa các dòng .htaccess chỉ chạy được trên host (mọi tệp .htaccess trong site, không chỉ thư mục gốc):
// - bộ xử lý PHP của cPanel/CloudLinux (ea-php, alt-php, lsphp), auto_prepend_file (tường lửa như Wordfence)
// - php_value / php_flag ngoài <IfModule php…>: FastCGI không hiểu (lỗi 500) → tắt và chuyển sang .user.ini cùng thư mục
// - khóa mật khẩu (Basic Auth) trỏ tới tệp .htpasswd không có ở máy này (thường gặp ở wp-admin của host Nhật)
// - lệnh của module máy chủ không có ở local (ModSecurity cũ, suPHP, Passenger, Fcgid) nằm ngoài <IfModule>
function fixHostOnlyLines(siteDir, notes) {
  const mark = '# [Sitebench đã tắt dòng này khi nhập site] ';
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (e.isFile() && e.name === '.htaccess') files.push(path.join(dir, e.name));
      else if (e.isDirectory() && !['node_modules', '.git', 'vendor', 'cache'].includes(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(siteDir, 0);
  const summary = { handler: 0, php: 0, auth: 0, module: 0 };
  for (const hta of files) {
    const lines = fs.readFileSync(hta, 'utf8').split(/\r?\n/);
    const stack = []; // khối <IfModule> đang mở: true nếu là module PHP
    const toIni = [];
    const authFileMissing = lines.some(l => {
      const m = /^\s*Auth(User|Group)File\s+"?([^"\s]+)"?/i.exec(l);
      return m && !exists(path.isAbsolute(m[2]) ? m[2] : path.join(siteDir, m[2]));
    });
    let changed = 0;
    const out = lines.map(line => {
      const t = line.trim();
      if (t.startsWith('#') || !t) return line;
      const open = /^<IfModule\s+(!?)([^>]+)>/i.exec(t);
      if (open) { stack.push(/php/i.test(open[2])); return line; }
      if (/^<\/IfModule>/i.test(t)) { stack.pop(); return line; }
      const inPhpBlock = stack.includes(true);
      const inAnyBlock = stack.length > 0;
      const off = kind => { summary[kind]++; changed++; return mark + line; };
      if (/^(AddHandler|AddType|SetHandler)\s+application\/x-httpd-(ea-|alt-)?php/i.test(t) || /^php_value\s+auto_prepend_file/i.test(t)) return off('handler');
      const pv = /^php_(admin_)?(value|flag)\s+(\S+)\s+(.*)$/i.exec(t);
      if (pv && !inPhpBlock) {
        let val = pv[4].trim().replace(/^"(.*)"$/, '$1');
        if (/flag/i.test(pv[2])) val = /^(on|1|true)$/i.test(val) ? 'On' : 'Off';
        if (!/auto_prepend_file/i.test(pv[3])) toIni.push(`${pv[3]} = ${/[\s;=]/.test(val) ? `"${val}"` : val}`);
        return off('php');
      }
      if (authFileMissing && (/^Auth(Type|Name|UserFile|GroupFile|BasicProvider)\b/i.test(t) || /^Require\s+(valid-user|user|group)\b/i.test(t))) return off('auth');
      if (!inAnyBlock && /^(Sec[A-Z]\w*|suPHP_\w+|Passenger\w+|Fcgid\w+|FCGIWrapper)\b/.test(t)) return off('module');
      return line;
    });
    if (changed) fs.writeFileSync(hta, out.join('\n'));
    if (toIni.length) {
      const ini = path.join(path.dirname(hta), '.user.ini');
      const old = isFile(ini) ? fs.readFileSync(ini, 'utf8') : '';
      const add = toIni.filter(l => !old.includes(l.split('=')[0].trim() + ' ='));
      if (add.length) fs.writeFileSync(ini, `${old}${old && !old.endsWith('\n') ? '\n' : ''}; [Sitebench] chuyển từ php_value/php_flag trong .htaccess\n${add.join('\n')}\n`);
    }
  }
  const parts = [
    summary.handler && `${summary.handler} dòng bộ xử lý PHP của host / auto_prepend_file`,
    summary.php && `${summary.php} dòng php_value/php_flag (đã chuyển sang .user.ini)`,
    summary.auth && `${summary.auth} dòng khóa mật khẩu trỏ tới tệp .htpasswd của host`,
    summary.module && `${summary.module} dòng của module máy chủ không có ở máy này`,
  ].filter(Boolean);
  if (parts.length) notes.push(`Đã tắt trong .htaccess: ${parts.join('; ')}.`);
  const userIni = path.join(siteDir, '.user.ini');
  if (isFile(userIni)) {
    const text = fs.readFileSync(userIni, 'utf8');
    const fixed = text.replace(/^(\s*auto_prepend_file\s*=.*)$/gmi, `; [Sitebench] $1`);
    if (fixed !== text) {
      fs.writeFileSync(userIni, fixed);
      notes.push('Đã tắt auto_prepend_file trong .user.ini (đường dẫn của host không tồn tại ở local).');
    }
  }
  return parts.length;
}

// Phiên bản PHP web khai báo trong .htaccess của cPanel / CloudLinux (ea-php81, alt-php74, lsphp80)
function phpFromHtaccess(text) {
  const m = /x-httpd-(?:ea-|alt-)?php(\d)(\d{1,2})/i.exec(text || '') || /lsphp(\d)(\d{1,2})/i.exec(text || '');
  return m ? `${m[1]}.${m[2]}` : null;
}

module.exports = (config, { laragon, jobs, wpTools, wpExtras, dbtools }) => {
  const D = dbtools;
  const X = wpExtras;
  const r = express.Router();
  const uploadDir = path.join(config.paths.tools, 'uploads');
  const W = wpTools;

  // Mở thử site qua Apache local; gặp lỗi 500 thì lấy nguyên nhân từ nhật ký lỗi của Apache
  async function probeSite(name, wordpress) {
    const host = laragon.domainOf(name);
    const port = Number(config.laragon.httpPort) || 80;
    const get = p => new Promise(res => {
      const req = require('http').get({ host: '127.0.0.1', port, path: p, headers: { Host: host }, timeout: 20000 }, r => { r.resume(); res(r.statusCode); });
      req.on('error', () => res(0));
      req.on('timeout', () => { req.destroy(); res(0); });
    });
    await new Promise(r => setTimeout(r, 1500));
    // Chỉ đọc phần nhật ký phát sinh trong lúc mở thử (không lẫn lỗi cũ)
    const log = (() => { try { return path.join(laragon.apache().dir, 'logs', 'error.log'); } catch { return null; } })();
    const from = (() => { try { return fs.statSync(log).size; } catch { return 0; } })();
    const pages = { '/': await get('/') };
    if (wordpress) pages['/wp-admin/'] = await get('/wp-admin/');
    const bad = Object.entries(pages).filter(([, c]) => c >= 500).map(([p]) => p);
    let reason = null;
    if (bad.length) {
      try {
        await new Promise(r => setTimeout(r, 300));
        const st = fs.statSync(log);
        const fd = fs.openSync(log, 'r');
        const len = Math.min(Math.max(0, st.size - from), 65536);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        const dir = laragon.projectDir(name).split(path.sep).join('/').toLowerCase();
        const lines = buf.toString('utf8').split(/\r?\n/).filter(l => l.split('\\').join('/').toLowerCase().includes(dir) || l.includes(host));
        reason = [...new Set(lines.slice(-6).map(l => l.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)*/, '').replace(/,?\s*referer:.*$/, '').trim()))].slice(-2).join(' · ') || null;
      } catch { /* không đọc được nhật ký */ }
    }
    return { pages, bad, reason };
  }

  async function query(db, sql, params) {
    const c = await mysql.createConnection({ ...config.mysql, database: db, charset: 'utf8mb4' });
    try { return (await c.query(sql, params))[0]; } finally { c.end().catch(() => {}); }
  }

  // ---------- Hoàn tất: đưa site vào www, nạp DB, sửa cấu hình, chạy site ----------
  async function finalize(ctx, o) {
    const name = o.name;
    const dest = laragon.projectDir(name);
    const kind = o.kind;
    const notes = [];
    const dbName = `${kind === 'wordpress' ? 'wp' : 'db'}_${name.replace(/-/g, '_')}`.slice(0, 64);
    let movedSite = false;
    let createdDb = false;
    let compatHint = ''; // cảnh báo WordPress cũ / PHP mới, gắn vào thông báo lỗi nếu nhập thất bại
    try {
      if (exists(dest)) throw httpError(409, `Đã có thư mục ${name} trong www.`);
      if (o.sqlFile && await W.dbExists(dbName)) throw httpError(409, `Database ${dbName} đã tồn tại.`);

      ctx.step(`Đưa mã nguồn vào ${dest}`);
      try { await fsp.rename(o.siteRoot, dest); } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        await fsp.cp(o.siteRoot, dest, { recursive: true });
      }
      movedSite = true;
      fixHostOnlyLines(dest, notes);

      if (o.sqlFile) {
        ctx.step(`Tạo database ${dbName} và nạp dữ liệu (${mb(fs.statSync(o.sqlFile).size)})`);
        await W.sql(`CREATE DATABASE ${W.ident(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        createdDb = true;
        const { completed } = await D.importFile(o.sqlFile, dbName, ctx);
        if (!completed) notes.push('Tệp dump không có dòng "Dump completed" ở cuối; có thể tệp bị cắt dở. Hãy kiểm tra dữ liệu.');
      } else {
        notes.push('Không có tệp database đi kèm nên chưa nạp dữ liệu.');
      }

      // PHP và HTTPS trước khi chạy WP-CLI (để WP-CLI dùng đúng PHP)
      if (o.php || o.https) {
        ctx.step(`Cấu hình ${[o.php && `PHP ${laragon.versionOf(o.php)}`, o.https && 'HTTPS'].filter(Boolean).join(' và ')}`);
        await laragon.applyProject(name, { php: o.php || null, https: !!o.https });
      }
      const localUrl = laragon.urlOf(name);

      if (kind === 'wordpress') {
        ctx.step('Sửa wp-config.php cho máy local');
        let cfg = W.readConfig(name);
        if (!cfg) throw httpError(400, 'Không có wp-config.php trong mã nguồn WordPress.');
        const prefix = (/\$table_prefix\s*=\s*['"]([^'"]+)['"]/.exec(cfg) || [])[1] || 'wp_';
        const port = Number(config.mysql.port) !== 3306 ? `:${config.mysql.port}` : '';
        cfg = W.setDefine(cfg, 'DB_NAME', W.phpStr(dbName));
        cfg = W.setDefine(cfg, 'DB_USER', W.phpStr(config.mysql.user));
        cfg = W.setDefine(cfg, 'DB_PASSWORD', W.phpStr(config.mysql.password || ''));
        cfg = W.setDefine(cfg, 'DB_HOST', W.phpStr(`${config.mysql.host === '127.0.0.1' ? 'localhost' : config.mysql.host}${port}`));
        cfg = W.setDefine(cfg, 'WP_ENVIRONMENT_TYPE', "'local'");
        // Cache của máy chủ production (Redis/Memcached, page cache) không có ở máy local: tắt để site khởi động được
        if (W.readDefine(cfg, 'WP_CACHE') !== null) cfg = W.setDefine(cfg, 'WP_CACHE', 'false');
        for (const drop of ['object-cache.php', 'advanced-cache.php']) {
          const f = path.join(laragon.projectDir(name), 'wp-content', drop);
          if (exists(f)) { fs.renameSync(f, `${f}.tat-tren-may-local`); ctx.log(`  tắt ${drop} (cache của máy chủ production)`); }
        }
        // Phiên bản WordPress so với PHP: bản cũ trên PHP mới dễ lỗi nghiêm trọng
        try {
          const wpv = (/\$wp_version\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(laragon.projectDir(name), 'wp-includes', 'version.php'), 'utf8')) || [])[1];
          const phpv = laragon.versionOf(laragon.phpFor(name) || laragon.defaultPhp() || '');
          if (wpv) {
            ctx.log(`  WordPress ${wpv} · PHP ${phpv}`);
            const [a, b] = wpv.split('.').map(Number), wpn = a + (b || 0) / 10;
            const maxPhp = wpn < 5.3 ? 7.3 : wpn < 5.6 ? 7.4 : wpn < 5.9 ? 8.0 : wpn < 6.1 ? 8.1 : wpn < 6.4 ? 8.2 : wpn < 6.7 ? 8.3 : 8.4;
            const [pa, pb] = String(phpv).split('.').map(Number);
            if (pa + (pb || 0) / 10 > maxPhp + 0.001) compatHint = `WordPress ${wpv} chỉ hỗ trợ tới PHP ${maxPhp} nhưng đang dùng PHP ${phpv}: nhập lại và chọn PHP ${maxPhp}.`;
            if (compatHint) notes.push(`WordPress ${wpv} chỉ hỗ trợ tới PHP ${maxPhp}, máy local đang dùng PHP ${phpv}. Nếu site lỗi, chọn PHP ${maxPhp} trong mục Máy chủ & dự án.`);
          }
        } catch { /* bỏ qua */ }
        // Các hằng số gắn với tên miền production
        for (const k of ['WP_HOME', 'WP_SITEURL']) if (W.readDefine(cfg, k) !== null) cfg = W.setDefine(cfg, k, W.phpStr(localUrl));
        if (W.readDefine(cfg, 'COOKIE_DOMAIN') !== null) cfg = W.setDefine(cfg, 'COOKIE_DOMAIN', 'false');
        if (W.readDefine(cfg, 'FORCE_SSL_ADMIN') !== null) cfg = W.setDefine(cfg, 'FORCE_SSL_ADMIN', o.https ? 'true' : 'false');
        if (W.readDefine(cfg, 'WP_CACHE') !== null) cfg = W.setDefine(cfg, 'WP_CACHE', 'false');
        fs.writeFileSync(W.configPath(name), cfg);
        W.setAutoUpdate(name, false); // giữ đúng phiên bản như production
        W.installMailGuard(name);
        notes.push('Đã tắt tự động cập nhật và chặn email thật (email được chuyển vào Mailpit).');

        let prodUrl = null;
        if (o.sqlFile) {
          ctx.step('Đổi địa chỉ production thành địa chỉ local');
          let rows = [];
          try {
            rows = await query(dbName, `SELECT option_name, option_value FROM \`${prefix.replace(/`/g, '')}options\` WHERE option_name IN ('siteurl','home')`);
          } catch (e) { notes.push(`Không đọc được địa chỉ cũ trong database (${e.message}).`); }
          const home = rows.find(x => x.option_name === 'home') || rows[0];
          if (home) prodUrl = String(home.option_value).replace(/\/+$/, '');
          const hosts = new Set();
          for (const row of rows) {
            try { const u = new URL(row.option_value); hosts.add(u.host + u.pathname.replace(/\/$/, '')); } catch { /* bỏ qua */ }
          }
          const domain = laragon.domainOf(name);
          for (const h of hosts) {
            const variants = [h, h.startsWith('www.') ? h.slice(4) : `www.${h}`];
            for (const v of variants) {
              ctx.log(`  //${v} → //${domain}`);
              await W.wp(name, ['search-replace', `//${v}`, `//${domain}`, '--all-tables-with-prefix', '--precise', '--report-changed-only'], { safe: true });
              // Dạng JSON (\/\/ten-mien) trong dữ liệu của trình dựng trang
              await W.wp(name, ['search-replace', `\\/\\/${v.replace(/\//g, '\\/')}`, `\\/\\/${domain}`, '--all-tables-with-prefix', '--report-changed-only'], { safe: true }).catch(() => {});
            }
          }
          // Đúng giao thức local (http hoặc https)
          const [from, to] = o.https ? [`http://${domain}`, `https://${domain}`] : [`https://${domain}`, `http://${domain}`];
          await W.wp(name, ['search-replace', from, to, '--all-tables-with-prefix', '--precise', '--report-changed-only'], { safe: true });
          if (o.remotePath) {
            ctx.log(`  ${o.remotePath} → ${dest}`);
            await W.wp(name, ['search-replace', o.remotePath, dest.split(path.sep).join('/'), '--all-tables-with-prefix', '--precise', '--report-changed-only'], { safe: true }).catch(() => {});
          }
          await W.wp(name, ['cache', 'flush'], { safe: true }).catch(() => {});
          if (!hosts.size) notes.push('Không tìm thấy địa chỉ cũ của site trong database nên chưa đổi địa chỉ.');
        }
        if (prodUrl) X.setMeta(name, { prodUrl });
        if (prodUrl && o.uploadsProxy !== false) {
          X.setUploadsProxy(name, true, prodUrl);
          notes.push(`Ảnh không có ở máy này sẽ tự lấy từ ${prodUrl}.`);
        }
        if (X.isWoo(name) && o.shopSafety !== false) {
          ctx.step('Bật chế độ an toàn cho shop');
          const r = await X.enableSafety(name);
          notes.push(`Chế độ an toàn cho shop: ${r.gateways.length ? `đã tắt cổng thanh toán ${r.gateways.join(', ')}` : 'không có cổng thanh toán trực tuyến nào đang bật'}; tạm dừng tác vụ ngầm, webhook và WP-Cron.`);
        }
        if (o.sqlFile && o.anonymize !== false) {
          ctx.step('Ẩn danh dữ liệu khách hàng');
          const c = await X.anonymize(name);
          const total = Object.values(c).reduce((a, b) => a + b, 0);
          notes.push(`Đã ẩn danh dữ liệu khách hàng (${total} bản ghi: email, số điện thoại, địa chỉ, tên).`);
        }
        notes.push('Nếu site dùng plugin cache, CDN hoặc bảo mật (WP Rocket, Cloudflare, Wordfence…), có thể cần tắt chúng ở local.');
      } else if (kind === 'laravel') {
        ctx.step('Sửa .env cho máy local');
        const envPath = path.join(dest, '.env');
        let env = isFile(envPath) ? fs.readFileSync(envPath, 'utf8') : (isFile(path.join(dest, '.env.example')) ? fs.readFileSync(path.join(dest, '.env.example'), 'utf8') : '');
        env = setEnv(env, 'APP_URL', localUrl);
        if (o.sqlFile) {
          env = setEnv(env, 'DB_CONNECTION', 'mysql');
          env = setEnv(env, 'DB_HOST', config.mysql.host);
          env = setEnv(env, 'DB_PORT', String(config.mysql.port));
          env = setEnv(env, 'DB_DATABASE', dbName);
          env = setEnv(env, 'DB_USERNAME', config.mysql.user);
          env = setEnv(env, 'DB_PASSWORD', config.mysql.password || '');
        }
        // Gửi email vào Mailpit thay vì máy chủ email thật
        for (const [k, v] of [['MAIL_MAILER', 'smtp'], ['MAIL_HOST', '127.0.0.1'], ['MAIL_PORT', String(config.mail?.smtpPort || 1025)], ['MAIL_USERNAME', 'null'], ['MAIL_PASSWORD', 'null'], ['MAIL_ENCRYPTION', 'null']]) env = setEnv(env, k, v);
        fs.writeFileSync(envPath, env);
        notes.push('Đã sửa .env: APP_URL, kết nối database và gửi email vào Mailpit. Nếu thiếu thư mục vendor, chạy "composer install" trong Terminal.');
      } else if (o.sqlFile) {
        notes.push(`Đã nạp dữ liệu vào database ${dbName} (user ${config.mysql.user}, mật khẩu ${config.mysql.password ? 'như cấu hình MySQL' : 'để trống'}). Hãy sửa thông tin kết nối trong mã nguồn của site.`);
      }

      X.setMeta(name, { kind, db: o.sqlFile ? dbName : null, imported: new Date().toISOString() });
      ctx.step('Tạo tên miền và khởi động lại Apache');
      const pub = await W.publish(name);
      for (const w of pub.warnings || []) notes.push(w);
      ctx.step('Mở thử site');
      const probe = await probeSite(name, kind === 'wordpress');
      ctx.log(`  ${Object.entries(probe.pages).map(([p, c]) => `${p} → ${c || 'không phản hồi'}`).join(' · ')}`);
      if (probe.bad.length) notes.push(`Site báo lỗi máy chủ ở ${probe.bad.join(', ')}${probe.reason ? `: ${probe.reason}` : ''}. Xem mục Nhật ký → Apache để biết thêm.`);
      return {
        name, kind, url: `${laragon.urlOf(name)}/`, db: o.sqlFile ? dbName : null,
        adminUrl: kind === 'wordpress' ? `${laragon.urlOf(name)}/wp-admin/` : null, notes,
      };
    } catch (e) {
      ctx.log('Đang hoàn tác…');
      if (createdDb) await W.sql(`DROP DATABASE IF EXISTS ${W.ident(dbName)}`).catch(() => {});
      laragon.forget(name);
      if (movedSite) fs.rmSync(dest, { recursive: true, force: true });
      if (compatHint && e && typeof e.message === 'string') e.message = `${e.message} — ${compatHint}`;
      throw e;
    }
  }

  // ---------- Nguồn: tệp sao lưu ----------
  function resolveInput(input, label) {
    if (!input) return null;
    if (input.upload) {
      if (!/^[a-f0-9]{16}-[^/\\]+$/.test(input.upload)) throw httpError(400, `Tệp ${label} không hợp lệ.`);
      const p = path.join(uploadDir, input.upload);
      if (!isFile(p)) throw httpError(400, `Không thấy tệp ${label} đã tải lên. Hãy tải lên lại.`);
      return { path: p, temp: true };
    }
    if (input.path) {
      const p = path.resolve(String(input.path).trim().replace(/^"|"$/g, ''));
      if (!isFile(p)) throw httpError(400, `Không tìm thấy tệp ${label}: ${p}`);
      return { path: p, temp: false };
    }
    return null;
  }

  async function extract(file, dest, ctx) {
    fs.mkdirSync(dest, { recursive: true });
    const n = file.toLowerCase();
    if (n.endsWith('.zip')) await extractZip(file, { dir: dest });
    else if (/\.(tar\.gz|tgz|tar)$/.test(n)) {
      const total = fs.statSync(file).size;
      let read = 0;
      await new Promise((resolve, reject) => {
        const input = fs.createReadStream(file);
        input.on('data', d => { read += d.length; ctx.progress((read / total) * 100); });
        input.on('error', reject);
        input.pipe(tar.x({ cwd: dest, strict: false })).on('finish', resolve).on('error', reject);
      });
    } else throw httpError(400, 'Tệp mã nguồn phải là .zip, .tar.gz, .tgz hoặc .tar.');
  }

  async function runFiles(ctx, o) {
    const work = path.join(laragon.P.www(), `.lp-import-${crypto.randomBytes(4).toString('hex')}`);
    const archive = resolveInput(o.archive, 'mã nguồn');
    const sqlIn = resolveInput(o.sql, 'database');
    try {
      ctx.step(`Giải nén ${path.basename(archive.path)} (${mb(fs.statSync(archive.path).size)})`);
      await extract(archive.path, work, ctx);
      const site = findSiteRoot(work);
      if (!site) throw httpError(400, 'Không tìm thấy mã nguồn website trong tệp sao lưu (không có wp-config.php, artisan hay index.php).');
      ctx.log(`  thư mục site: ${path.relative(work, site.root) || '(gốc)'} · loại: ${site.kind === 'wordpress' ? 'WordPress' : site.kind === 'laravel' ? 'Laravel' : 'PHP'}`);

      let sqlFile = sqlIn?.path || null;
      if (!sqlFile) {
        // Tìm .sql đi kèm trong tệp sao lưu (bản backup đầy đủ của cPanel có thư mục mysql/)
        const cfg = site.kind === 'wordpress' && isFile(path.join(site.root, 'wp-config.php')) ? fs.readFileSync(path.join(site.root, 'wp-config.php'), 'utf8') : '';
        const want = W.readDefine(cfg, 'DB_NAME') || readEnv(isFile(path.join(site.root, '.env')) ? fs.readFileSync(path.join(site.root, '.env'), 'utf8') : '', 'DB_DATABASE');
        const candidates = findSqlFiles(work);
        const match = want && candidates.find(c => path.basename(c.path).replace(/\.sql(\.gz)?$/i, '') === want);
        const pick = match || candidates.sort((a, b) => b.size - a.size)[0];
        if (pick) { sqlFile = pick.path; ctx.log(`  tệp database trong bản sao lưu: ${path.relative(work, pick.path)}`); }
      }
      if (site.kind === 'wordpress' && !sqlFile) throw httpError(400, 'Site WordPress cần tệp database (.sql hoặc .sql.gz). Hãy chọn thêm tệp database.');
      return await finalize(ctx, { ...o, kind: site.kind, siteRoot: site.root, sqlFile });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      if (archive?.temp) fs.rmSync(archive.path, { force: true });
      if (sqlIn?.temp) fs.rmSync(sqlIn.path, { force: true });
    }
  }

  // ---------- Nguồn: SSH ----------
  const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
  // "~/public_html" → "$HOME"/'public_html' (để shell trên host tự hiểu thư mục nhà)
  const rpath = p => {
    const t = String(p || '').trim().replace(/\/+$/, '') || '~';
    if (t === '~') return '"$HOME"';
    if (t.startsWith('~/')) return `"$HOME"/${q(t.slice(2))}`;
    return q(t);
  };

  function connect(o) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const opts = {
        host: String(o.host || '').trim(), port: Number(o.port) || 22, username: String(o.user || '').trim(),
        readyTimeout: 20000, keepaliveInterval: 10000, tryKeyboard: true,
      };
      if (!opts.host || !opts.username) return reject(httpError(400, 'Cần nhập máy chủ và tên đăng nhập SSH.'));
      if (o.auth === 'key') {
        let key = o.privateKey;
        if (!key && o.keyPath) {
          try { key = fs.readFileSync(path.resolve(String(o.keyPath).trim()), 'utf8'); } catch { return reject(httpError(400, `Không đọc được tệp khóa ${o.keyPath}.`)); }
        }
        if (!key) return reject(httpError(400, 'Cần dán khóa riêng (private key) hoặc nhập đường dẫn tệp khóa.'));
        opts.privateKey = key;
        if (o.passphrase) opts.passphrase = o.passphrase;
      } else {
        opts.password = o.password || '';
      }
      conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => finish(prompts.map(() => o.password || '')));
      conn.on('ready', () => resolve(conn));
      conn.on('error', e => reject(httpError(400, `Không kết nối được SSH: ${/authentication/i.test(e.message) ? 'sai tên đăng nhập, mật khẩu hoặc khóa' : e.message}`)));
      try { conn.connect(opts); } catch (e) { reject(httpError(400, `Không kết nối được SSH: ${e.message}`)); }
    });
  }
  function exec(conn, cmd) {
    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = '', errOut = '';
        stream.on('data', d => { out += d; });
        stream.stderr.on('data', d => { errOut += d; });
        stream.on('close', code => resolve({ code, out, err: errOut }));
      });
    });
  }
  function execToStream(conn, cmd, dest, onBytes) {
    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let errOut = '';
        let code = null;
        let finished = false;
        const done = () => { if (finished && code !== null) resolve({ code, err: errOut }); };
        stream.stderr.on('data', d => { errOut += d; });
        stream.on('data', d => onBytes?.(d.length));
        stream.on('exit', c => { code = c ?? 0; done(); });
        stream.pipe(dest);
        dest.on('finish', () => { finished = true; done(); });
        dest.on('close', () => { finished = true; done(); });
        dest.on('error', reject);
      });
    });
  }

  // Thông tin database trên host từ wp-config.php hoặc .env
  function remoteDb(kind, cfgText) {
    if (kind === 'wordpress') {
      const g = k => W.readDefine(cfgText, k);
      return g('DB_NAME') ? { name: g('DB_NAME'), user: g('DB_USER'), password: g('DB_PASSWORD') || '', host: g('DB_HOST') || 'localhost' } : null;
    }
    if (kind === 'laravel') {
      const g = k => readEnv(cfgText, k);
      return g('DB_DATABASE') ? { name: g('DB_DATABASE'), user: g('DB_USERNAME'), password: g('DB_PASSWORD') || '', host: `${g('DB_HOST') || 'localhost'}${g('DB_PORT') && g('DB_PORT') !== '3306' ? `:${g('DB_PORT')}` : ''}` } : null;
    }
    return null;
  }

  async function probe(o) {
    const conn = await connect(o);
    try {
      const base = rpath(o.remotePath);
      const pwd = await exec(conn, `cd ${base} && pwd`);
      if (pwd.code !== 0) throw httpError(400, `Không có thư mục ${o.remotePath || '~'} trên host.`);
      const dir = pwd.out.trim().split('\n').pop();
      const has = async f => (await exec(conn, `test -f ${q(`${dir}/${f}`)} && echo yes`)).out.trim() === 'yes';
      const cat = async f => ((await has(f)) ? (await exec(conn, `cat ${q(`${dir}/${f}`)}`)).out : '');
      let kind = null;
      if (await has('wp-config.php') || await has('wp-includes/version.php')) kind = 'wordpress';
      else if (await has('artisan')) kind = 'laravel';
      else if (await has('index.php') || await has('index.html')) kind = 'php';
      if (!kind) throw httpError(400, `Thư mục ${dir} không giống thư mục website (không có wp-config.php, artisan hay index.php).`);
      const cfgText = kind === 'wordpress' ? await cat('wp-config.php') : kind === 'laravel' ? await cat('.env') : '';
      const db = remoteDb(kind, cfgText);
      const wpVer = kind === 'wordpress' ? (/\$wp_version\s*=\s*'([^']+)'/.exec(await cat('wp-includes/version.php')) || [])[1] || null : null;
      const htPhp = phpFromHtaccess(await cat('.htaccess'));
      const cliPhp = (await exec(conn, "php -r 'echo PHP_VERSION;' 2>/dev/null")).out.trim() || null;
      const size = (await exec(conn, `du -sh ${q(dir)} 2>/dev/null | cut -f1`)).out.trim() || null;
      const uploads = kind === 'wordpress' ? (await exec(conn, `du -sh ${q(`${dir}/wp-content/uploads`)} 2>/dev/null | cut -f1`)).out.trim() || null : null;
      const tools = (await exec(conn, 'command -v mysqldump >/dev/null && echo dump; command -v tar >/dev/null && echo tar; command -v gzip >/dev/null && echo gzip')).out;
      let siteUrl = null;
      if (kind === 'laravel') siteUrl = readEnv(cfgText, 'APP_URL');
      return {
        dir, kind, wpVersion: wpVer, php: htPhp || cliPhp, phpSource: htPhp ? 'htaccess' : cliPhp ? 'cli' : null,
        db: db ? { name: db.name, user: db.user, host: db.host } : null,
        size, uploads, siteUrl,
        missing: ['tar', 'gzip', ...(db ? ['dump'] : [])].filter(t => !tools.includes(t)).map(t => (t === 'dump' ? 'mysqldump' : t)),
        _db: db,
      };
    } finally {
      conn.end();
    }
  }

  async function runSsh(ctx, o) {
    const work = path.join(laragon.P.www(), `.lp-import-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(work, { recursive: true });
    ctx.step(`Kết nối ${o.user}@${o.host}`);
    const info = await probe(o);
    if (info.missing.length) throw httpError(400, `Host thiếu lệnh ${info.missing.join(', ')} nên không kéo qua SSH được. Hãy dùng cách nhập từ tệp sao lưu.`);
    ctx.log(`  ${info.dir} · ${info.kind}${info.wpVersion ? ` ${info.wpVersion}` : ''} · PHP trên host ${info.php || '?'} · ${info.size || '?'}`);
    const conn = await connect(o);
    try {
      let sqlFile = null;
      if (info._db) {
        ctx.step(`Xuất database ${info._db.name} trên host`);
        sqlFile = path.join(work, 'database.sql.gz');
        const [h, p] = info._db.host.split(':');
        const hostArgs = p && /^\d+$/.test(p) ? `-h ${q(h)} -P ${p}` : p ? `-h ${q(h)} -S ${q(p)}` : `-h ${q(h)}`;
        const cmd = `MYSQL_PWD=${q(info._db.password)} mysqldump --single-transaction --quick --no-tablespaces --skip-lock-tables --default-character-set=utf8mb4 ${hostArgs} -u ${q(info._db.user)} ${q(info._db.name)} | gzip -c`;
        let got = 0;
        let lastLog = 0;
        const res = await execToStream(conn, cmd, fs.createWriteStream(sqlFile), n => {
          got += n;
          if (got - lastLog > 5 * 1048576) { ctx.log(`  đã nhận ${mb(got)}`); lastLog = got; }
        });
        if (/mysqldump: (Got error|Couldn't|Error|Access denied)/i.test(res.err)) {
          throw httpError(400, `Xuất database trên host thất bại: ${res.err.trim().split('\n').pop()}`);
        }
        ctx.log(`  database: ${mb(fs.statSync(sqlFile).size)} (đã nén)`);
      }
      ctx.step(`Tải mã nguồn từ ${info.dir}${info.size ? ` (${info.size})` : ''}`);
      const excludes = ['./wp-content/cache', './wp-content/updraft', './wp-content/ai1wm-backups', './wp-content/backups-dup-lite',
        './wp-content/uploads/backwpup-*', './node_modules', './.git', './error_log', ...(o.skipUploads ? ['./wp-content/uploads'] : [])]
        .map(x => `--exclude=${q(x)}`).join(' ');
      const files = path.join(work, 'site');
      fs.mkdirSync(files, { recursive: true });
      let got = 0;
      let lastLog = 0;
      const res = await execToStream(conn, `tar -czf - ${excludes} -C ${q(info.dir)} .`, tar.x({ cwd: files, strict: false }), n => {
        got += n;
        if (got - lastLog > 10 * 1048576) { ctx.log(`  đã nhận ${mb(got)}`); lastLog = got; }
      });
      // tar trả mã 1 khi có tệp thay đổi lúc đang đọc: chỉ là cảnh báo
      if (res.code > 1) throw httpError(400, `Tải mã nguồn thất bại: ${res.err.trim().split('\n').pop()}`);
      ctx.log(`  đã nhận ${mb(got)} mã nguồn (đã nén)`);
      conn.end();
      const result = await finalize(ctx, { ...o, kind: info.kind, siteRoot: files, sqlFile, remotePath: info.dir });
      if (o.skipUploads) result.notes.push(`Đã bỏ qua thư mục uploads${info.uploads ? ` (${info.uploads})` : ''} khi tải về.`);
      if (info.php) result.notes.push(`PHP trên host: ${info.php}${info.phpSource === 'cli' ? ' (bản dòng lệnh, có thể khác bản web dùng)' : ''}.`);
      return result;
    } finally {
      conn.end();
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  // ---------- API ----------
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => { fs.mkdirSync(uploadDir, { recursive: true }); cb(null, uploadDir); },
      filename: (req, file, cb) => {
        const n = path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8')).replace(/[^\w.\-]+/g, '_');
        cb(null, `${crypto.randomBytes(8).toString('hex')}-${n}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 * 1024 },
  });
  r.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn tệp.' });
    res.json({ ok: true, upload: req.file.filename, size: req.file.size });
  });

  r.post('/ssh/probe', wrap(async (req, res) => {
    if (!laragon.detected()) throw httpError(400, 'Chưa tìm thấy Laragon.');
    const info = await probe(req.body || {});
    delete info._db;
    // Gợi ý phiên bản PHP local gần nhất với host
    const local = laragon.phpVersions();
    let suggest = null;
    if (info.php) {
      const mm = info.php.split('.').slice(0, 2).join('.');
      suggest = local.find(f => laragon.versionOf(f).startsWith(`${mm}.`) || laragon.versionOf(f) === mm) || null;
    }
    res.json({ ...info, suggestPhp: suggest });
  }));

  function checkStart(o) {
    if (!laragon.detected()) throw httpError(400, 'Chưa tìm thấy Laragon.');
    const name = String(o.name || '').trim().toLowerCase();
    if (!NAME.test(name)) throw httpError(400, 'Tên dự án chỉ gồm chữ thường không dấu, số và dấu gạch ngang.');
    if (exists(laragon.projectDir(name))) throw httpError(409, `Đã có dự án ${name} trong www.`);
    if (o.php && !laragon.phpVersions().includes(o.php)) throw httpError(400, 'Phiên bản PHP không hợp lệ.');
    return { ...o, name };
  }

  r.post('/start', wrap(async (req, res) => {
    const o = checkStart(req.body || {});
    if (o.source === 'files') {
      if (!o.archive) throw httpError(400, 'Hãy chọn tệp mã nguồn.');
      resolveInput(o.archive, 'mã nguồn');
      resolveInput(o.sql, 'database');
    } else if (o.source !== 'ssh') throw httpError(400, 'Nguồn không hợp lệ.');
    const id = jobs.start(`Nhập site ${o.name}`, ctx => W.withLock(o.name, 'được nhập', () => (o.source === 'ssh' ? runSsh(ctx, o) : runFiles(ctx, o))));
    res.json({ ok: true, job: id });
  }));

  r.post('/fix-htaccess/:name', wrap(async (req, res) => {
    const name = req.params.name;
    laragon.checkProject(name);
    const notes = [];
    const changed = fixHostOnlyLines(laragon.projectDir(name), notes);
    const probe = await probeSite(name, kindOf(laragon.projectDir(name)) === 'wordpress');
    res.json({ ok: true, changed, notes, probe });
  }));

  return { router: r };
};
