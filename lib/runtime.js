// Máy chủ độc lập của EzPanel (không cần Laragon).
// EzPanel tự dựng một thư mục máy chủ có cấu trúc giống Laragon:
//   <gốc>/bin/apache/<bản>   <gốc>/bin/php/<bản>   <gốc>/bin/mysql/<bản>
//   <gốc>/etc/apache2/sites-enabled   <gốc>/www   <gốc>/data/<mysql-8.0…>   <gốc>/usr/tpanel.ini
// nên mọi tính năng sẵn có (PHP riêng, HTTPS, WordPress, sao lưu…) dùng lại được nguyên vẹn.
// Khác Laragon: mọi dự án chạy PHP qua FastCGI (giống PHP-FPM trên host), không dùng mod_php.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const extractZip = (file, opts) => require('./util').unzip(file, opts.dir, opts); // tar.exe trên Windows
const { wrap, httpError, fetchText, download } = require('./util');

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const fwd = p => p.split(path.sep).join('/');
const mb = n => `${Math.round(n / 1048576)} MB`;
const cmpVer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

const APACHE_PAGE = 'https://www.apachelounge.com/download/';
const MARIADB_API = 'https://downloads.mariadb.org/rest-api/mariadb/';
// Mô-đun Apache cần cho WordPress/Laravel chạy giống host (chỉ nạp mô-đun có thật trong bản tải về)
const APACHE_MODULES = ['access_compat', 'actions', 'alias', 'allowmethods', 'auth_basic', 'authn_core', 'authn_file', 'authz_core',
  'authz_groupfile', 'authz_host', 'authz_user', 'autoindex', 'deflate', 'dir', 'env', 'expires', 'filter', 'headers', 'include',
  'log_config', 'mime', 'negotiation', 'rewrite', 'setenvif', 'socache_shmcb', 'ssl', 'version',
  'proxy', 'proxy_fcgi', 'proxy_balancer', 'slotmem_shm', 'lbmethod_byrequests'];

