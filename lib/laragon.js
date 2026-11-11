// Tích hợp Laragon (Apache): chọn phiên bản PHP riêng cho từng dự án.
//
// Cách hoạt động:
//  - Mỗi phiên bản PHP đang được dùng sẽ chạy một tiến trình php-cgi (FastCGI) trên một cổng riêng.
//    EzPanel giám sát và tự khởi động lại tiến trình nếu nó tắt.
//  - Virtual host của dự án được ghi thành tệp "<tên>.test.conf" (không có tiền tố "auto."),
//    Laragon sẽ giữ nguyên tệp này. Bên trong, các tệp .php được chuyển sang cổng php-cgi tương ứng.
//  - Trước khi lưu, EzPanel chạy "httpd -t" để kiểm tra cú pháp; nếu lỗi thì tự hoàn tác.

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const os = require('os');
const { wrap, httpError, fetchText, download } = require('./util');
const extractZip = (file, opts) => require('./util').unzip(file, opts.dir, opts); // tar.exe trên Windows

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
const MARK_BEGIN = '# >>> LocalPanel PHP';
const MARK_END = '# <<< LocalPanel PHP';
const HEADER = '# Tệp này do LocalPanel quản lý (PHP riêng cho dự án). Đổi PHP trong LocalPanel thay vì sửa tay.';
const MODULES_FILE = '00-localpanel-modules.conf';

