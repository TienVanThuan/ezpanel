// Chuyển từ Laragon sang máy chủ độc lập của Sitebench.
// Laragon được giữ nguyên: mã nguồn được CHÉP, database được XUẤT (mysqldump của Laragon) rồi NẠP vào MySQL của Sitebench.
// Giữ: bản PHP (kèm php.ini), PHP riêng / HTTPS / Wi-Fi của từng dự án, chứng chỉ gốc đã được Windows tin, thông tin site.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const mysql = require('mysql2/promise');
const { wrap, httpError } = require('./util');

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const fwd = p => p.split(path.sep).join('/');
const SYSTEM_DBS = ['mysql', 'information_schema', 'performance_schema', 'sys', '#innodb_redo', '#innodb_temp'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cmpVer = (a, b) => {
  const x = (/(\d+(?:\.\d+)*)/.exec(a) || [, '0'])[1].split('.').map(Number), y = (/(\d+(?:\.\d+)*)/.exec(b) || [, '0'])[1].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
// Tên thư mục database của MySQL mã hóa ký tự đặc biệt: "my@002dshop" = "my-shop"
const decodeDbDir = n => n.replace(/@([0-9a-f]{4})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
const portFree = port => new Promise(resolve => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});

module.exports = (config, { laragon, services, dbtools, wpTools, wpExtras, certs, jobs }) => {
  const r = express.Router();
  const D = dbtools, W = wpTools;

  // ---------- Đọc một bản Laragon (bất kỳ đường dẫn nào) ----------
  function source(rootIn) {
    const root = path.resolve(String(rootIn || ''));
    if (!isDir(path.join(root, 'www')) || !isDir(path.join(root, 'bin', 'php'))) throw httpError(404, `Không thấy Laragon tại ${root}.`);
    if (path.resolve(laragon.P.root()) === root) throw httpError(400, 'Đây là thư mục máy chủ hiện tại của Sitebench, không phải Laragon.');
    const iniText = (() => { try { return fs.readFileSync(path.join(root, 'usr', 'laragon.ini'), 'utf8'); } catch { return ''; } })();
    const ini = sec => {
      const m = new RegExp(`\\[${sec}\\]([\\s\\S]*?)(?:\\n\\[|$)`, 'i').exec(iniText);
      return m ? (/^\s*Version\s*=\s*(.+?)\s*$/mi.exec(m[1]) || [])[1] || null : null;
    };
    const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); } catch { return []; } };
    const phps = dirs(path.join(root, 'bin', 'php')).filter(f => exists(path.join(root, 'bin', 'php', f, `php-cgi${EXE}`)));
    const mysqlBase = path.join(root, 'bin', 'mysql');
    const mysqlDirs = dirs(mysqlBase).filter(f => ['mysqld', 'mariadbd'].some(n => exists(path.join(mysqlBase, f, 'bin', `${n}${EXE}`))));
    const myName = mysqlDirs.includes(ini('mysql')) ? ini('mysql') : mysqlDirs.sort(cmpVer).reverse()[0] || null;
    let my = null;
    if (myName) {
      const dir = path.join(mysqlBase, myName);
      const iniFile = ['my.ini', 'my.cnf'].map(f => path.join(dir, f)).find(exists) || null;
      const text = iniFile ? fs.readFileSync(iniFile, 'utf8') : '';
      let datadir = (/^\s*datadir\s*=\s*"?([^"\r\n]+?)"?\s*$/mi.exec(text) || [])[1] || null;
      if (!datadir) {
        // Laragon để dữ liệu trong <laragon>\data\mysql-8, data\mysql… (giống cách Sitebench bật MySQL của Laragon)
        const major = (/(\d+)\.\d+/.exec(myName) || [])[1];
        const kind = /mariadb/i.test(myName) ? 'mariadb' : 'mysql';
        datadir = [`${kind}-${major}`, kind, myName, 'mysql-8', 'mysql'].map(d => path.join(root, 'data', d)).find(isDir) || null;
      }
      const bin = path.join(dir, 'bin');
      my = { name: myName, dir, bin, iniFile, datadir: datadir ? path.resolve(datadir) : null,
        mysqld: ['mysqld', 'mariadbd'].map(n => path.join(bin, `${n}${EXE}`)).find(exists),
        mariadb: /mariadb/i.test(myName) };
    }
    const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(root, 'etc', 'localpanel', f), 'utf8')); } catch { return {}; } };
    return { root, defaultPhp: phps.includes(ini('php')) ? ini('php') : phps.sort(cmpVer).reverse()[0] || null, phps, my,
      state: readJson('state.json'), meta: readJson('sites-meta.json'), projects: dirs(path.join(root, 'www')) };
  }

  function databasesIn(datadir) {
    if (!datadir || !isDir(datadir)) return [];
    return fs.readdirSync(datadir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('#') && !SYSTEM_DBS.includes(e.name.toLowerCase()))
      .map(e => decodeDbDir(e.name))
      .filter(n => !SYSTEM_DBS.includes(n.toLowerCase()));
  }

  // ---------- Xem trước ----------
  async function scan(rootIn) {
    if (!laragon.standalone()) throw httpError(400, 'Chuyển từ Laragon dùng cho chế độ máy chủ độc lập của Sitebench.');
    const s = source(rootIn);
    const meta = s.meta;
    const projects = s.projects.map(name => {
      const dir = path.join(s.root, 'www', name);
      const st = s.state.projects?.[name] || {};
      const db = D.projectDb(dir, meta[name]);
      return {
        name, kind: D.kindOf(dir), db: db?.name || null,
        php: st.php ? laragon.versionOf(st.php) : null, https: !!st.https, lan: !!st.lan,
        exists: exists(laragon.projectDir(name)),
        nodeModules: [path.join(dir, 'node_modules'), path.join(dir, '_dev', 'node_modules')].some(isDir),
      };
    });
    let targetDbs = [];
    try { targetDbs = (await D.query('SHOW DATABASES')).map(x => x.Database); } catch { /* MySQL của Sitebench chưa chạy */ }
    const dbs = databasesIn(s.my?.datadir).map(name => ({ name, exists: targetDbs.includes(name), usedBy: projects.filter(p => p.db === name).map(p => p.name) }));
    return {
      root: fwd(s.root), mysql: s.my ? { name: s.my.name, datadir: s.my.datadir && fwd(s.my.datadir), mariadb: s.my.mariadb } : null,
      defaultPhp: s.defaultPhp ? laragon.versionOf(s.defaultPhp) : null,
      phps: s.phps.map(f => ({ folder: f, version: laragon.versionOf(f), inTpanel: laragon.phpVersions().includes(f) })),
      projects, databases: dbs, ca: exists(path.join(s.root, 'etc', 'localpanel', 'ssl', 'localpanel-ca.crt')),
      laragonRunning: (await laragonProcs(s.root)).length > 0,
    };
  }

  // ---------- Tiến trình của Laragon ----------
  function laragonProcs(root) {
    return new Promise(resolve => {
      const base = fwd(path.join(root, 'bin')).toLowerCase();
      if (isWin) {
        const ps = "Get-CimInstance Win32_Process -Filter \"Name='httpd.exe' or Name='mysqld.exe' or Name='mariadbd.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress";
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
          try {
            const j = JSON.parse(out || '[]');
            resolve((Array.isArray(j) ? j : [j]).filter(x => fwd(x.ExecutablePath || '').toLowerCase().startsWith(base)).map(x => x.ProcessId));
          } catch { resolve([]); }
        });
      } else {
        execFile('ps', ['-eo', 'pid=,args='], (err, out) => resolve(err ? [] : out.split('\n')
          .map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(m => m && m[2].toLowerCase().includes(base)).map(m => Number(m[1]))));
      }
    });
  }
  const kill = pid => new Promise(res => {
    if (isWin) execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, () => res());
    else { try { process.kill(pid, 'SIGTERM'); } catch { /* đã tắt */ } res(); }
  });

  // Bật tạm MySQL của Laragon ở cổng riêng (chỉ đọc dữ liệu ra), tắt êm khi xong
  async function startSourceMysql(s, password, ctx) {
    if (!s.my?.mysqld || !s.my.datadir) throw httpError(400, 'Không tìm thấy MySQL hoặc thư mục dữ liệu của Laragon.');
    let port = 3307;
    while (!(await portFree(port)) && port < 3399) port++;
    const args = [...(s.my.iniFile ? [`--defaults-file=${s.my.iniFile}`] : []), `--datadir=${s.my.datadir}`, `--port=${port}`, '--bind-address=127.0.0.1',
      ...(s.my.mariadb ? [] : ['--mysqlx=OFF']), ...(isWin ? [] : [`--socket=${path.join(config.paths.tools, `src-${port}.sock`)}`, `--pid-file=${path.join(config.paths.tools, `src-${port}.pid`)}`])];
    ctx.log(`  bật tạm MySQL của Laragon (${s.my.name}) ở cổng ${port}`);
    const child = spawn(s.my.mysqld, args, { cwd: s.my.dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err = (err + d).slice(-3000); });
    const conn = { host: '127.0.0.1', port, user: 'root', password: password || '' };
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) break;
      try { const c = await mysql.createConnection({ ...conn, connectTimeout: 1500 }); await c.end(); return { child, conn }; } catch (e) {
        if (/Access denied/i.test(e.message)) { child.kill(); throw httpError(400, 'Sai mật khẩu root của MySQL trong Laragon. Nhập mật khẩu (Laragon mặc định để trống).'); }
      }
      await sleep(1000);
    }
    child.kill();
    const line = err.split(/\r?\n/).filter(l => /error/i.test(l)).slice(-2).join(' ');
    throw httpError(500, `Không bật được MySQL của Laragon${line ? `: ${line}` : ''}. Hãy thoát hẳn Laragon rồi thử lại.`);
  }
  async function stopSourceMysql(src) {
    if (!src) return;
    try { const c = await mysql.createConnection({ ...src.conn, connectTimeout: 2000 }); await c.query('SHUTDOWN').catch(() => {}); c.destroy(); } catch { /* buộc tắt bên dưới */ }
    for (let i = 0; i < 30 && src.child.exitCode === null; i++) await sleep(500);
    if (src.child.exitCode === null) src.child.kill();
  }

  // Xuất database từ MySQL của Laragon bằng mysqldump của chính Laragon
  function dumpSource(s, src, db, file) {
    return new Promise((resolve, reject) => {
      const exe = ['mysqldump', 'mariadb-dump'].map(n => path.join(s.my.bin, `${n}${EXE}`)).find(exists);
      if (!exe) return reject(new Error('Không có mysqldump trong Laragon'));
      const out = fs.createWriteStream(file);
      const child = spawn(exe, ['-h', '127.0.0.1', '-P', String(src.conn.port), '-u', 'root', '--default-character-set=utf8mb4', '--single-transaction',
        '--quick', '--routines', '--triggers', '--add-drop-table', '--no-tablespaces', db], { env: { ...process.env, MYSQL_PWD: src.conn.password }, windowsHide: true });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.stdout.pipe(out);
      child.on('error', reject);
      child.on('close', code => out.on('close', () => (code === 0 ? resolve() : reject(new Error(err.split(/\r?\n/).filter(l => l && !/password/i.test(l)).slice(-1)[0] || `mã ${code}`)))));
    });
  }

  async function copyDir(src, dest, skipNodeModules, onFile) {
    await fsp.mkdir(dest, { recursive: true });
    for (const e of await fsp.readdir(src, { withFileTypes: true })) {
      if (e.name.startsWith('.lp-') || (skipNodeModules && e.name === 'node_modules')) continue;
      const a = path.join(src, e.name), b = path.join(dest, e.name);
      if (e.isDirectory()) await copyDir(a, b, skipNodeModules, onFile);
      else if (e.isFile()) { await fsp.copyFile(a, b); onFile?.(); }
      else if (e.isSymbolicLink()) { try { await fsp.symlink(await fsp.readlink(a), b); } catch { /* bỏ qua */ } }
    }
  }

  // ---------- Chuyển ----------
  async function migrate(ctx, o) {
    if (!laragon.standalone()) throw httpError(400, 'Chuyển từ Laragon dùng cho chế độ máy chủ độc lập của Sitebench.');
    const s = source(o.root);
    const pick = new Set(o.projects || s.projects);
    const pickDb = new Set(o.databases || databasesIn(s.my?.datadir));
    const notes = [];
    const done = { projects: [], databases: [], skipped: [] };
    const www = laragon.P.www();

    // 1) Tắt Apache/MySQL của Laragon nếu đang chạy (cùng cổng 80/3306 với Sitebench, và dữ liệu không được mở hai nơi)
    const running = await laragonProcs(s.root);
    if (running.length) {
      ctx.step('Tắt Apache và MySQL của Laragon');
      for (const pid of running) await kill(pid);
      await sleep(1500);
    }

    // 2) Bản PHP: chép từ Laragon sang (kèm php.ini, Xdebug) để dự án chạy đúng như cũ
    const needPhp = new Set();
    for (const name of pick) {
      const st = s.state.projects?.[name];
      if (st?.php) needPhp.add(st.php);
      else if (o.keepPhp !== false && s.defaultPhp) needPhp.add(s.defaultPhp);
    }
    for (const folder of needPhp) {
      if (laragon.phpVersions().includes(folder) || !s.phps.includes(folder)) continue;
      ctx.step(`Chép PHP ${laragon.versionOf(folder)} từ Laragon`);
      await copyDir(path.join(s.root, 'bin', 'php', folder), path.join(laragon.P.php(), folder), false);
    }

    // 3) Chứng chỉ gốc đã được Windows tin: dùng lại để khỏi phải cài lại
    const srcCa = path.join(s.root, 'etc', 'localpanel', 'ssl');
    const dstCa = path.join(laragon.P.root(), 'etc', 'localpanel', 'ssl');
    if (exists(path.join(srcCa, 'localpanel-ca.crt')) && exists(path.join(srcCa, 'localpanel-ca.key'))) {
      ctx.step('Dùng lại chứng chỉ gốc HTTPS của bản Laragon');
      fs.mkdirSync(dstCa, { recursive: true });
      for (const f of ['localpanel-ca.crt', 'localpanel-ca.key']) {
        const t = path.join(dstCa, f);
        if (exists(t) && !exists(`${t}.cu`)) fs.copyFileSync(t, `${t}.cu`);
        fs.copyFileSync(path.join(srcCa, f), t);
      }
      certs.reset();
    }

    // 4) Mã nguồn
    for (const name of pick) {
      if (!s.projects.includes(name)) continue;
      if (exists(path.join(www, name))) { done.skipped.push(`${name} (đã có trong Sitebench)`); continue; }
      ctx.step(`Chép mã nguồn ${name}`);
      let files = 0;
      await copyDir(path.join(s.root, 'www', name), path.join(www, name), o.skipNodeModules !== false, () => { files++; if (files % 2000 === 0) ctx.log(`  đã chép ${files} tệp`); });
      ctx.log(`  ${files} tệp`);
      done.projects.push(name);
    }

    // 5) Database: bật tạm MySQL của Laragon, xuất từng database, nạp vào MySQL của Sitebench
    const dbList = [...pickDb].filter(db => databasesIn(s.my?.datadir).includes(db));
    if (dbList.length) {
      ctx.step('Bật MySQL của Sitebench');
      await services.run('mysql', 'start').catch(e => { throw httpError(500, `Chưa bật được MySQL của Sitebench: ${e.message}`); });
      const targetDbs = (await D.query('SHOW DATABASES')).map(x => x.Database);
      let src = null;
      try {
        ctx.step('Bật tạm MySQL của Laragon để xuất dữ liệu');
        src = await startSourceMysql(s, o.password, ctx);
        for (const db of dbList) {
          if (targetDbs.includes(db)) { done.skipped.push(`database ${db} (đã có trong Sitebench)`); continue; }
          ctx.step(`Chuyển database ${db}`);
          const file = path.join(config.paths.tools, `mig-${crypto.randomBytes(4).toString('hex')}.sql`);
          try {
            await dumpSource(s, src, db, file);
            ctx.log(`  đã xuất ${D.mb(fs.statSync(file).size)}`);
            await D.query(`CREATE DATABASE \`${db.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await D.importFile(file, db, ctx);
            done.databases.push(db);
          } catch (e) {
            notes.push(`Database ${db} chưa chuyển được: ${e.message}`);
            await D.query(`DROP DATABASE IF EXISTS \`${db.replace(/`/g, '``')}\``).catch(() => {});
          } finally { fs.rmSync(file, { force: true }); }
        }
      } finally {
        ctx.log('  tắt MySQL tạm của Laragon');
        await stopSourceMysql(src);
      }
    }

    // 6) Tên miền, PHP riêng, HTTPS, Wi-Fi, thông tin site
    ctx.step('Tạo tên miền và cấu hình từng dự án');
    for (const name of done.projects) {
      try { await laragon.ensureDomain(name); } catch (e) { notes.push(`${name}: ${e.message}`); }
      const st = s.state.projects?.[name] || {};
      const php = st.php || (o.keepPhp !== false ? s.defaultPhp : null);
      const opts = {
        php: php && laragon.phpVersions().includes(php) && php !== laragon.defaultPhp() ? php : null,
        https: !!st.https, lan: !!st.lan,
      };
      if (opts.php || opts.https || opts.lan) {
        try { await laragon.applyProject(name, opts); } catch (e) { notes.push(`${name}: chưa áp dụng được PHP/HTTPS (${e.message})`); }
      }
      if (s.meta[name]) wpExtras.setMeta(name, s.meta[name]);
      // Đường dẫn tuyệt đối cũ (ví dụ D:/laragon/www/ten) trong database của WordPress
      if (W.isWp(name) && W.readConfig(name)) {
        const oldDir = path.join(s.root, 'www', name), newDir = laragon.projectDir(name);
        for (const [a, b] of [[fwd(oldDir), fwd(newDir)], [oldDir.split('/').join('\\'), newDir.split('/').join('\\')]]) {
          if (a !== b) await W.wp(name, ['search-replace', a, b, '--all-tables-with-prefix', '--precise', '--report-changed-only'], { safe: true }).catch(() => {});
        }
      }
      try { laragon.writeDevInfo(name); } catch { /* bỏ qua */ }
    }

    ctx.step('Bật Apache');
    await laragon.refreshConfs().catch(() => {});
    laragon.restartFcgi();
    const ap = await services.run('apache', 'restart').catch(e => `Chưa bật được Apache: ${e.message}`);
    ctx.log(`  ${ap}`);
    if (done.projects.some(n => [path.join(laragon.projectDir(n), 'package.json'), path.join(laragon.projectDir(n), '_dev', 'package.json')].some(exists)) && o.skipNodeModules !== false) {
      notes.push('node_modules không được chép: mở Terminal của dự án và chạy "npm install" (trong _dev với template wp-vite-starter).');
    }
    notes.push('Laragon vẫn nguyên vẹn. Đừng bật lại Apache/MySQL của Laragon khi đang dùng Sitebench (trùng cổng 80/3306).');
    return { ...done, notes };
  }

  // ---------- API ----------
  r.get('/laragon', wrap(async (req, res) => res.json(await scan(req.query.root))));
  r.post('/laragon', wrap(async (req, res) => {
    const o = req.body || {};
    source(o.root);
    res.json({ ok: true, job: jobs.start('Chuyển từ Laragon', ctx => migrate(ctx, o)) });
  }));
  return { router: r };
};