module.exports = (config, { laragon, services, jobs, certs }) => {
  const r = express.Router();
  const L = config.laragon;
  const root = () => path.resolve(L.root);
  const standalone = () => config.mode === 'standalone';

  // ---------- Tìm Laragon có sẵn trên máy ----------
  function findLaragon() {
    const found = new Set();
    const candidates = isWin
      ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').flatMap(d => [`${d}:\\laragon`, `${d}:\\Laragon`])
      : ['/tmp/laragon', path.join(os.homedir(), 'laragon')];
    if (L.root) candidates.unshift(path.resolve(L.root));
    for (const c of candidates) {
      if (isDir(path.join(c, 'www')) && isDir(path.join(c, 'bin', 'php')) && !exists(path.join(c, 'usr', 'tpanel.ini'))) found.add(fwd(c));
    }
    return [...found];
  }

  // ---------- Cấu trúc thư mục & phiên bản đang dùng ----------
  function layout(dir) {
    for (const d of ['bin/apache', 'bin/php', 'bin/mysql', 'etc/apache2/sites-enabled', 'www', 'data', 'usr', 'logs', 'tmp']) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
  }
  const iniFile = () => path.join(root(), 'usr', 'tpanel.ini');
  function readIni() {
    const out = {};
    let sec = null;
    try {
      for (const line of fs.readFileSync(iniFile(), 'utf8').split(/\r?\n/)) {
        const s = /^\s*\[(.+)\]\s*$/.exec(line);
        if (s) { sec = s[1].toLowerCase(); continue; }
        const kv = /^\s*Version\s*=\s*(.+?)\s*$/i.exec(line);
        if (kv && sec) out[sec] = kv[1];
      }
    } catch { /* chưa có */ }
    return out;
  }
  function setActive(kind, folder) {
    const cur = { ...readIni(), [kind]: folder };
    fs.mkdirSync(path.dirname(iniFile()), { recursive: true });
    fs.writeFileSync(iniFile(), '; Phiên bản đang dùng của máy chủ EzPanel\r\n' +
      Object.entries(cur).map(([k, v]) => `[${k}]\r\nVersion=${v}\r\n`).join('\r\n'));
  }

  // ---------- Thư viện Visual C++ (Apache, PHP, MySQL bản Windows đều cần) ----------
  function vcInstalled() {
    if (!isWin) return Promise.resolve(true);
    return new Promise(resolve => {
      execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', '/v', 'Major'], { windowsHide: true }, (err, out) => {
        const m = /Major\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out || '');
        resolve(!err && m && parseInt(m[1], 16) >= 14);
      });
    });
  }
  async function ensureVc(ctx) {
    if (await vcInstalled()) return;
    ctx.step('Cài Microsoft Visual C++ Redistributable (Windows sẽ hỏi quyền admin)');
    const file = path.join(config.paths.tools, 'vc_redist.x64.exe');
    fs.mkdirSync(config.paths.tools, { recursive: true });
    await download('https://aka.ms/vs/17/release/vc_redist.x64.exe', file);
    try { await laragon.runElevated([`Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList '/install','/quiet','/norestart' -Wait`]); } catch { /* xử lý bên dưới */ }
    fs.rmSync(file, { force: true });
    if (!(await vcInstalled())) throw httpError(400, 'Chưa cài được Visual C++ Redistributable (quyền admin bị từ chối?). Cài thủ công từ https://aka.ms/vs/17/release/vc_redist.x64.exe rồi thử lại.');
  }

  // Giải nén zip vào thư mục đích; nếu zip chỉ có một thư mục bọc ngoài thì lấy thư mục đó
  async function unpack(zip, destParent, name, pickInner) {
    const tmp = path.join(destParent, `.lp-unpack-${crypto.randomBytes(4).toString('hex')}`);
    try {
      await extractZip(zip, { dir: tmp, preferTar: true });
      let src = tmp;
      if (pickInner) src = pickInner(tmp) || tmp;
      else {
        const items = fs.readdirSync(tmp);
        if (items.length === 1 && isDir(path.join(tmp, items[0]))) src = path.join(tmp, items[0]);
      }
      const dest = path.join(destParent, name);
      fs.rmSync(dest, { recursive: true, force: true });
      await fsp.rename(src, dest);
      return dest;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const progressLog = (ctx, label) => {
    let last = 0;
    return (got, total) => {
      if (total) ctx.progress((got / total) * 100);
      if (got - last > 5 * 1048576) { last = got; ctx.log(`  ${label}: ${mb(got)}${total ? ` / ${mb(total)}` : ''}`); }
    };
  };

  // ---------- Apache (bản Windows của Apache Lounge) ----------
  async function apacheCatalog() {
    let html;
    try { html = await fetchText(APACHE_PAGE); } catch (e) { throw httpError(502, `Không mở được trang tải Apache (${e.message}).`); }
    const list = [];
    for (const m of html.matchAll(/href="([^"]*?(httpd-(2\.4\.\d+)-(\d+)-[Ww]in64-(VS\d+)\.zip))"/g)) {
      list.push({ url: new URL(m[1], APACHE_PAGE).href, file: m[2], version: m[3], build: m[5] });
    }
    if (!list.length) throw httpError(502, 'Không tìm thấy bản Apache trên trang Apache Lounge (trang có thể đã đổi cấu trúc).');
    return list.sort((a, b) => cmpVer(b.version, a.version));
  }
  async function installApache(ctx) {
    const [latest] = await apacheCatalog();
    ctx.step(`Tải Apache ${latest.version} (${latest.build})`);
    const zip = path.join(config.paths.tools, latest.file);
    fs.mkdirSync(config.paths.tools, { recursive: true });
    try {
      await download(latest.url, zip, { headers: { Referer: APACHE_PAGE }, onProgress: progressLog(ctx, 'Apache'), onRetry: (n, e) => ctx.log(`  lỗi tải (${e.message}), thử lại lần ${n + 1}…`) });
      const folder = `httpd-${latest.version}-win64-${latest.build}`;
      // Gói của Apache Lounge có thư mục Apache24 kèm vài tệp ReadMe
      const dir = await unpack(zip, path.join(root(), 'bin', 'apache'), folder, tmp => (isDir(path.join(tmp, 'Apache24')) ? path.join(tmp, 'Apache24') : null));
      writeHttpdConf(dir);
      setActive('apache', folder);
      return folder;
    } finally { fs.rmSync(zip, { force: true }); }
  }

  // httpd.conf do EzPanel tạo: Apache 2.4 giống host (rewrite, headers, deflate, expires…), PHP qua FastCGI
  function writeHttpdConf(dir) {
    const conf = path.join(dir, 'conf', 'httpd.conf');
    fs.mkdirSync(path.dirname(conf), { recursive: true });
    if (exists(conf) && !exists(`${conf}.goc`) && !/Do (EzPanel|tPanel) tạo/.test(fs.readFileSync(conf, 'utf8'))) fs.copyFileSync(conf, `${conf}.goc`);
    const mods = APACHE_MODULES.filter(m => exists(path.join(dir, 'modules', `mod_${m}.so`)))
      .map(m => `LoadModule ${m}_module modules/mod_${m}.so`);
    const www = fwd(path.join(root(), 'www'));
    const port = Number(L.httpPort) || 80;
    const lines = [
      '# Do EzPanel tạo. Đổi cài đặt trong EzPanel thay vì sửa tay (tệp sẽ được tạo lại).',
      `ServerRoot "${fwd(dir)}"`,
      `Listen ${port}`,
      ...(isWin ? [] : ['LoadModule mpm_prefork_module modules/mod_mpm_prefork.so',
        `PidFile "${fwd(path.join(root(), 'tmp', 'httpd.pid'))}"`]),
      ...mods,
      `ServerName localhost:${port}`,
      'ServerAdmin admin@localhost',
      ...(isWin ? ['<IfModule mpm_winnt_module>', '    ThreadsPerChild 150', '    MaxConnectionsPerChild 0', '</IfModule>',
        'AcceptFilter http none', 'AcceptFilter https none'] : []),
      'EnableSendfile Off', 'EnableMMAP Off',
      'Timeout 300', 'KeepAlive On', 'MaxKeepAliveRequests 100', 'KeepAliveTimeout 5',
      `DocumentRoot "${www}"`,
      '<Directory />', '    AllowOverride none', '    Require all denied', '</Directory>',
      `<Directory "${www}">`, '    Options FollowSymLinks Indexes', '    AllowOverride All', '    Require all granted', '</Directory>',
      'DirectoryIndex index.php index.html index.htm',
      '<Files ".ht*">', '    Require all denied', '</Files>',
      '<Files ".tpanel.json">', '    Require all denied', '</Files>',
      'ErrorLog "logs/error.log"', 'LogLevel warn',
      'LogFormat "%h %l %u %t \\"%r\\" %>s %b \\"%{Referer}i\\" \\"%{User-Agent}i\\"" combined',
      'CustomLog "logs/access.log" combined',
      'TypesConfig conf/mime.types',
      'AddType application/x-gzip .gz .tgz',
      '<IfModule deflate_module>',
      '    AddOutputFilterByType DEFLATE text/html text/plain text/css text/xml application/javascript application/json image/svg+xml',
      '</IfModule>',
      `IncludeOptional "${fwd(path.join(root(), 'etc', 'apache2', 'sites-enabled'))}/*.conf"`,
      '',
    ];
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(conf, lines.join('\n'));
  }

  // ---------- MySQL (bản zip chính thức) / MariaDB ----------
  async function mariadbRelease(major) {
    let data;
    try { data = JSON.parse(await fetchText(`${MARIADB_API}${major}/latest/`)); } catch (e) { throw httpError(502, `Không tải được thông tin MariaDB ${major} (${e.message}).`); }
    // Tìm tệp zip cho Windows x64 trong dữ liệu trả về (không phụ thuộc chi tiết cấu trúc)
    const files = [];
    const walk = o => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.file_name) files.push(o); Object.values(o).forEach(walk); } };
    walk(data);
    const f = files.find(x => /^mariadb-[\d.]+-winx64\.zip$/i.test(x.file_name));
    if (!f) throw httpError(404, `Không tìm thấy bản zip Windows cho MariaDB ${major}.`);
    const version = /mariadb-([\d.]+)-winx64/i.exec(f.file_name)[1];
    return { version, file: f.file_name, url: f.file_download_url, sha256: f.checksum?.sha256sum || null };
  }
  const sha256 = file => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

  async function installDatabase(ctx, { type = 'mysql', version }) {
    fs.mkdirSync(config.paths.tools, { recursive: true });
    let folder, zip, urls, expect = null;
    if (type === 'mariadb') {
      const rel = await mariadbRelease(version || '11.4');
      folder = `mariadb-${rel.version}-winx64`;
      zip = path.join(config.paths.tools, rel.file);
      urls = [rel.url];
      expect = rel.sha256;
      ctx.step(`Tải MariaDB ${rel.version}`);
    } else {
      if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw httpError(400, 'Nhập đúng phiên bản MySQL, ví dụ 8.0.46 (xem trong Tình trạng website của host).');
      const mm = version.split('.').slice(0, 2).join('.');
      folder = `mysql-${version}-winx64`;
      zip = path.join(config.paths.tools, `${folder}.zip`);
      urls = [`https://cdn.mysql.com/Downloads/MySQL-${mm}/${folder}.zip`, `https://cdn.mysql.com/archives/mysql-${mm}/${folder}.zip`,
        `https://downloads.mysql.com/archives/get/p/23/file/${folder}.zip`];
      ctx.step(`Tải MySQL ${version} (khoảng 250–300 MB)`);
    }
    try {
      let ok = false, lastErr;
      for (const u of urls) {
        try { await download(u, zip, { onProgress: progressLog(ctx, type === 'mariadb' ? 'MariaDB' : 'MySQL'), onRetry: (n, e) => ctx.log(`  lỗi tải (${e.message}), thử lại lần ${n + 1}…`) }); ok = true; break; } catch (e) { lastErr = e; }
      }
      if (!ok) throw httpError(502, `Không tải được ${type === 'mariadb' ? 'MariaDB' : `MySQL ${version}`} (${lastErr?.message}). Kiểm tra số phiên bản và kết nối Internet.`);
      if (expect) {
        ctx.log('  kiểm tra mã băm SHA-256');
        if ((await sha256(zip)) !== expect.toLowerCase()) throw httpError(400, 'Tệp tải về không khớp mã băm SHA-256 của nhà phát hành. Hãy thử lại.');
      }
      ctx.step('Giải nén');
      const dir = await unpack(zip, path.join(root(), 'bin', 'mysql'), folder);
      const series = type === 'mariadb' ? `mariadb-${folder.split('-')[1].split('.').slice(0, 2).join('.')}` : `mysql-${version.split('.').slice(0, 2).join('.')}`;
      const datadir = path.join(root(), 'data', series);
      writeMyIni(dir, datadir, type);
      if (!exists(path.join(datadir, 'mysql'))) await initDatadir(dir, datadir, type, ctx);
      else ctx.log(`  dùng lại dữ liệu có sẵn trong ${fwd(datadir)}`);
      setActive('mysql', folder);
      return folder;
    } finally { fs.rmSync(zip, { force: true }); }
  }

  // my.ini giống host: utf8mb4, max_allowed_packet 256M, 151 kết nối
  // PHP 5.6–7.3 không hiểu cách đăng nhập caching_sha2_password và bảng mã số 255 (utf8mb4_0900_ai_ci) của MySQL 8:
  // dùng cách đăng nhập kiểu cũ và bảng mã utf8mb4_unicode_ci (giống Laragon). Mỗi dòng MySQL cần cấu hình khác nhau.
  function compatLines(dirName, type) {
    const out = ['collation-server=utf8mb4_unicode_ci'];
    if (type === 'mariadb') return out;
    const m = /mysql-(\d+)\.(\d+)/i.exec(dirName || '');
    const major = m ? Number(m[1]) : 8, minor = m ? Number(m[2]) : 0;
    if (major === 8 && minor < 4) out.push('default_authentication_plugin=mysql_native_password');
    else if (major === 8) out.push('mysql_native_password=ON');
    return out; // MySQL 9 trở lên không còn cách đăng nhập kiểu cũ
  }

  function writeMyIni(dir, datadir, type) {
    const lines = ['# Do EzPanel tạo', '[mysqld]',
      `basedir="${fwd(dir)}"`, `datadir="${fwd(datadir)}"`,
      `port=${Number(config.mysql.port) || 3306}`, 'bind-address=127.0.0.1',
      'character-set-server=utf8mb4', ...compatLines(path.basename(dir), type), 'max_allowed_packet=256M', 'max_connections=151',
      'innodb_buffer_pool_size=256M',
      ...(type === 'mariadb' ? [] : ['mysqlx=OFF']),
      ...(isWin ? [] : [`socket="${fwd(path.join(root(), 'tmp', 'mysql.sock'))}"`, `user=${os.userInfo().username}`, `pid-file="${fwd(path.join(root(), 'tmp', 'mysqld.pid'))}"`]),
      '', '[client]', `port=${Number(config.mysql.port) || 3306}`, 'default-character-set=utf8mb4', ''];
    fs.writeFileSync(path.join(dir, 'my.ini'), lines.join('\r\n'));
  }

  function run(cmd, args, opts, ctx) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true, ...opts });
      let tail = '';
      const on = d => { tail = (tail + d).slice(-3000); };
      child.stdout?.on('data', on);
      child.stderr?.on('data', on);
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) return resolve(tail);
        // Ưu tiên dòng báo lỗi thật (ERROR/FATAL) thay vì dòng cuối (thường chỉ là đường dẫn tài liệu)
        const lines = tail.trim().split(/\r?\n/).filter(Boolean);
        const key = lines.filter(l => /error|fatal|failed|không/i.test(l)).slice(0, 2);
        reject(new Error((key.length ? key : lines.slice(-3)).join(' ') || `mã ${code}`));
      });
    });
  }
  // Khởi tạo thư mục dữ liệu: root@localhost không mật khẩu (như Laragon)
  async function initDatadir(dir, datadir, type, ctx) {
    ctx.step('Khởi tạo database (lần đầu, có thể mất 1–2 phút)');
    fs.mkdirSync(path.dirname(datadir), { recursive: true });
    const bin = path.join(dir, 'bin');
    try {
      if (type === 'mariadb') {
        const tool = ['mariadb-install-db', 'mysql_install_db'].map(n => path.join(bin, `${n}${EXE}`)).find(exists);
        if (!tool) throw new Error('không có mariadb-install-db');
        await run(tool, isWin ? [`--datadir=${datadir}`] : [`--defaults-file=${path.join(dir, 'my.ini')}`, `--basedir=${dir}`, `--datadir=${datadir}`, '--auth-root-authentication-method=normal'], { cwd: dir }, ctx);
      } else {
        const mysqld = path.join(bin, `mysqld${EXE}`);
        await run(mysqld, [`--defaults-file=${path.join(dir, 'my.ini')}`, '--initialize-insecure', '--console'], { cwd: dir }, ctx);
      }
    } catch (e) {
      fs.rmSync(datadir, { recursive: true, force: true });
      throw httpError(500, `Khởi tạo database thất bại: ${e.message}`);
    }
  }

  // MySQL 8 khởi tạo chỉ có root@localhost: thêm root@127.0.0.1 và root@::1 để mọi kiểu kết nối đều được chấp nhận
  async function ensureRootHosts() {
    const mysql = require('mysql2/promise');
    let c;
    for (let i = 0; i < 20; i++) {
      try { c = await mysql.createConnection({ ...config.mysql, connectTimeout: 3000 }); break; } catch { await new Promise(res => setTimeout(res, 1500)); }
    }
    if (!c) return false;
    try {
      const [[{ v }]] = await c.query('SELECT VERSION() AS v');
      const mysql8 = !/mariadb/i.test(v) && /^8\./.test(v);
      const pwv = c.escape(config.mysql.password || '');
      // MySQL 8: kiểu đăng nhập cũ để PHP 5.6–7.3 kết nối được; MariaDB / MySQL 9: giữ mặc định
      const auth = mysql8 ? ` IDENTIFIED WITH mysql_native_password BY ${pwv}` : config.mysql.password ? ` IDENTIFIED BY ${pwv}` : '';
      for (const host of ['127.0.0.1', '::1']) {
        await c.query(`CREATE USER IF NOT EXISTS 'root'@'${host}'${auth}`);
        await c.query(`GRANT ALL PRIVILEGES ON *.* TO 'root'@'${host}' WITH GRANT OPTION`);
      }
      if (mysql8) for (const host of ['localhost', '127.0.0.1', '::1']) await c.query(`ALTER USER 'root'@'${host}'${auth}`);
      await c.query('FLUSH PRIVILEGES');
      return true;
    } catch (e) { console.warn('ensureRootHosts:', e.message); return false; } finally { c.end().catch(() => {}); }
  }

  // Tự nâng cấp my.ini do bản cũ tạo (khi khởi động): bỏ skip-name-resolve (bản 2.0.0–2.0.2),
  // thêm dòng tương thích PHP cũ (bản trước 3.0.2); rồi khởi động lại MySQL và đổi kiểu đăng nhập của root
  async function upgradeMyIni() {
    if (!standalone() || !laragon.detected()) return;
    const m = laragon.mysqlInfo();
    const file = m && path.join(m.dir, 'my.ini');
    if (!file || !exists(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    if (!/Do (EzPanel|tPanel) tạo/.test(text)) return;
    // Xử lý từng dòng (không dùng regex nhiều dòng: "^" của JavaScript còn khớp sau ký tự \r của Windows)
    let lines = text.split(/\r?\n/);
    let changed = false;
    if (lines.some(l => l.trim() === 'skip-name-resolve')) { lines = lines.filter(l => l.trim() !== 'skip-name-resolve'); changed = true; }
    const keyOf = l => l.split('=')[0].trim().toLowerCase();
    const missing = compatLines(m.name, /mariadb/i.test(m.name) ? 'mariadb' : 'mysql').filter(w => !lines.some(l => keyOf(l) === keyOf(w)));
    if (missing.length) {
      const i = lines.findIndex(l => keyOf(l) === 'character-set-server');
      const at = i >= 0 ? i + 1 : lines.findIndex(l => l.trim().toLowerCase() === '[mysqld]') + 1;
      lines.splice(at, 0, ...missing);
      changed = true;
    }
    if (!changed) return;
    fs.writeFileSync(file, lines.join('\r\n'));
    const st = await services.status();
    if (st.mysql.running) await services.run('mysql', 'restart').catch(() => {});
    if ((await services.status()).mysql.running) await ensureRootHosts();
  }
  setTimeout(() => upgradeMyIni().catch(() => {}), 3000);

  // ---------- PHP ----------
  async function installPhpSeries(ctx, series) {
    const cat = await laragon.phpCatalog();
    const pickV = cat.find(v => v.version.startsWith(`${series}.`));
    if (!pickV) throw httpError(404, `Không tìm thấy PHP ${series} cho Windows.`);
    if (pickV.installed) {
      const folder = laragon.phpVersions().find(f => laragon.versionOf(f) === pickV.version);
      setActive('php', folder);
      return folder;
    }
    ctx.step(`Tải PHP ${pickV.version}`);
    const r = await laragon.installPhp(pickV.file, { log: l => ctx.log(l), onProgress: progressLog(ctx, 'PHP') });
    ctx.log(r.works ? '  PHP chạy tốt' : `  ${r.warning}`);
    setActive('php', r.folder);
    return r.folder;
  }

  // ---------- Node.js LTS cho terminal dự án (npm, npx, Vite…), đặt ở bin\nodejs như Laragon ----------
  async function installNode(ctx) {
    if (!isWin) return null;
    const index = JSON.parse(await fetchText('https://nodejs.org/dist/index.json'));
    const rel = index.find(x => x.lts && x.version.startsWith('v22.')) || index.find(x => x.lts);
    const v = rel.version, name = `node-${v}-win-x64`;
    const dir = path.join(root(), 'bin', 'nodejs');
    if (exists(path.join(dir, name, 'node.exe'))) { ctx.log(`  đã có Node.js ${v}`); return name; }
    ctx.step(`Tải Node.js ${v} (cho npm trong terminal dự án)`);
    fs.mkdirSync(config.paths.tools, { recursive: true });
    const zip = path.join(config.paths.tools, `${name}.zip`);
    try {
      await download(`https://nodejs.org/dist/${v}/${name}.zip`, zip, { onProgress: progressLog(ctx, 'Node.js'), onRetry: (n, e) => ctx.log(`  lỗi tải (${e.message}), thử lại lần ${n + 1}…`) });
      const line = (await fetchText(`https://nodejs.org/dist/${v}/SHASUMS256.txt`)).split('\n').find(l => l.trim().endsWith(`${name}.zip`));
      if (!line || line.trim().split(/\s+/)[0].toLowerCase() !== await sha256(zip)) throw httpError(400, 'Tệp Node.js tải về không khớp mã băm SHA-256.');
      ctx.log('  mã băm SHA-256 khớp');
      await unpack(zip, dir, name);
      return name;
    } finally { fs.rmSync(zip, { force: true }); }
  }

  // ---------- Dựng máy chủ độc lập (trình hướng dẫn lần đầu) ----------
  async function setupStandalone(ctx, o) {
    const dir = path.resolve(String(o.root || '').trim());
    if (!o.root || /[;'"<>|]/.test(dir)) throw httpError(400, 'Thư mục máy chủ không hợp lệ.');
    ctx.step(`Tạo thư mục máy chủ ${fwd(dir)}`);
    layout(dir);
    config.mode = 'standalone';
    config.roots = { ...(config.roots || {}), standalone: fwd(dir) };
    laragon.switchRoot(dir); // nạp trạng thái của thư mục mới, không mang trạng thái của Laragon sang
    await ensureVc(ctx);
    const php = await installPhpSeries(ctx, o.php || '8.4');
    ctx.log(`  PHP: ${php}`);
    const apache = await installApache(ctx);
    ctx.log(`  Apache: ${apache}`);
    const db = await installDatabase(ctx, o.database || { type: 'mysql', version: '8.0.46' });
    ctx.log(`  Database: ${db}`);
    try { const node = await installNode(ctx); if (node) ctx.log(`  Node.js: ${node}`); } catch (e) { ctx.log(`  chưa cài được Node.js (${e.message}); cài sau trong Cài đặt.`); }
    ctx.step('Tạo cấu hình Apache cho PHP qua FastCGI');
    await laragon.refreshConfs();
    laragon.restartFcgi();
    ctx.step('Bật Apache và MySQL');
    const msg = await services.run('all', 'start').catch(e => `Chưa bật được: ${e.message}`);
    ctx.log(`  ${msg}`);
    if ((await services.status()).mysql.running) {
      ctx.step('Cấp quyền kết nối cho root (localhost, 127.0.0.1, ::1)');
      if (!(await ensureRootHosts())) ctx.log('  chưa kết nối được MySQL để cấp quyền; EzPanel sẽ thử lại khi khởi động');
    }
    return { root: fwd(dir), php, apache, db, message: msg };
  }

  // Đổi phiên bản Apache đang dùng sang bản đã có (hoặc tạo lại httpd.conf khi đổi cổng / thư mục)
  function regenerateApache() {
    const a = laragon.apache();
    if (a && standalone()) writeHttpdConf(a.dir);
  }

  // ---------- API ----------
  r.get('/', wrap(async (req, res) => {
    const ini = readIni();
    res.json({
      mode: config.mode || 'laragon', root: L.root, active: ini, vc: await vcInstalled(),
      apache: laragon.detected() ? laragon.apache()?.name || null : null,
      mysql: laragon.detected() ? laragon.mysqlInfo()?.name || null : null,
      php: laragon.detected() ? laragon.defaultPhp() : null,
    });
  }));
  r.get('/apache-catalog', wrap(async (req, res) => res.json({ versions: await apacheCatalog() })));
  r.post('/apache/install', wrap(async (req, res) => {
    if (!standalone()) throw httpError(400, 'Chỉ dùng ở chế độ máy chủ độc lập.');
    res.json({ ok: true, job: jobs.start('Cài Apache', async ctx => ({ folder: await installApache(ctx) })) });
  }));
  r.post('/database/install', wrap(async (req, res) => {
    if (!standalone()) throw httpError(400, 'Chỉ dùng ở chế độ máy chủ độc lập.');
    const o = { type: req.body?.type === 'mariadb' ? 'mariadb' : 'mysql', version: String(req.body?.version || '') };
    res.json({ ok: true, job: jobs.start(`Cài ${o.type === 'mariadb' ? 'MariaDB' : 'MySQL'} ${o.version}`, async ctx => ({ folder: await installDatabase(ctx, o) })) });
  }));
  r.post('/node/install', wrap(async (req, res) => {
    if (!standalone()) throw httpError(400, 'Chỉ dùng ở chế độ máy chủ độc lập.');
    res.json({ ok: true, job: jobs.start('Cài Node.js', async ctx => ({ folder: await installNode(ctx) })) });
  }));
  r.post('/active', wrap(async (req, res) => {
    if (!standalone()) throw httpError(400, 'Chỉ dùng ở chế độ máy chủ độc lập.');
    const { kind, folder } = req.body || {};
    if (!['php', 'apache', 'mysql'].includes(kind)) throw httpError(400, 'Loại không hợp lệ.');
    const base = path.join(root(), 'bin', kind === 'mysql' ? 'mysql' : kind);
    if (!folder || /[\\/]/.test(folder) || !isDir(path.join(base, folder))) throw httpError(404, 'Không tìm thấy phiên bản này.');
    const before = await services.status();
    if (kind === 'mysql' && before.mysql.running) await services.run('mysql', 'stop');
    if (kind === 'apache' && before.apache.running) await services.run('apache', 'stop');
    setActive(kind, folder);
    if (kind === 'apache') regenerateApache();
    await laragon.refreshConfs();
    laragon.restartFcgi();
    let message = '';
    if (kind === 'mysql' && before.mysql.running) message = await services.run('mysql', 'start').catch(e => e.message);
    if (kind === 'apache' && before.apache.running) message = await services.run('apache', 'start').catch(e => e.message);
    res.json({ ok: true, message, ...(kind === 'php' ? await laragon.afterApacheChange() : {}) });
  }));

  // Các bản đã cài trong máy chủ độc lập (để chọn bản đang dùng)
  function installed() {
    const list = kind => { try { return fs.readdirSync(path.join(root(), 'bin', kind), { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name); } catch { return []; } };
    const ini = readIni();
    const series = f => (/mariadb/i.test(f) ? `MariaDB ${(/(\d+\.\d+)/.exec(f) || [])[1]}` : `MySQL ${(/(\d+\.\d+)/.exec(f) || [])[1]}`);
    return {
      apache: list('apache').filter(f => exists(path.join(root(), 'bin', 'apache', f, 'bin', `httpd${EXE}`))).map(f => ({ folder: f, active: f === laragon.apache()?.name })),
      php: laragon.phpVersions().map(f => ({ folder: f, version: laragon.versionOf(f), active: f === laragon.defaultPhp() })),
      mysql: list('mysql').filter(f => ['mysqld', 'mariadbd'].some(n => exists(path.join(root(), 'bin', 'mysql', f, 'bin', `${n}${EXE}`))))
        .map(f => ({ folder: f, series: series(f), active: f === laragon.mysqlInfo()?.name })),
      node: list('nodejs').filter(f => exists(path.join(root(), 'bin', 'nodejs', f, isWin ? 'node.exe' : 'node'))),
      ini,
    };
  }

  // Đổi cổng MySQL ở chế độ độc lập: viết lại my.ini (giữ thư mục dữ liệu)
  function rewriteMyIni() {
    const m = laragon.mysqlInfo();
    if (!m) return;
    const file = path.join(m.dir, 'my.ini');
    const datadir = exists(file) ? (/^\s*datadir\s*=\s*"?([^"\r\n]+?)"?\s*$/mi.exec(fs.readFileSync(file, 'utf8')) || [])[1] : null;
    if (datadir) writeMyIni(m.dir, path.resolve(datadir), /mariadb/i.test(m.name) ? 'mariadb' : 'mysql');
  }

  return { router: r, ensureRootHosts, compatLines, upgradeMyIni, findLaragon, installed, rewriteMyIni, apacheCatalog, mariadbRelease, installApache, installDatabase, setupStandalone, standalone, regenerateApache, layout, setActive, readIni, writeHttpdConf, writeMyIni, initDatadir };
};