const fwd = p => p.split(path.sep).join('/');
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const listDirs = dir => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name);
  } catch { return []; }
};
const versionOf = folder => (/(\d+\.\d+(?:\.\d+)?)/.exec(folder) || [])[1] || folder;
const cmpVer = (a, b) => {
  const pa = versionOf(a).split('.').map(Number), pb = versionOf(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

module.exports = (config, certs) => {
  config.laragon = Object.assign({ root: 'C:/laragon', domainSuffix: '.test', httpPort: 80, phpBasePort: 9100, phpWorkers: 4, lanBasePort: 8100 }, config.laragon || {});
  const PHP_MIRROR = (config.laragon.phpMirror || 'https://downloads.php.net/~windows/releases/').replace(/\/?$/, '/');
  const L = config.laragon;
  // Trạng thái nằm trong <laragon>/etc/localpanel/state.json (chuyển từ vị trí cũ trong thư mục EzPanel nếu có)
  const stateFile = () => {
    const d = config.paths.laragonData();
    return d ? path.join(d, 'state.json') : config.paths.laragonState;
  };
  function loadState() {
    const f = stateFile();
    if (!exists(f) && f !== config.paths.laragonState && exists(config.paths.laragonState)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.copyFileSync(config.paths.laragonState, f);
      fs.renameSync(config.paths.laragonState, `${config.paths.laragonState}.da-chuyen`);
    }
    const st = exists(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    return { ports: {}, blocks: {}, pids: {}, projects: {}, ...st };
  }
  let state = loadState();

  const BLOCK = 20; // mỗi phiên bản PHP có một dải 20 cổng cho các tiến trình php-cgi
  const workerCount = () => Math.min(16, Math.max(1, Number(L.phpWorkers) || 4));
  const saveState = () => {
    const f = stateFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state, null, 2));
  };

  // ---------- Đường dẫn ----------
  const P = {
    root: () => path.resolve(L.root),
    www: () => path.join(P.root(), 'www'),
    php: () => path.join(P.root(), 'bin', 'php'),
    sitesEnabled: () => path.join(P.root(), 'etc', 'apache2', 'sites-enabled'),
  };
  const detected = () => exists(P.www()) && exists(P.php());

  // Phiên bản đang chọn trong Laragon (usr/laragon.ini, mục [php] / [apache] / [mysql])
  function iniVersion(section) {
    try {
      const own = path.join(P.root(), 'usr', 'tpanel.ini');
      const ini = fs.readFileSync(exists(own) ? own : path.join(P.root(), 'usr', 'laragon.ini'), 'utf8');
      const sec = new RegExp(`\\[${section}\\]([\\s\\S]*?)(?:\\n\\[|$)`, 'i').exec(ini);
      const m = sec && /^\s*Version\s*=\s*(.+?)\s*$/mi.exec(sec[1]);
      return m ? m[1] : null;
    } catch { return null; }
  }
  // Chọn thư mục theo laragon.ini, nếu không có thì lấy bản mới nhất thỏa điều kiện
  function pick(kind, ok) {
    const base = path.join(P.root(), 'bin', kind);
    const dirs = listDirs(base).filter(d => ok(path.join(base, d))).sort(cmpVer).reverse();
    const want = iniVersion(kind);
    const name = dirs.includes(want) ? want : dirs[0];
    return name ? { name, dir: path.join(base, name) } : null;
  }
  function apache() {
    const a = pick('apache', d => exists(path.join(d, 'bin', `httpd${EXE}`)));
    return a ? { ...a, httpd: path.join(a.dir, 'bin', `httpd${EXE}`) } : null;
  }
  function mysqlInfo() {
    const exeOf = d => ['mysqld', 'mariadbd'].map(n => path.join(d, 'bin', `${n}${EXE}`)).find(exists);
    const m = pick('mysql', d => !!exeOf(d));
    return m ? { ...m, mysqld: exeOf(m.dir), bin: path.join(m.dir, 'bin') } : null;
  }
  function mysqlBin() {
    return mysqlInfo()?.bin || null;
  }
  function phpVersions() {
    return listDirs(P.php())
      .filter(f => exists(path.join(P.php(), f, `php-cgi${EXE}`)) && exists(path.join(P.php(), f, `php${EXE}`)))
      .sort(cmpVer).reverse();
  }
  // PHP đang được chọn trong Laragon (đọc từ usr/laragon.ini), nếu không đọc được thì lấy bản mới nhất
  function defaultPhp() {
    const versions = phpVersions();
    const want = iniVersion('php');
    return versions.includes(want) ? want : versions[0] || null;
  }
  const phpDir = folder => path.join(P.php(), folder);
  const phpCli = folder => path.join(phpDir(folder), `php${EXE}`);

  // ---------- Dự án ----------
  const domainOf = name => `${name.toLowerCase()}${L.domainSuffix}`;
  const autoConf = name => path.join(P.sitesEnabled(), `auto.${domainOf(name)}.conf`);
  const ownConf = name => path.join(P.sitesEnabled(), `${domainOf(name)}.conf`);
  const projectDir = name => path.join(P.www(), name);
  const urlOf = name => (httpsFor(name) ? `https://${domainOf(name)}` : `http://${domainOf(name)}${L.httpPort === 80 ? '' : `:${L.httpPort}`}`);
  function checkProject(name) {
    if (!name || /[\\/]/.test(name) || name.startsWith('.') || !exists(projectDir(name))) {
      throw httpError(404, `Không tìm thấy dự án "${name}" trong ${fwd(P.www())}.`);
    }
    return name;
  }
  const phpFor = name => state.projects[name]?.php || null; // null = PHP mặc định của Laragon
  const httpsFor = name => !!state.projects[name]?.https;

  function projects() {
    return listDirs(P.www()).map(name => {
      const dir = projectDir(name);
      const own = exists(ownConf(name)) ? fs.readFileSync(ownConf(name), 'utf8') : null;
      return {
        name,
        domain: domainOf(name),
        url: `${urlOf(name)}/`,
        php: phpFor(name),
        wordpress: exists(path.join(dir, 'wp-config.php')) || exists(path.join(dir, 'wp-includes', 'version.php')),
        // Laragon tạo lại tệp auto.* khi đã có tệp riêng → tệp auto.* được nạp trước và lấn át
        https: httpsFor(name),
        lan: state.projects[name]?.lan || null,
        conflict: !!state.projects[name] && exists(autoConf(name)),
        customConf: !!own && !own.includes(HEADER) && !own.includes(NEW_HEADER),
        hasVhost: hasVhost(name),
      };
    });
  }

  // ---------- php.ini ----------
  // Nếu phiên bản PHP chưa có php.ini (Laragon chỉ tạo cho bản đang chọn), tạo từ php.ini-development
  const EXTENSIONS = ['curl', 'fileinfo', 'gd', 'gd2', 'intl', 'mbstring', 'mysqli', 'openssl', 'pdo_mysql', 'zip', 'exif', 'sodium'];
  function ensurePhpIni(folder) {
    const dir = phpDir(folder);
    const ini = path.join(dir, 'php.ini');
    if (exists(ini)) return;
    const src = ['php.ini-development', 'php.ini-production'].map(f => path.join(dir, f)).find(exists);
    let text = src ? fs.readFileSync(src, 'utf8') : '[PHP]\n';
    const extDir = path.join(dir, 'ext');
    if (exists(extDir)) {
      text = text.replace(/^;?\s*extension_dir\s*=\s*"ext"\s*$/m, `extension_dir = "${fwd(extDir)}"`);
      if (!/^extension_dir\s*=/m.test(text)) text = text.replace('[PHP]', `[PHP]\nextension_dir = "${fwd(extDir)}"`);
      for (const ext of EXTENSIONS) {
        const dll = path.join(extDir, `php_${ext}.dll`);
        if (!isWin || exists(dll)) text = text.replace(new RegExp(`^;(extension=(?:php_)?${ext}(?:\\.dll)?)\\s*$`, 'm'), '$1');
      }
    }
    const set = (k, v) => {
      const re = new RegExp(`^;?\\s*${k}\\s*=.*$`, 'm');
      text = re.test(text) ? text.replace(re, `${k} = ${v}`) : text.replace('[PHP]', `[PHP]\n${k} = ${v}`);
    };
    set('memory_limit', '512M');
    set('upload_max_filesize', '128M');
    set('post_max_size', '128M');
    set('max_execution_time', '300');
    fs.writeFileSync(ini, `; Do EzPanel tạo từ ${src ? path.basename(src) : 'cấu hình tối thiểu'}\n${text}`);
  }

  // Thư mục .ini bổ sung của EzPanel (ví dụ cấu hình gửi email vào Mailpit), giữ thư mục người dùng đã đặt nếu có
  // Mục rỗng ở đầu = PHP vẫn quét thư mục .ini mặc định của nó (nơi Linux/macOS nạp extension)
  const scanDir = env => ['', config.paths.phpIni, env.PHP_INI_SCAN_DIR].filter(x => x !== undefined && x !== null).join(path.delimiter);

  // ---------- Tiến trình php-cgi ----------
  const procs = new Map(); // folder -> { child, port, restarts, lastError, stopping, timer }

  // Cổng đầu của dải dành cho một phiên bản PHP
  function blockFor(folder) {
    if (!state.blocks[folder]) {
      const used = new Set(Object.values(state.blocks));
      let p = Number(L.phpBasePort) || 9100;
      const clash = b => used.has(b) || (config.port >= b && config.port < b + BLOCK) || (config.sitesPort >= b && config.sitesPort < b + BLOCK);
      while (clash(p)) p += BLOCK;
      state.blocks[folder] = p;
      saveState();
    }
    return state.blocks[folder];
  }
  const portFor = blockFor; // giữ tên cũ cho các chỗ đang dùng
  const workerKey = (folder, i) => `${folder}#${i}`;
  const balancerName = folder => `lp-php-${folder.replace(/[^A-Za-z0-9]/g, '_')}`;

  function startWorker(folder, i) {
    const key = workerKey(folder, i);
    const cur = procs.get(key);
    if (cur && (cur.child || cur.timer)) return;
    const rec = cur || { restarts: 0, lastError: null, folder, i };
    rec.stopping = false;
    rec.port = blockFor(folder) + i;
    procs.set(key, rec);
    try { ensurePhpIni(folder); } catch (e) { rec.lastError = `Không tạo được php.ini: ${e.message}`; }

    const started = Date.now();
    const child = spawn(path.join(phpDir(folder), `php-cgi${EXE}`), ['-b', `127.0.0.1:${rec.port}`], {
      cwd: phpDir(folder),
      // PHP_FCGI_MAX_REQUESTS=0: không tự thoát sau 500 request; PHPRC: dùng php.ini của đúng phiên bản
      env: { ...process.env, PHP_FCGI_MAX_REQUESTS: '0', PHP_FCGI_CHILDREN: '0', PHPRC: phpDir(folder), PHP_INI_SCAN_DIR: scanDir(process.env) },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    rec.child = child;
    let errText = '';
    child.stderr.on('data', d => {
      errText = (errText + d).slice(-2000);
      try {
        fs.mkdirSync(config.paths.logs, { recursive: true });
        fs.appendFileSync(path.join(config.paths.logs, 'php-cgi.log'), String(d).split(/\r?\n/).filter(Boolean).map(l => `[${new Date().toISOString()}] [PHP ${versionOf(folder)}] ${l}`).join('\n') + '\n');
      } catch { /* bỏ qua */ }
    });
    child.on('error', e => { rec.lastError = e.message; });
    child.on('spawn', () => { state.pids[key] = child.pid; saveState(); });
    child.on('exit', code => {
      rec.child = null;
      delete state.pids[key];
      saveState();
      if (rec.stopping) return;
      if (errText.trim()) rec.lastError = errText.trim().split(/\r?\n/).slice(-3).join(' ');
      else if (!rec.lastError) rec.lastError = `php-cgi đã thoát (mã ${code}).`;
      // Tự khởi động lại, chờ lâu dần nếu bị lỗi liên tục
      rec.restarts = Date.now() - started < 5000 ? rec.restarts + 1 : 0;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(rec.restarts, 5));
      rec.timer = setTimeout(() => { rec.timer = null; startWorker(folder, i); }, delay);
    });
    // Chạy ổn định 5 giây thì xóa lỗi cũ
    setTimeout(() => { if (rec.child === child) { rec.lastError = null; rec.restarts = 0; } }, 5000);
  }

  function stopKey(key) {
    const rec = procs.get(key);
    if (!rec) return;
    rec.stopping = true;
    clearTimeout(rec.timer);
    rec.timer = null;
    if (rec.child) rec.child.kill();
    procs.delete(key);
  }
  const keysOf = folder => [...procs.keys()].filter(k => k.startsWith(`${folder}#`));

  function startFcgi(folder) {
    const n = workerCount();
    for (let i = 0; i < n; i++) startWorker(folder, i);
    for (const k of keysOf(folder)) if (Number(k.split('#').pop()) >= n) stopKey(k);
  }
  function stopFcgi(folder) {
    for (const k of keysOf(folder)) stopKey(k);
  }
  const fcgiStatus = folder => {
    const recs = keysOf(folder).map(k => procs.get(k));
    return {
      running: recs.filter(r => r.child).length,
      total: recs.length,
      restarting: recs.some(r => r.timer),
      error: recs.map(r => r.lastError).find(Boolean) || null,
    };
  };
  const standalone = () => config.mode === 'standalone';
  // Chế độ độc lập: PHP mặc định cũng chạy qua nhóm php-cgi (không có mod_php)
  const usedVersions = () => [...new Set([...(standalone() && defaultPhp() ? [defaultPhp()] : []),
    ...Object.values(state.projects).map(p => p.php)].filter(f => f && exists(phpDir(f))))];

  // Chỉ chạy php-cgi cho những phiên bản đang có dự án dùng
  function syncFcgi() {
    const needed = new Set(usedVersions());
    for (const f of needed) startFcgi(f);
    for (const k of [...procs.keys()]) if (!needed.has(k.split('#')[0])) stopKey(k);
  }

  function stopAll() {
    for (const k of [...procs.keys()]) stopKey(k);
  }

  // ---------- Cấu hình Apache ----------
  const stripBlock = text => text.replace(new RegExp(`\\s*${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`, 'g'), '\n');
  // GENERIC: gửi đường dẫn tệp thật cho php-cgi (kiểu FPM mặc định gửi kèm "proxy:fcgi://", php-cgi không hiểu)
  // Dấu "/" sau tên nhóm: Apache ghép đường dẫn tệp vào sau handler; trên Windows đường dẫn bắt đầu bằng ổ đĩa (D:/…)
  // nên thiếu "/" thì tên nhóm bị dính chữ ổ đĩa và không tìm thấy (AH01144). ProxyFCGISetEnvIf bỏ "/" thừa trước
  // ổ đĩa (/D:/… → D:/…) hoặc "//" (Linux) trong đường dẫn gửi cho php-cgi.
  const phpHandler = (folder, pad = '') => [
    `${pad}<FilesMatch "\\.php$">`,
    `${pad}    SetHandler "proxy:balancer://${balancerName(folder)}/"`,
    `${pad}    ProxyFCGISetEnvIf "reqenv('SCRIPT_FILENAME') =~ m#^/+([A-Za-z]:/.*)$#" SCRIPT_FILENAME "$1"`,
    `${pad}    ProxyFCGISetEnvIf "reqenv('SCRIPT_FILENAME') =~ m#^//+(.*)$#" SCRIPT_FILENAME "/$1"`,
    `${pad}    ProxyFCGISetEnvIf "reqenv('PATH_TRANSLATED') =~ m#^/+([A-Za-z]:/.*)$#" PATH_TRANSLATED "$1"`,
    `${pad}</FilesMatch>`,
  ].join('\n') + '\n';
  const fcgiBlock = folder => `    ${MARK_BEGIN}\n    ProxyFCGIBackendType GENERIC\n${phpHandler(folder, '    ')}    ${MARK_END}\n`;
  const BALANCER_FILE = '00-localpanel-php.conf';
  // Mỗi phiên bản PHP đang dùng = một nhóm tiến trình php-cgi, Apache chia đều request
  const balancerConf = () => `# Do EzPanel tạo: nhóm tiến trình php-cgi cho từng phiên bản PHP (${workerCount()} tiến trình mỗi bản)\n` +
    usedVersions().map(f => `<Proxy "balancer://${balancerName(f)}">\n` +
      Array.from({ length: workerCount() }, (_, i) => `    BalancerMember "fcgi://127.0.0.1:${blockFor(f) + i}" retry=1 timeout=600\n`).join('') +
      '    ProxySet lbmethod=byrequests\n</Proxy>\n').join('') +
    // Chế độ độc lập: mọi dự án mặc định chạy PHP mặc định qua FastCGI (dự án có PHP riêng sẽ ghi đè trong vhost)
    (standalone() && defaultPhp() ? `ProxyFCGIBackendType GENERIC\n${phpHandler(defaultPhp())}` : '');
  const webRoot = name => (exists(path.join(projectDir(name), 'public', 'index.php')) ? path.join(projectDir(name), 'public') : projectDir(name));
  const defaultVhost = name => `define ROOT "${fwd(webRoot(name))}"
define SITE "${domainOf(name)}"

<VirtualHost *:${L.httpPort}>
    DocumentRoot "\${ROOT}"
    ServerName \${SITE}
    ServerAlias *.\${SITE}
    <Directory "\${ROOT}">
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
`;
  // Dựng tệp cấu hình của dự án từ bản gốc + các tùy chọn (PHP riêng, HTTPS)
  const VHOST = /<VirtualHost\s+([^>]*)>[\s\S]*?<\/VirtualHost>/gi;
  function renderConf(name, entry) {
    const base = entry.original?.content || defaultVhost(name);
    let text = stripBlock(base.replace(`${HEADER}\n`, '')).replace(/^# (PHP|Tùy chọn) .*\n/gm, '').replace(/^\n+/, '');
    if (!/<\/VirtualHost>/i.test(text)) throw httpError(400, 'Tệp virtual host của dự án không có khối <VirtualHost>.');
    if (entry.https) {
      // Bỏ khối :443 có sẵn (của Laragon), thay bằng khối :443 dùng chứng chỉ của EzPanel
      text = text.replace(VHOST, (block, args) => (/:443\b/.test(args) ? '' : block));
      const http = (text.match(VHOST) || [])[0];
      if (!http) throw httpError(400, 'Không tìm thấy khối <VirtualHost> cổng 80 trong cấu hình của dự án.');
      const cert = certs.siteCert(domainOf(name));
      const ssl = http
        .replace(/<VirtualHost\s+[^>]*>/i, '<VirtualHost *:443>')
        .replace(/^([ \t]*)<\/VirtualHost>/im, `    SSLEngine on\n    SSLCertificateFile "${fwd(cert.crt)}"\n    SSLCertificateKeyFile "${fwd(cert.key)}"\n$1</VirtualHost>`);
      text = `${text.trimEnd()}\n\n${ssl}\n`;
    }
    if (entry.lan) {
      // Cổng riêng cho điện thoại/máy khác trong mạng Wi-Fi (http, theo địa chỉ IP)
      const http = text.match(VHOST).find(b => !/:443\b/.test(b.split('>')[0]));
      const lanBlock = http.replace(/<VirtualHost\s+[^>]*>/i, `<VirtualHost *:${entry.lan}>`);
      text = `Listen ${entry.lan}\n${text.trimEnd()}\n\n# Xem qua Wi-Fi\n${lanBlock}\n`;
    }
    if (entry.php) text = text.replace(/^([ \t]*)<\/VirtualHost>/gim, (m, indent) => `${fcgiBlock(entry.php)}${indent}</VirtualHost>`);
    const opts = [entry.php && `PHP ${versionOf(entry.php)} (${entry.php}) qua nhóm php-cgi`, entry.https && 'HTTPS', entry.lan && `Wi-Fi cổng ${entry.lan}`].filter(Boolean);
    return `${HEADER}\n# Tùy chọn: ${opts.join(' · ')}\n${text}`;
  }
  const modulesConf = `# Do EzPanel tạo: nạp module để chạy PHP riêng cho từng dự án qua php-cgi
<IfModule !proxy_module>
    LoadModule proxy_module modules/mod_proxy.so
</IfModule>
<IfModule !proxy_fcgi_module>
    LoadModule proxy_fcgi_module modules/mod_proxy_fcgi.so
</IfModule>
<IfModule !slotmem_shm_module>
    LoadModule slotmem_shm_module modules/mod_slotmem_shm.so
</IfModule>
<IfModule !proxy_balancer_module>
    LoadModule proxy_balancer_module modules/mod_proxy_balancer.so
</IfModule>
<IfModule !lbmethod_byrequests_module>
    LoadModule lbmethod_byrequests_module modules/mod_lbmethod_byrequests.so
</IfModule>
`;

  const SSL_FILE = '00-localpanel-ssl.conf';
  const sslConf = listen => `# Do EzPanel tạo: bật HTTPS cho các dự án .test
<IfModule !ssl_module>
    LoadModule ssl_module modules/mod_ssl.so
</IfModule>
<IfModule !socache_shmcb_module>
    LoadModule socache_shmcb_module modules/mod_socache_shmcb.so
</IfModule>
${listen ? 'Listen 443\n' : ''}`;

  function testApache() {
    const a = apache();
    if (!a) return Promise.resolve({ ok: true, skipped: true });
    return new Promise(resolve => {
      execFile(a.httpd, ['-t', '-d', a.dir, '-f', 'conf/httpd.conf'], { cwd: a.dir, windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        resolve({ ok: !err && /Syntax OK/i.test(out), out });
      });
    });
  }

  // Ghi nhiều tệp cùng lúc, kiểm tra Apache, lỗi thì trả lại như cũ
  async function applyFiles(changes) {
    const backup = changes.map(c => ({ file: c.file, content: exists(c.file) ? fs.readFileSync(c.file, 'utf8') : null }));
    const restore = () => backup.forEach(b => b.content === null ? fs.rmSync(b.file, { force: true }) : fs.writeFileSync(b.file, b.content));
    try {
      fs.mkdirSync(P.sitesEnabled(), { recursive: true });
      for (const c of changes) c.content === null ? fs.rmSync(c.file, { force: true }) : fs.writeFileSync(c.file, c.content);
    } catch (e) {
      restore();
      throw httpError(500, `Không ghi được cấu hình Apache: ${e.message}`);
    }
    const t = await testApache();
    if (!t.ok) {
      restore();
      throw httpError(400, `Apache báo lỗi cấu hình nên EzPanel đã hoàn tác. Chi tiết: ${t.out.split(/\r?\n/).slice(-4).join(' ')}`);
    }
    return t;
  }

  const locks = new Set();
  // Đặt tùy chọn cho dự án: { php: thư mục PHP | null, https: true/false }; trường không truyền thì giữ nguyên
  async function applyProject(name, changes) {
    checkProject(name);
    const prev = state.projects[name];
    const next = {
      php: changes.php !== undefined ? (changes.php || null) : (prev?.php || null),
      https: changes.https !== undefined ? !!changes.https : !!prev?.https,
      lan: changes.lan !== undefined ? (changes.lan ? (prev?.lan || await freeLanPort()) : null) : (prev?.lan || null),
    };
    if (next.php && !phpVersions().includes(next.php)) throw httpError(400, 'Không tìm thấy phiên bản PHP này trong Laragon.');
    if (locks.has(name)) throw httpError(409, 'Dự án đang được cấu hình, thử lại sau giây lát.');
    locks.add(name);
    try {
      let tested;
      if (next.php || next.https || next.lan) {
        // Lần đầu: lưu lại cấu hình gốc để có thể trả về như cũ
        let original = prev?.original;
        if (!prev) {
          if (exists(ownConf(name))) original = { file: 'own', content: fs.readFileSync(ownConf(name), 'utf8') };
          else if (exists(autoConf(name))) original = { file: 'auto', content: fs.readFileSync(autoConf(name), 'utf8') };
          else original = null;
        }
        const entry = { ...next, original };
        const before = state.projects[name];
        state.projects[name] = entry; // để nhóm tiến trình gồm cả phiên bản mới
        const balancer = balancerConf();
        if (before) state.projects[name] = before; else delete state.projects[name];
        const files = [
          { file: path.join(P.sitesEnabled(), MODULES_FILE), content: modulesConf },
          { file: path.join(P.sitesEnabled(), BALANCER_FILE), content: balancer },
          { file: ownConf(name), content: renderConf(name, entry) },
          { file: autoConf(name), content: null },
        ];
        if (next.https) {
          // Thử thêm "Listen 443"; nếu Apache báo đã có (Laragon đã bật SSL) thì bỏ dòng đó
          const sslPath = path.join(P.sitesEnabled(), SSL_FILE);
          const hadSsl = exists(sslPath) ? fs.readFileSync(sslPath, 'utf8') : null;
          try {
            tested = await applyFiles([{ file: sslPath, content: hadSsl ?? sslConf(true) }, ...files]);
          } catch (e) {
            if (!/multiple Listeners|Listen/i.test(e.message)) throw e;
            tested = await applyFiles([{ file: sslPath, content: sslConf(false) }, ...files]);
          }
        } else {
          tested = await applyFiles(files);
        }
        state.projects[name] = entry;
      } else if (prev) {
        const o = prev.original;
        tested = await applyFiles([
          { file: ownConf(name), content: o?.file === 'own' ? o.content : null },
          ...(o?.file === 'auto' ? [{ file: autoConf(name), content: o.content }] : []),
        ]);
        delete state.projects[name];
      }
      saveState();
      syncFcgi();
      try { writeDevInfo(name); } catch { /* bỏ qua */ }
      return { apacheChecked: tested ? !tested.skipped : false };
    } finally {
      locks.delete(name);
    }
  }
  const setPhp = (name, folder) => applyProject(name, { php: folder || null });

  // ---------- Thông tin cho công cụ dev (BrowserSync, Vite…) ----------
  // <dự án>/.tpanel.json: địa chỉ site hiện tại + chứng chỉ "localhost" do EzPanel cấp (trình duyệt tin được),
  // để script dev đọc từ bất kỳ terminal nào (kể cả VS Code). Chỉ ghi cho dự án có _dev/ hoặc đã có tệp này.
  function writeDevInfo(name, force = false) {
    const dir = projectDir(name);
    const file = path.join(dir, '.tpanel.json');
    if (!exists(dir) || (!force && !exists(file) && !exists(path.join(dir, '_dev')))) return false;
    const url = urlOf(name);
    let localhost = null;
    try { const c = certs.siteCert('localhost'); localhost = { cert: fwd(c.crt), key: fwd(c.key) }; } catch { /* bỏ qua */ }
    fs.writeFileSync(file, JSON.stringify({
      note: 'Do EzPanel tạo cho công cụ dev (BrowserSync…): địa chỉ site và chứng chỉ HTTPS cho localhost. Không upload lên server.',
      url, domain: domainOf(name), https: httpsFor(name), localhostCert: localhost, ca: fwd(certs.caPath),
    }, null, 2) + '\n');
    // Giữ wpUrl trong _dev/site.config.mjs khớp địa chỉ hiện tại (http/https)
    const sc = path.join(dir, '_dev', 'site.config.mjs');
    if (exists(sc)) {
      const text = fs.readFileSync(sc, 'utf8');
      const next = text.replace(/(wpUrl\s*:\s*['"])[^'"]*(['"])/, `$1${url}$2`);
      if (next !== text) fs.writeFileSync(sc, next);
    }
    return true;
  }

  // ---------- Tên miền cho dự án mới (việc nút Reload của Laragon vẫn làm) ----------
  const NEW_HEADER = '# Tệp này do LocalPanel tạo cho dự án mới (giống tệp auto.* của Laragon).';
  const hasVhost = name => exists(autoConf(name)) || exists(ownConf(name));
  const hostsPath = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  const inHosts = (text, domain) => new RegExp(`^\\s*127\\.0\\.0\\.1\\s+(?:[^#\\n]*\\s)?${domain.replace(/\./g, '\\.')}(\\s|$)`, 'mi').test(text);

  // Thêm tên miền vào tệp hosts; không có quyền thì hỏi quyền admin (hộp thoại UAC) một lần cho cả danh sách
  async function ensureHosts(domains) {
    if (!isWin) return { skipped: true };
    const file = hostsPath();
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* tạo mới */ }
    const missing = domains.filter(d => /^[a-z0-9.-]+$/.test(d) && !inHosts(text, d));
    if (!missing.length) return { added: [] };
    const lines = missing.map(d => `127.0.0.1\t${d}\t#LocalPanel`).join('\r\n') + '\r\n';
    const prefix = text && !text.endsWith('\n') ? '\r\n' : '';
    try {
      fs.appendFileSync(file, prefix + lines);
      return { added: missing };
    } catch (e) {
      if (!['EPERM', 'EACCES'].includes(e.code)) throw e;
    }
    const script = path.join(config.paths.tools, `hosts-${crypto.randomBytes(4).toString('hex')}.ps1`);
    fs.mkdirSync(config.paths.tools, { recursive: true });
    fs.writeFileSync(script, [
      "$h = Join-Path $env:SystemRoot 'System32\\drivers\\etc\\hosts'",
      '$raw = if (Test-Path $h) { [IO.File]::ReadAllText($h) } else { "" }',
      '$nl = if ($raw.Length -gt 0 -and -not $raw.EndsWith("`n")) { "`r`n" } else { "" }',
      `[IO.File]::AppendAllText($h, $nl + "${missing.map(d => `127.0.0.1\`t${d}\`t#LocalPanel`).join('`r`n')}\`r\`n")`,
    ].join('\r\n'));
    try {
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${script}"'`],
        { windowsHide: true, timeout: 120000 }, err => (err ? reject(err) : resolve()));
      });
    } catch {
      throw httpError(403, `Chưa thêm được ${missing.join(', ')} vào tệp hosts vì quyền admin bị từ chối. Bấm "Tạo tên miền" ở mục Laragon để thử lại.`);
    } finally {
      fs.rmSync(script, { force: true });
    }
    const after = fs.readFileSync(file, 'utf8');
    const still = missing.filter(d => !inHosts(after, d));
    if (still.length) throw httpError(500, `Chưa thêm được ${still.join(', ')} vào tệp hosts.`);
    return { added: missing };
  }

  // Bảo đảm dự án có virtual host và tên miền, giống khi bấm Reload trong Laragon
  async function ensureDomain(name) {
    checkProject(name);
    let created = false;
    if (!hasVhost(name)) {
      await applyFiles([{ file: ownConf(name), content: `${NEW_HEADER}\n${defaultVhost(name)}` }]);
      created = true;
    }
    const hosts = await ensureHosts([domainOf(name)]);
    return { vhostCreated: created, hostsAdded: hosts.added?.length > 0 };
  }

  // Viết lại cấu hình của mọi dự án đang quản lý (khi nâng cấp EzPanel hoặc đổi số tiến trình)
  async function refreshConfs() {
    if (!detected()) return false;
    const changes = [
      { file: path.join(P.sitesEnabled(), MODULES_FILE), content: modulesConf },
      { file: path.join(P.sitesEnabled(), BALANCER_FILE), content: usedVersions().length ? balancerConf() : null },
    ];
    for (const [name, entry] of Object.entries(state.projects)) {
      if (!exists(projectDir(name))) continue;
      try { changes.push({ file: ownConf(name), content: renderConf(name, entry) }); } catch { /* bỏ qua dự án lỗi */ }
    }
    // Tệp do EzPanel tạo nhưng chứng chỉ không còn (EzPanel bị chuyển chỗ, cài lại…): cấp lại chứng chỉ
    try {
      for (const f of fs.readdirSync(P.sitesEnabled())) {
        const file = path.join(P.sitesEnabled(), f);
        if (!f.endsWith('.conf') || changes.some(c => c.file === file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes(HEADER) && !text.includes(NEW_HEADER)) continue;
        const missing = [...text.matchAll(/SSLCertificate(?:Key)?File\s+"([^"]+)"/g)].some(m => !exists(m[1]));
        const site = (/define\s+SITE\s+"([^"]+)"/i.exec(text) || /ServerName\s+(\S+)/i.exec(text) || [])[1];
        if (!missing || !site || !/^[a-z0-9.-]+$/.test(site)) continue;
        const cert = certs.siteCert(site);
        changes.push({ file, content: text
          .replace(/SSLCertificateFile\s+"[^"]+"/g, `SSLCertificateFile "${fwd(cert.crt)}"`)
          .replace(/SSLCertificateKeyFile\s+"[^"]+"/g, `SSLCertificateKeyFile "${fwd(cert.key)}"`) });
      }
    } catch { /* bỏ qua */ }
    const changed = changes.filter(c => (exists(c.file) ? fs.readFileSync(c.file, 'utf8') : null) !== c.content);
    if (!changed.length) return false;
    await applyFiles(changed);
    return true;
  }

  async function setWorkers(n) {
    L.phpWorkers = Math.min(16, Math.max(1, Number(n) || 4));
    config.save();
    syncFcgi(); // thêm/bớt tiến trình
    const changed = await refreshConfs();
    return { workers: L.phpWorkers, ...(changed ? await afterApacheChange() : {}) };
  }

  // ---------- Xem qua Wi-Fi ----------
  const portBusy = port => new Promise(resolve => {
    const srv = require('net').createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '0.0.0.0');
  });
  async function freeLanPort() {
    const used = new Set(Object.values(state.projects).map(p => p.lan).filter(Boolean));
    for (let p = Number(L.lanBasePort) || 8100; p < (Number(L.lanBasePort) || 8100) + 200; p++) {
      if (used.has(p) || p === config.port || p === config.sitesPort) continue;
      if (!(await portBusy(p))) return p;
    }
    throw httpError(409, 'Không còn cổng trống cho chế độ xem qua Wi-Fi.');
  }
  // Địa chỉ IPv4 trong mạng nội bộ (ưu tiên 192.168.x, 10.x, 172.16–31.x)
  function lanAddresses() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.internal || a.address.startsWith('169.254.')) continue;
        const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
        const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|br-|veth/i.test(name);
        out.push({ address: a.address, name, score: (priv ? 2 : 0) + (virtual ? -3 : 0) });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }
  function lanInfo(name) {
    const port = state.projects[name]?.lan || null;
    if (!port) return { port: null };
    const ips = lanAddresses();
    const urls = ips.map(i => ({ url: `http://${i.address}:${port}/`, iface: i.name }));
    let qr = null;
    if (urls[0]) {
      try {
        const q = require('qrcode-generator')(0, 'M');
        q.addData(urls[0].url);
        q.make();
        qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      } catch { /* bỏ qua */ }
    }
    return { port, urls, qr };
  }

  // Chạy lệnh với quyền admin (Windows hỏi xác nhận UAC)
  async function runElevated(lines) {
    const script = path.join(config.paths.tools, `admin-${crypto.randomBytes(4).toString('hex')}.ps1`);
    fs.mkdirSync(config.paths.tools, { recursive: true });
    fs.writeFileSync(script, lines.join('\r\n'));
    try {
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${script}"'`],
        { windowsHide: true, timeout: 120000 }, err => (err ? reject(err) : resolve()));
      });
    } finally {
      fs.rmSync(script, { force: true });
    }
  }
  const fwRule = port => `LocalPanel Wi-Fi ${port}`;
  function firewallOpen(port) {
    if (!isWin) return Promise.resolve(true);
    return new Promise(resolve => {
      execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${fwRule(port)}`], { windowsHide: true }, err => resolve(!err));
    });
  }
  async function openFirewall(port) {
    if (!isWin) return;
    try {
      await runElevated([`netsh advfirewall firewall add rule name="${fwRule(port)}" dir=in action=allow protocol=TCP localport=${port} profile=private`]);
    } catch {
      throw httpError(403, 'Chưa mở được tường lửa vì quyền admin bị từ chối.');
    }
    if (!(await firewallOpen(port))) throw httpError(500, 'Chưa thêm được quy tắc tường lửa.');
  }

  // Bỏ quản lý một dự án đã bị xóa
  function forget(name) {
    const own = exists(ownConf(name)) ? fs.readFileSync(ownConf(name), 'utf8') : '';
    if (own.includes(NEW_HEADER)) fs.rmSync(ownConf(name), { force: true });
    if (!state.projects[name]) return;
    fs.rmSync(ownConf(name), { force: true });
    delete state.projects[name];
    saveState();
    syncFcgi();
  }

  // Kiểm tra thực tế: đặt một tệp PHP tạm vào thư mục web của dự án, gọi qua Apache, đọc phiên bản trả về
  function docRoot(name) {
    const file = [ownConf(name), autoConf(name)].find(exists);
    if (file) {
      const t = fs.readFileSync(file, 'utf8');
      const m = /define\s+ROOT\s+"([^"]+)"/i.exec(t) || /DocumentRoot\s+"([^"$]+)"/i.exec(t);
      if (m) return path.resolve(m[1]);
    }
    const pub = path.join(projectDir(name), 'public');
    return exists(path.join(pub, 'index.php')) ? pub : projectDir(name);
  }
  async function checkLive(name) {
    checkProject(name);
    const dir = docRoot(name);
    const file = `.lp-check-${crypto.randomBytes(6).toString('hex')}.php`;
    fs.writeFileSync(path.join(dir, file), '<?php echo "LPVER:" . PHP_VERSION . ":" . PHP_SAPI;');
    try {
      const body = await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: L.httpPort, path: `/${file}`, headers: { Host: domainOf(name) }, timeout: 8000, agent: false }, res => {
          let b = '';
          res.on('data', d => { b += d; });
          res.on('end', () => resolve({ status: res.statusCode, body: b }));
        });
        req.on('timeout', () => req.destroy(new Error('Apache không phản hồi trong 8 giây.')));
        req.on('error', reject);
      });
      const m = /LPVER:([^:]+):(\S+)/.exec(body.body);
      if (!m) {
        const hint = body.status === 503 || body.status === 502
          ? 'Apache không gọi được php-cgi. Hãy Reload Apache trong Laragon.'
          : `Apache trả về mã ${body.status}. Có thể bạn chưa Reload Apache sau khi đổi PHP.`;
        return { ok: false, message: hint };
      }
      return { ok: true, version: m[1], sapi: m[2] };
    } catch (e) {
      return { ok: false, message: e.code === 'ECONNREFUSED' ? 'Apache chưa chạy. Bấm Start All trong Laragon.' : e.message };
    } finally {
      fs.rmSync(path.join(dir, file), { force: true });
    }
  }


  // ---------- Tải thêm phiên bản PHP từ downloads.php.net ----------
  // Chỉ lấy bản Thread Safe x64 (đúng loại Laragon dùng cho Apache; php-cgi cũng chạy được)
  const PHP_ZIP = /href="(?:[^"]*\/)?(php-(\d+\.\d+\.\d+)-Win32-(v[cs]\d+)-x64\.zip)"/gi;
  let catalogCache = null;
  async function phpCatalog(force = false) {
    if (!force && catalogCache && Date.now() - catalogCache.at < 3600e3) return catalogCache.list;
    const found = new Map();
    for (const dir of ['', 'archives/']) {
      let html;
      try { html = await fetchText(PHP_MIRROR + dir); } catch (e) {
        if (dir === '') throw httpError(502, `Không tải được danh sách PHP (${e.message}). Kiểm tra kết nối Internet.`);
        continue;
      }
      for (const m of html.matchAll(PHP_ZIP)) {
        const [, file, version, build] = m;
        const [maj, min] = version.split('.').map(Number);
        if (maj < 5 || (maj === 5 && min < 6)) continue; // bản x64 dùng được từ 5.6
        if (!found.has(version)) found.set(version, { version, build: build.toLowerCase(), file, url: PHP_MIRROR + dir + file });
      }
    }
    const list = [...found.values()].sort((a, b) => cmpVer(b.version, a.version));
    catalogCache = { at: Date.now(), list };
    return list;
  }
  // Bản PHP mới cần Visual C++ 2015–2022, PHP 5.6 (VC11) cần Visual C++ 2012
  const vcHint = build => /^vc11$/i.test(build)
    ? 'Visual C++ 2012 Redistributable (x64): https://www.microsoft.com/download/details.aspx?id=30679'
    : 'Visual C++ 2015–2022 Redistributable (x64): https://aka.ms/vs/17/release/vc_redist.x64.exe';

  function runPhpVersion(folder) {
    return new Promise(resolve => {
      execFile(phpCli(folder), ['-v'], { cwd: phpDir(folder), env: { ...process.env, PHPRC: phpDir(folder) }, windowsHide: true, timeout: 15000 },
        (err, stdout) => resolve({ ok: !err && /^PHP \d/.test(stdout), code: err?.code, out: (stdout || '').split(/\r?\n/)[0] }));
    });
  }

  const installing = new Set();
  // log(dòng), onProgress(đã tải, tổng): để trình hướng dẫn / tác vụ nền hiện tiến độ
  async function installPhp(file, { log = () => {}, onProgress } = {}) {
    const item = (await phpCatalog()).find(x => x.file === file);
    if (!item) throw httpError(400, 'Không tìm thấy phiên bản PHP này trên downloads.php.net.');
    const folder = file.replace(/\.zip$/i, '');
    const dest = phpDir(folder);
    if (exists(dest)) throw httpError(409, `PHP ${item.version} đã có trong Laragon.`);
    if (installing.has(folder)) throw httpError(409, `PHP ${item.version} đang được tải.`);
    installing.add(folder);
    const zip = path.join(config.paths.tools, `${folder}.zip`);
    const tmp = path.join(P.php(), `.lp-${folder}`);
    try {
      fs.mkdirSync(config.paths.tools, { recursive: true });
      await download(item.url, zip, { onProgress, onRetry: (n, e) => log(`  lỗi tải (${e.message}), thử lại lần ${n + 1}…`) })
        .catch(e => { throw httpError(502, `Tải PHP thất bại: ${e.message}. Kiểm tra kết nối Internet rồi thử lại.`); });
      log(`  đã tải ${Math.round(fs.statSync(zip).size / 1048576)} MB, đang giải nén…`);
      fs.rmSync(tmp, { recursive: true, force: true });
      await extractZip(zip, { dir: tmp, log, preferTar: true });
      log('  đang kiểm tra PHP chạy được không…');
      if (!exists(path.join(tmp, `php-cgi${EXE}`))) throw httpError(500, 'Gói PHP tải về không có php-cgi.');
      fs.renameSync(tmp, dest);
      ensurePhpIni(folder);
      const check = await runPhpVersion(folder);
      return {
        folder,
        version: item.version,
        works: check.ok,
        // 0xC0000135 / 0xC000007B: thiếu hoặc sai thư viện Visual C++
        warning: check.ok ? null : `PHP đã được giải nén nhưng chưa chạy được${check.code ? ` (mã ${check.code})` : ''}. Thường là do máy thiếu ${vcHint(item.build)}`,
      };
    } finally {
      installing.delete(folder);
      fs.rmSync(zip, { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---------- API ----------
  const r = express.Router();
  // Được server.js gắn vào: khởi động lại Apache khi cấu hình thay đổi
  const hooks = { apacheChanged: async () => false, httpsChanged: async () => null, lanChanged: async () => null };
  const afterApacheChange = async () => {
    try { return { reloaded: await hooks.apacheChanged() }; } catch (e) { return { reloaded: false, reloadError: e.message }; }
  };

  r.get('/', (req, res) => {
    if (!detected()) return res.json({ detected: false, root: fwd(P.root()), domainSuffix: L.domainSuffix });
    const list = projects();
    const def = defaultPhp();
    res.json({
      detected: true,
      root: fwd(P.root()),
      domainSuffix: L.domainSuffix,
      httpPort: L.httpPort,
      apache: apache()?.name || null,
      mysqlBin: mysqlBin() ? fwd(mysqlBin()) : null,
      defaultPhp: def,
      versions: phpVersions().map(f => {
        const st = fcgiStatus(f);
        return {
          id: f,
          version: versionOf(f),
          isDefault: f === def,
          port: state.blocks[f] || null,
          workers: st.total,
          workersRunning: st.running,
          running: st.running > 0,
          restarting: st.restarting,
          error: st.error,
          projects: list.filter(p => p.php === f).map(p => p.name),
        };
      }),
      projects: list,
      phpWorkers: workerCount(),
    });
  });

  r.post('/workers', wrap(async (req, res) => {
    res.json({ ok: true, ...(await setWorkers(req.body?.count)) });
  }));

  // Chuyển mọi dự án đang dùng bản PHP "from" sang "to" (sau khi cập nhật PHP hoặc khi quay lại bản cũ)
  async function repointPhp(from, to) {
    let n = 0;
    for (const entry of Object.values(state.projects)) if (entry.php === from) { entry.php = to; n++; }
    saveState();
    await refreshConfs();
    stopAll(); // khởi động lại các nhóm php-cgi theo bản mới
    syncFcgi();
    return n;
  }

  // Trỏ EzPanel sang một thư mục máy chủ khác (Laragon hoặc máy chủ độc lập) và nạp lại trạng thái của nó
  function switchRoot(root) {
    stopAll();
    L.root = fwd(path.resolve(root));
    config.save();
    state = loadState();
    certs.reset();
    syncFcgi();
  }

  // Đổi cổng Apache: viết lại virtual host do EzPanel tạo (dự án đang quản lý dựng lại từ bản gốc)
  async function changeHttpPort(port) {
    const old = Number(L.httpPort) || 80;
    L.httpPort = port;
    config.save();
    if (old === port || !detected()) return;
    const changes = [];
    try {
      for (const f of fs.readdirSync(P.sitesEnabled())) {
        const file = path.join(P.sitesEnabled(), f);
        if (!f.endsWith('.conf') || f.startsWith('auto.')) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes(NEW_HEADER) || Object.keys(state.projects).some(n => file === ownConf(n))) continue;
        changes.push({ file, content: text.replace(new RegExp(`<VirtualHost \\*:${old}>`, 'g'), `<VirtualHost *:${port}>`) });
      }
    } catch { /* bỏ qua */ }
    // Dự án đang quản lý: bản gốc là tệp của Laragon/EzPanel với cổng cũ
    for (const entry of Object.values(state.projects)) {
      if (entry.original?.content) entry.original.content = entry.original.content.replace(new RegExp(`<VirtualHost \\*:${old}>`, 'g'), `<VirtualHost *:${port}>`);
    }
    saveState();
    if (changes.length) await applyFiles(changes);
    await refreshConfs();
    for (const name of listDirs(P.www())) { try { writeDevInfo(name); } catch { /* bỏ qua */ } }
  }

  r.post('/config', wrap(async (req, res) => {
    const root = String(req.body?.root || '').trim();
    const suffix = String(req.body?.domainSuffix || '.test').trim();
    const port = Number(req.body?.httpPort) || 80;
    if (!root) throw httpError(400, 'Hãy nhập thư mục cài Laragon.');
    if (!/^\.[a-z0-9.-]+$/i.test(suffix)) throw httpError(400, 'Đuôi tên miền phải bắt đầu bằng dấu chấm, ví dụ .test');
    if (!exists(path.join(root, 'www')) || !exists(path.join(root, 'bin', 'php'))) {
      throw httpError(400, `Không thấy thư mục www và bin/php trong ${root}. Đây có phải thư mục cài Laragon không?`);
    }
    Object.assign(L, { domainSuffix: suffix, httpPort: port });
    switchRoot(root);
    res.json({ ok: true });
  }));

  r.post('/projects/:name/php', wrap(async (req, res) => {
    const php = req.body?.php || null;
    const out = await setPhp(req.params.name, php);
    res.json({ ok: true, ...out, ...(await afterApacheChange()) });
  }));

  r.post('/projects/:name/https', wrap(async (req, res) => {
    const on = !!req.body?.on;
    const out = await applyProject(req.params.name, { https: on });
    const warnings = [];
    try { const note = await hooks.httpsChanged(req.params.name, on); if (note) out.note = note; } catch (e) { warnings.push(e.message); }
    res.json({ ok: true, ...out, warnings, ...(await afterApacheChange()) });
  }));

  r.post('/projects/:name/lan', wrap(async (req, res) => {
    const name = checkProject(req.params.name);
    const on = !!req.body?.on;
    const out = await applyProject(name, { lan: on });
    const warnings = [];
    try { await hooks.lanChanged(name, state.projects[name]?.lan || null); } catch (e) { warnings.push(e.message); }
    res.json({ ok: true, ...out, warnings, ...(await afterApacheChange()), ...lanInfo(name),
      firewall: on ? await firewallOpen(state.projects[name]?.lan) : null });
  }));
  r.get('/projects/:name/lan', wrap(async (req, res) => {
    const name = checkProject(req.params.name);
    const info = lanInfo(name);
    res.json({ ...info, firewall: info.port ? await firewallOpen(info.port) : null, windows: isWin });
  }));
  r.post('/projects/:name/lan/firewall', wrap(async (req, res) => {
    const name = checkProject(req.params.name);
    const port = state.projects[name]?.lan;
    if (!port) throw httpError(400, 'Dự án chưa bật xem qua Wi-Fi.');
    await openFirewall(port);
    res.json({ ok: true });
  }));

  r.post('/projects/:name/domain', wrap(async (req, res) => {
    const out = await ensureDomain(req.params.name);
    res.json({ ok: true, ...out, ...(out.vhostCreated ? await afterApacheChange() : {}) });
  }));

  r.post('/projects/:name/check', wrap(async (req, res) => {
    res.json(await checkLive(req.params.name));
  }));

  r.get('/php-catalog', wrap(async (req, res) => {
    const list = await phpCatalog(req.query.refresh === '1');
    const installed = new Set(phpVersions().map(versionOf));
    res.json({ versions: list.map(x => ({ ...x, installed: installed.has(x.version) || installing.has(x.file.replace(/\.zip$/i, '')) })) });
  }));

  r.post('/php-install', wrap(async (req, res) => {
    if (!detected()) throw httpError(400, 'Chưa tìm thấy Laragon.');
    res.json({ ok: true, ...(await installPhp(String(req.body?.file || ''))) });
  }));

  r.post('/php/:id/restart', wrap(async (req, res) => {
    const id = req.params.id;
    if (!keysOf(id).length) throw httpError(400, 'Phiên bản PHP này chưa được dự án nào dùng.');
    stopFcgi(id);
    syncFcgi();
    res.json({ ok: true });
  }));

  return {
    router: r,
    applyFiles, scanDir, lanInfo, runElevated, autoConf, ownConf, hostsPath, inHosts,
    projectState: name => state.projects[name] || null,
    writeDevInfo,
    restartFcgi() { stopAll(); syncFcgi(); },
    apache, mysqlInfo, testApache, ensureDomain, ensureHosts, hooks, afterApacheChange, projects, applyProject, httpsFor,
    detected, P, phpVersions, defaultPhp, phpCli, phpDir, mysqlBin, ensurePhpIni,
    domainOf, projectDir, phpFor, setPhp, forget, checkProject, versionOf,
    urlOf,
    summary: () => ({ running: [...procs.values()].filter(p => p.child).length, total: procs.size }),
    refreshConfs, usedVersions, phpCatalog, installPhp, iniVersion, pick, standalone, switchRoot, changeHttpPort, repointPhp,
    start() {
      // Tắt các php-cgi còn sót lại từ lần chạy trước (nếu panel bị đóng đột ngột)
      for (const pid of Object.values(state.pids || {})) { try { process.kill(pid); } catch { /* đã tắt */ } }
      state.pids = {};
      saveState();
      if (detected()) {
        setTimeout(syncFcgi, 300);
        setTimeout(() => refreshConfs().then(ch => ch && afterApacheChange()).catch(e => console.warn(`  Cập nhật cấu hình Apache: ${e.message}`)), 1500);
      }
    },
    stopAll,
  };
};
